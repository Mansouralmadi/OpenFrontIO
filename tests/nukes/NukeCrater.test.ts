import { NukeMagnitude } from "../../src/core/configuration/Config";
import { atan2 } from "../../src/core/DetMath";
import {
  craterRadii,
  waterCraterTiles,
} from "../../src/core/execution/NukeCrater";
import { NukeExecution } from "../../src/core/execution/NukeExecution";
import {
  Game,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../src/core/game/Game";
import { TileRef } from "../../src/core/game/GameMap";
import { setup } from "../util/Setup";
import { TestConfig } from "../util/TestConfig";
import { constructionExecution, executeTicks } from "../util/utils";

const MAG: NukeMagnitude = { inner: 40, outer: 60 };
// Area of the old crater: r² uniform in [inner², outer²].
const OLD_AREA = (Math.PI * (MAG.inner ** 2 + MAG.outer ** 2)) / 2;

/** Farthest converted tile per angular bucket, as seen from the center. */
function rimDistances(
  game: Game,
  center: TileRef,
  tiles: Set<TileRef>,
  buckets = 64,
): number[] {
  const far = new Array<number>(buckets).fill(0);
  const cx = game.x(center);
  const cy = game.y(center);
  for (const t of tiles) {
    const dx = game.x(t) - cx;
    const dy = game.y(t) - cy;
    const b =
      Math.floor(((atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * buckets) %
      buckets;
    far[b] = Math.max(far[b], Math.sqrt(dx * dx + dy * dy));
  }
  return far;
}

describe("water nuke crater shape", () => {
  let game: Game;
  let center: TileRef;

  beforeAll(async () => {
    game = await setup("big_plains");
    center = game.ref(100, 100);
  });

  test("is not a disc: the rim distance varies with angle", () => {
    for (const seed of [1, 42, 9001]) {
      const tiles = waterCraterTiles(game, center, MAG, seed);
      const rim = rimDistances(game, center, tiles);
      const min = Math.min(...rim);
      const max = Math.max(...rim);
      // A disc would have max/min ~ 1.
      expect(max / min).toBeGreaterThan(1.3);
    }
  });

  test("keeps roughly the old crater's area", () => {
    for (const seed of [1, 42, 9001, 123456]) {
      const tiles = waterCraterTiles(game, center, MAG, seed);
      expect(tiles.size / OLD_AREA).toBeGreaterThan(0.9);
      expect(tiles.size / OLD_AREA).toBeLessThan(1.1);
    }
  });

  test("radius profile stays a crater (no holes, bounded spikes)", () => {
    for (let seed = 0; seed < 50; seed++) {
      const r = craterRadii(MAG, seed);
      const mean = Math.sqrt((MAG.inner ** 2 + MAG.outer ** 2) / 2);
      for (const v of r) {
        expect(v).toBeGreaterThan(mean * 0.5);
        expect(v).toBeLessThan(mean * 1.8);
      }
    }
  });

  test("is deterministic per seed and differs across seeds", () => {
    const a = [...waterCraterTiles(game, center, MAG, 7)];
    const b = [...waterCraterTiles(game, center, MAG, 7)];
    const c = [...waterCraterTiles(game, center, MAG, 8)];
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  test("a water nuke floods an irregular crater in game", async () => {
    class MagConfig extends TestConfig {
      nukeMagnitudes(): NukeMagnitude {
        return MAG;
      }
    }
    const info = new PlayerInfo("p", PlayerType.Human, null, "p");
    const run = async () => {
      const g = await setup(
        "big_plains",
        { infiniteGold: true, instantBuild: true, waterNukes: true },
        [info],
        undefined,
        MagConfig,
      );
      const p = g.player(info.id);
      p.conquer(g.ref(1, 1));
      constructionExecution(g, p, 1, 1, UnitType.MissileSilo);
      g.addExecution(
        new NukeExecution(UnitType.AtomBomb, p, g.ref(120, 120), null),
      );
      executeTicks(g, 120);
      const water = new Set<TileRef>();
      g.forEachTile((t) => {
        if (g.isWater(t)) water.add(t);
      });
      return { g, water };
    };
    const { g, water } = await run();
    expect(water.size / OLD_AREA).toBeGreaterThan(0.85);
    expect(water.size / OLD_AREA).toBeLessThan(1.15);
    const rim = rimDistances(g, g.ref(120, 120), water);
    expect(Math.max(...rim) / Math.min(...rim)).toBeGreaterThan(1.3);
    // Same game, same crater.
    const again = await run();
    expect([...again.water]).toEqual([...water]);
  });
});
