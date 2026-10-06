import { Game } from "../game/Game";
import { TileRef } from "../game/GameMap";
import {
  addCoastDetail,
  clamp01,
  coarseField,
  components,
  fbm,
  fbmNorm,
  fbmPart,
  hash,
  MIN_ISLET,
  minIslandSize,
  percentile,
} from "../game/RandomMapGenerator";
import { PseudoRandom } from "../PseudoRandom";

// Land bomb terrain: a natural-looking landmass, not a blob. A local
// heightfield over the blast box is built the way the random map generator
// builds a world (domain-warped fractal gradient noise, then fine noise in a
// band around the coast for bays and headlands), plus a soft radial falloff
// that keeps it inside the blast radius. Sea level is the percentile that
// makes LAND_SHARE of the disc land. Elevation comes from the same field
// (low coast, inland hills) plus ridged noise for a small mountain spine.

const FREQ = 2.5; // base noise cycles across the box
const WARP = 0.5;
const OCTAVES = 6;
const NOISE_WEIGHT = 1;
const FALLOFF_WEIGHT = 0.65;
const MAX_STRETCH = 1.6; // the falloff is an ellipse up to this elongated
const LAND_SHARE = 0.36; // of the radius disc, before coast detail/cleanup
const MIN_SPECK = 20; // smaller coast-joined pieces are dropped
const MIN_LAKE = 40; // smaller enclosed water is filled
const MAX_ISLETS = 3;
const ISLET_MAX_SHARE = 4; // an islet is at most 1/4 of the main landmass
// Separate islands, as on generated maps: under MIN_ISLET tiles always go;
// up to minIslandSize they survive 1 time in SMALL_ISLET_ODDS (hashed), and
// a bomb leaves at most MAX_SMALL_ISLETS of them.
const SMALL_ISLET_ODDS = 5;
const MAX_SMALL_ISLETS = 1;

export interface RaisedLand {
  tiles: TileRef[];
  magnitudes: number[];
}

/**
 * Water tiles a land bomb at `center` raises, with their elevations.
 * Existing land is never in the result. Deterministic in `seed`.
 */
export function landBombTerrain(
  mg: Game,
  center: TileRef,
  radius: number,
  seed: number,
): RaisedLand {
  const map = mg.map();
  const D = 2 * radius + 1;
  const n = D * D;
  const ox = map.x(center) - radius;
  const oy = map.y(center) - radius;
  const s = seed & 0x7fffffff;
  // Box cell → world tile, or -1 off the map.
  const world = new Int32Array(n);
  for (let ly = 0; ly < D; ly++) {
    for (let lx = 0; lx < D; lx++) {
      const x = ox + lx;
      const y = oy + ly;
      world[ly * D + lx] = map.isValidCoord(x, y) ? map.ref(x, y) : -1;
    }
  }

  // ---- heightfield (shape units: the box is 1 across)
  const warpX = coarseField(D, D, 8, (nx, ny) =>
    fbm(nx * 2, ny * 2, s + 11, 3),
  );
  const warpY = coarseField(D, D, 8, (nx, ny) =>
    fbm(nx * 2, ny * 2, s + 23, 3),
  );
  const ridgeNoise = coarseField(D, D, 3, (nx, ny) =>
    fbm(nx * 3, ny * 3, s + 37, 4),
  );
  const norm = fbmNorm(OCTAVES, 0.6);
  // Falloff: a randomly oriented, stretched ellipse, itself domain-warped,
  // so the landmass is elongated and lobed rather than round.
  const rand = new PseudoRandom(s);
  let ax = rand.nextFloat(-1, 1);
  let ay = rand.nextFloat(-1, 1);
  const alen = Math.sqrt(ax * ax + ay * ay) || 1;
  ax /= alen;
  ay /= alen;
  const stretch = rand.nextFloat(1, MAX_STRETCH);
  const elev = new Float32Array(n);
  const inDisc = new Uint8Array(n);
  const r2 = radius * radius;
  let discArea = 0;
  for (let ly = 0; ly < D; ly++) {
    for (let lx = 0; lx < D; lx++) {
      const i = ly * D + lx;
      const dx = lx - radius;
      const dy = ly - radius;
      const d2 = (dx * dx + dy * dy) / r2;
      if (d2 <= 1) {
        inDisc[i] = 1;
        discArea++;
      }
      const ox = WARP * (warpX(lx, ly) - 0.5);
      const oy = WARP * (warpY(lx, ly) - 0.5);
      const wx = lx / D + ox;
      const wy = ly / D + oy;
      const noise =
        0.5 + fbmPart(wx * FREQ, wy * FREQ, s, 0, OCTAVES, 0.6) / norm;
      const fx = dx + ox * D * 0.5;
      const fy = dy + oy * D * 0.5;
      const along = (fx * ax + fy * ay) / stretch;
      const across = fy * ax - fx * ay;
      const f2 = (along * along + across * across) / r2;
      elev[i] = NOISE_WEIGHT * noise + FALLOFF_WEIGHT * (1 - f2);
    }
  }
  let [min, max] = range(elev);
  const wantLand = Math.floor(discArea * LAND_SHARE);
  addCoastDetail(
    elev,
    D,
    D,
    percentile(elev, n - wantLand, min, max),
    0.08 * (max - min),
    s,
    D / 10,
  );
  [min, max] = range(elev);
  const sea = percentile(elev, n - wantLand, min, max);

  // ---- land mask: new land only on water, only inside the disc.
  const type = new Uint8Array(n); // 1 = raised
  for (let i = 0; i < n; i++) {
    const t = world[i];
    if (
      inDisc[i] &&
      elev[i] >= sea &&
      t !== -1 &&
      map.isWater(t) &&
      !map.isImpassable(t)
    ) {
      type[i] = 1;
    }
  }
  pruneStrands(type, world, D, mg);
  keepLandmass(type, world, D, mg, s);
  fillLakes(type, world, D, mg);

  // ---- elevation: low coast, hills inland, a ridged mountain spine.
  const tiles: TileRef[] = [];
  const magnitudes: number[] = [];
  for (let i = 0; i < n; i++) {
    if (type[i] !== 1) continue;
    const inland = clamp01((elev[i] - sea) / (max - sea || 1));
    const ridge = 1 - Math.abs(2 * ridgeNoise(i % D, Math.floor(i / D)) - 1);
    let mag: number;
    if (inland > 0.7 && ridge > 0.93) {
      mag = 20 + Math.min(6, Math.floor((ridge - 0.93) * 80));
    } else if (inland > 0.5 && ridge > 0.7) {
      mag = 10 + Math.min(9, Math.floor((ridge - 0.7) * 40));
    } else {
      mag = Math.min(9, Math.floor(inland * 13));
    }
    tiles.push(world[i]);
    magnitudes.push(mag);
  }
  return { tiles, magnitudes };
}

function range(v: Float32Array): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const e of v) {
    if (e < min) min = e;
    if (e > max) max = e;
  }
  return [min, max];
}

/** Drops 1-tile-wide strands: tiles with under 2 land neighbours, twice. */
function pruneStrands(
  type: Uint8Array,
  world: Int32Array,
  D: number,
  mg: Game,
): void {
  const land = (i: number, x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= D || y >= D) return 0;
    const j = y * D + x;
    return type[j] === 1 || (world[j] !== -1 && mg.isLand(world[j])) ? 1 : 0;
  };
  for (let pass = 0; pass < 2; pass++) {
    const drop: number[] = [];
    for (let i = 0; i < type.length; i++) {
      if (type[i] !== 1) continue;
      const x = i % D;
      const y = (i - x) / D;
      const nbrs =
        land(i, x - 1, y) +
        land(i, x + 1, y) +
        land(i, x, y - 1) +
        land(i, x, y + 1);
      if (nbrs < 2) drop.push(i);
    }
    for (const i of drop) type[i] = 0;
  }
}

function touchesOldLand(
  i: number,
  world: Int32Array,
  D: number,
  mg: Game,
): boolean {
  const t = world[i];
  return (
    t !== -1 &&
    mg
      .map()
      .neighbors(t)
      .some((nb) => mg.isLand(nb))
  );
}

/**
 * Keeps the main landmass, pieces that join the existing coast (bar specks),
 * and up to MAX_ISLETS offshore islets (see MIN_ISLET for small ones).
 */
function keepLandmass(
  type: Uint8Array,
  world: Int32Array,
  D: number,
  mg: Game,
  seed: number,
): void {
  const { label, sizes } = components(
    { width: D, height: D, type, mag: type },
    1,
  );
  if (sizes.length === 0) return;
  const coastal = new Uint8Array(sizes.length);
  const first = new Int32Array(sizes.length).fill(-1);
  for (let i = 0; i < type.length; i++) {
    if (type[i] !== 1) continue;
    if (first[label[i]] === -1) first[label[i]] = world[i];
    if (touchesOldLand(i, world, D, mg)) coastal[label[i]] = 1;
  }
  const order = sizes.map((_, id) => id).sort((a, b) => sizes[b] - sizes[a]);
  const main = order[0];
  const minIsland = minIslandSize(mg.width(), mg.height());
  const keep = new Uint8Array(sizes.length);
  let smallIslets = 0;
  // Generated-map island rule for a piece standing alone in the sea.
  const islandOk = (id: number): boolean => {
    if (sizes[id] >= minIsland) return true;
    if (sizes[id] < MIN_ISLET || smallIslets >= MAX_SMALL_ISLETS) return false;
    if (hash(first[id], 0, seed) % SMALL_ISLET_ODDS !== 0) return false;
    smallIslets++;
    return true;
  };
  keep[main] = coastal[main] || islandOk(main) ? 1 : 0;
  let islets = 0;
  for (const id of order) {
    if (id === main || sizes[id] < MIN_SPECK) continue;
    if (coastal[id]) {
      keep[id] = 1;
    } else if (
      islets < MAX_ISLETS &&
      sizes[id] * ISLET_MAX_SHARE <= sizes[main] &&
      islandOk(id)
    ) {
      keep[id] = 1;
      islets++;
    }
  }
  for (let i = 0; i < type.length; i++) {
    if (type[i] === 1 && !keep[label[i]]) type[i] = 0;
  }
}

/** Fills small water pockets enclosed by land (old or new) inside the box. */
function fillLakes(
  type: Uint8Array,
  world: Int32Array,
  D: number,
  mg: Game,
): void {
  // 1 = water (not land, on the map) for the component pass.
  const water = new Uint8Array(type.length);
  for (let i = 0; i < type.length; i++) {
    const t = world[i];
    water[i] = type[i] === 0 && t !== -1 && mg.isWater(t) ? 1 : 0;
  }
  const { label, sizes } = components(
    { width: D, height: D, type: water, mag: water },
    1,
  );
  const open = new Uint8Array(sizes.length);
  // Only pockets the new land helped enclose; old lakes stay.
  const nearNew = new Uint8Array(sizes.length);
  for (let i = 0; i < water.length; i++) {
    if (!water[i]) continue;
    const x = i % D;
    const y = Math.floor(i / D);
    if (x === 0 || y === 0 || x === D - 1 || y === D - 1) {
      open[label[i]] = 1;
    } else if (
      type[i - 1] === 1 ||
      type[i + 1] === 1 ||
      type[i - D] === 1 ||
      type[i + D] === 1
    ) {
      nearNew[label[i]] = 1;
    }
  }
  for (let i = 0; i < water.length; i++) {
    const id = label[i];
    if (
      water[i] &&
      !open[id] &&
      nearNew[id] &&
      sizes[id] < MIN_LAKE &&
      !mg.isImpassable(world[i])
    ) {
      type[i] = 1;
    }
  }
}
