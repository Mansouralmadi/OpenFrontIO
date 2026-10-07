import { vi } from "vitest";
import { AttackLogicInput, Config } from "../src/core/configuration/Config";
import { AttackExecution } from "../src/core/execution/AttackExecution";
import { RebellionExecution } from "../src/core/execution/RebellionExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  TerrainType,
} from "../src/core/game/Game";
import { PlayerUpdate } from "../src/core/game/GameUpdates";
import { UserSettings } from "../src/core/game/UserSettings";
import { GameConfig } from "../src/core/Schemas";
import { setup } from "./util/Setup";
import { expectSnapshotRoundTrip } from "./util/Snapshot";

// Same layout as Rebellion.test.ts: plains is 100x100 land; a's 10x10 home
// is integrated (taken in the spawn phase), land conquered later isn't.
// Happiness stays 50 (no PlayerExecution): rebellions need 600 ticks of
// unintegration after a 1200-tick grace, and the warning window is 300.
const MAP = "plains";

async function newGame(
  homeW = 10,
  homeH = 10,
): Promise<{ game: Game; a: Player }> {
  const game = await setup(MAP, {}, [], undefined, undefined, false);
  const a = game.addPlayer(
    new PlayerInfo("a", PlayerType.Human, "client_a", "a"),
  );
  conquerRect(game, a, 0, 0, homeW, homeH);
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

// What the worker sends on a player's first emission.
const full = (p: Player) =>
  (p as unknown as { toFullUpdate(): PlayerUpdate }).toFullUpdate();

function rebelOf(game: Game): Player | undefined {
  return game.players().find((p) => p.name().startsWith("a Rebels"));
}

function runUntilRebellion(game: Game): Player {
  while (rebelOf(game) === undefined) game.executeNextTick();
  return rebelOf(game)!;
}

describe("unrest: attack modifiers", () => {
  const config = new Config({} as GameConfig, new UserSettings(), false);
  const base: AttackLogicInput = {
    terrain: TerrainType.Plains,
    attackTroops: 100_000,
    attacker: { type: PlayerType.Human, numTiles: 20_000 },
    defender: {
      type: PlayerType.Human,
      numTiles: 20_000,
      troops: 100_000,
      isTraitor: false,
      isDisconnectedTeammate: false,
    },
    defenderHasDefensePost: false,
    falloutRatio: null,
    borderSize: 100,
  };
  const run = (o: Partial<AttackLogicInput>) =>
    config.attackLogic({ ...base, ...o });

  test("unintegrated tiles cost x0.75 troops and fall x1.25 faster", () => {
    const plain = run({});
    const fresh = run({ tileUnintegrated: true });
    expect(fresh.attackerTroopLoss).toBeCloseTo(
      plain.attackerTroopLoss * 0.75,
      9,
    );
    expect(fresh.tickFraction).toBeCloseTo(plain.tickFraction * 0.8, 9);
    expect(fresh.defenderTroopLoss).toBe(plain.defenderTroopLoss);
  });

  test("stacks multiplicatively with a defense post", () => {
    const post = run({ defenderHasDefensePost: true });
    const both = run({ defenderHasDefensePost: true, tileUnintegrated: true });
    expect(both.attackerTroopLoss).toBeCloseTo(
      post.attackerTroopLoss * 0.75,
      9,
    );
    expect(both.tickFraction).toBeCloseTo(post.tickFraction * 0.8, 9);
  });

  test("revolutionary fervor: x1.5 troops, x0.75 speed", () => {
    const plain = run({});
    const fervor = run({ defender: { ...base.defender!, fervor: true } });
    expect(fervor.attackerTroopLoss).toBeCloseTo(
      plain.attackerTroopLoss * 1.5,
      9,
    );
    expect(fervor.tickFraction).toBeCloseTo(plain.tickFraction / 0.75, 9);
  });

  test("terra nullius is unaffected", () => {
    const tn = run({ defender: null });
    expect(run({ defender: null, tileUnintegrated: true })).toEqual(tn);
  });
});

describe("unrest: rebellions", () => {
  test("rebels take 1.5x their proportional troop share", async () => {
    // 4000 integrated home tiles, 5000 cut off (x 50..99): the rebellion
    // takes half the backlog, 2500 tiles of 9000.
    const { game, a } = await newGame(40, 100);
    conquerRect(game, a, 50, 0, 50, 100);
    const troops = a.troops();
    const rebel = runUntilRebellion(game);
    expect(rebel.numTilesOwned()).toBe(2500);
    const share = Math.floor((troops * 2500 * 1.5) / 9000);
    expect(rebel.troops()).toBe(share);
    expect(a.troops()).toBe(troops - share);
  });

  test("the owner keeps at least 30% of its troops", async () => {
    // 3000 of 6100 tiles: 1.5x would be ~74% of the owner's troops.
    const { game, a } = await newGame();
    conquerRect(game, a, 40, 0, 60, 100);
    const troops = a.troops();
    const rebel = runUntilRebellion(game);
    expect(rebel.numTilesOwned()).toBe(3000);
    const taken = Math.floor(troops * 0.7);
    expect(rebel.troops()).toBe(taken);
    expect(a.troops()).toBe(troops - taken);
  });

  test("fervor protects the rebels for 3 minutes, then expires", async () => {
    const { game, a } = await newGame();
    conquerRect(game, a, 40, 0, 60, 100);
    const rebel = runUntilRebellion(game);
    // The tick that just ran (ticks() has moved past it).
    const start = game.ticks() - 1;
    expect(rebel.fervorUntil()).toBe(start + 1800);

    // b borders the rebels' land (row 99 is theirs, x 70..99).
    const b = game.addPlayer(
      new PlayerInfo("b", PlayerType.Human, "client_b", "b"),
    );
    b.conquer(game.ref(98, 98));
    b.addTroops(100_000);
    const spy = vi.spyOn(game.config(), "attackLogic");
    const attackRebels = () => {
      spy.mockClear();
      game.addExecution(new AttackExecution(1000, b, rebel.id()));
      for (let i = 0; i < 5; i++) game.executeNextTick();
      // Only b's attack (the rebel AI expands too).
      const inputs = spy.mock.calls
        .map(([input]) => input)
        .filter((input) => input.attacker.type === PlayerType.Human);
      expect(inputs.length).toBeGreaterThan(0);
      return inputs;
    };

    for (const input of attackRebels()) {
      expect(input.defender?.fervor).toBe(true);
      // The rebels' land starts integrated.
      expect(input.tileUnintegrated).toBe(false);
    }
    while (game.ticks() < start + 1800) game.executeNextTick();
    expect(rebel.fervorUntil()).toBeLessThanOrEqual(game.ticks());
    // b may have been overrun meanwhile: give it a fresh foothold.
    b.conquer([...rebel.tiles()][0]);
    b.addTroops(100_000);
    for (const input of attackRebels()) {
      expect(input.defender?.fervor).toBe(false);
    }
    spy.mockRestore();
  });

  test("attacks on fresh conquests see unintegrated tiles", async () => {
    const { game, a } = await newGame();
    conquerRect(game, a, 40, 0, 20, 20);
    const b = game.addPlayer(
      new PlayerInfo("b", PlayerType.Human, "client_b", "b"),
    );
    b.conquer(game.ref(60, 10));
    b.addTroops(100_000);
    const spy = vi.spyOn(game.config(), "attackLogic");
    game.addExecution(new AttackExecution(1000, b, a.id()));
    for (let i = 0; i < 5; i++) game.executeNextTick();
    const inputs = spy.mock.calls.map(([input]) => input);
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.every((i) => i.tileUnintegrated === true)).toBe(true);
    spy.mockRestore();
  });
});

describe("unrest: warning", () => {
  test("warns before a rebellion with the region, ETA and center", async () => {
    const { game, a } = await newGame();
    conquerRect(game, a, 40, 0, 60, 100);
    const messages = vi.spyOn(game, "displayMessage");

    while (a.unrest() === null) {
      game.executeNextTick();
      expect(rebelOf(game)).toBeUndefined();
    }
    const warnedAt = game.ticks();
    const unrest = a.unrest()!;
    // Within the 30s window before the 1200-tick grace ends.
    expect(warnedAt).toBeGreaterThanOrEqual(900);
    expect(unrest.tiles).toBe(3000);
    expect(unrest.tick).toBeGreaterThan(warnedAt);
    expect(unrest.tick - warnedAt).toBeLessThanOrEqual(300);
    expect(game.owner(unrest.tile)).toBe(a);
    const warnings = () =>
      messages.mock.calls.filter(
        (c) => c[0] === "events_display.unrest_warning",
      );
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0][2]).toBe(a.id());

    const rebel = runUntilRebellion(game);
    // It rebels when announced, with the announced region.
    expect(game.ticks() - 1).toBe(unrest.tick);
    expect(rebel.numTilesOwned()).toBe(unrest.tiles);
    expect(game.owner(unrest.tile)).toBe(rebel);
    // And the warning clears (the rest waits out the cooldown).
    expect(a.unrest()).toBeNull();
    expect(warnings()).toHaveLength(1);
    messages.mockRestore();
  });

  test("no warning for regions too small to rebel", async () => {
    const { game, a } = await newGame();
    conquerRect(game, a, 40, 40, 10, 10);
    while (game.ticks() < 1600) {
      game.executeNextTick();
      expect(a.unrest()).toBeNull();
    }
  });

  test("player updates carry fervor and unrest", async () => {
    const { game, a } = await newGame();
    conquerRect(game, a, 40, 0, 60, 100);
    while (a.unrest() === null) game.executeNextTick();
    const u = full(a);
    expect(u.unrestTiles).toBe(a.unrest()!.tiles);
    expect(u.unrestTick).toBe(a.unrest()!.tick);
    expect(u.unrestTile).toBe(a.unrest()!.tile);
    const rebel = runUntilRebellion(game);
    expect(full(rebel).fervorUntil).toBe(rebel.fervorUntil());
    expect(full(a).unrestTiles).toBe(0);
  });

  test("fervor and unrest survive a snapshot round trip", async () => {
    const { game, a } = await newGame();
    conquerRect(game, a, 40, 0, 60, 100);
    while (a.unrest() === null) game.executeNextTick();
    // Warning live at the snapshot; the rebellion (and fervor) follow.
    const restored = await expectSnapshotRoundTrip(game, MAP, 400);
    expect(restored.player(a.id()).unrest()).toEqual(a.unrest());
    const rebel = rebelOf(game)!;
    expect(rebel.fervorUntil()).toBeGreaterThan(game.ticks());
    const restoredRebel = await expectSnapshotRoundTrip(game, MAP, 10);
    expect(restoredRebel.player(rebel.id()).fervorUntil()).toBe(
      rebel.fervorUntil(),
    );
  });
});

describe("happiness breakdown", () => {
  const config = new Config({} as GameConfig, new UserSettings(), false);
  test("terms add up to happiness()", () => {
    for (const farms of [0, 3, 5, 12])
      for (const [unintegrated, tiles] of [
        [0, 1000],
        [300, 1000],
        [900, 1000],
        [0, 0],
      ])
        for (const since of [0, 700, 1200, Infinity]) {
          const b = config.happinessBreakdown(
            farms,
            unintegrated,
            tiles,
            since,
          );
          expect(b.total).toBe(
            Math.min(100, Math.max(0, b.base + b.farms - b.penalty)),
          );
          expect(b.total).toBe(
            config.happiness(farms, unintegrated, tiles, since),
          );
          expect(b.penalty).toBeLessThanOrEqual(b.fullPenalty);
        }
  });

  test("ramping while the penalty phases in", () => {
    const early = config.happinessBreakdown(0, 500, 1000, 900);
    expect(early.ramping).toBe(true);
    expect(early.penalty).toBeLessThan(early.fullPenalty);
    const late = config.happinessBreakdown(0, 500, 1000);
    expect(late.ramping).toBe(false);
    expect(late.penalty).toBe(late.fullPenalty);
  });
});
