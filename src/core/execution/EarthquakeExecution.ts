import { z } from "zod";
import { Execution, Game, MessageType, Player, UnitType } from "../game/Game";
import { TileRef } from "../game/GameMap";
import { PseudoRandom } from "../PseudoRandom";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type { ExecRecord, SnapshotReader } from "../snapshot/SnapshotContext";
import { zInt } from "../snapshot/SnapshotType";
import { FlatBinaryHeap } from "./utils/FlatBinaryHeap";

/**
 * "The earth shifts" (GameConfig.earthquakes, off by default). Every 2-4
 * minutes of play an earthquake strikes:
 *  1. Drowning: an irregular, noise-shaped patch of coastal land sinks into
 *     the sea. Owners lose those tiles; units and structures on them are
 *     destroyed. The tiles go through the water-nuke land→water path.
 *  2. Uplift: elsewhere a patch of similar size rises as unowned land — a new
 *     island in open ocean, or (EXTEND_COAST_PERCENT of the time) an existing
 *     coastline pushed outward. Ships caught where land rises are wrecked
 *     (deleted); moving ships re-path because their path finders key on the
 *     map's waterVersion. Enclosed ocean is filled in, so risen land never
 *     leaves a lagoon wrongly flagged as ocean.
 *
 * Deterministic: each quake draws from a PseudoRandom seeded by (game seed,
 * quake number), so only two integers of state survive between quakes. The
 * patch shapes come from integer value noise; no float math.
 */

const TICKS_PER_MINUTE = 600;
export const EARTHQUAKE_MIN_TICKS = 2 * TICKS_PER_MINUTE;
export const EARTHQUAKE_MAX_TICKS = 4 * TICKS_PER_MINUTE;
// Patch size: 0.1-0.3% of the map's land, clamped to keep the burst small.
const PATCH_MIN_PERMYRIAD = 10;
const PATCH_MAX_PERMYRIAD = 30;
// Raised land is never a tiny speck (see minIslandSize).
const PATCH_MIN_TILES = 150;
const PATCH_MAX_TILES = 4000;
const EXTEND_COAST_PERCENT = 30;
// New islands keep this much open water to existing land.
const ISLAND_LAND_CLEARANCE = 3;
const SITE_ATTEMPTS = 4000;

const AIRBORNE = new Set<UnitType>([
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRV,
  UnitType.MIRVWarhead,
  UnitType.SAMMissile,
]);

export interface EarthquakeResult {
  sunk: TileRef[];
  raised: TileRef[];
  /** Player that lost the most land, if anyone did. */
  victim: Player | null;
}

export class EarthquakeExecution implements Execution {
  private mg: Game | null = null;
  private quakes = 0;
  private nextQuakeTick = 0;

  constructor(private seed: number) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.nextQuakeTick = ticks + this.interval();
  }

  tick(ticks: number): void {
    if (this.mg === null || ticks < this.nextQuakeTick) return;
    this.quake();
    this.nextQuakeTick = ticks + this.interval();
  }

  /** Strikes now. Public for tests. */
  quake(): EarthquakeResult {
    const mg = this.mg!;
    const rand = new PseudoRandom(
      this.seed ^ Math.imul(this.quakes + 1, 0x9e3779b1),
    );
    this.quakes++;
    const result = strike(mg, rand);
    if (result.sunk.length > 0 || result.raised.length > 0) {
      const victim = result.victim;
      mg.displayMessage(
        victim !== null
          ? "events_display.earthquake_near"
          : "events_display.earthquake",
        MessageType.NUKE_DETONATED,
        null,
        undefined,
        victim !== null ? { name: victim.displayName() } : undefined,
        undefined,
        victim?.id(),
      );
    }
    return result;
  }

  private interval(): number {
    const rand = new PseudoRandom(
      this.seed ^ Math.imul(this.quakes + 1, 0x85ebca6b),
    );
    return rand.nextInt(EARTHQUAKE_MIN_TICKS, EARTHQUAKE_MAX_TICKS + 1);
  }

  isActive(): boolean {
    return true;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(): ExecRecord {
    return EarthquakeExecutionSnapshot.write({
      seed: this.seed,
      initialized: this.mg !== null,
      quakes: this.quakes,
      nextQuakeTick: this.nextQuakeTick,
    });
  }

  restoreSnapshot(s: EarthquakeState, r: SnapshotReader): void {
    this.seed = s.seed;
    this.mg = s.initialized ? r.game : null;
    this.quakes = s.quakes;
    this.nextQuakeTick = s.nextQuakeTick;
  }
}

/** One earthquake: sink a coastal patch, then raise a patch elsewhere. */
export function strike(mg: Game, rand: PseudoRandom): EarthquakeResult {
  const map = mg.map();
  const permyriad = rand.nextInt(PATCH_MIN_PERMYRIAD, PATCH_MAX_PERMYRIAD + 1);
  const size = Math.min(
    PATCH_MAX_TILES,
    Math.max(
      PATCH_MIN_TILES,
      Math.floor((map.numLandTiles() * permyriad) / 10000),
    ),
  );
  const radius = Math.max(3, Math.floor(Math.sqrt(size / 3)));
  const noiseSeed = rand.nextInt(0, 0x7fffffff);

  // ── Drowning ──
  let sunk: TileRef[] = [];
  const shore = findSite(mg, rand, (t) => isSinkableShore(mg, t));
  if (shore !== null) {
    sunk = growPatch(
      mg,
      shore,
      size,
      radius,
      noiseSeed,
      (t) => map.isLand(t) && !map.isImpassable(t),
    );
  }
  const lost = new Map<Player, number>();
  for (const t of sunk) {
    const owner = mg.owner(t);
    if (owner.isPlayer()) lost.set(owner, (lost.get(owner) ?? 0) + 1);
  }
  deleteUnitsOn(mg, new Set(sunk));
  for (const t of sunk) mg.sinkLand(t);
  let victim: Player | null = null;
  for (const [p, n] of lost) {
    if (victim === null || n > lost.get(victim)!) victim = p;
  }

  // ── Uplift ──
  const sunkSet = new Set(sunk);
  const extend = rand.nextInt(0, 100) < EXTEND_COAST_PERCENT;
  let raised: TileRef[] = [];
  if (extend) {
    const coast = findSite(
      mg,
      rand,
      (t) => isOpenWater(mg, t, 2, 0) && touchesLand(mg, t, sunkSet),
    );
    if (coast !== null) {
      // May close a strait; WaterManager relabels water bodies for that.
      raised = growPatch(mg, coast, size, radius, noiseSeed + 1, (t) =>
        isOpenWater(mg, t, 2, 0),
      );
    }
  }
  if (raised.length === 0) {
    const margin = radius * 2 + ISLAND_LAND_CLEARANCE;
    const centre = findSite(
      mg,
      rand,
      (t) =>
        isOpenWater(mg, t, margin, ISLAND_LAND_CLEARANCE) &&
        map.magnitude(t) * 2 >= Math.min(margin, 60),
    );
    if (centre !== null) {
      raised = growPatch(mg, centre, size, radius, noiseSeed + 2, (t) =>
        isOpenWater(mg, t, ISLAND_LAND_CLEARANCE + 2, ISLAND_LAND_CLEARANCE),
      );
    }
  }
  if (raised.length > 0) {
    raised = fillEnclosedOcean(mg, raised);
    deleteUnitsOn(mg, new Set(raised));
    mg.raiseLand(raised, elevations(mg, raised, radius, noiseSeed));
  }
  return { sunk, raised, victim };
}

function isSinkableShore(mg: Game, t: TileRef): boolean {
  const map = mg.map();
  return map.isShore(t) && !map.isImpassable(t) && map.isOceanShore(t);
}

/**
 * Ocean water at least `edgeMargin` tiles from the map edge with no land
 * (passable or not) within `clearance` tiles (Chebyshev).
 */
function isOpenWater(
  mg: Game,
  t: TileRef,
  edgeMargin: number,
  clearance: number,
): boolean {
  const map = mg.map();
  if (!map.isWater(t) || !map.isOcean(t)) return false;
  const x = map.x(t);
  const y = map.y(t);
  edgeMargin = Math.max(edgeMargin, clearance); // keeps the scan on the map
  if (
    x < edgeMargin ||
    y < edgeMargin ||
    x >= map.width() - edgeMargin ||
    y >= map.height() - edgeMargin
  ) {
    return false;
  }
  // Magnitude is ceil(coast distance / 2): deep water is clear without a scan.
  if (map.magnitude(t) * 2 > clearance * 2 + 1) return true;
  for (let dy = -clearance; dy <= clearance; dy++) {
    for (let dx = -clearance; dx <= clearance; dx++) {
      if (map.isLand(map.ref(x + dx, y + dy))) return false;
    }
  }
  return true;
}

/** Water touching passable land that is not about to sink. */
function touchesLand(mg: Game, t: TileRef, sinking: Set<TileRef>): boolean {
  const map = mg.map();
  for (const n of map.neighbors(t)) {
    if (map.isLand(n) && !map.isImpassable(n) && !sinking.has(n)) return true;
  }
  return false;
}

function findSite(
  mg: Game,
  rand: PseudoRandom,
  ok: (t: TileRef) => boolean,
): TileRef | null {
  const total = mg.width() * mg.height();
  for (let i = 0; i < SITE_ATTEMPTS; i++) {
    const t = rand.nextInt(0, total);
    if (ok(t)) return t;
  }
  return null;
}

/** Integer value noise in [0, 192), smooth over `cell` tiles. */
function valueNoise(x: number, y: number, cell: number, seed: number): number {
  const gx = Math.floor(x / cell);
  const gy = Math.floor(y / cell);
  const fx = x - gx * cell;
  const fy = y - gy * cell;
  const h = (ix: number, iy: number): number => {
    let v = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ seed;
    v = Math.imul(v ^ (v >>> 15), 0x85ebca6b);
    v ^= v >>> 13;
    return (v >>> 0) % 192;
  };
  const top = h(gx, gy) * (cell - fx) + h(gx + 1, gy) * fx;
  const bottom = h(gx, gy + 1) * (cell - fx) + h(gx + 1, gy + 1) * fx;
  return Math.floor((top * (cell - fy) + bottom * fy) / (cell * cell));
}

/** Two octaves of value noise scaled to a patch of `radius`; [0, 192). */
function shapeNoise(x: number, y: number, radius: number, seed: number) {
  const coarse = valueNoise(x, y, Math.max(3, radius >> 1), seed);
  const fine = valueNoise(x, y, Math.max(2, radius >> 2), seed ^ 0x5bd1e995);
  return Math.floor((coarse * 2 + fine) / 3);
}

/**
 * Best-first growth from `start` through accepted tiles, ordered by squared
 * distance scaled by smooth noise: the reach varies by direction, giving a
 * lobed, irregular blob instead of a disc.
 */
function growPatch(
  mg: Game,
  start: TileRef,
  size: number,
  radius: number,
  noiseSeed: number,
  accept: (t: TileRef) => boolean,
): TileRef[] {
  const map = mg.map();
  const sx = map.x(start);
  const sy = map.y(start);
  const heap = new FlatBinaryHeap();
  const seen = new Set<TileRef>([start]);
  const out: TileRef[] = [];
  heap.enqueue(start, 0);
  while (heap.size() > 0 && out.length < size) {
    const t = heap.dequeue();
    out.push(t);
    for (const n of map.neighbors(t)) {
      if (seen.has(n)) continue;
      seen.add(n);
      if (!accept(n)) continue;
      const dx = map.x(n) - sx;
      const dy = map.y(n) - sy;
      const noise = shapeNoise(map.x(n), map.y(n), radius, noiseSeed);
      // Reach in a direction scales with 1/sqrt(24 + noise): up to ~3x.
      heap.enqueue(n, (dx * dx + dy * dy) * (24 + noise));
    }
  }
  return out;
}

/**
 * Adds ocean tiles the patch would wall off (within its bounding box) so
 * no lagoon keeps an ocean bit it no longer deserves.
 */
function fillEnclosedOcean(mg: Game, patch: TileRef[]): TileRef[] {
  const map = mg.map();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of patch) {
    minX = Math.min(minX, map.x(t));
    maxX = Math.max(maxX, map.x(t));
    minY = Math.min(minY, map.y(t));
    maxY = Math.max(maxY, map.y(t));
  }
  minX = Math.max(0, minX - 1);
  minY = Math.max(0, minY - 1);
  maxX = Math.min(map.width() - 1, maxX + 1);
  maxY = Math.min(map.height() - 1, maxY + 1);
  const inPatch = new Set(patch);
  const reached = new Set<TileRef>();
  const queue: TileRef[] = [];
  const open = (t: TileRef) =>
    map.isWater(t) && !inPatch.has(t) && !reached.has(t);
  for (let x = minX; x <= maxX; x++) {
    for (const y of [minY, maxY]) {
      const t = map.ref(x, y);
      if (open(t)) {
        reached.add(t);
        queue.push(t);
      }
    }
  }
  for (let y = minY; y <= maxY; y++) {
    for (const x of [minX, maxX]) {
      const t = map.ref(x, y);
      if (open(t)) {
        reached.add(t);
        queue.push(t);
      }
    }
  }
  for (let head = 0; head < queue.length; head++) {
    for (const n of map.neighbors(queue[head])) {
      const x = map.x(n);
      const y = map.y(n);
      if (x < minX || x > maxX || y < minY || y > maxY || !open(n)) continue;
      reached.add(n);
      queue.push(n);
    }
  }
  const out = [...patch];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const t = map.ref(x, y);
      if (
        map.isOcean(t) &&
        map.isWater(t) &&
        !inPatch.has(t) &&
        !reached.has(t)
      ) {
        out.push(t);
      }
    }
  }
  return out;
}

/**
 * Low at the new coast, climbing 2 per tile inland to a noisy ceiling of
 * 4-17: plains with the odd highland hill.
 */
function elevations(
  mg: Game,
  patch: TileRef[],
  radius: number,
  noiseSeed: number,
): number[] {
  const map = mg.map();
  const inPatch = new Set(patch);
  const dist = new Map<TileRef, number>();
  const queue: TileRef[] = [];
  for (const t of patch) {
    if (map.neighbors(t).some((n) => !inPatch.has(n) && map.isWater(n))) {
      dist.set(t, 0);
      queue.push(t);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const t = queue[head];
    for (const n of map.neighbors(t)) {
      if (inPatch.has(n) && !dist.has(n)) {
        dist.set(n, dist.get(t)! + 1);
        queue.push(n);
      }
    }
  }
  return patch.map((t) => {
    const ceiling =
      4 +
      Math.floor(
        (shapeNoise(map.x(t), map.y(t), radius, ~noiseSeed) * 14) / 192,
      );
    return Math.min(ceiling, 2 + 2 * (dist.get(t) ?? 0));
  });
}

function deleteUnitsOn(mg: Game, tiles: Set<TileRef>): void {
  if (tiles.size === 0) return;
  for (const unit of mg.units()) {
    if (
      unit.isActive() &&
      !AIRBORNE.has(unit.type()) &&
      tiles.has(unit.tile())
    ) {
      unit.delete(true);
    }
  }
}

const EarthquakeStateSchema = z.object({
  seed: zInt(),
  initialized: z.boolean(),
  quakes: zInt(),
  nextQuakeTick: zInt(),
});
type EarthquakeState = z.infer<typeof EarthquakeStateSchema>;

export const EarthquakeExecutionSnapshot = execSnapshotType({
  name: "Earthquake",
  version: 1,
  schema: EarthquakeStateSchema,
  cls: () => EarthquakeExecution,
});
