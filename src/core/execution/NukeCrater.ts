import type { NukeMagnitude } from "../configuration/Config";
import { atan2 } from "../DetMath";
import { Game } from "../game/Game";
import { TileRef } from "../game/GameMap";
import { PseudoRandom } from "../PseudoRandom";

// Water-nuke crater shape: a blast basin, not a disc.
//
// r(θ) = R · (1 + NOISE_AMPLITUDE · noise(θ)) + spurs, sampled at
// ANGLE_SAMPLES angles, then rescaled so ½∫r²dθ equals the area of the old
// crater (whose r² was uniform in [inner², outer²], i.e. mean r² =
// (inner² + outer²) / 2). noise(θ) is periodic value noise: OCTAVES lattice
// layers with smoothstep interpolation, normalised to [-1, 1]. Rim tiles get a
// hashed per-2x2-block jitter of ±(1 + RIM_JITTER·R) tiles so the shoreline is
// ragged; blocks (not single tiles) keep it from scattering lone pixels.
const ANGLE_SAMPLES = 128;
// [lattice cells around the circle, amplitude]
const OCTAVES: readonly (readonly [number, number])[] = [
  [5, 1],
  [11, 0.5],
  [23, 0.25],
];
const NOISE_AMPLITUDE = 0.32;
const MIN_SPURS = 2;
const MAX_SPURS = 4; // exclusive
const SPUR_HEIGHT_MIN = 0.2;
const SPUR_HEIGHT_MAX = 0.45;
const RIM_JITTER = 0.03;
// Below a mean radius of 6 tiles the crater stays a plain disc.
const SMALL_CRATER_R2 = 36;

function hash01(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Angular radius profile (tiles) of a water-nuke crater; deterministic in seed. */
export function craterRadii(
  magnitude: NukeMagnitude,
  seed: number,
): Float64Array {
  // Area of the old crater: r² was uniform in [inner², outer²].
  const meanR2 =
    (magnitude.inner * magnitude.inner + magnitude.outer * magnitude.outer) / 2;
  const r = new Float64Array(ANGLE_SAMPLES);
  if (meanR2 < SMALL_CRATER_R2) {
    // A few tiles across: noise would only punch holes, keep a disc.
    return r.fill(Math.sqrt(meanR2));
  }
  const rand = new PseudoRandom(seed);
  let ampSum = 0;
  for (const [cells, amp] of OCTAVES) {
    ampSum += amp;
    const lattice: number[] = [];
    for (let i = 0; i < cells; i++) lattice.push(rand.nextFloat(-1, 1));
    for (let i = 0; i < ANGLE_SAMPLES; i++) {
      const t = (i * cells) / ANGLE_SAMPLES;
      const i0 = Math.floor(t);
      const f = t - i0;
      const s = f * f * (3 - 2 * f);
      r[i] += amp * (lattice[i0] * (1 - s) + lattice[(i0 + 1) % cells] * s);
    }
  }
  for (let i = 0; i < ANGLE_SAMPLES; i++) {
    r[i] = 1 + (NOISE_AMPLITUDE * r[i]) / ampSum;
  }
  // Spurs: a few narrow triangular "fingers" where the blast ran further.
  const spurs = rand.nextInt(MIN_SPURS, MAX_SPURS);
  for (let s = 0; s < spurs; s++) {
    const at = rand.nextInt(0, ANGLE_SAMPLES);
    const halfWidth = rand.nextInt(2, 5);
    const height = rand.nextFloat(SPUR_HEIGHT_MIN, SPUR_HEIGHT_MAX);
    for (let d = -halfWidth; d <= halfWidth; d++) {
      const i = (at + d + ANGLE_SAMPLES) % ANGLE_SAMPLES;
      r[i] += height * (1 - Math.abs(d) / (halfWidth + 1));
    }
  }
  // Rescale so the polar area (½∫r²dθ) matches the old crater's.
  let sum = 0;
  for (let i = 0; i < ANGLE_SAMPLES; i++) sum += r[i] * r[i];
  const k = Math.sqrt((meanR2 * ANGLE_SAMPLES) / sum);
  for (let i = 0; i < ANGLE_SAMPLES; i++) r[i] *= k;
  return r;
}

/** Tiles flooded by a water nuke at `center` (impassable tiles excluded). */
export function waterCraterTiles(
  mg: Game,
  center: TileRef,
  magnitude: NukeMagnitude,
  seed: number,
): Set<TileRef> {
  const r = craterRadii(magnitude, seed);
  let rMin = Infinity;
  let rMax = 0;
  for (const v of r) {
    rMin = Math.min(rMin, v);
    rMax = Math.max(rMax, v);
  }
  const jitter =
    rMin === rMax
      ? 0
      : 1 + (RIM_JITTER * (magnitude.inner + magnitude.outer)) / 2;
  const inside2 = Math.max(0, rMin - jitter) ** 2;
  const bound = Math.ceil(rMax + jitter);
  const bound2 = bound * bound;

  const cx = mg.x(center);
  const cy = mg.y(center);
  const result = new Set<TileRef>();
  const x0 = Math.max(0, cx - bound);
  const y0 = Math.max(0, cy - bound);
  const x1 = Math.min(mg.width() - 1, cx + bound);
  const y1 = Math.min(mg.height() - 1, cy + bound);
  const scale = ANGLE_SAMPLES / (2 * Math.PI);
  for (let py = y0; py <= y1; py++) {
    const dy = py - cy;
    for (let px = x0; px <= x1; px++) {
      const dx = px - cx;
      const d2 = dx * dx + dy * dy;
      if (d2 > bound2) continue;
      if (d2 > inside2) {
        const t = (atan2(dy, dx) + Math.PI) * scale; // [0, ANGLE_SAMPLES]
        const i0 = Math.floor(t) % ANGLE_SAMPLES;
        const f = t - Math.floor(t);
        const edge =
          r[i0] * (1 - f) +
          r[(i0 + 1) % ANGLE_SAMPLES] * f +
          (hash01(px >> 1, py >> 1, seed) * 2 - 1) * jitter;
        if (edge <= 0 || d2 > edge * edge) continue;
      }
      const tile = mg.ref(px, py);
      if (mg.isImpassable(tile)) continue;
      result.add(tile);
    }
  }
  return result;
}
