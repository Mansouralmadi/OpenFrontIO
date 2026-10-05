import { Config, NukeMagnitude } from "../../src/core/configuration/Config";
import { ConstructionExecution } from "../../src/core/execution/ConstructionExecution";
import { NukeExecution } from "../../src/core/execution/NukeExecution";
import { SAMMissileExecution } from "../../src/core/execution/SAMMissileExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../src/core/game/Game";
import { TileRef } from "../../src/core/game/GameMap";
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
// Roughly the middle of Africa on the World map (2000x1000).
const AFRICA_X = 1030;
const AFRICA_Y = 500;

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
  // A: a silo in Spain. B: all of Africa (and whatever else is in the box).
  const silo = game.ref(908, 264);
  a.conquer(silo);
  a.buildUnit(UnitType.MissileSilo, silo, {});
  for (let y = AFRICA_Y - 320; y <= AFRICA_Y + 320; y++) {
    for (let x = AFRICA_X - 320; x <= AFRICA_X + 320; x++) {
      const t = game.ref(x, y);
      if (game.isLand(t) && !game.hasOwner(t)) b.conquer(t);
    }
  }
  return { game, a, b, target: game.ref(AFRICA_X, AFRICA_Y) };
}

function dist(game: Game, a: TileRef, b: TileRef): number {
  return Math.sqrt(game.euclideanDistSquared(a, b));
}

function launch(game: Game, a: Player, target: TileRef) {
  game.addExecution(
    new ConstructionExecution(a, UnitType.AntimatterBomb, target),
  );
}

describe("Antimatter bomb", () => {
  test("magnitude scales with the map: World covers Africa", () => {
    const cfg = Config.prototype;
    const world = cfg.nukeMagnitudes(UnitType.AntimatterBomb, {
      width: () => 2000,
      height: () => 1000,
    });
    expect(world).toEqual({ inner: 204, outer: 255 });
    const big = cfg.nukeMagnitudes(UnitType.AntimatterBomb, {
      width: () => 4108,
      height: () => 1948,
    });
    expect(big.outer).toBeGreaterThan(world.outer * 1.9);
    // Small maps: never weaker than a hydrogen bomb.
    const small = cfg.nukeMagnitudes(UnitType.AntimatterBomb, {
      width: () => 200,
      height: () => 200,
    });
    expect(small.outer).toBeGreaterThan(
      cfg.nukeMagnitudes(UnitType.HydrogenBomb).outer,
    );
  });

  test("costs the same as the MIRV", async () => {
    const game = await setup("plains", { infiniteGold: false }, [A]);
    const a = game.player(A.id);
    const cost = (t: UnitType) => game.unitInfo(t).cost(game, a);
    expect(cost(UnitType.AntimatterBomb)).toBe(cost(UnitType.MIRV));
    expect(cost(UnitType.AntimatterBomb)).toBe(25_000_000n);
    game.recordMirvLaunch();
    expect(cost(UnitType.AntimatterBomb)).toBe(cost(UnitType.MIRV));
  });

  test("cannot be built when disabled", async () => {
    const game = await setup(
      "plains",
      {
        infiniteGold: true,
        instantBuild: true,
        disabledUnits: [UnitType.AntimatterBomb],
      },
      [A, B],
    );
    const a = game.player(A.id);
    const b = game.player(B.id);
    a.conquer(game.ref(1, 1));
    a.buildUnit(UnitType.MissileSilo, game.ref(1, 1), {});
    b.conquer(game.ref(50, 50));
    expect(a.canBuild(UnitType.AntimatterBomb, game.ref(50, 50))).toBe(false);
    expect(a.canBuild(UnitType.HydrogenBomb, game.ref(50, 50))).not.toBe(false);
    launch(game, a, game.ref(50, 50));
    executeTicks(game, 5);
    expect(a.units(UnitType.AntimatterBomb)).toHaveLength(0);
  });

  test("wipes out a continent: Africa on World", async () => {
    const { game, a, b, target } = await worldGame();
    const { inner, outer } = game
      .config()
      .nukeMagnitudes(UnitType.AntimatterBomb, game);
    // A city deep in the blast and one well outside it.
    const doomed = game.ref(AFRICA_X + 100, AFRICA_Y + 100);
    const safe = game.ref(AFRICA_X, AFRICA_Y - 310);
    expect(game.isLand(doomed) && game.isLand(safe)).toBe(true);
    b.buildUnit(UnitType.City, doomed, {});
    b.buildUnit(UnitType.City, safe, {});
    const before = b.numTilesOwned();
    const troopsBefore = b.troops();

    launch(game, a, target);
    executeTicks(game, 3);
    expect(a.units(UnitType.AntimatterBomb)).toHaveLength(1);
    let ticks = 0;
    let slowest = 0;
    while (a.units(UnitType.AntimatterBomb).length > 0 && ticks++ < 200) {
      const t0 = performance.now();
      game.executeNextTick();
      slowest = Math.max(slowest, performance.now() - t0);
    }
    executeTicks(game, 2); // water/fallout flush
    console.log(
      `antimatter detonation: lost ${before - b.numTilesOwned()} tiles, slowest tick ${slowest.toFixed(0)}ms`,
    );

    // Everything inside the inner radius is gone, nothing past outer is touched.
    let innerLand = 0;
    let innerOwned = 0;
    let outsideLost = 0;
    for (let y = AFRICA_Y - 320; y <= AFRICA_Y + 320; y++) {
      for (let x = AFRICA_X - 320; x <= AFRICA_X + 320; x++) {
        const t = game.ref(x, y);
        if (!game.isLand(t)) continue;
        const d = dist(game, t, target);
        if (d <= inner) {
          innerLand++;
          if (game.owner(t) === b) innerOwned++;
        } else if (d > outer + 1 && !game.hasOwner(t)) {
          outsideLost++;
        }
      }
    }
    expect(innerLand).toBeGreaterThan(80_000); // continent-scale
    expect(innerOwned).toBe(0);
    expect(outsideLost).toBe(0);
    expect(before - b.numTilesOwned()).toBeGreaterThan(80_000);
    expect(b.troops()).toBeLessThan(troopsBefore);
    const cities = b.units(UnitType.City).map((c) => c.tile());
    expect(cities).toEqual([safe]);
  });

  test("with water nukes, Africa is flooded by an irregular crater", async () => {
    const { game, a, target } = await worldGame({ waterNukes: true });
    launch(game, a, target);
    executeTicks(game, 40);
    expect(a.units(UnitType.AntimatterBomb)).toHaveLength(0);
    let flooded = 0;
    for (let y = AFRICA_Y - 200; y <= AFRICA_Y + 200; y++) {
      for (let x = AFRICA_X - 200; x <= AFRICA_X + 200; x++) {
        if (game.isWater(game.ref(x, y))) flooded++;
      }
    }
    // Before the strike this box is almost entirely land.
    expect(flooded).toBeGreaterThan(80_000);
  });

  test("detonation is deterministic", async () => {
    const run = async () => {
      const { game, a, target } = await worldGame({ waterNukes: true });
      launch(game, a, target);
      executeTicks(game, 40);
      return (game as unknown as { hash(): number }).hash();
    };
    expect(await run()).toBe(await run());
  });

  test("takes two SAM hits to bring down", async () => {
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
    const bomb = a.buildUnit(UnitType.AntimatterBomb, game.ref(1, 1), {
      targetTile: target,
      trajectory: [{ tile: target, targetable: true }],
    });
    bomb.move(target);
    const hit = () => {
      bomb.setTargetedBySAM(true);
      game.addExecution(
        new SAMMissileExecution(game.ref(50, 50), b, sam, bomb, target),
      );
      executeTicks(game, 3);
    };
    hit();
    expect(bomb.isActive()).toBe(true);
    expect(bomb.health()).toBe(1);
    // Freed for the next SAM.
    expect(bomb.targetedBySAM()).toBe(false);
    hit();
    expect(bomb.isActive()).toBe(false);
  });

  test("snapshot round-trips with a bomb in flight", async () => {
    const game = await setup(
      "big_plains",
      { infiniteGold: true, instantBuild: true },
      [A, B],
    );
    const a = game.player(A.id);
    const b = game.player(B.id);
    for (let x = 0; x < 30; x++) {
      for (let y = 0; y < 30; y++) a.conquer(game.ref(x, y));
    }
    for (let x = 100; x < 200; x++) {
      for (let y = 100; y < 200; y++) b.conquer(game.ref(x, y));
    }
    a.buildUnit(UnitType.MissileSilo, game.ref(10, 10), {});
    game.addExecution(
      new NukeExecution(UnitType.AntimatterBomb, a, game.ref(150, 150)),
    );
    executeTicks(game, 6);
    const bomb = a.units(UnitType.AntimatterBomb)[0];
    expect(bomb).toBeDefined();
    bomb.modifyHealth(-1); // a damaged bomb keeps its health across restore
    await expectSnapshotRoundTrip(game, "big_plains", 60);
  });
});
