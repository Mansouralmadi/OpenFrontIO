import { vi } from "vitest";
import { ConstructionExecution } from "../src/core/execution/ConstructionExecution";
import { refreshHappiness } from "../src/core/execution/Happiness";
import { NationStructureBehavior } from "../src/core/execution/nation/NationStructureBehavior";
import { PlayerExecution } from "../src/core/execution/PlayerExecution";
import { RebellionExecution } from "../src/core/execution/RebellionExecution";
import { TrainStationExecution } from "../src/core/execution/TrainStationExecution";
import { UpgradeStructureExecution } from "../src/core/execution/UpgradeStructureExecution";
import {
  Difficulty,
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../src/core/game/Game";
import { PseudoRandom } from "../src/core/PseudoRandom";
import { createGame, L } from "./core/pathfinding/_fixtures";
import { setup } from "./util/Setup";
import { expectSnapshotRoundTrip } from "./util/Snapshot";
import { executeTicks } from "./util/utils";

const BIG = "big_plains";

function conquerRect(
  game: Game,
  p: Player,
  x0: number,
  y0: number,
  w: number,
  h: number,
) {
  for (let x = x0; x < x0 + w; x++) {
    for (let y = y0; y < y0 + h; y++) {
      const t = game.ref(x, y);
      if (game.isLand(t)) p.conquer(t);
    }
  }
}

async function twoPlayers(
  config: Parameters<typeof setup>[1] = {},
): Promise<{ game: Game; a: Player; b: Player }> {
  const game = await setup(BIG, config, [
    new PlayerInfo("alice", PlayerType.Human, "client_a", "alice"),
    new PlayerInfo("bob", PlayerType.Human, "client_b", "bob"),
  ]);
  const a = game.player("alice");
  const b = game.player("bob");
  // setup already ended the spawn phase, so this land starts unintegrated.
  conquerRect(game, a, 0, 0, 40, 60);
  conquerRect(game, b, 40, 0, 20, 60);
  return { game, a, b };
}

function integrateAll(p: Player) {
  p.integrateTiles(1_000_000);
}

describe("Happiness", () => {
  test("formula: farms add with diminishing returns, unintegrated land subtracts", async () => {
    const { game } = await twoPlayers();
    const c = game.config();
    expect(c.happiness(0, 0, 1000)).toBe(50);
    expect(c.happiness(1, 0, 1000)).toBe(56);
    expect(c.happiness(5, 0, 1000)).toBe(80);
    expect(c.happiness(6, 0, 1000)).toBe(83);
    expect(c.happiness(10, 0, 1000)).toBe(90); // capped at +40
    expect(c.happiness(50, 0, 1000)).toBe(90);
    expect(c.happiness(0, 100, 1000)).toBe(44); // 10% -> -6
    expect(c.happiness(0, 500, 1000)).toBe(20); // 50% -> -30
    expect(c.happiness(0, 1000, 1000)).toBe(10); // capped at -40
    expect(c.happiness(10, 1000, 1000)).toBe(50);
    expect(c.happiness(0, 0, 0)).toBe(50);
  });

  test("the unintegrated penalty is off for 1 minute, then phases in over 3", async () => {
    const { game } = await twoPlayers();
    const c = game.config();
    const min = 60 * 10;
    expect(c.happiness(0, 1000, 1000, 0)).toBe(50);
    expect(c.happiness(0, 1000, 1000, min)).toBe(50);
    expect(c.happiness(0, 1000, 1000, min + 90 * 10)).toBe(30); // -40 * 1/2
    expect(c.happiness(0, 1000, 1000, 4 * min)).toBe(10);
    expect(c.happiness(0, 1000, 1000, 60 * min)).toBe(10);
    // Farms count from the start
    expect(c.happiness(1, 1000, 1000, 0)).toBe(56);
  });

  test("refresh: everyone starts at base happiness despite all-new land", async () => {
    const { game, a } = await twoPlayers();
    expect(game.ticksSinceStart()).toBeLessThan(60 * 10);
    refreshHappiness(game, a);
    expect(a.happiness()).toBe(50);
  });

  test("refresh: rises with completed farm levels, falls with unintegrated share", async () => {
    const { game, a } = await twoPlayers({ infiniteGold: true });
    // Well past the opening grace period
    vi.spyOn(game, "ticksSinceStart").mockReturnValue(10 * 60 * 10);
    refreshHappiness(game, a);
    expect(a.happiness()).toBe(10); // all land unintegrated
    integrateAll(a);
    refreshHappiness(game, a);
    expect(a.happiness()).toBe(50);

    const farm = a.buildUnit(UnitType.Farm, game.ref(10, 10), {});
    refreshHappiness(game, a);
    expect(a.happiness()).toBe(56);
    game.addExecution(new UpgradeStructureExecution(a, farm.id(), 4));
    executeTicks(game, 1);
    expect(farm.level()).toBe(5);
    refreshHappiness(game, a);
    expect(a.happiness()).toBe(80);
  });

  test("farms under construction don't count; captured and destroyed ones stop counting", async () => {
    const { game, a, b } = await twoPlayers({ infiniteGold: true });
    integrateAll(a);
    game.addExecution(
      new ConstructionExecution(a, UnitType.Farm, game.ref(10, 10)),
    );
    executeTicks(game, 2);
    expect(a.units(UnitType.Farm)[0].isUnderConstruction()).toBe(true);
    expect(a.totalUnitLevels(UnitType.Farm)).toBe(0);
    executeTicks(game, 25);
    expect(a.totalUnitLevels(UnitType.Farm)).toBe(1);

    const farm = a.units(UnitType.Farm)[0];
    const other = a.buildUnit(UnitType.Farm, game.ref(30, 30), {});
    expect(a.totalUnitLevels(UnitType.Farm)).toBe(2);
    b.captureUnit(farm);
    expect(a.totalUnitLevels(UnitType.Farm)).toBe(1);
    expect(b.totalUnitLevels(UnitType.Farm)).toBe(1);
    other.delete(false);
    expect(a.totalUnitLevels(UnitType.Farm)).toBe(0);
    refreshHappiness(game, a);
    expect(a.happiness()).toBe(50);
  });

  test("troop growth scales 0.5x / 1x / 1.5x at happiness 0 / 50 / 100", async () => {
    const { game, a } = await twoPlayers();
    const c = game.config();
    a.setHappiness(50);
    const base = c.troopIncreaseRate(a);
    expect(base).toBeGreaterThan(0);
    a.setHappiness(0);
    expect(c.troopIncreaseRate(a) / base).toBeCloseTo(0.5);
    a.setHappiness(100);
    expect(c.troopIncreaseRate(a) / base).toBeCloseTo(1.5);
  });

  test("PlayerExecution refreshes happiness and player updates carry it", async () => {
    const { game, a } = await twoPlayers({ infiniteGold: true });
    integrateAll(a);
    a.buildUnit(UnitType.Farm, game.ref(10, 10), {});
    game.addExecution(new PlayerExecution(a));
    executeTicks(game, 12);
    expect(a.happiness()).toBe(56);
    a.toUpdate(); // ticks already emitted updates; this syncs the diff base
    a.setHappiness(70);
    expect(a.toUpdate()?.happiness).toBe(70);
  });

  test("rebellion delay and min size scale with happiness", async () => {
    const { game } = await twoPlayers();
    const c = game.config();
    expect(c.rebellionUnintegratedTicks(0)).toBe(300);
    expect(c.rebellionUnintegratedTicks(50)).toBe(600);
    expect(c.rebellionUnintegratedTicks(100)).toBe(1200);
    expect(c.rebellionMinTiles(10_000, 89)).toBe(150);
    expect(c.rebellionMinTiles(10_000, 90)).toBe(225);
  });
});

describe("Happiness and rebellions", () => {
  // plains: 100x100 all land; grace 1200 ticks, checks every 100 ticks.
  async function rebelGame(happiness: number) {
    const game = await setup("plains", {}, [], undefined, undefined, false);
    const a = game.addPlayer(
      new PlayerInfo("a", PlayerType.Human, "client_a", "a"),
    );
    conquerRect(game, a, 0, 0, 10, 10);
    a.setSpawnTile(game.ref(5, 5));
    game.endSpawnPhase();
    game.addExecution(new RebellionExecution("game_1"));
    a.setHappiness(happiness);
    const run = (tick: number) => {
      while (game.ticks() < tick) game.executeNextTick();
    };
    const rebels = () =>
      game.players().filter((p) => p.name().startsWith("a Rebels")).length;
    return { game, a, run, rebels };
  }

  test("unhappy land rebels after 30s", async () => {
    const { game, a, run, rebels } = await rebelGame(0);
    run(1250);
    conquerRect(game, a, 40, 0, 60, 100);
    run(1250 + 250);
    expect(rebels()).toBe(0);
    run(1250 + 450);
    expect(rebels()).toBe(1);
  });

  test("happy land holds out for 2 minutes", async () => {
    const { game, a, run, rebels } = await rebelGame(100);
    run(1250);
    conquerRect(game, a, 40, 0, 60, 100);
    run(1250 + 1150);
    expect(rebels()).toBe(0);
    run(1250 + 1350);
    expect(rebels()).toBe(1);
  });

  test("very happy players need a 50% larger region", async () => {
    // 200 tiles: enough at happiness 50 (min 150), not at 90+ (min 225).
    for (const [happiness, expected] of [
      [50, 1],
      [95, 0],
    ]) {
      const { game, a, run, rebels } = await rebelGame(happiness);
      conquerRect(game, a, 40, 40, 20, 10);
      run(2500);
      expect(rebels()).toBe(expected);
    }
  });
});

describe("Integration bonus", () => {
  test("factories and rail-connected structures speed integration, capped", async () => {
    const { game, a } = await twoPlayers({ instantBuild: true });
    const c = game.config();
    expect(c.integrationPerTick(5000, 0)).toBe(10);
    expect(c.integrationPerTick(5000, 7)).toBe(17);

    refreshHappiness(game, a);
    expect(a.integrationBonus()).toBe(0);

    const factory = a.buildUnit(UnitType.Factory, game.ref(10, 10), {});
    a.upgradeUnit(factory);
    refreshHappiness(game, a);
    expect(a.integrationBonus()).toBe(6); // 3 per factory level

    // Two cities on the factory's rail cluster: each is connected to the other.
    const c1 = a.buildUnit(UnitType.City, game.ref(25, 12), {});
    const c2 = a.buildUnit(UnitType.City, game.ref(12, 30), {});
    game.addExecution(
      new TrainStationExecution(factory, true),
      new TrainStationExecution(c1),
      new TrainStationExecution(c2),
    );
    executeTicks(game, 5);
    const stations = game.railNetwork().stationManager();
    const cluster = stations.findStation(factory)?.getCluster();
    expect(cluster).toBeTruthy();
    expect(stations.findStation(c1)?.getCluster()).toBe(cluster);
    expect(stations.findStation(c2)?.getCluster()).toBe(cluster);
    refreshHappiness(game, a);
    expect(a.integrationBonus()).toBe(8);

    for (let i = 0; i < 30; i++) a.upgradeUnit(factory);
    refreshHappiness(game, a);
    expect(a.integrationBonus()).toBe(60);
  });

  test("a player with a factory integrates its backlog faster", async () => {
    const run = async (withFactory: boolean) => {
      const { game, a } = await twoPlayers({ infiniteGold: true });
      if (withFactory) a.buildUnit(UnitType.Factory, game.ref(10, 10), {});
      game.addExecution(new PlayerExecution(a));
      executeTicks(game, 50);
      return a.unintegratedTiles();
    };
    expect(await run(true)).toBeLessThan(await run(false));
  });
});

describe("Farm", () => {
  test("cost starts at 100K and doubles per farm level owned, capped at 500K", async () => {
    const { game, a } = await twoPlayers();
    a.addGold(10_000_000n);
    const cost = () => game.unitInfo(UnitType.Farm).cost(game, a);
    expect(cost()).toBe(100_000n);
    const farm = a.buildUnit(UnitType.Farm, game.ref(10, 10), {});
    expect(cost()).toBe(200_000n);
    a.upgradeUnit(farm);
    expect(cost()).toBe(400_000n);
    a.buildUnit(UnitType.Farm, game.ref(30, 30), {});
    expect(cost()).toBe(500_000n);
    expect(game.unitInfo(UnitType.Farm).upgradable).toBe(true);
  });

  test("can't build when disabled", async () => {
    const { game, a } = await twoPlayers({
      infiniteGold: true,
      disabledUnits: [UnitType.Farm],
    });
    expect(a.canBuild(UnitType.Farm, game.ref(10, 10))).toBe(false);
    const enabled = await twoPlayers({ infiniteGold: true });
    expect(
      enabled.a.canBuild(UnitType.Farm, enabled.game.ref(10, 10)),
    ).not.toBe(false);
  });

  test("snapshot round-trip with farms and happiness", async () => {
    const { game, a, b } = await twoPlayers({ infiniteGold: true });
    game.addExecution(
      new PlayerExecution(a),
      new PlayerExecution(b),
      new ConstructionExecution(a, UnitType.Farm, game.ref(10, 10)),
      new ConstructionExecution(b, UnitType.Farm, game.ref(50, 10)),
      new ConstructionExecution(a, UnitType.Factory, game.ref(30, 40)),
    );
    executeTicks(game, 25);
    game.addExecution(
      new UpgradeStructureExecution(a, a.units(UnitType.Farm)[0].id(), 2),
      new ConstructionExecution(a, UnitType.Farm, game.ref(30, 20)),
    );
    executeTicks(game, 13);
    expect(a.totalUnitLevels(UnitType.Farm)).toBe(3);
    expect(a.integrationBonus()).toBe(3);
    await expectSnapshotRoundTrip(game, BIG, 40);
  });
});

describe("Nation farms", () => {
  // 60x60 all-land map; the nation owns the west 40 columns. Only cities and
  // farms are enabled, so the build order is just the two.
  function nationGame() {
    const size = 60;
    const game = createGame(
      { width: size, height: size, grid: new Array(size * size).fill(L) },
      {
        difficulty: Difficulty.Hard,
        disabledUnits: [
          UnitType.Port,
          UnitType.Factory,
          UnitType.MissileSilo,
          UnitType.SAMLauncher,
          UnitType.DefensePost,
        ],
      },
    );
    const nation = game.addPlayer(
      new PlayerInfo("nation", PlayerType.Nation, null, "nation_id"),
    );
    game.map().forEachTile((t) => {
      if (game.x(t) < 40) nation.conquer(t);
    });
    const behavior = new NationStructureBehavior(
      new PseudoRandom(7),
      game,
      nation,
    );
    const spy = vi.spyOn(game, "addExecution");
    const built = () =>
      spy.mock.calls
        .map((c) => c[0])
        .filter((e) => e instanceof ConstructionExecution)
        .map((e) => e["constructionType"]);
    const cities = (n: number) => {
      for (let i = 0; i < n; i++) {
        nation.buildUnit(UnitType.City, game.ref(5 + 12 * i, 5), {});
      }
    };
    return { nation, behavior, built, cities };
  }

  test("no farm with two cities", () => {
    const { nation, behavior, built, cities } = nationGame();
    cities(2);
    nation.addGold(150_000n - nation.gold()); // buildUnit charged the cities
    behavior.handleStructures();
    expect(built()).not.toContain(UnitType.Farm);
  });

  test("builds a farm once it has three cities, before the next city", () => {
    const { nation, behavior, built, cities } = nationGame();
    cities(3);
    nation.addGold(150_000n - nation.gold()); // buildUnit charged the cities
    behavior.handleStructures();
    expect(built()).toEqual([UnitType.Farm]);
  });
});
