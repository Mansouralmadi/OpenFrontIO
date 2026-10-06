import { PseudoRandom } from "../PseudoRandom";
import type { MapManifest } from "./TerrainMapLoader";

// Procedural map generator for GameMapType.Random. Produces the same packed
// terrain bytes the Go map-generator writes (see map-generator/map_generator.go),
// so the rest of the game can't tell a generated map from a shipped one.
// Uses only + - * / floor abs and 32-bit integer hashing, so the same params
// produce identical bytes on every platform (main thread and worker both build it).

export const RANDOM_MAP_STYLES = [
  "continents",
  "pangaea",
  "archipelago",
  "inland_sea",
  "fractal",
] as const;
export type RandomMapStyle = (typeof RANDOM_MAP_STYLES)[number];

export const RANDOM_MAP_SIZES = {
  small: [1400, 700],
  medium: [2000, 1000],
  large: [2400, 1200],
} as const;
export type RandomMapSize = keyof typeof RANDOM_MAP_SIZES;

export const GENERATED_NATION_COUNT: Record<RandomMapSize, number> = {
  small: 10,
  medium: 16,
  large: 22,
};

export interface RandomMapParams {
  seed: number;
  /** Target share of the map that is land, 10–85. */
  landPercent: number;
  style: RandomMapStyle;
  size: RandomMapSize;
  /** 0 = flat, 100 = very rugged. Controls highland/mountain share of land. */
  mountains: number;
  /** 0 = arid, 100 = wet. Controls how many rivers and lakes form. */
  rivers: number;
}

export const DEFAULT_RANDOM_MAP: RandomMapParams = {
  seed: 1,
  landPercent: 40,
  style: "continents",
  size: "medium",
  mountains: 50,
  rivers: 50,
};

export interface GeneratedMap {
  manifest: MapManifest;
  mapBin: Uint8Array;
  map4xBin: Uint8Array;
  map16xBin: Uint8Array;
}

const WATER = 0;
const LAND = 1;
/**
 * Islands at least this big (tiles) are always kept: 250 (~16x16) on a
 * 2000x1000 map. Smaller ones are specks to micromanage, so they're rare.
 */
export function minIslandSize(width: number, height: number): number {
  return Math.max(150, Math.floor((width * height) / 8000));
}

/** Islets below this are always removed. */
export const MIN_ISLET = 50;
/** An islet between MIN_ISLET and minIslandSize survives 1 in this many. */
const ISLET_KEEP_ODDS = 5;
const MIN_LAKE = 200;
const BUCKETS = 4096;

// ---------- noise ----------

function hash(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// 16 unit gradients (cos/sin of k·22.5°), as literals: no trig at runtime.
// prettier-ignore
const GRAD_X = [1, 0.9238795, 0.7071068, 0.3826834, 0, -0.3826834, -0.7071068, -0.9238795, -1, -0.9238795, -0.7071068, -0.3826834, 0, 0.3826834, 0.7071068, 0.9238795];
// prettier-ignore
const GRAD_Y = [0, 0.3826834, 0.7071068, 0.9238795, 1, 0.9238795, 0.7071068, 0.3826834, 0, -0.3826834, -0.7071068, -0.9238795, -1, -0.9238795, -0.7071068, -0.3826834];

function grad(ix: number, iy: number, seed: number, dx: number, dy: number) {
  const g = hash(ix, iy, seed) & 15;
  return GRAD_X[g] * dx + GRAD_Y[g] * dy;
}

/** Perlin gradient noise, roughly in [-0.7, 0.7]. No lattice blockiness. */
function gradientNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const sy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = grad(ix, iy, seed, fx, fy);
  const b = grad(ix + 1, iy, seed, fx - 1, fy);
  const c = grad(ix, iy + 1, seed, fx, fy - 1);
  const d = grad(ix + 1, iy + 1, seed, fx - 1, fy - 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

// Rotate each octave ~29° so lattice axes never line up into streaks.
const ROT_C = 0.8746197;
const ROT_S = 0.4848096;

/**
 * Unnormalised sum of octaves [from, to) of fractal noise. Splitting lets
 * smooth low octaves be sampled coarsely and only fine octaves per tile.
 */
function fbmPart(
  x: number,
  y: number,
  seed: number,
  from: number,
  to: number,
  persistence: number,
): number {
  let sum = 0;
  let amp = 1;
  for (let i = 0; i < to; i++) {
    if (i >= from) sum += amp * gradientNoise(x, y, (seed + i * 1013) | 0);
    amp *= persistence;
    const rx = ROT_C * x - ROT_S * y;
    y = (ROT_S * x + ROT_C * y) * 2 + 17.3;
    x = rx * 2 + 31.7;
  }
  return sum;
}

/** Sum of octave amplitudes, to normalise fbmPart sums. */
function fbmNorm(octaves: number, persistence: number): number {
  let norm = 0;
  for (let i = 0, amp = 1; i < octaves; i++, amp *= persistence) norm += amp;
  return norm;
}

/** Fractal noise, roughly in [0, 1]. */
function fbm(
  x: number,
  y: number,
  seed: number,
  octaves: number,
  persistence = 0.5,
): number {
  return (
    0.5 +
    fbmPart(x, y, seed, 0, octaves, persistence) / fbmNorm(octaves, persistence)
  );
}

interface Grid {
  g: Float32Array;
  gw: number;
  gh: number;
  step: number;
}

/** Grid of fn(gx*step, gy*step), one cell beyond the map for bilerp. */
function makeGrid(
  w: number,
  h: number,
  step: number,
  fn: (x: number, y: number) => number,
): Grid {
  const gw = Math.floor(w / step) + 2;
  const gh = Math.floor(h / step) + 2;
  const g = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) g[gy * gw + gx] = fn(gx * step, gy * step);
  }
  return { g, gw, gh, step };
}

function bilerp({ g, gw, step }: Grid, x: number, y: number): number {
  const fx = x / step;
  const fy = y / step;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const i = iy * gw + ix;
  const top = g[i] + (g[i + 1] - g[i]) * tx;
  const bot = g[i + gw] + (g[i + gw + 1] - g[i + gw]) * tx;
  return top + (bot - top) * ty;
}

/**
 * fn(x/height, y/height) sampled every `step` tiles, bilinear in between.
 * For low-frequency fields where per-tile evaluation is wasted work.
 */
function coarseField(
  w: number,
  h: number,
  step: number,
  fn: (nx: number, ny: number) => number,
): (x: number, y: number) => number {
  const grid = makeGrid(w, h, step, (x, y) => fn(x / h, y / h));
  return (x, y) => bilerp(grid, x, y);
}

/** A tile field point-sampled every `step` tiles (edges clamped). */
function sampleGrid(v: Float32Array, w: number, h: number, step: number) {
  return makeGrid(
    w,
    h,
    step,
    (x, y) => v[Math.min(y, h - 1) * w + Math.min(x, w - 1)],
  );
}

/** Value with `below` cells under it (histogram approximation). */
function percentile(
  v: Float32Array,
  below: number,
  min: number,
  max: number,
): number {
  const span = max - min || 1;
  const hist = new Uint32Array(BUCKETS);
  for (let i = 0; i < v.length; i++) {
    hist[Math.min(BUCKETS - 1, Math.floor(((v[i] - min) / span) * BUCKETS))]++;
  }
  let b = 0;
  for (let acc = 0; b < BUCKETS && acc + hist[b] <= below; b++) acc += hist[b];
  return min + (b / BUCKETS) * span;
}

// ---------- style shapes ----------

interface Blob {
  x: number;
  y: number;
  rx: number;
  ry: number;
}

interface StyleShape {
  freq: number; // base noise cycles per map height
  warp: number; // domain-warp strength
  noiseWeight: number;
  maskWeight: number;
  edgeFalloff: boolean;
  invert: boolean; // inland sea: water inside the blob
  blobs: Blob[];
}

function styleShape(
  style: RandomMapStyle,
  aspect: number,
  rand: PseudoRandom,
): StyleShape {
  const blob = (x: number, y: number, r: number): Blob => ({
    x,
    y,
    rx: r * rand.nextFloat(0.8, 1.3),
    ry: r * rand.nextFloat(0.8, 1.2),
  });
  switch (style) {
    case "pangaea":
      return {
        freq: 2.2,
        warp: 0.8,
        noiseWeight: 0.65,
        maskWeight: 0.4,
        edgeFalloff: true,
        invert: false,
        blobs: [
          blob(
            aspect / 2 + rand.nextFloat(-0.1, 0.1),
            0.5 + rand.nextFloat(-0.05, 0.05),
            0.55,
          ),
        ],
      };
    case "archipelago": {
      const n = rand.nextInt(14, 26);
      const blobs: Blob[] = [];
      for (let i = 0; i < n; i++) {
        blobs.push(
          blob(
            rand.nextFloat(0.1, aspect - 0.1),
            rand.nextFloat(0.1, 0.9),
            rand.nextFloat(0.06, 0.14),
          ),
        );
      }
      return {
        freq: 5,
        warp: 0.5,
        noiseWeight: 0.75,
        maskWeight: 0.3,
        edgeFalloff: true,
        invert: false,
        blobs,
      };
    }
    case "inland_sea":
      return {
        freq: 2.5,
        warp: 1.1,
        noiseWeight: 0.7,
        maskWeight: 0.3,
        edgeFalloff: false,
        invert: true,
        blobs: [blob(aspect / 2, 0.5, 0.35)],
      };
    case "fractal":
      return {
        freq: 3,
        warp: 0.6,
        noiseWeight: 1,
        maskWeight: 0,
        edgeFalloff: true,
        invert: false,
        blobs: [],
      };
    case "continents":
    default: {
      // Spread 2–4 continents across horizontal bands so oceans separate them.
      const n = rand.nextInt(2, 5);
      const blobs: Blob[] = [];
      for (let i = 0; i < n; i++) {
        const band = aspect / n;
        blobs.push(
          blob(
            band * (i + 0.5) + rand.nextFloat(-band * 0.15, band * 0.15),
            rand.nextFloat(0.3, 0.7),
            rand.nextFloat(0.26, 0.38),
          ),
        );
      }
      return {
        freq: 2.5,
        warp: 0.8,
        noiseWeight: 0.7,
        maskWeight: 0.35,
        edgeFalloff: true,
        invert: false,
        blobs,
      };
    }
  }
}

// ---------- terrain ----------

export interface RawTerrain {
  width: number;
  height: number;
  type: Uint8Array; // WATER | LAND
  mag: Uint8Array; // land elevation 0–30
}

/**
 * Elevation, coasts, rivers and lakes for any resolution. Shapes are defined
 * in map-height units, so a small preview looks like the full-size map.
 *
 * Pipeline (see docs in each step):
 *  1. macro shape: warped fBm + style mask; ridged noise for mountain chains
 *  2. coast detail: fine noise only near the provisional coast
 *  3. stream-power erosion on a coarse grid, against a sea level 4% lower
 *  4. final sea level by percentile: eroded valleys drown into bays and rias
 *  5. rivers + lakes from priority-flood drainage
 *  6. elevation classes (plains / highlands / mountains) by percentile
 */
export function generateTerrain(
  params: RandomMapParams,
  width: number,
  height: number,
): RawTerrain {
  const n = width * height;
  const rand = new PseudoRandom(params.seed);
  const s = rand.nextInt(0, 0x7fffffff);
  const aspect = width / height;
  const shape = styleShape(params.style, aspect, rand);

  // ---- 1. macro shape. Octaves down to ~3px; coast detail goes finer.
  let octaves = 1;
  for (let f = 2; octaves < 8 && height / (shape.freq * f) > 3; f *= 2) {
    octaves++;
  }
  const elev = new Float32Array(n);
  const ridge = new Float32Array(n);
  // Smooth fields: sample on a coarse grid, interpolate per tile.
  const warpX = coarseField(width, height, 8, (nx, ny) =>
    fbm(nx * 2, ny * 2, s + 11, 3),
  );
  const warpY = coarseField(width, height, 8, (nx, ny) =>
    fbm(nx * 2, ny * 2, s + 23, 3),
  );
  // The first 3 octaves of the main noise are smooth too (warp is smooth).
  const mainNorm = fbmNorm(octaves, 0.6);
  const lowOctaves = coarseField(width, height, 4, (nx, ny) => {
    const wx = nx + shape.warp * (fbm(nx * 2, ny * 2, s + 11, 3) - 0.5);
    const wy = ny + shape.warp * (fbm(nx * 2, ny * 2, s + 23, 3) - 0.5);
    return fbmPart(wx * shape.freq, wy * shape.freq, s, 0, 3, 0.6) / mainNorm;
  });
  const ridgeNoise = coarseField(width, height, 3, (nx, ny) =>
    fbm(nx * 3, ny * 3, s + 37, 5),
  );
  for (let y = 0; y < height; y++) {
    const ny = y / height;
    for (let x = 0; x < width; x++) {
      const nx = x / height;
      const wx = nx + shape.warp * (warpX(x, y) - 0.5);
      const wy = ny + shape.warp * (warpY(x, y) - 0.5);
      let e =
        shape.noiseWeight *
        (0.5 +
          lowOctaves(x, y) +
          fbmPart(wx * shape.freq, wy * shape.freq, s, 3, octaves, 0.6) /
            mainNorm);

      if (shape.blobs.length > 0) {
        let mask = -1;
        for (const b of shape.blobs) {
          const dx = (wx - b.x) / b.rx;
          const dy = (wy - b.y) / b.ry;
          const v = 1 - (dx * dx + dy * dy);
          if (v > mask) mask = v;
        }
        e += shape.maskWeight * (shape.invert ? -mask : mask);
      }

      if (shape.edgeFalloff) {
        const d = Math.min(nx, aspect - nx, ny, 1 - ny);
        if (d < 0.12) {
          const t = (0.12 - d) / 0.12;
          e -= 0.6 * t * t;
        }
      }

      const i = y * width + x;
      elev[i] = e;
      // Ridged noise: high along the zero-crossings of an fbm field, giving
      // long mountain chains instead of round peaks.
      ridge[i] = 1 - Math.abs(2 * ridgeNoise(x, y) - 1);
    }
  }

  const wantLand = Math.floor((n * params.landPercent) / 100);
  let [min, max] = range(elev);

  // ---- 2. coast detail (mapgen4's "noisy coastlines"). The macro octaves
  // decide where coasts are but leave them smooth, so add fine noise only in
  // a band around the provisional coast. A regional roughness field mixes
  // smooth beaches with broken, rocky coast (Here Dragons Abound).
  {
    const sea = percentile(elev, n - wantLand, min, max);
    const band = 0.08 * (max - min);
    const roughness = coarseField(width, height, 16, (nx, ny) =>
      clamp01(0.5 + 2.5 * (fbm(nx * 3.3, ny * 3.3, s + 61, 2) - 0.5)),
    );
    const f = height / 40; // 25px features (at 1000px) down to ~1.5px
    // Fewer octaves at low resolution (previews), or they alias into speckle.
    let coastOctaves = 1;
    for (let g = f / 2; coastOctaves < 5 && g >= 1.5; g /= 2) coastOctaves++;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const d = (elev[i] - sea) / band;
        if (d * d >= 1) continue;
        const r = 0.25 + 0.75 * roughness(x, y);
        const detail = fbm(x / f, y / f, s + 53, coastOctaves, 0.6) - 0.5;
        elev[i] += (1 - d * d) * r * 1.6 * band * detail;
      }
    }
    [min, max] = range(elev);
  }

  // ---- 3. erosion (Braun & Willett 2013 stream power) on a 1/4-res grid
  // against a sea level 4% lower than final, then add the change back.
  // Raising the sea afterwards floods the cut valleys into inlets
  // (mewo2/terrain does erosion before setSeaLevel for the same reason).
  {
    const step = 4;
    const lowSea = percentile(
      elev,
      n - Math.min(n, wantLand + Math.floor(n * 0.04)),
      min,
      max,
    );
    const grid = sampleGrid(elev, width, height, step);
    const before = grid.g.slice();
    erode(grid.g, grid.gw, grid.gh, lowSea, 10, 0.012);
    for (let i = 0; i < before.length; i++) grid.g[i] -= before[i];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        elev[y * width + x] += bilerp(grid, x, y);
      }
    }
    [min, max] = range(elev);
  }

  // ---- 4. final sea level = percentile giving landPercent land, plus a
  // little extra that rivers and lakes will take back.
  const span = max - min || 1;
  const landTarget = Math.min(
    n,
    Math.floor(wantLand * (1 + (0.06 * params.rivers) / 100)),
  );
  const bucket = (e: number) =>
    Math.min(BUCKETS - 1, Math.floor(((e - min) / span) * BUCKETS));
  const hist = new Uint32Array(BUCKETS);
  for (let i = 0; i < n; i++) hist[bucket(elev[i])]++;
  let seaBucket = BUCKETS;
  let acc = 0;
  while (seaBucket > 0 && acc + hist[seaBucket - 1] <= landTarget) {
    acc += hist[--seaBucket];
  }
  const landCount = acc || 1;
  // cdf[b] = share of land at or below bucket b: 0 at the coast, 1 at the peak.
  const cdf = new Float32Array(BUCKETS);
  let run = 0;
  for (let b = seaBucket; b < BUCKETS; b++) {
    run += hist[b];
    cdf[b] = run / landCount;
  }

  const type = new Uint8Array(n);
  const inland = new Float32Array(n);
  const rugged = new Float32Array(n);
  const rHist = new Uint32Array(BUCKETS);
  for (let i = 0; i < n; i++) {
    const b = bucket(elev[i]);
    if (b < seaBucket) continue;
    type[i] = LAND;
    inland[i] = cdf[b];
    // Slight preference for mountains inland, away from coasts.
    const r = ridge[i] * (0.85 + 0.15 * cdf[b]);
    rugged[i] = r;
    rHist[Math.min(BUCKETS - 1, Math.floor(r * BUCKETS))]++;
  }

  // ---- 5. mountain/highland thresholds by percentile of land (slider).
  const m = params.mountains / 100;
  const mountainShare = 0.15 * m;
  const highlandShare = 0.05 + 0.3 * m;
  const threshold = (share: number) => {
    let b = BUCKETS;
    let c = 0;
    const want = share * landCount;
    while (b > 0 && c + rHist[b - 1] <= want) c += rHist[--b];
    return b / BUCKETS;
  };
  const tMountain = mountainShare > 0 ? threshold(mountainShare) : 2;
  const tHigh = threshold(mountainShare + highlandShare);

  // ---- 6. rivers and lakes. Flow over the eroded terrain (its valleys make
  // tributaries converge), with highlands/mountains raised so rivers route
  // around ranges and through passes instead of over peaks.
  {
    const sea = min + (seaBucket / BUCKETS) * span;
    const flow = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (type[i] !== LAND) continue;
      const hill = clamp01((rugged[i] - tHigh) / (1 - tHigh + 1e-6));
      flow[i] = (elev[i] - sea) / (max - sea) + 0.5 * hill;
    }
    carveRivers(params, type, flow, width, height, s);
  }

  const mag = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (type[i] !== LAND) continue;
    const r = rugged[i];
    if (r >= tMountain) {
      const t = (r - tMountain) / (1 - tMountain + 1e-6);
      mag[i] = Math.min(30, 20 + Math.floor(10 * t));
    } else if (r >= tHigh) {
      const t = (r - tHigh) / (Math.min(tMountain, 1) - tHigh + 1e-6);
      mag[i] = Math.min(19, 10 + Math.floor(10 * t));
    } else {
      mag[i] = Math.min(9, Math.floor(inland[i] * 10));
    }
  }
  return { width, height, type, mag };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function range(v: Float32Array): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < v.length; i++) {
    if (v[i] < min) min = v[i];
    if (v[i] > max) max = v[i];
  }
  return [min, max];
}

// ---------- hydrology ----------

interface Drainage {
  /** Land cells in flood order: each is visited after the cell it drains to. */
  order: Int32Array;
  count: number;
  /** Neighbour each land cell drains into, or -1. */
  recv: Int32Array;
  /** Quantised height with depressions filled to their spill level. */
  filled: Uint16Array;
  /** The input heights, quantised the same way. */
  level: Uint16Array;
}

const LEVELS = 65536;

/**
 * Priority-Flood (Barnes, Lehman & Mulla 2014) inward from water and the map
 * edge, using a monotone bucket queue over 16-bit heights: O(n), and FIFO
 * within a level makes flow cross flats along shortest paths. Pop order is a
 * drainage order and the cell that first reached a cell is where it drains,
 * so flow routing comes for free, with no pits. `diagonal` adds diagonal
 * neighbours for natural 45° rivers (fill a corner to stay 4-connected).
 * `jitter` (in levels) is added to queue keys only: inside filled basins the
 * FIFO wavefront would draw ruler-straight rivers; jitter makes them wander.
 */
function priorityFlood(
  h: Float32Array,
  water: Uint8Array,
  w: number,
  ht: number,
  diagonal = false,
  jitter?: Uint16Array,
): Drainage {
  const n = w * ht;
  const [lo, hi] = range(h);
  const scale = (LEVELS - 1) / (hi - lo || 1);
  const level = new Uint16Array(n);
  for (let i = 0; i < n; i++) level[i] = Math.floor((h[i] - lo) * scale);

  const filled = new Uint16Array(n);
  const recv = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const order = new Int32Array(n);
  let count = 0;
  // Bucket queue: per-level singly linked FIFO lists.
  const head = new Int32Array(LEVELS).fill(-1);
  const tail = new Int32Array(LEVELS).fill(-1);
  const next = new Int32Array(n);
  const push = (c: number, key: number) => {
    next[c] = -1;
    if (tail[key] < 0) head[key] = c;
    else next[tail[key]] = c;
    tail[key] = c;
  };
  for (let i = 0; i < n; i++) {
    const x = i % w;
    const y = (i - x) / w;
    if (water[i] || x === 0 || y === 0 || x === w - 1 || y === ht - 1) {
      done[i] = 1;
      filled[i] = level[i];
      push(i, level[i]);
    }
  }
  let cur = 0;
  const visit = (c: number, j: number) => {
    if (done[j]) return;
    done[j] = 1;
    recv[j] = c;
    filled[j] = level[j] > filled[c] ? level[j] : filled[c];
    const key = jitter
      ? Math.min(LEVELS - 1, filled[j] + jitter[j])
      : filled[j];
    push(j, key > cur ? key : cur);
  };
  while (cur < LEVELS) {
    const c = head[cur];
    if (c < 0) {
      cur++;
      continue;
    }
    head[cur] = next[c];
    if (head[cur] < 0) tail[cur] = -1;
    if (!water[c]) order[count++] = c;
    const x = c % w;
    if (x > 0) visit(c, c - 1);
    if (x < w - 1) visit(c, c + 1);
    if (c >= w) visit(c, c - w);
    if (c < n - w) visit(c, c + w);
    if (diagonal) {
      if (x > 0 && c >= w) visit(c, c - w - 1);
      if (x < w - 1 && c >= w) visit(c, c - w + 1);
      if (x > 0 && c < n - w) visit(c, c + w - 1);
      if (x < w - 1 && c < n - w) visit(c, c + w + 1);
    }
  }
  return { order, count, recv, filled, level };
}

/** Upstream cell count + 1 for every land cell. */
function flowAccumulation(d: Drainage, n: number): Float32Array {
  const flux = new Float32Array(n);
  for (let k = d.count - 1; k >= 0; k--) {
    const c = d.order[k];
    flux[c] += 1;
    if (d.recv[c] >= 0) flux[d.recv[c]] += flux[c];
  }
  return flux;
}

/**
 * Implicit stream-power erosion: each cell moves toward its receiver's height
 * by K·sqrt(drainage area). Unconditionally stable; carves dendritic valleys.
 * Depressions are left alone so they can become lakes.
 */
function erode(
  h: Float32Array,
  w: number,
  ht: number,
  seaLevel: number,
  iterations: number,
  k: number,
) {
  const base = new Uint8Array(w * ht);
  for (let i = 0; i < base.length; i++) base[i] = h[i] < seaLevel ? 1 : 0;
  for (let it = 0; it < iterations; it++) {
    const d = priorityFlood(h, base, w, ht);
    const area = flowAccumulation(d, w * ht);
    for (let j = 0; j < d.count; j++) {
      const c = d.order[j];
      const r = d.recv[c];
      if (r < 0 || d.filled[c] > d.level[c]) continue;
      const f = k * Math.sqrt(area[c]);
      h[c] = (h[c] + f * h[r]) / (1 + f);
    }
  }
}

/**
 * Turns the wettest drainage paths into rivers and deep basins into lakes,
 * writing WATER into `type`. Rivers rise in the highlands and follow the
 * lowest path to the sea, widening downstream.
 */
function carveRivers(
  params: RandomMapParams,
  type: Uint8Array,
  flow: Float32Array,
  w: number,
  ht: number,
  seed: number,
) {
  const wet = params.rivers / 100;
  if (wet <= 0) return;
  const n = w * ht;
  // Height for flow: rises inland and on ridges. Small "meander" noise keeps
  // rivers from running ruler-straight across flats (mapgen4).
  const meander = coarseField(w, ht, 3, (nx, ny) =>
    fbm(nx * 40, ny * 40, seed + 71, 2),
  );
  const h = new Float32Array(n);
  const water = new Uint8Array(n);
  let land = 0;
  for (let i = 0; i < n; i++) {
    if (type[i] === LAND) {
      const x = i % w;
      h[i] = flow[i] + 0.03 * meander(x, (i - x) / w);
      land++;
    } else {
      water[i] = 1;
    }
  }
  const jitter = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const x = i % w;
    jitter[i] = Math.floor(600 * meander(x, (i - x) / w));
  }
  const d = priorityFlood(h, water, w, ht, true, jitter);
  const flux = flowAccumulation(d, n);

  // Lakes: depressions (filled above terrain) that are big and deep enough.
  // Small/shallow ones stay land, otherwise fBm leaves hundreds of puddles.
  {
    const depth = new Float32Array(n);
    const [lo, hi] = range(h);
    const unit = (hi - lo) / (LEVELS - 1);
    for (let k = 0; k < d.count; k++) {
      const c = d.order[k];
      depth[c] = (d.filled[c] - d.level[c]) * unit;
    }
    const minDepth = 0.12 - 0.09 * wet;
    const minArea = Math.floor(n * 0.0004) + 200;
    const lake = new Uint8Array(n);
    const seen = new Uint8Array(n);
    // All depressions' cells, back to back; candidates index into it.
    const members = new Int32Array(n);
    let used = 0;
    const candidates: { from: number; to: number; deepest: number }[] = [];
    for (let start = 0; start < n; start++) {
      if (seen[start] || depth[start] <= 1e-4) continue;
      // Flood one depression.
      const from = used;
      let head = used;
      let deepest = 0;
      members[used++] = start;
      seen[start] = 1;
      while (head < used) {
        const c = members[head++];
        if (depth[c] > deepest) deepest = depth[c];
        const x = c % w;
        const nb = [
          x > 0 ? c - 1 : -1,
          x < w - 1 ? c + 1 : -1,
          c >= w ? c - w : -1,
          c < n - w ? c + w : -1,
        ];
        for (const j of nb) {
          if (j >= 0 && !seen[j] && depth[j] > 1e-4) {
            seen[j] = 1;
            members[used++] = j;
          }
        }
      }
      if (used - from >= minArea && deepest >= minDepth) {
        candidates.push({ from, to: used, deepest });
      }
    }
    // Closed lakes (Azgaar: evaporation beats inflow): water fills only the
    // deeper part of the basin. Deepest basins first, within a budget.
    candidates.sort((a, b) => b.deepest - a.deepest || a.from - b.from);
    let budget = Math.floor(land * (0.005 + 0.03 * wet));
    for (const { from, to, deepest } of candidates) {
      if (budget <= 0) break;
      for (let k = from; k < to; k++) {
        const c = members[k];
        if (depth[c] >= 0.4 * deepest) {
          lake[c] = 1;
          budget--;
        }
      }
    }
    // One majority-filter pass: fractal lake shores look wrong.
    for (let i = 0; i < n; i++) {
      const x = i % w;
      const y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === ht - 1) continue;
      let votes = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) votes += lake[i + dy * w + dx];
      }
      if (votes >= 5 && type[i] === LAND) type[i] = WATER;
    }
  }

  // Rivers. Threshold adapts so river cells are ~0.3–1.5% of land; checked
  // on sqrt(flux) buckets since flux spans 1..land.
  const maxRoot = Math.floor(Math.sqrt(land)) + 1;
  const rootHist = new Uint32Array(maxRoot + 1);
  for (let k = 0; k < d.count; k++) {
    rootHist[Math.floor(Math.sqrt(flux[d.order[k]]))]++;
  }
  const want = land * (0.003 + 0.012 * wet);
  let root = maxRoot;
  for (let c = 0; root > 1 && c + rootHist[root - 1] <= want; ) {
    c += rootHist[--root];
  }
  const threshold = Math.max(root * root, 50);
  const isRiver = (c: number) => flux[c] >= threshold;

  // Prune short coastal creeks: a river system is kept only if its longest
  // branch is >= minLength tiles (decided at the mouth, inherited upstream).
  const minLength = Math.max(8, Math.floor(ht / 50));
  const up = new Uint16Array(n);
  for (let k = d.count - 1; k >= 0; k--) {
    const c = d.order[k];
    const r = d.recv[c];
    if (isRiver(c)) {
      up[c] = Math.min(65535, up[c] + 1);
      if (r >= 0 && up[r] < up[c]) up[r] = up[c];
    }
  }
  const keep = new Uint8Array(n);
  for (let k = 0; k < d.count; k++) {
    const c = d.order[k];
    if (!isRiver(c)) continue;
    const r = d.recv[c];
    const mouth = r < 0 || !isRiver(r) || water[r];
    keep[c] = mouth ? (up[c] >= minLength ? 1 : 0) : keep[r];
  }

  // Stamp rivers; width grows with flux (w ∝ sqrt Q): 1, 2 then 3 tiles.
  for (let k = 0; k < d.count; k++) {
    const c = d.order[k];
    if (!keep[c]) continue;
    type[c] = WATER;
    const r = d.recv[c];
    if (r < 0) continue;
    const dx = (r % w) - (c % w);
    // Diagonal step: fill the lower corner so the river stays 4-connected.
    if (dx !== 0 && r !== c + dx) {
      const a = c + dx;
      const b = r - dx;
      type[h[a] <= h[b] ? a : b] = WATER;
    }
    if (flux[c] < threshold * 6) continue;
    // Perpendicular-ish to the flow direction.
    const side = dx !== 0 && r === c + dx ? w : 1;
    const x = c % w;
    const ok = (j: number) =>
      j >= 0 && j < n && (side === w || Math.abs((j % w) - x) === 1);
    if (ok(c + side)) type[c + side] = WATER;
    if (flux[c] >= threshold * 30 && ok(c - side)) type[c - side] = WATER;
  }
}

// ---------- post-processing (ports of the Go generator) ----------

interface Tiles extends RawTerrain {
  shore: Uint8Array;
  ocean: Uint8Array;
  dist: Uint16Array;
}

/** Orthogonal neighbours of i, or -1 off the map edge. */
function neighbors(i: number, w: number, n: number): number[] {
  const x = i % w;
  return [
    x > 0 ? i - 1 : -1,
    x < w - 1 ? i + 1 : -1,
    i >= w ? i - w : -1,
    i < n - w ? i + w : -1,
  ];
}

/** Connected components (4-neighbour) of tiles equal to `want`. */
function components(
  t: RawTerrain,
  want: number,
): { label: Int32Array; sizes: number[] } {
  const { width: w, height: h, type } = t;
  const n = w * h;
  const label = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  const queue = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (type[start] !== want || label[start] !== -1) continue;
    const id = sizes.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    label[start] = id;
    while (head < tail) {
      for (const j of neighbors(queue[head++], w, n)) {
        if (j >= 0 && type[j] === want && label[j] === -1) {
          label[j] = id;
          queue[tail++] = j;
        }
      }
    }
    sizes.push(tail);
  }
  return { label, sizes };
}

/**
 * Removes land pieces under minSize. With `rare`, pieces of at least
 * rare.min tiles survive 1 in ISLET_KEEP_ODDS, picked by a hash of their
 * first tile so the same seed keeps the same islets.
 */
function removeSmallIslands(
  t: RawTerrain,
  minSize: number,
  rare?: { min: number; seed: number },
) {
  const { label, sizes } = components(t, LAND);
  const keep = new Uint8Array(sizes.length);
  for (let i = 0; i < t.type.length; i++) {
    if (t.type[i] !== LAND) continue;
    const c = label[i];
    if (keep[c] !== 0) continue;
    // Decided once per piece, at its first (lowest-index) tile.
    const size = sizes[c];
    const kept =
      size >= minSize ||
      (rare !== undefined &&
        size >= rare.min &&
        hash(i % t.width, Math.floor(i / t.width), rare.seed) %
          ISLET_KEEP_ODDS ===
          0);
    keep[c] = kept ? 1 : 2;
  }
  for (let i = 0; i < t.type.length; i++) {
    if (t.type[i] === LAND && keep[label[i]] === 2) {
      t.type[i] = WATER;
      t.mag[i] = 0;
    }
  }
}

function processWater(t: RawTerrain, removeSmall: boolean): Tiles {
  const { width: w, height: h, type } = t;
  const n = w * h;
  const ocean = new Uint8Array(n);
  const shore = new Uint8Array(n);
  const dist = new Uint16Array(n);
  const { label, sizes } = components(t, WATER);
  if (sizes.length === 0) return { ...t, ocean, shore, dist };

  let largest = 0;
  for (let k = 1; k < sizes.length; k++) {
    if (sizes[k] > sizes[largest]) largest = k;
  }
  for (let i = 0; i < n; i++) {
    if (type[i] !== WATER) continue;
    if (label[i] === largest) ocean[i] = 1;
    else if (removeSmall && sizes[label[i]] < MIN_LAKE) {
      type[i] = LAND;
      t.mag[i] = 0;
    }
  }

  const queue = new Int32Array(n);
  let tail = 0;
  const visited = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const other = type[i] === LAND ? WATER : LAND;
    if (neighbors(i, w, n).some((j) => j >= 0 && type[j] === other)) {
      shore[i] = 1;
      if (type[i] === WATER) {
        queue[tail++] = i;
        visited[i] = 1;
      }
    }
  }
  // Water magnitude = Manhattan distance to land (BFS from shoreline water).
  let head = 0;
  while (head < tail) {
    const i = queue[head++];
    for (const j of neighbors(i, w, n)) {
      if (j >= 0 && !visited[j] && type[j] === WATER) {
        visited[j] = 1;
        dist[j] = dist[i] + 1;
        queue[tail++] = j;
      }
    }
  }
  return { ...t, ocean, shore, dist };
}

/** Halve resolution; water wins any 2×2 block (keeps straits for pathfinding). */
function downscale(t: RawTerrain): RawTerrain {
  const w = t.width / 2;
  const h = t.height / 2;
  const type = new Uint8Array(w * h);
  const mag = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i00 = 2 * y * t.width + 2 * x;
      const i11 = i00 + t.width + 1;
      const water =
        t.type[i00] === WATER ||
        t.type[i00 + 1] === WATER ||
        t.type[i00 + t.width] === WATER ||
        t.type[i11] === WATER;
      type[y * w + x] = water ? WATER : LAND;
      mag[y * w + x] = water ? 0 : t.mag[i11];
    }
  }
  return { width: w, height: h, type, mag };
}

/** Bit 7 land, bit 6 shoreline, bit 5 ocean, bits 0–4 magnitude. */
function pack(t: Tiles): { data: Uint8Array; land: number } {
  const data = new Uint8Array(t.type.length);
  let land = 0;
  for (let i = 0; i < data.length; i++) {
    let b = t.shore[i] ? 0x40 : 0;
    if (t.type[i] === LAND) {
      b |= 0x80 | Math.min(t.mag[i], 31);
      land++;
    } else {
      if (t.ocean[i]) b |= 0x20;
      b |= Math.min((t.dist[i] + 1) >> 1, 31);
    }
    data[i] = b;
  }
  return { data, land };
}

// ---------- nations ----------

// prettier-ignore
const NAME_START = ["Ar", "Bel", "Cor", "Dar", "El", "Fen", "Gal", "Hal", "Is", "Kar", "Lor", "Mar", "Nor", "Or", "Pel", "Quen", "Ros", "Sar", "Tal", "Ul", "Val", "Wes", "Yr", "Zan"];
// prettier-ignore
const NAME_MID = ["a", "e", "i", "o", "ae", "ia", "an", "en", "or"];
// prettier-ignore
const NAME_END = ["dor", "heim", "land", "mark", "ria", "stan", "via", "gard", "mor", "thal", "wyn", "cia", "nia", "os"];

function nationNames(count: number, rand: PseudoRandom): string[] {
  const names = new Set<string>();
  const pick = (arr: string[]) => arr[rand.nextInt(0, arr.length)];
  while (names.size < count) {
    const mid = rand.chance(2) ? pick(NAME_MID) : "";
    names.add(pick(NAME_START) + mid + pick(NAME_END));
  }
  return [...names];
}

// ---------- entry point ----------

export function generateRandomMap(params: RandomMapParams): GeneratedMap {
  const [width, height] = RANDOM_MAP_SIZES[params.size];
  const full = generateTerrain(params, width, height);
  const minIsland = minIslandSize(width, height);
  removeSmallIslands(full, minIsland, { min: MIN_ISLET, seed: params.seed });
  const map = processWater(full, true);

  // Islands were already filtered at full size; on the minimap (a quarter of
  // the tiles, shrunk further where water wins) only drop leftover specks.
  const raw4x = downscale(map);
  removeSmallIslands(raw4x, Math.floor(MIN_ISLET / 8));
  const map4x = processWater(raw4x, false);

  const map16x = processWater(downscale(map4x), false);

  const p1 = pack(map);
  const p4 = pack(map4x);
  const p16 = pack(map16x);

  const nationCount = GENERATED_NATION_COUNT[params.size];
  const nameRand = new PseudoRandom(params.seed ^ 0x5eed);
  return {
    manifest: {
      name: "Random",
      map: { width, height, num_land_tiles: p1.land },
      map4x: {
        width: map4x.width,
        height: map4x.height,
        num_land_tiles: p4.land,
      },
      map16x: {
        width: map16x.width,
        height: map16x.height,
        num_land_tiles: p16.land,
      },
      // No coordinates: nations spawn on random land tiles.
      nations: nationNames(nationCount, nameRand).map((name) => ({ name })),
    },
    mapBin: p1.data,
    map4xBin: p4.data,
    map16xBin: p16.data,
  };
}
