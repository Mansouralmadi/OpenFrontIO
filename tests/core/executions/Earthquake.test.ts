import {
  EARTHQUAKE_MAX_TICKS,
  EarthquakeExecution,
  strike,
} from "../../../src/core/execution/EarthquakeExecution";
import {
  Game,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../../src/core/game/Game";
import { GameMap, TileRef } from "../../../src/core/game/GameMap";
import { GameUpdateType } from "../../../src/core/game/GameUpdates";
import { ConnectedComponents } from "../../../src/core/pathfinding/algorithms/ConnectedComponents";
import { PathFinding } from "../../../src/core/pathfinding/PathFinder";
import { PseudoRandom } from "../../../src/core/PseudoRandom";
import { GameConfig } from "../../../src/core/Schemas";
import { decodeSnapshotValue } from "../../../src/core/snapshot/SnapshotCodec";
import {
  createScriptedRunner,
  scriptedGameStart,
} from "../../util/ScriptedGame";
import { setup } from "../../util/Setup";
import { expectSnapshotRoundTrip } from "../../util/Snapshot";

const MAP = "world";
const info = new PlayerInfo("quaker", PlayerType.Human, null, "quaker");

function newGame(config: Partial<GameConfig> = {}): Promise<Game> {
  return setup(MAP, { earthquakes: true, ...config }, [info]);
}

/** Tiles within `r` (Chebyshev) of any of `tiles`. */
function around(map: GameMap, tiles: TileRef[], r: number): Set<TileRef> {
  const out = new Set<TileRef>();
  for (const t of tiles) {
    const x = map.x(t);
    const y = map.y(t);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (map.isValidCoord(x + dx, y + dy)) out.add(map.ref(x + dx, y + dy));
      }
    }
  }
  return out;
}

function expectShorelinesConsistent(map: GameMap, tiles: Set<TileRef>) {
  for (const t of tiles) {
    if (map.isImpassable(t)) continue;
    const shore = map
      .neighbors(t)
      .some((n) => !map.isImpassable(n) && map.isLand(n) !== map.isLand(t));
    expect(map.isShoreline(t), `shoreline at ${map.x(t)},${map.y(t)}`).toBe(
      shore,
    );
  }
}

/** ceil(BFS distance from the nearest coast / 2) for every water tile. */
function oracleMagnitudes(map: GameMap): Int32Array {
  const n = map.width() * map.height();
  const dist = new Int32Array(n).fill(-1);
  const queue: number[] = [];
  for (let t = 0; t < n; t++) {
    if (map.isWater(t) && map.neighbors(t).some((m) => map.isLand(m))) {
      dist[t] = 0;
      queue.push(t);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const t = queue[head];
    for (const m of map.neighbors(t)) {
      if (map.isWater(m) && dist[m] < 0) {
        dist[m] = dist[t] + 1;
        queue.push(m);
      }
    }
  }
  return dist.map((d) => (d < 0 ? 31 : Math.min(Math.ceil(d / 2), 31)));
}

function tickUntilWaterGraphRebuild(game: Game): void {
  const v = game.waterGraphVersion();
  for (let i = 0; i < 40 && game.waterGraphVersion() === v; i++) {
    game.executeNextTick();
  }
}

describe("Earthquakes", () => {
  test("off by default", async () => {
    const game = await setup(MAP);
    expect(game.config().earthquakes()).toBe(false);
  });

  test("GameRunner only schedules earthquakes when the option is on", async () => {
    const types = async (earthquakes: boolean) => {
      const runner = await createScriptedRunner(
        MAP,
        scriptedGameStart({ earthquakes }),
      );
      const root = decodeSnapshotValue(runner.snapshot()) as {
        execs: { t: string }[];
      };
      return root.execs.map((e) => e.t);
    };
    expect(await types(false)).not.toContain("Earthquake");
    expect(await types(true)).toContain("Earthquake");
  }, 60_000);

  test("sinks a coastal patch and raises unowned land", async () => {
    const game = await newGame();
    const map = game.map();
    const landBefore = game.numLandTiles();
    const { sunk, raised } = strike(game, new PseudoRandom(1));
    game.executeNextTick(); // sinking is flushed with the water nukes

    // ~0.1-0.3% of the 651k land tiles each (less when a small island
    // sinks whole).
    expect(sunk.length).toBeGreaterThan(0);
    expect(sunk.length).toBeLessThanOrEqual(2000);
    expect(raised.length).toBeGreaterThan(600);
    expect(raised.length).toBeLessThanOrEqual(2600);
    for (const t of sunk) expect(map.isWater(t)).toBe(true);
    for (const t of raised) {
      expect(map.isLand(t)).toBe(true);
      expect(game.hasOwner(t)).toBe(false);
      expect(map.isImpassable(t)).toBe(false);
    }
    expect(game.numLandTiles()).toBe(landBefore - sunk.length + raised.length);
    expect(new Set([...sunk, ...raised]).size).toBe(
      sunk.length + raised.length,
    );

    const near = around(map, [...sunk, ...raised], 2);
    expectShorelinesConsistent(map, near);
    const oracle = oracleMagnitudes(map);
    for (const t of around(map, [...sunk, ...raised], 8)) {
      if (map.isWater(t))
        expect(map.magnitude(t), `mag at ${t}`).toBe(oracle[t]);
    }

    // Minimap: land only where all four source tiles are land.
    const mini = game.miniMap();
    for (const t of raised) {
      const mx = Math.floor(map.x(t) / 2);
      const my = Math.floor(map.y(t) / 2);
      const allLand = [0, 1].every((dy) =>
        [0, 1].every((dx) => map.isLand(map.ref(mx * 2 + dx, my * 2 + dy))),
      );
      if (allLand) expect(mini.isLand(mini.ref(mx, my))).toBe(true);
    }
  });

  test("owners lose drowned land and the units on it", async () => {
    // Same terrain + same seed picks the same patches, so a dry run tells
    // us which tiles to own beforehand.
    const dry = await newGame();
    const { sunk: expected } = strike(dry, new PseudoRandom(5));

    const game = await newGame();
    const player = game.player(info.id);
    for (const t of expected) player.conquer(t);
    const city = player.buildUnit(UnitType.City, expected[0], {});
    const { sunk, victim } = strike(game, new PseudoRandom(5));
    game.executeNextTick();

    expect(sunk).toEqual(expected);
    expect(victim).toBe(player);
    expect(player.numTilesOwned()).toBe(0);
    expect(city.isActive()).toBe(false);
    for (const t of sunk) expect(game.map().isWater(t)).toBe(true);
  });

  test("sometimes pushes an existing coastline outward instead", async () => {
    let extended = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const game = await newGame();
      const map = game.map();
      const { raised } = strike(game, new PseudoRandom(seed));
      const inRaised = new Set(raised);
      const touchesOldLand = raised.some((t) =>
        map.neighbors(t).some((n) => map.isLand(n) && !inRaised.has(n)),
      );
      if (!touchesOldLand) continue;
      extended++;
      game.executeNextTick();
      expectShorelinesConsistent(map, around(map, raised, 2));
      // No ocean left walled off inside the new land's bounding box.
      for (const t of around(map, raised, 1)) {
        if (map.isWater(t) && map.isOcean(t)) {
          expect(map.neighbors(t).every((n) => inRaised.has(n))).toBe(false);
        }
      }
    }
    expect(extended).toBeGreaterThan(0);
  }, 60_000);

  test("deterministic for the same seed", async () => {
    const a = strike(await newGame(), new PseudoRandom(77));
    const b = strike(await newGame(), new PseudoRandom(77));
    expect(a.sunk).toEqual(b.sunk);
    expect(a.raised).toEqual(b.raised);
    const c = strike(await newGame(), new PseudoRandom(78));
    expect(c.sunk).not.toEqual(a.sunk);
  });

  test("strikes on schedule and announces itself to everyone", async () => {
    const game = await newGame();
    game.addExecution(new EarthquakeExecution(1234));
    const land: number[] = [];
    let messages = 0;
    for (let i = 0; i <= EARTHQUAKE_MAX_TICKS + 1; i++) {
      const updates = game.executeNextTick();
      for (const u of updates[GameUpdateType.DisplayEvent]) {
        if (u.message.startsWith("events_display.earthquake")) {
          expect(u.playerID).toBeNull();
          messages++;
        }
      }
      land.push(game.numLandTiles());
    }
    expect(messages).toBe(1);
    // Nothing happens before the minimum interval.
    expect(new Set(land.slice(0, 1199)).size).toBe(1);
  }, 60_000);

  test("water components and boat paths follow the new terrain", async () => {
    const game = await newGame({ disableNavMesh: false });
    const map = game.map();
    const mini = game.miniMap();
    const { sunk, raised } = strike(game, new PseudoRandom(3));
    tickUntilWaterGraphRebuild(game);

    // Live labeling partitions minimap water exactly like a fresh labeling.
    const fresh = new ConnectedComponents(mini);
    fresh.initialize();
    const liveToFresh = new Map<number, number>();
    const freshToLive = new Map<number, number>();
    for (let t = 0; t < mini.width() * mini.height(); t++) {
      if (!mini.isWater(t)) continue;
      const live = game.miniWaterGraph()!.getComponentId(t);
      const f = fresh.getComponentId(t);
      expect(liveToFresh.get(live) ?? f).toBe(f);
      expect(freshToLive.get(f) ?? live).toBe(live);
      liveToFresh.set(live, f);
      freshToLive.set(f, live);
    }

    // Boats sail around the new land, never through it.
    const xs = raised.map((t) => map.x(t));
    const ys = raised.map((t) => map.y(t));
    const cy = Math.floor((Math.min(...ys) + Math.max(...ys)) / 2);
    const findWater = (x: number, step: number): TileRef => {
      while (!map.isOcean(map.ref(x, cy))) x += step;
      return map.ref(x, cy);
    };
    const west = findWater(Math.min(...xs) - 4, -1);
    const east = findWater(Math.max(...xs) + 4, 1);
    const path = PathFinding.Water(game).findPath(west, east);
    expect(path).not.toBeNull();
    for (const t of path!) expect(map.isWater(t)).toBe(true);

    // Boats can sail into the new bay.
    const bay = sunk[sunk.length - 1];
    const toBay = PathFinding.Water(game).findPath(west, bay);
    expect(toBay).not.toBeNull();
  }, 60_000);

  test("snapshot round trip after an earthquake", async () => {
    const game = await newGame();
    const exec = new EarthquakeExecution(99);
    game.addExecution(exec);
    game.executeNextTick();
    const { sunk, raised } = exec.quake();
    expect(sunk.length + raised.length).toBeGreaterThan(0);
    // Mid-tick (sinking still pending) and after it is flushed.
    await expectSnapshotRoundTrip(game, MAP, 10);
  }, 60_000);
});
