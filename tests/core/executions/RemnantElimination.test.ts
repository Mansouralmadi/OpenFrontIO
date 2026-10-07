import { beforeEach, describe, expect, test, vi } from "vitest";
import { PlayerExecution } from "../../../src/core/execution/PlayerExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../../src/core/game/Game";
import { setup } from "../../util/Setup";

// big_plains: all land, no water. setup() already ended the spawn phase.
let game: Game;
let a: Player;
let victim: Player;

function rect(p: Player, x0: number, y0: number, w: number, h: number) {
  for (let x = x0; x < x0 + w; x++) {
    for (let y = y0; y < y0 + h; y++) p.conquer(game.ref(x, y));
  }
}

function releaseRect(p: Player, x0: number, y0: number, w: number, h: number) {
  for (let x = x0; x < x0 + w; x++) {
    for (let y = y0; y < y0 + h; y++) {
      if (game.ownerID(game.ref(x, y)) === p.smallID()) {
        p.relinquish(game.ref(x, y));
      }
    }
  }
}

function run(ticks: number) {
  for (let i = 0; i < ticks; i++) game.executeNextTick();
}

// The cluster checks run after the owner's territory changes, and the first
// run is staggered up to 20 ticks out (see AnnexationRequiresEnclosure).
function runClusterCheck(p: Player) {
  run(25);
  p.conquer(game.ref(0, 0));
  p.relinquish(game.ref(0, 0));
  run(45);
}

beforeEach(async () => {
  game = await setup("big_plains", {}, [
    new PlayerInfo("a", PlayerType.Human, "client_a", "a"),
    new PlayerInfo("victim", PlayerType.Human, "client_v", "victim"),
  ]);
  a = game.player("a");
  victim = game.player("victim");
  a.setTroops(100_000);
  victim.setTroops(100_000);
});

describe("remnant elimination", () => {
  // Past the opening grace period.
  const lateGame = () =>
    vi.spyOn(game, "ticksSinceStart").mockReturnValue(10 * 60 * 10);

  function nukedVictim() {
    // The victim once held 30x30, now only a 3x3 scrap next to a and
    // unclaimed land (fallout) everywhere else.
    rect(victim, 40, 40, 30, 30);
    releaseRect(victim, 40, 40, 30, 30);
    rect(victim, 50, 50, 3, 3);
    rect(a, 49, 50, 1, 3);
  }

  test("a stalled country down to a sliver of its peak is finished off", () => {
    lateGame();
    nukedVictim();
    expect(victim.peakTiles()).toBe(900);
    game.addExecution(new PlayerExecution(a), new PlayerExecution(victim));
    run(5);
    expect(victim.isAlive()).toBe(true); // land changed just now
    run(310);
    expect(victim.isAlive()).toBe(false);
    // The pieces touching a go to a, settled.
    expect(game.ownerID(game.ref(52, 52))).toBe(a.smallID());
    expect(game.isUnintegrated(game.ref(52, 52))).toBe(false);
  });

  test("with no enemy next to it, the scraps go back to unclaimed land", () => {
    lateGame();
    rect(victim, 40, 40, 30, 30);
    releaseRect(victim, 40, 40, 30, 30);
    rect(victim, 50, 50, 3, 3);
    game.addExecution(new PlayerExecution(victim));
    run(320);
    expect(victim.isAlive()).toBe(false);
    expect(game.hasOwner(game.ref(51, 51))).toBe(false);
  });

  test("a small country that never shrank survives", () => {
    lateGame();
    rect(victim, 50, 50, 7, 7); // about a spawn's worth
    rect(a, 49, 50, 1, 7);
    game.addExecution(new PlayerExecution(a), new PlayerExecution(victim));
    run(320);
    expect(victim.isAlive()).toBe(true);
  });

  test("not during the opening grace period", () => {
    nukedVictim();
    expect(game.ticksSinceStart()).toBeLessThan(2 * 60 * 10);
    game.addExecution(new PlayerExecution(a), new PlayerExecution(victim));
    run(320);
    expect(victim.isAlive()).toBe(true);
  });

  test("not while it has a boat at sea", () => {
    lateGame();
    nukedVictim();
    vi.spyOn(victim, "units").mockImplementation((...types) =>
      types.includes(UnitType.TransportShip) ? [{} as never] : [],
    );
    game.addExecution(new PlayerExecution(a), new PlayerExecution(victim));
    run(320);
    expect(victim.isAlive()).toBe(true);
  });
});

describe("scrap cleanup", () => {
  function mainAndScrap(scrapSize: number) {
    rect(victim, 10, 10, 20, 20); // main territory
    rect(a, 60, 60, 1, scrapSize); // a borders the scrap on the west
    rect(victim, 61, 60, 1, scrapSize);
  }

  test("a tiny cut-off piece goes to the enemy beside it", () => {
    mainAndScrap(4);
    game.addExecution(new PlayerExecution(victim));
    runClusterCheck(victim);
    expect(game.ownerID(game.ref(61, 61))).toBe(a.smallID());
    expect(game.ownerID(game.ref(15, 15))).toBe(victim.smallID());
  });

  test("a piece bigger than a scrap stays", () => {
    mainAndScrap(30);
    game.addExecution(new PlayerExecution(victim));
    runClusterCheck(victim);
    expect(game.ownerID(game.ref(61, 61))).toBe(victim.smallID());
  });

  test("a scrap with a structure on it stays", () => {
    mainAndScrap(4);
    victim.buildUnit(UnitType.DefensePost, game.ref(61, 61), {});
    game.addExecution(new PlayerExecution(victim));
    runClusterCheck(victim);
    expect(game.ownerID(game.ref(61, 61))).toBe(victim.smallID());
  });
});
