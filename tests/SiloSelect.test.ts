import { ConstructionExecution } from "../src/core/execution/ConstructionExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  Unit,
  UnitType,
} from "../src/core/game/Game";
import { GameUpdateType } from "../src/core/game/GameUpdates";
import { setup } from "./util/Setup";

let game: Game;
let me: Player;
let enemy: Player;
let near: Unit;
let far: Unit;

function conquerRect(
  p: Player,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) {
  for (let x = x0; x < x1; x++) {
    for (let y = y0; y < y1; y++) {
      const t = game.ref(x, y);
      if (game.isLand(t)) p.conquer(t);
    }
  }
}

function launch(unit: UnitType, x: number, y: number, silo?: number) {
  game.addExecution(
    new ConstructionExecution(me, unit, game.ref(x, y), true, undefined, silo),
  );
  const messages: string[] = [];
  for (let i = 0; i < 3; i++) {
    const updates = game.executeNextTick();
    for (const e of updates[GameUpdateType.DisplayEvent] ?? []) {
      messages.push(e.message);
    }
  }
  return messages;
}

describe("Choosing the launching silo", () => {
  beforeEach(async () => {
    game = await setup("plains", { instantBuild: true }, [
      new PlayerInfo("me", PlayerType.Human, null, "me"),
      new PlayerInfo("enemy", PlayerType.Human, null, "enemy"),
    ]);
    me = game.player("me");
    enemy = game.player("enemy");
    conquerRect(me, 0, 0, 90, 12);
    conquerRect(enemy, 40, 60, 60, 80);
    me.addGold(100_000_000n);
    enemy.addGold(100_000_000n);
    near = me.buildUnit(UnitType.MissileSilo, game.ref(48, 5), {});
    far = me.buildUnit(UnitType.MissileSilo, game.ref(5, 5), {});
  });

  test("launches from the chosen silo; only that silo reloads", () => {
    const gold = me.gold();
    launch(UnitType.AtomBomb, 50, 70, far.id());
    const bombs = me.units(UnitType.AtomBomb);
    expect(bombs).toHaveLength(1);
    // Spawned on the far silo and has not moved far from it yet.
    expect(game.manhattanDist(bombs[0].tile(), far.tile())).toBeLessThan(
      game.manhattanDist(bombs[0].tile(), near.tile()),
    );
    expect(far.isInCooldown()).toBe(true);
    expect(near.isInCooldown()).toBe(false);
    expect(me.gold()).toBeLessThan(gold);
  });

  test("without a silo the nearest ready one fires (unchanged)", () => {
    launch(UnitType.AtomBomb, 50, 70);
    expect(me.units(UnitType.AtomBomb)).toHaveLength(1);
    expect(near.isInCooldown()).toBe(true);
    expect(far.isInCooldown()).toBe(false);
  });

  test("a chosen silo on cooldown refuses instead of using another", () => {
    launch(UnitType.AtomBomb, 50, 70, far.id());
    const gold = me.gold();
    expect(launch(UnitType.AtomBomb, 55, 75, far.id())).toContain(
      "events_display.silo_launch_failed_reloading",
    );
    expect(me.units(UnitType.AtomBomb)).toHaveLength(1);
    expect(near.isInCooldown()).toBe(false);
    // No nuke was bought (gold only grew from income).
    expect(me.gold()).toBeGreaterThanOrEqual(gold);
  });

  test("an enemy's silo or a non-silo unit refuses and spends no gold", () => {
    conquerRect(enemy, 60, 20, 80, 30);
    const enemySilo = enemy.buildUnit(
      UnitType.MissileSilo,
      game.ref(70, 25),
      {},
    );
    const city = me.buildUnit(UnitType.City, game.ref(20, 5), {});
    const gold = me.gold();
    expect(launch(UnitType.AtomBomb, 50, 70, enemySilo.id())).toContain(
      "events_display.silo_launch_failed_lost",
    );
    launch(UnitType.HydrogenBomb, 50, 70, city.id());
    launch(UnitType.MIRV, 50, 70, 987654);
    expect(me.units(UnitType.AtomBomb)).toHaveLength(0);
    expect(me.units(UnitType.HydrogenBomb)).toHaveLength(0);
    expect(me.units(UnitType.MIRV)).toHaveLength(0);
    expect(enemySilo.isInCooldown()).toBe(false);
    expect(near.isInCooldown()).toBe(false);
    expect(far.isInCooldown()).toBe(false);
    // No nuke was bought (gold only grew from income).
    expect(me.gold()).toBeGreaterThanOrEqual(gold);
  });

  test("a captured chosen silo refuses", () => {
    enemy.conquer(far.tile());
    enemy.captureUnit(far);
    expect(far.owner()).toBe(enemy);
    const id = far.id();
    const gold = me.gold();
    launch(UnitType.AtomBomb, 50, 70, id);
    expect(me.units(UnitType.AtomBomb)).toHaveLength(0);
    // No nuke was bought (gold only grew from income).
    expect(me.gold()).toBeGreaterThanOrEqual(gold);
  });

  test("MIRV launches from the chosen silo", () => {
    launch(UnitType.MIRV, 50, 70, far.id());
    expect(me.units(UnitType.MIRV)).toHaveLength(1);
    expect(far.isInCooldown()).toBe(true);
    expect(near.isInCooldown()).toBe(false);
  });
});
