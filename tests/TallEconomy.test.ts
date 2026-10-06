import { vi } from "vitest";
import { pow } from "../src/core/DetMath";
import { integrateNearCities } from "../src/core/execution/CityIntegration";
import { ConstructionExecution } from "../src/core/execution/ConstructionExecution";
import { NationStructureBehavior } from "../src/core/execution/nation/NationStructureBehavior";
import { PlayerExecution } from "../src/core/execution/PlayerExecution";
import { UpgradeStructureExecution } from "../src/core/execution/UpgradeStructureExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../src/core/game/Game";
import { PseudoRandom } from "../src/core/PseudoRandom";
import { setup } from "./util/Setup";
import { diffGraphs, roundTrip } from "./util/Snapshot";

// plains: 100x100, all 10,000 tiles land. Capacity = 2% (200) + 1% (100) per
// built city level; integration = 5 + backlog/1000 per tick empire-wide, plus
// 10/tick per level from each city within 30 (+6 per extra level) tiles.
const MAP = "plains";

function human(game: Game, name: string): Player {
  return game.addPlayer(
    new PlayerInfo(name, PlayerType.Human, `client_${name}`, name),
  );
}

function conquerRect(
  game: Game,
  p: Player,
  x0: number,
  y0: number,
  w: number,
  h: number,
) {
  for (let x = x0; x < x0 + w; x++) {
    for (let y = y0; y < y0 + h; y++) p.conquer(game.ref(x, y));
  }
}

function addCityLevels(game: Game, p: Player, x: number, y: number, n: number) {
  const city = p.buildUnit(UnitType.City, game.ref(x, y), {});
  for (let i = 1; i < n; i++) city.increaseLevel();
}

async function spawnPhaseGame(disableIntegration = false): Promise<Game> {
  return setup(
    MAP,
    { infiniteGold: true, instantBuild: true, disableIntegration },
    [],
    undefined,
    undefined,
    false,
  );
}

describe("tall economy: integration backlog", () => {
  test("only land taken after the spawn phase joins the backlog", async () => {
    const game = await spawnPhaseGame();
    const a = human(game, "a");
    const b = human(game, "b");
    conquerRect(game, a, 0, 0, 10, 10);
    expect(a.unintegratedTiles()).toBe(0);

    game.endSpawnPhase();
    conquerRect(game, a, 10, 0, 30, 50);
    expect(a.unintegratedTiles()).toBe(1500);

    // Losing unintegrated land shrinks the backlog; losing core land doesn't.
    conquerRect(game, b, 30, 0, 10, 10);
    expect(a.unintegratedTiles()).toBe(1400);
    expect(b.unintegratedTiles()).toBe(100);
    a.relinquish(game.ref(0, 0));
    expect(a.unintegratedTiles()).toBe(1400);
    a.relinquish(game.ref(10, 0));
    expect(a.unintegratedTiles()).toBe(1399);
    expect(game.isUnintegrated(game.ref(10, 0))).toBe(false);
  });

  test("each unintegrated tile is flagged; integration clears the oldest first", async () => {
    const game = await spawnPhaseGame();
    const a = human(game, "a");
    const b = human(game, "b");
    conquerRect(game, a, 0, 0, 10, 10);
    game.endSpawnPhase();
    expect(game.isUnintegrated(game.ref(0, 0))).toBe(false); // spawn land
    conquerRect(game, a, 10, 0, 1, 10); // older
    conquerRect(game, a, 11, 0, 1, 10); // newer
    expect(game.isUnintegrated(game.ref(10, 0))).toBe(true);

    // A lost tile goes to its new owner's backlog, then is skipped by ours.
    b.conquer(game.ref(10, 0));
    expect(game.isUnintegrated(game.ref(10, 0))).toBe(true);
    expect(b.unintegratedTiles()).toBe(1);

    a.integrateTiles(9);
    for (let y = 1; y < 10; y++) {
      expect(game.isUnintegrated(game.ref(10, y))).toBe(false);
    }
    expect(game.isUnintegrated(game.ref(11, 0))).toBe(true);
    expect(a.unintegratedTiles()).toBe(10);

    a.integrateTiles(100);
    expect(a.unintegratedTiles()).toBe(0);
    expect(game.isUnintegrated(game.ref(11, 9))).toBe(false);
    expect(game.isUnintegrated(game.ref(10, 0))).toBe(true); // still b's
  });

  test("the backlog decays each tick, oldest land first", async () => {
    const game = await spawnPhaseGame();
    const plain = human(game, "plain");
    conquerRect(game, plain, 0, 0, 10, 10);
    game.endSpawnPhase();
    conquerRect(game, plain, 0, 10, 50, 40);
    expect(plain.unintegratedTiles()).toBe(2000);

    game.addExecution(new PlayerExecution(plain));
    game.executeNextTick(); // inits the execution
    game.executeNextTick();
    // 5 + 2000/1000 = 7
    expect(plain.unintegratedTiles()).toBe(1993);
    for (let i = 0; i < 100; i++) game.executeNextTick();
    expect(plain.unintegratedTiles()).toBeGreaterThan(1000);
  });

  test("cities integrate the land around them, nearest first", async () => {
    const game = await spawnPhaseGame();
    const plain = human(game, "plain");
    const city = human(game, "city");
    conquerRect(game, plain, 0, 0, 10, 10);
    conquerRect(game, city, 50, 0, 10, 10);
    addCityLevels(game, city, 55, 5, 3); // radius 30 + 2*6 = 42
    game.endSpawnPhase();
    conquerRect(game, plain, 0, 10, 50, 40);
    conquerRect(game, city, 50, 10, 50, 40);

    game.addExecution(new PlayerExecution(plain));
    game.addExecution(new PlayerExecution(city));
    game.executeNextTick(); // inits the executions
    for (let i = 0; i < 20; i++) game.executeNextTick();

    // Two bursts of 3 levels * 10/tick * 10 ticks of budget on top of the
    // shared rate, but the nearest land is 5+ tiles out and costs 2-3 a tile.
    expect(plain.unintegratedTiles() - city.unintegratedTiles()).toBe(198);
    // Close to the city: integrated. The far corner, last in queue order and
    // beyond the city's reach, isn't.
    expect(game.isUnintegrated(game.ref(55, 12))).toBe(false);
    expect(game.isUnintegrated(game.ref(99, 49))).toBe(true);

    for (let i = 0; i < 300; i++) game.executeNextTick();
    // Everything within the radius is done
    for (let y = 10; y < 50; y++) {
      for (let x = 50; x < 100; x++) {
        if ((x - 55) ** 2 + (y - 5) ** 2 <= 42 ** 2) {
          expect(game.isUnintegrated(game.ref(x, y))).toBe(false);
        }
      }
    }
  });

  test("city integration falls off with distance", async () => {
    const game = await spawnPhaseGame();
    const a = human(game, "a");
    conquerRect(game, a, 48, 48, 5, 5);
    addCityLevels(game, a, 50, 50, 1); // radius 30, 100 budget per burst
    game.endSpawnPhase();
    conquerRect(game, a, 0, 0, 100, 100);
    const integratedWithin = (lo: number, hi: number) => {
      let done = 0;
      let all = 0;
      for (let y = 0; y < 100; y++) {
        for (let x = 0; x < 100; x++) {
          const d2 = (x - 50) ** 2 + (y - 50) ** 2;
          if (d2 <= lo * lo || d2 > hi * hi) continue;
          all++;
          if (!game.isUnintegrated(game.ref(x, y))) done++;
        }
      }
      return done / all;
    };

    // No PlayerExecution: only the city integrates, one burst per 10 ticks.
    for (let i = 0; i < 60; i++) {
      game.executeNextTick();
      integrateNearCities(game, a);
    }
    // Six bursts (600 budget) finish the ring within 10 tiles...
    expect(integratedWithin(0, 10)).toBe(1);
    // ...where a flat cost of 1 would have reached ~14 tiles out.
    expect(integratedWithin(13, 30)).toBe(0);

    for (let i = 0; i < 600; i++) {
      game.executeNextTick();
      integrateNearCities(game, a);
    }
    // Sixty bursts: the inner 20 tiles are done, the outer edge barely begun.
    expect(integratedWithin(0, 20)).toBe(1);
    expect(integratedWithin(25, 30)).toBeLessThan(0.25);
  });

  test("land cut off from the main territory integrates slower", async () => {
    const game = await spawnPhaseGame();
    const linked = human(game, "linked");
    const landed = human(game, "landed");
    conquerRect(game, linked, 0, 0, 20, 20);
    conquerRect(game, landed, 0, 50, 20, 20);
    game.endSpawnPhase();
    game.addExecution(new PlayerExecution(linked));
    game.addExecution(new PlayerExecution(landed));
    // Past the executions' first (staggered) cluster check.
    for (let i = 0; i < 25; i++) game.executeNextTick();
    conquerRect(game, linked, 20, 0, 15, 15); // touches the home land
    conquerRect(game, landed, 30, 50, 15, 15); // a boat landing
    for (let i = 0; i < 60; i++) game.executeNextTick();

    expect(game.isDetached(game.ref(44, 64))).toBe(true);
    expect(game.isDetached(game.ref(34, 14))).toBe(false);
    // 5 a tick for both until the pocket is flagged, then 1 a tick there.
    expect(linked.unintegratedTiles()).toBe(0);
    expect(landed.unintegratedTiles()).toBeGreaterThan(50);

    // Joining it back up makes it count as connected again.
    const backlog = landed.unintegratedTiles();
    conquerRect(game, landed, 20, 50, 10, 1);
    for (let i = 0; i < 25; i++) game.executeNextTick();
    for (let x = 30; x < 45; x++) {
      for (let y = 50; y < 65; y++) {
        expect(game.isDetached(game.ref(x, y))).toBe(false);
      }
    }
    // Faster than the 1 a tick it got while detached.
    expect(backlog + 10 - landed.unintegratedTiles()).toBeGreaterThan(40);
  });

  test("cities only integrate their owner's land", async () => {
    const game = await spawnPhaseGame();
    const a = human(game, "a");
    const b = human(game, "b");
    conquerRect(game, a, 0, 0, 10, 10);
    conquerRect(game, b, 20, 0, 10, 10);
    addCityLevels(game, a, 5, 5, 1);
    game.endSpawnPhase();
    conquerRect(game, b, 10, 0, 10, 10); // next to a's city
    conquerRect(game, a, 0, 10, 10, 10);
    game.addExecution(new PlayerExecution(a));
    game.executeNextTick();
    for (let i = 0; i < 20; i++) game.executeNextTick();
    expect(a.unintegratedTiles()).toBe(0);
    expect(b.unintegratedTiles()).toBe(100);
    expect(game.isUnintegrated(game.ref(10, 5))).toBe(true);
  });

  test("unintegrated land lowers max troops until it integrates", async () => {
    const game = await spawnPhaseGame();
    const a = human(game, "a");
    conquerRect(game, a, 0, 0, 10, 10);
    game.endSpawnPhase();
    conquerRect(game, a, 10, 0, 10, 10);
    const config = game.config();
    const lagging = config.maxTroops(a);
    a.integrateTiles(a.unintegratedTiles());
    expect(config.maxTroops(a)).toBeGreaterThan(lagging);
    // 200 tiles fully integrated sit exactly at the base capacity.
    expect(config.economicTiles(a)).toBe(200);
  });
});

describe("tall economy: building cities", () => {
  test("a new city integrates all its owner's land in its radius at once", async () => {
    const game = await spawnPhaseGame();
    const a = human(game, "a");
    conquerRect(game, a, 0, 0, 10, 10);
    game.endSpawnPhase();
    conquerRect(game, a, 10, 0, 90, 100);
    const before = a.unintegratedTiles();

    game.addExecution(
      new ConstructionExecution(a, UnitType.City, game.ref(50, 50)),
    );
    game.executeNextTick();
    game.executeNextTick();
    const city = a.units(UnitType.City)[0];
    expect(city).toBeDefined();
    // Radius 30 around (50, 50), edge included; the far corner waits.
    expect(game.isUnintegrated(game.ref(50 + 30, 50))).toBe(false);
    expect(game.isUnintegrated(game.ref(50 + 21, 50 + 21))).toBe(false);
    expect(game.isUnintegrated(game.ref(99, 99))).toBe(true);
    expect(before - a.unintegratedTiles()).toBeGreaterThan(2500);

    // Upgrading widens the radius (36) and settles the new ring at once.
    expect(game.isUnintegrated(game.ref(50 + 34, 50))).toBe(true);
    game.addExecution(new UpgradeStructureExecution(a, city.id()));
    game.executeNextTick();
    expect(city.level()).toBe(2);
    expect(game.isUnintegrated(game.ref(50 + 34, 50))).toBe(false);
    expect(game.isUnintegrated(game.ref(99, 99))).toBe(true);
  });
});

test("a refused city upgrade settles nothing", async () => {
  const game = await setup(
    MAP,
    { infiniteGold: false, instantBuild: true },
    [],
    undefined,
    undefined,
    false,
  );
  const a = human(game, "a");
  conquerRect(game, a, 0, 0, 10, 10);
  game.endSpawnPhase();
  a.addGold(10_000_000n);
  game.addExecution(
    new ConstructionExecution(a, UnitType.City, game.ref(5, 5)),
  );
  game.executeNextTick();
  game.executeNextTick();
  const city = a.units(UnitType.City)[0];
  expect(city).toBeDefined();
  conquerRect(game, a, 10, 0, 90, 100); // taken after the city: unintegrated
  a.removeGold(a.gold());
  expect(a.canUpgradeUnit(city)).toBe(false);
  const before = a.unintegratedTiles();

  game.addExecution(new UpgradeStructureExecution(a, city.id()));
  game.executeNextTick();
  expect(city.level()).toBe(1);
  expect(game.isUnintegrated(game.ref(12, 5))).toBe(true);
  // Only the ordinary trickle ran, not a whole radius at once.
  expect(before - a.unintegratedTiles()).toBeLessThan(500);
});

describe("tall economy: integration toggle", () => {
  test("with integration off, taken land is integrated at once", async () => {
    const game = await spawnPhaseGame(true);
    expect(game.config().integration()).toBe(false);
    const a = human(game, "a");
    conquerRect(game, a, 0, 0, 10, 10);
    game.endSpawnPhase();
    conquerRect(game, a, 10, 0, 30, 50);
    expect(a.unintegratedTiles()).toBe(0);
    expect(game.isUnintegrated(game.ref(20, 20))).toBe(false);
  });

  test("integration is on by default", async () => {
    const game = await setup(MAP, {});
    expect(game.config().integration()).toBe(true);
  });
});

describe("tall economy: overextension", () => {
  test("a city-less sprawl has fewer max troops than a compact empire with cities at equal tiles", async () => {
    const game = await spawnPhaseGame();
    const sprawl = human(game, "sprawl");
    const compact = human(game, "compact");
    // Taken during the spawn phase: fully integrated, so only capacity differs.
    conquerRect(game, sprawl, 0, 0, 100, 10);
    conquerRect(game, compact, 0, 50, 40, 25);
    expect(sprawl.numTilesOwned()).toBe(compact.numTilesOwned());
    addCityLevels(game, compact, 20, 60, 8);

    const config = game.config();
    expect(sprawl.adminCapacity()).toBe(200);
    expect(compact.adminCapacity()).toBe(1000);
    // 200 at full value + 800 beyond capacity at half.
    expect(config.economicTiles(sprawl)).toBe(600);
    expect(config.economicTiles(compact)).toBe(1000);

    const rawTileTroops = 2 * (pow(1000, 0.6) * 1000 + 50000);
    expect(config.maxTroops(sprawl)).toBeLessThan(rawTileTroops);
    // Even without the per-city troop bonus the compact empire's land is worth more.
    expect(
      config.maxTroops(compact) - 8 * config.cityTroopIncrease(),
    ).toBeCloseTo(rawTileTroops, 6);
    expect(config.maxTroops(compact)).toBeGreaterThan(config.maxTroops(sprawl));
  });

  test("overextended nations perceive cities as cheaper", () => {
    const player = {
      numTilesOwned: () => 5000,
      adminCapacity: () => 1000,
      unitsOwned: () => 4,
      gold: () => 0n,
    };
    const game = {
      config: () => ({ gameConfig: () => ({ difficulty: "Hard" }) }),
    };
    const behavior = new NationStructureBehavior(
      new PseudoRandom(0),
      game as any,
      player as any,
    );
    const b = behavior as any;
    vi.spyOn(b, "cost").mockReturnValue(1_000_000n);
    vi.spyOn(b, "getSaveUpTarget").mockReturnValue(50_000_000n);
    vi.spyOn(b, "cityCount").mockReturnValue(10);

    // 4 cities owned: 1 + 0.5 * 4 = 3x while overextended.
    expect(b.getPerceivedCost(UnitType.City)).toBe(3_000_000n);
    player.adminCapacity = () => 10_000;
    // Within capacity: the usual 1 + 1 * 4 = 5x.
    expect(b.getPerceivedCost(UnitType.City)).toBe(5_000_000n);
  });
});

describe("tall economy: snapshots and updates", () => {
  test("the backlog survives a snapshot round trip", async () => {
    const game = await spawnPhaseGame();
    const a = human(game, "a");
    conquerRect(game, a, 0, 0, 10, 10);
    game.endSpawnPhase();
    conquerRect(game, a, 10, 0, 20, 10);
    game.addExecution(new PlayerExecution(a));
    game.executeNextTick();
    game.executeNextTick();
    const backlog = a.unintegratedTiles();
    expect(backlog).toBeGreaterThan(0);

    const { restored } = await roundTrip(game, MAP);
    expect(diffGraphs(game, restored)).toEqual([]);
    expect(restored.player(a.id()).unintegratedTiles()).toBe(backlog);
    // Same tiles flagged, and integration continues in the same order.
    for (let i = 0; i < 3; i++) {
      game.executeNextTick();
      restored.executeNextTick();
    }
    expect(restored.player(a.id()).unintegratedTiles()).toBe(
      a.unintegratedTiles(),
    );
    for (let x = 10; x < 30; x++) {
      for (let y = 0; y < 10; y++) {
        const t = game.ref(x, y);
        expect(restored.isUnintegrated(t)).toBe(game.isUnintegrated(t));
      }
    }
  });

  test("player updates carry the backlog", async () => {
    const game = await spawnPhaseGame();
    const a = human(game, "a");
    game.endSpawnPhase();
    conquerRect(game, a, 0, 0, 5, 5);
    // First emission is the full update.
    expect(a.toUpdate()?.unintegratedTiles).toBe(25);
  });
});
