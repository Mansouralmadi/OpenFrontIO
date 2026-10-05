import { PlayerExecution } from "../src/core/execution/PlayerExecution";
import { RebellionExecution } from "../src/core/execution/RebellionExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  Relation,
  UnitType,
} from "../src/core/game/Game";
import { setup } from "./util/Setup";
import { expectSnapshotRoundTrip } from "./util/Snapshot";

// plains: 100x100, all land, so the smallest region that can rebel is 1.5% =
// 150 tiles. Rebellions need land unintegrated for 600 ticks, wait out a
// 1200-tick grace after the spawn phase and a 1800-tick cooldown, and each
// player is checked every 100 ticks.
const MAP = "plains";

async function newGame(): Promise<{ game: Game; a: Player }> {
  const game = await setup(MAP, {}, [], undefined, undefined, false);
  const a = game.addPlayer(
    new PlayerInfo("a", PlayerType.Human, "client_a", "a"),
  );
  conquerRect(game, a, 0, 0, 10, 10);
  a.setSpawnTile(game.ref(5, 5));
  game.endSpawnPhase();
  game.addExecution(new RebellionExecution("game_1"));
  return { game, a };
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

function rebels(game: Game): Player[] {
  return game.players().filter((p) => p.name().startsWith("a Rebels"));
}

function runUntil(game: Game, tick: number) {
  while (game.ticks() < tick) game.executeNextTick();
}

describe("rebellions", () => {
  test("a large region left unintegrated for a minute breaks away", async () => {
    const { game, a } = await newGame();
    conquerRect(game, a, 40, 0, 60, 100); // 6000 tiles, cut off
    const troops = a.troops();

    // Long unintegrated, but still within the grace period.
    while (rebels(game).length === 0) game.executeNextTick();
    expect(game.ticks()).toBeGreaterThan(1200);
    expect(game.ticks()).toBeLessThan(1310);

    const [rebel] = rebels(game);
    expect(rebel.type()).toBe(PlayerType.Nation);
    // Capped at half the backlog, grown from the land farthest from home.
    expect(rebel.numTilesOwned()).toBe(3000);
    expect(game.owner(game.ref(99, 99))).toBe(rebel);
    expect(game.owner(game.ref(40, 0))).toBe(a);
    expect(rebel.unintegratedTiles()).toBe(0);
    expect(a.unintegratedTiles()).toBe(3000);
    // Takes its share of the owner's troops with it.
    expect(rebel.troops()).toBeGreaterThan(0);
    expect(a.troops()).toBeLessThan(troops);
    expect(rebel.relation(a)).toBe(Relation.Hostile);
    expect(a.relation(rebel)).toBe(Relation.Hostile);
  });

  test("small regions don't rebel", async () => {
    const { game, a } = await newGame();
    conquerRect(game, a, 40, 40, 10, 10); // 100 tiles
    runUntil(game, 1600);
    expect(rebels(game)).toEqual([]);
  });

  test("only land unintegrated for the full minute counts", async () => {
    const { game, a } = await newGame();
    runUntil(game, 1250);
    conquerRect(game, a, 40, 0, 60, 100);
    runUntil(game, 1250 + 550);
    expect(rebels(game)).toEqual([]);
    runUntil(game, 1250 + 750);
    expect(rebels(game)).toHaveLength(1);
  });

  test("land integrated in time doesn't rebel", async () => {
    const { game, a } = await newGame();
    a.buildUnit(UnitType.City, game.ref(5, 5), {});
    game.addExecution(new PlayerExecution(a));
    conquerRect(game, a, 10, 0, 30, 100); // 3000 tiles, connected
    runUntil(game, 1600);
    expect(a.unintegratedTiles()).toBe(0);
    expect(rebels(game)).toEqual([]);
  });

  test("a player can't suffer another rebellion within the cooldown", async () => {
    const { game, a } = await newGame();
    conquerRect(game, a, 40, 0, 60, 100);
    let first = 0;
    while (rebels(game).length === 0) {
      game.executeNextTick();
      first = game.ticks();
    }
    runUntil(game, first + 1750);
    expect(rebels(game)).toHaveLength(1);
    runUntil(game, first + 1900);
    expect(rebels(game)).toHaveLength(2);
  });

  test("rebellions survive a snapshot round trip", async () => {
    const { game, a } = await newGame();
    conquerRect(game, a, 40, 0, 60, 100);
    runUntil(game, 1150);
    // The rebellion happens on both sides of the restore, then plays on.
    const restored = await expectSnapshotRoundTrip(game, MAP, 200);
    expect(rebels(game)).toHaveLength(1);
    expect(
      restored.players().filter((p) => p.name().startsWith("a Rebels")),
    ).toHaveLength(1);
    await expectSnapshotRoundTrip(game, MAP, 30);
  });
});
