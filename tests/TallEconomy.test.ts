import { vi } from "vitest";
import { pow } from "../src/core/DetMath";
import { NationStructureBehavior } from "../src/core/execution/nation/NationStructureBehavior";
import { PlayerExecution } from "../src/core/execution/PlayerExecution";
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
// built city level; integration = 5 + 5/city level + backlog/1000 per tick.
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

async function spawnPhaseGame(): Promise<Game> {
  return setup(
    MAP,
    { infiniteGold: true, instantBuild: true },
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

    // Losing land takes it off the backlog first; never below zero.
    conquerRect(game, b, 30, 0, 10, 10);
    expect(a.unintegratedTiles()).toBe(1400);
    expect(b.unintegratedTiles()).toBe(100);
    a.relinquish(game.ref(0, 0));
    expect(a.unintegratedTiles()).toBe(1399);
  });

  test("the backlog decays each tick, faster with cities", async () => {
    const game = await spawnPhaseGame();
    const plain = human(game, "plain");
    const city = human(game, "city");
    conquerRect(game, plain, 0, 0, 10, 10);
    conquerRect(game, city, 50, 0, 10, 10);
    addCityLevels(game, city, 55, 5, 3);
    game.endSpawnPhase();
    conquerRect(game, plain, 0, 10, 50, 40);
    conquerRect(game, city, 50, 10, 50, 40);
    expect(plain.unintegratedTiles()).toBe(2000);
    expect(city.unintegratedTiles()).toBe(2000);

    game.addExecution(new PlayerExecution(plain));
    game.addExecution(new PlayerExecution(city));
    game.executeNextTick(); // inits the executions
    game.executeNextTick();
    // 5 + 2000/1000 = 7, vs 5 + 3*5 + 2 = 22.
    expect(plain.unintegratedTiles()).toBe(1993);
    expect(city.unintegratedTiles()).toBe(1978);

    for (let i = 0; i < 100; i++) game.executeNextTick();
    expect(city.unintegratedTiles()).toBe(0);
    expect(plain.unintegratedTiles()).toBeGreaterThan(1000);
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
    game.executeNextTick();
    restored.executeNextTick();
    expect(restored.player(a.id()).unintegratedTiles()).toBe(
      a.unintegratedTiles(),
    );
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
