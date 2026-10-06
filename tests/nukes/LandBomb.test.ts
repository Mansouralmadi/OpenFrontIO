import { Config, NukeMagnitude } from "../../src/core/configuration/Config";
import { ConstructionExecution } from "../../src/core/execution/ConstructionExecution";
import { landBombTerrain } from "../../src/core/execution/LandBombTerrain";
import { SAMMissileExecution } from "../../src/core/execution/SAMMissileExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  Unit,
  UnitType,
} from "../../src/core/game/Game";
import { GameMap, TileRef } from "../../src/core/game/GameMap";
import { GameUpdateType } from "../../src/core/game/GameUpdates";
import {
  MIN_ISLET,
  minIslandSize,
} from "../../src/core/game/RandomMapGenerator";
import { ConnectedComponents } from "../../src/core/pathfinding/algorithms/ConnectedComponents";
import { GameConfig } from "../../src/core/Schemas";
import { setup } from "../util/Setup";
import { expectSnapshotRoundTrip } from "../util/Snapshot";
import { TestConfig } from "../util/TestConfig";
import { executeTicks } from "../util/utils";

/** Real nuke magnitudes (TestConfig flattens them to 1) and fast flight. */
class RealMagnitudeConfig extends TestConfig {
  nukeMagnitudes(
    unitType: UnitType,
    map?: { width(): number; height(): number },
  ): NukeMagnitude {
    return Config.prototype.nukeMagnitudes.call(this, unitType, map);
  }
  nukeSpeed(): number {
    return 50;
  }
}

const A = new PlayerInfo("a", PlayerType.Human, null, "a");
const B = new PlayerInfo("b", PlayerType.Human, null, "b");
const R = 100; // hydrogen bomb outer radius
// Strait of Gibraltar on the World map (2000x1000).
const STRAIT_X = 905;
const STRAIT_Y = 285;

/** A tile with nothing but water within `r` (Chebyshev). */
function openOcean(game: Game, r: number): TileRef {
  for (let y = r; y < game.height() - r; y += 25) {
    for (let x = r; x < game.width() - r; x += 25) {
      let ok = true;
      for (let dy = -r; dy <= r && ok; dy += 1) {
        for (let dx = -r; dx <= r; dx++) {
          if (!game.isWater(game.ref(x + dx, y + dy))) {
            ok = false;
            break;
          }
        }
      }
      if (ok) return game.ref(x, y);
    }
  }
  throw new Error("no open ocean");
}

async function worldGame(cfg: Partial<GameConfig> = {}) {
  const game = await setup(
    "world",
    { instantBuild: true, infiniteGold: true, ...cfg },
    [A, B],
    undefined,
    RealMagnitudeConfig,
  );
  const a = game.player(A.id);
  const b = game.player(B.id);
  // A: a silo in Spain. B: a block of Morocco next to the strait.
  const silo = game.ref(908, 264);
  a.conquer(silo);
  a.buildUnit(UnitType.MissileSilo, silo, {});
  for (let y = 300; y < 340; y++) {
    for (let x = 880; x < 930; x++) {
      const t = game.ref(x, y);
      if (game.isLand(t) && !game.hasOwner(t)) b.conquer(t);
    }
  }
  return { game, a, b };
}

function launch(game: Game, a: Player, target: TileRef) {
  game.addExecution(new ConstructionExecution(a, UnitType.LandBomb, target));
}

function untilLanded(game: Game, a: Player): void {
  executeTicks(game, 2);
  for (let i = 0; i < 200 && a.units(UnitType.LandBomb).length > 0; i++) {
    game.executeNextTick();
  }
  expect(a.units(UnitType.LandBomb)).toHaveLength(0);
}

/** 4-neighbour components of `tiles`, largest first. */
function pieces(map: GameMap, tiles: TileRef[]): number[] {
  const set = new Set(tiles);
  const seen = new Set<TileRef>();
  const sizes: number[] = [];
  for (const start of tiles) {
    if (seen.has(start)) continue;
    seen.add(start);
    const queue = [start];
    for (let h = 0; h < queue.length; h++) {
      for (const n of map.neighbors(queue[h])) {
        if (set.has(n) && !seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    sizes.push(queue.length);
  }
  return sizes.sort((x, y) => y - x);
}

/** Tile edges between the set and the rest of the map. */
function perimeter(map: GameMap, tiles: TileRef[]): number {
  const set = new Set(tiles);
  let p = 0;
  for (const t of tiles) {
    p += 4 - map.neighbors(t).filter((n) => set.has(n)).length;
  }
  return p;
}

describe("Land bomb", () => {
  test("costs 2.5M (half a hydrogen bomb), sized like a hydrogen bomb", async () => {
    const game = await setup("plains", { infiniteGold: false }, [A]);
    const a = game.player(A.id);
    const cost = (t: UnitType) => game.unitInfo(t).cost(game, a);
    expect(cost(UnitType.LandBomb)).toBe(2_500_000n);
    expect(Config.prototype.nukeMagnitudes(UnitType.LandBomb)).toEqual(
      Config.prototype.nukeMagnitudes(UnitType.HydrogenBomb),
    );
  });

  test("cannot be built when disabled", async () => {
    const game = await setup(
      "plains",
      {
        infiniteGold: true,
        instantBuild: true,
        disabledUnits: [UnitType.LandBomb],
      },
      [A, B],
    );
    const a = game.player(A.id);
    a.conquer(game.ref(1, 1));
    a.buildUnit(UnitType.MissileSilo, game.ref(1, 1), {});
    expect(a.canBuild(UnitType.LandBomb, game.ref(50, 50))).toBe(false);
    expect(a.canBuild(UnitType.HydrogenBomb, game.ref(50, 50))).not.toBe(false);
    launch(game, a, game.ref(50, 50));
    executeTicks(game, 5);
    expect(a.units(UnitType.LandBomb)).toHaveLength(0);
  });

  test("open ocean: one natural landmass inside the radius", async () => {
    const game = await setup("world");
    const map = game.map();
    const center = openOcean(game, R + 5);
    // A digital disc has perimeter/sqrt(area) = 8/sqrt(pi) ~ 4.5.
    const DISC_RATIO = 8 / Math.sqrt(Math.PI);
    for (let seed = 1; seed <= 6; seed++) {
      const { tiles, magnitudes } = landBombTerrain(game, center, R, seed);
      expect(tiles.length).toBeGreaterThan(3000);
      for (const t of tiles) {
        expect(map.isWater(t)).toBe(true);
        expect(game.euclideanDistSquared(t, center)).toBeLessThanOrEqual(R * R);
      }
      // A main landmass plus at most three islets, none tiny: every
      // separate piece is at least the generated-map minimum island size.
      const sizes = pieces(map, tiles);
      expect(sizes.length).toBeLessThanOrEqual(4);
      expect(sizes[0]).toBeGreaterThan(tiles.length * 0.7);
      // Islets of 50+ tiles; at most one under the always-kept size.
      for (const s of sizes) expect(s).toBeGreaterThanOrEqual(MIN_ISLET);
      expect(sizes.filter((s) => s < 250).length).toBeLessThanOrEqual(1);
      // Ragged coast: well above a disc's perimeter for its area.
      const ratio = perimeter(map, tiles) / Math.sqrt(tiles.length);
      expect(ratio, `seed ${seed}`).toBeGreaterThan(DISC_RATIO * 1.5);
      // Mostly plains, some hills, all passable.
      const plains = magnitudes.filter((m) => m < 10).length;
      expect(plains).toBeGreaterThan(tiles.length * 0.6);
      expect(magnitudes.some((m) => m >= 10)).toBe(true);
      expect(Math.max(...magnitudes)).toBeLessThan(31);
    }
  });

  test("near a coast: no tiny islands, only coast-joined pieces", async () => {
    const game = await setup("world");
    const map = game.map();
    for (const [x, y] of [
      [STRAIT_X, STRAIT_Y],
      [700, 450],
      [1250, 380],
    ]) {
      for (let seed = 1; seed <= 4; seed++) {
        const { tiles } = landBombTerrain(game, game.ref(x, y), R, seed);
        const set = new Set(tiles);
        const seen = new Set<TileRef>();
        let small = 0;
        for (const start of tiles) {
          if (seen.has(start)) continue;
          seen.add(start);
          const piece = [start];
          let coastal = false;
          for (let h = 0; h < piece.length; h++) {
            for (const n of map.neighbors(piece[h])) {
              if (map.isLand(n)) coastal = true;
              if (set.has(n) && !seen.has(n)) {
                seen.add(n);
                piece.push(n);
              }
            }
          }
          if (!coastal) {
            const msg = `${x},${y} seed ${seed}`;
            expect(piece.length, msg).toBeGreaterThanOrEqual(MIN_ISLET);
            if (piece.length < minIslandSize(game.width(), game.height())) {
              small++;
            }
          }
        }
        // At most one small (50 .. minIslandSize) islet per bomb.
        expect(small).toBeLessThanOrEqual(1);
      }
    }
  });

  test("minimum island size follows the generated-map rule", () => {
    expect(minIslandSize(2000, 1000)).toBe(250);
    expect(minIslandSize(200, 200)).toBe(150);
  });

  test("deterministic in the seed", async () => {
    const game = await setup("world");
    const center = openOcean(game, R + 5);
    const a = landBombTerrain(game, center, R, 42);
    expect(landBombTerrain(game, center, R, 42)).toEqual(a);
    expect(landBombTerrain(game, center, R, 43).tiles).not.toEqual(a.tiles);
  });

  test("bridges the strait: raises unowned land, wrecks ships on it", async () => {
    const { game, a, b } = await worldGame();
    const map = game.map();
    const target = game.ref(STRAIT_X, STRAIT_Y);
    // B's ships on water all around the target.
    const ships: Unit[] = [];
    for (let dy = -60; dy <= 60; dy += 20) {
      for (let dx = -60; dx <= 60; dx += 20) {
        const t = game.ref(STRAIT_X + dx, STRAIT_Y + dy);
        if (map.isWater(t) && map.isOcean(t)) {
          ships.push(b.buildUnit(UnitType.Warship, t, { patrolTile: t }));
        }
      }
    }
    const farShip = b.buildUnit(UnitType.Warship, openOcean(game, 20), {
      patrolTile: openOcean(game, 20),
    });
    expect(ships.length).toBeGreaterThan(3);
    const bTiles = new Set(b.tiles());
    const bCount = b.numTilesOwned();
    const landBefore = game.numLandTiles();
    const aGold = a.gold();

    launch(game, a, target);
    let messages = 0;
    // Close to the silo: it lands within a couple of ticks.
    for (let i = 0; i < 200; i++) {
      if (i > 2 && a.units(UnitType.LandBomb).length === 0) break;
      const updates = game.executeNextTick();
      for (const u of updates[GameUpdateType.DisplayEvent]) {
        if (u.message === "events_display.land_bomb_detonated") messages++;
      }
    }
    expect(a.units(UnitType.LandBomb)).toHaveLength(0);
    expect(messages).toBe(1);
    expect(a.gold()).toBe(aGold); // infinite gold: free

    const raised = game.numLandTiles() - landBefore;
    expect(raised).toBeGreaterThan(1000);
    let newUnowned = 0;
    for (let y = STRAIT_Y - R; y <= STRAIT_Y + R; y++) {
      for (let x = STRAIT_X - R; x <= STRAIT_X + R; x++) {
        const t = game.ref(x, y);
        if (map.isLand(t) && !game.hasOwner(t)) newUnowned++;
      }
    }
    expect(newUnowned).toBeGreaterThanOrEqual(raised);
    // Owned land untouched.
    expect(b.numTilesOwned()).toBe(bCount);
    for (const t of bTiles) expect(game.owner(t)).toBe(b);
    // Ships on risen land are wrecked, the rest sail on.
    let wrecked = 0;
    for (const s of ships) {
      expect(s.isActive()).toBe(map.isWater(s.tile()));
      if (!s.isActive()) wrecked++;
    }
    expect(wrecked).toBeGreaterThan(0);
    expect(farShip.isActive()).toBe(true);
    expect(b.isAlive()).toBe(true);
  }, 60_000);

  test("terrain bits, minimap and water components stay consistent", async () => {
    const { game, a } = await worldGame({ disableNavMesh: false });
    const map = game.map();
    const mini = game.miniMap();
    launch(game, a, game.ref(STRAIT_X, STRAIT_Y));
    untilLanded(game, a);
    executeTicks(game, 2);
    for (let y = STRAIT_Y - R - 3; y <= STRAIT_Y + R + 3; y++) {
      for (let x = STRAIT_X - R - 3; x <= STRAIT_X + R + 3; x++) {
        const t = map.ref(x, y);
        if (map.isImpassable(t)) continue;
        const shore = map
          .neighbors(t)
          .some((n) => !map.isImpassable(n) && map.isLand(n) !== map.isLand(t));
        expect(map.isShoreline(t), `shoreline at ${x},${y}`).toBe(shore);
        // Minimap: land only where all four source tiles are land.
        const mt = mini.ref(Math.floor(x / 2), Math.floor(y / 2));
        if (mini.isLand(mt)) expect(map.isLand(t)).toBe(true);
      }
    }
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
  }, 60_000);

  test("a target deep inland raises nothing", async () => {
    const { game, a } = await worldGame();
    const landBefore = game.numLandTiles();
    launch(game, a, game.ref(1030, 500)); // middle of Africa
    untilLanded(game, a);
    expect(game.numLandTiles()).toBe(landBefore);
  }, 60_000);

  test("a single SAM hit brings it down", async () => {
    const game = await setup(
      "plains",
      { infiniteGold: true, instantBuild: true },
      [A, B],
    );
    const a = game.player(A.id);
    const b = game.player(B.id);
    b.conquer(game.ref(50, 50));
    const sam = b.buildUnit(UnitType.SAMLauncher, game.ref(50, 50), {});
    const target = game.ref(52, 50);
    const bomb = a.buildUnit(UnitType.LandBomb, game.ref(1, 1), {
      targetTile: target,
      trajectory: [{ tile: target, targetable: true }],
    });
    bomb.move(target);
    bomb.setTargetedBySAM(true);
    game.addExecution(
      new SAMMissileExecution(game.ref(50, 50), b, sam, bomb, target),
    );
    executeTicks(game, 3);
    expect(bomb.isActive()).toBe(false);
  });

  test("whole detonation is deterministic", async () => {
    const run = async () => {
      const { game, a } = await worldGame();
      launch(game, a, game.ref(STRAIT_X, STRAIT_Y));
      untilLanded(game, a);
      return (game as unknown as { hash(): number }).hash();
    };
    expect(await run()).toBe(await run());
  }, 60_000);

  test("snapshot round-trips in flight, through and after impact", async () => {
    const { game, a } = await worldGame();
    launch(game, a, game.ref(STRAIT_X, STRAIT_Y));
    executeTicks(game, 3);
    expect(a.units(UnitType.LandBomb)).toHaveLength(1);
    // Continues both games past the impact, comparing state.
    await expectSnapshotRoundTrip(game, "world", 20);
    expect(a.units(UnitType.LandBomb)).toHaveLength(0);
    await expectSnapshotRoundTrip(game, "world", 3);
  }, 120_000);
});
