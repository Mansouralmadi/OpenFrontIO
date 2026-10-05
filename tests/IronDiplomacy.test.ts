import { MAX_ALLIANCES } from "../src/core/configuration/DiplomacyConstants";
import { AllianceRequestExecution } from "../src/core/execution/alliance/AllianceRequestExecution";
import { BreakAllianceExecution } from "../src/core/execution/alliance/BreakAllianceExecution";
import { AttackExecution } from "../src/core/execution/AttackExecution";
import { NationAllianceBehavior } from "../src/core/execution/nation/NationAllianceBehavior";
import { NationEmojiBehavior } from "../src/core/execution/nation/NationEmojiBehavior";
import {
  findDominantPlayer,
  findRunawayLeader,
} from "../src/core/execution/nation/NationUtils";
import { AiAttackBehavior } from "../src/core/execution/utils/AiAttackBehavior";
import {
  AllianceRequest,
  Difficulty,
  Game,
  GameMode,
  Player,
  PlayerInfo,
  PlayerType,
  Relation,
  Tick,
} from "../src/core/game/Game";
import { GameImpl } from "../src/core/game/GameImpl";
import { GameUpdateType } from "../src/core/game/GameUpdates";
import { PlayerImpl } from "../src/core/game/PlayerImpl";
import { PseudoRandom } from "../src/core/PseudoRandom";
import { playerInfo, setup } from "./util/Setup";
import { expectSnapshotRoundTrip } from "./util/Snapshot";

async function humans(n: number): Promise<{ game: Game; ps: Player[] }> {
  const names = Array.from({ length: n }, (_, i) => `p${i + 1}`);
  const game = await setup(
    "plains",
    { infiniteGold: false },
    names.map((name) => playerInfo(name, PlayerType.Human)),
  );
  const ps = names.map((name, i) => {
    const p = game.player(name);
    p.conquer(game.ref(i, 0));
    return p;
  });
  return { game, ps };
}

function ally(game: Game, a: Player, b: Player) {
  (game as GameImpl).createAllianceRequest(a, b)!.accept();
  expect(a.isAlliedWith(b)).toBe(true);
}

test("alliances are free", async () => {
  const { game, ps } = await humans(2);
  const [a, b] = ps;
  a.addGold(1_000n);
  b.addGold(2_000n);
  game.addExecution(new AllianceRequestExecution(a, b.id()));
  game.executeNextTick();
  game.addExecution(new AllianceRequestExecution(b, a.id()));
  game.executeNextTick();
  expect(a.isAlliedWith(b)).toBe(true);
  expect(a.gold()).toBeGreaterThanOrEqual(1_000n);
  expect(b.gold()).toBeGreaterThanOrEqual(2_000n);
});

describe("alliance slots", () => {
  test(`a player can hold at most ${MAX_ALLIANCES} alliances`, async () => {
    const { game, ps } = await humans(MAX_ALLIANCES + 2);
    const [a, ...others] = ps;
    for (let i = 0; i < MAX_ALLIANCES; i++) ally(game, a, others[i]);

    const outsider = others[MAX_ALLIANCES];
    expect(a.canSendAllianceRequest(outsider)).toBe(false);
    expect(a.allianceRequestBlocker(outsider)).toBe("slots_self");
    expect(outsider.canSendAllianceRequest(a)).toBe(false);
    expect(outsider.allianceRequestBlocker(a)).toBe("slots_other");

    // The request intent is refused with a message saying why
    game.addExecution(new AllianceRequestExecution(outsider, a.id()));
    const updates = game.executeNextTick();
    expect(outsider.outgoingAllianceRequests()).toHaveLength(0);
    const messages =
      updates[GameUpdateType.DisplayEvent]?.map((e) => e.message) ?? [];
    expect(messages).toContain("player_panel.alliance_blocked_slots_other");
  });

  test("a pending request fails if slots fill up before it is accepted", async () => {
    const { game, ps } = await humans(MAX_ALLIANCES + 2);
    const [a, ...others] = ps;
    const late = (game as GameImpl).createAllianceRequest(
      others[MAX_ALLIANCES],
      a,
    )!;
    for (let i = 0; i < MAX_ALLIANCES; i++) ally(game, a, others[i]);

    late.accept();
    expect(late.status()).toBe("rejected");
    expect(a.isAlliedWith(others[MAX_ALLIANCES])).toBe(false);
    expect(a.alliances()).toHaveLength(MAX_ALLIANCES);
  });
});

describe("durations", () => {
  test("default alliance lasts 5 minutes, traitor debuff 1 minute", async () => {
    const { game, ps } = await humans(2);
    const [a, b] = ps;
    expect(game.config().allianceDuration()).toBe(300 * 10);
    ally(game, a, b);
    expect(a.allianceWith(b)!.expiresAt()).toBe(game.ticks() + 300 * 10);

    game.addExecution(new BreakAllianceExecution(a, b.id()));
    game.executeNextTick();
    game.executeNextTick();
    expect(a.isTraitor()).toBe(true);
    const remaining = (a as PlayerImpl).getTraitorRemainingTicks();
    expect(remaining).toBeGreaterThan(50 * 10);
    expect(remaining).toBeLessThanOrEqual(60 * 10);
  });
});

// Full-height stripes, left to right: helper | leader | nation | runnerUp.
async function stripes(
  difficulty: Difficulty,
  widths: [number, number, number, number],
) {
  const game = await setup(
    "big_plains",
    { difficulty, gameMode: GameMode.FFA },
    [
      new PlayerInfo("helper", PlayerType.Human, null, "helper_id"),
      new PlayerInfo("leader", PlayerType.Human, null, "leader_id"),
      new PlayerInfo("nation", PlayerType.Nation, null, "nation_id"),
      new PlayerInfo("runnerUp", PlayerType.Human, null, "runner_up_id"),
    ],
  );
  const players = ["helper_id", "leader_id", "nation_id", "runner_up_id"].map(
    (id) => game.player(id),
  );
  for (let x = 0; x < game.map().width(); x++) {
    let stripe = 0;
    let edge = widths[0];
    while (x >= edge && stripe < widths.length - 1) edge += widths[++stripe];
    for (let y = 0; y < game.map().height(); y++) {
      const tile = game.ref(x, y);
      if (game.map().isLand(tile)) players[stripe].conquer(tile);
    }
  }
  const [helper, leader, nation, runnerUp] = players;
  const emoji = new NationEmojiBehavior(new PseudoRandom(42), game, nation);
  const alliance = new NationAllianceBehavior(
    new PseudoRandom(42),
    game,
    nation,
    emoji,
  );
  const attack = new AiAttackBehavior(
    new PseudoRandom(42),
    game,
    nation,
    0.5,
    0.3,
    0.2,
    alliance,
    emoji,
  );
  return { game, helper, leader, nation, runnerUp, alliance, attack };
}

function requestFrom(game: Game, requestor: Player, recipient: Player) {
  const request = {
    requestor: () => requestor,
    recipient: () => recipient,
    createdAt: () => (game.config().numSpawnPhaseTurns() + 2) as Tick,
    accept: vi.fn(),
    reject: vi.fn(),
  } as unknown as AllianceRequest;
  vi.spyOn(recipient, "incomingAllianceRequests").mockReturnValue([request]);
  return request;
}

// Leader owns 62% of the land, 2.5x the runner-up: dominant, but short of
// the 3x a Medium runaway leader needs.
const DOMINANT: [number, number, number, number] = [10, 125, 15, 50];
// 50% of the land but only 1.4x the runner-up: not dominant.
const CONTESTED: [number, number, number, number] = [10, 100, 20, 70];

describe("betrayal reputation", () => {
  test("a betrayal is counted and lowers every nation's relation", async () => {
    const { game, helper, leader, nation } = await stripes(
      Difficulty.Medium,
      CONTESTED,
    );
    ally(game, helper, leader);
    expect(nation.relation(helper)).toBe(Relation.Neutral);

    game.addExecution(new BreakAllianceExecution(helper, leader.id()));
    game.executeNextTick();
    game.executeNextTick();
    expect(helper.betrayals()).toBe(1);
    // The nation wasn't involved and isn't the helper's neighbor
    expect(nation.relation(helper)).toBeLessThan(Relation.Neutral);
  });

  // The leader is a big threat, which nations normally ally with at once
  async function decide(betrayals: number, seed: number): Promise<boolean> {
    const { game, leader, nation } = await stripes(
      Difficulty.Medium,
      CONTESTED,
    );
    game.config().traitorDuration = () => 0; // isolate the lasting part
    for (let i = 0; i < betrayals; i++) leader.markTraitor();
    leader.setTroops(1_000_000);
    nation.setTroops(100_000);
    const behavior = new NationAllianceBehavior(
      new PseudoRandom(seed),
      game,
      nation,
      new NationEmojiBehavior(new PseudoRandom(seed), game, nation),
    );
    const request = requestFrom(game, leader, nation);
    behavior.handleAllianceRequests();
    return vi.mocked(request.accept).mock.calls.length > 0;
  }

  test("each betrayal halves acceptance, two make nations refuse", async () => {
    const seeds = Array.from({ length: 24 }, (_, i) => i + 1);
    const accepted = async (betrayals: number) => {
      let n = 0;
      for (const seed of seeds) if (await decide(betrayals, seed)) n++;
      return n;
    };
    const clean = await accepted(0);
    const once = await accepted(1);
    const twice = await accepted(2);
    expect(clean).toBeGreaterThanOrEqual(seeds.length - 3);
    expect(once).toBeGreaterThan(0);
    expect(once).toBeLessThan(clean - 4);
    expect(twice).toBe(0);
  });
});

describe("power politics", () => {
  test("findDominantPlayer: a large land share, clearly ahead", async () => {
    const dominant = await stripes(Difficulty.Medium, DOMINANT);
    expect(findDominantPlayer(dominant.game)).toBe(dominant.leader);
    // Too small a lead for a Medium runaway leader
    expect(findRunawayLeader(dominant.game)).toBeNull();

    const contested = await stripes(Difficulty.Medium, CONTESTED);
    expect(findDominantPlayer(contested.game)).toBeNull();

    const easy = await stripes(Difficulty.Easy, DOMINANT);
    expect(findDominantPlayer(easy.game)).toBeNull();
  });

  test("small nations want a much bigger (even dominant) protector", async () => {
    const { game, leader, nation, alliance } = await stripes(
      Difficulty.Medium,
      DOMINANT,
    );
    nation.updateRelation(leader, -30); // Distrustful, but not Hostile
    const request = requestFrom(game, leader, nation);
    alliance.handleAllianceRequests();
    expect(request.accept).toHaveBeenCalled();
  });

  test("small nations still refuse a protector they hate", async () => {
    const { game, leader, nation, alliance } = await stripes(
      Difficulty.Impossible,
      DOMINANT,
    );
    nation.updateRelation(leader, -100); // Hostile
    const request = requestFrom(game, leader, nation);
    alliance.handleAllianceRequests();
    expect(request.accept).not.toHaveBeenCalled();
  });

  // Leader 80 and nation 70 columns of 200: two great powers of similar size
  const RIVALS: [number, number, number, number] = [20, 80, 70, 30];

  test("rival great powers rarely ally, and only when friendly", async () => {
    const seeds = Array.from({ length: 30 }, (_, i) => i + 1);
    let neutral = 0;
    let friendly = 0;
    for (const seed of seeds) {
      for (const relation of [0, 100]) {
        const { game, leader, nation } = await stripes(
          Difficulty.Impossible,
          RIVALS,
        );
        nation.updateRelation(leader, relation);
        const behavior = new NationAllianceBehavior(
          new PseudoRandom(seed),
          game,
          nation,
          new NationEmojiBehavior(new PseudoRandom(seed), game, nation),
        );
        const request = requestFrom(game, leader, nation);
        behavior.handleAllianceRequests();
        if (vi.mocked(request.accept).mock.calls.length > 0) {
          if (relation === 0) neutral++;
          else friendly++;
        }
      }
    }
    expect(neutral).toBe(0);
    expect(friendly).toBeGreaterThan(0);
    expect(friendly).toBeLessThan(seeds.length / 2);
  });

  test("Medium nations join attacks on a dominant (not runaway) leader", async () => {
    const { game, helper, leader, nation, runnerUp, attack } = await stripes(
      Difficulty.Medium,
      DOMINANT,
    );
    nation.setTroops(Math.floor(game.config().maxTroops(nation) * 0.7));
    runnerUp.setTroops(Math.floor(nation.troops() * 0.8));
    leader.setTroops(1_000_000);
    helper.setTroops(300_000);
    game.addExecution(new AttackExecution(200_000, helper, leader.id()));
    game.executeNextTick();

    const spy = vi.spyOn(game, "addExecution");
    attack.maybeAttack();
    const onLeader = spy.mock.calls
      .map((c) => c[0])
      .filter(
        (e) => e instanceof AttackExecution && e.targetID() === leader.id(),
      );
    expect(onLeader.length).toBeGreaterThan(0);
  });
});

describe("allies join wars", () => {
  // helper | leader | nation | runnerUp: the nation and its ally the helper
  // both border the leader.
  async function allied() {
    const s = await stripes(Difficulty.Hard, CONTESTED);
    const { game, helper, leader, nation, runnerUp } = s;
    ally(game, helper, nation);
    nation.setTroops(Math.floor(game.config().maxTroops(nation) * 0.7));
    leader.setTroops(Math.floor(nation.troops() * 0.5));
    runnerUp.setTroops(Math.floor(nation.troops() * 0.3));
    helper.setTroops(300_000);
    return s;
  }

  function attacksOn(spy: { mock: { calls: unknown[][] } }, target: Player) {
    return spy.mock.calls
      .map((c) => c[0])
      .filter(
        (e) => e instanceof AttackExecution && e.targetID() === target.id(),
      );
  }

  test("a nation joins its ally's attack and tells the ally", async () => {
    const { game, helper, leader, attack } = await allied();
    game.addExecution(new AttackExecution(100_000, helper, leader.id()));
    game.executeNextTick();

    const spy = vi.spyOn(game, "addExecution");
    const display = vi.spyOn(game, "displayMessage");
    attack.maybeAttack();
    expect(attacksOn(spy, leader).length).toBeGreaterThan(0);
    expect(display).toHaveBeenCalledWith(
      "events_display.ally_joined_war",
      expect.anything(),
      helper.id(),
      undefined,
      expect.anything(),
      undefined,
      expect.anything(),
    );
  });

  test("a nation defends an ally under attack", async () => {
    const { game, helper, leader, attack } = await allied();
    leader.setTroops(leader.troops() + 100_000);
    game.addExecution(new AttackExecution(100_000, leader, helper.id()));
    game.executeNextTick();

    const spy = vi.spyOn(game, "addExecution");
    const display = vi.spyOn(game, "displayMessage");
    attack.maybeAttack();
    expect(attacksOn(spy, leader).length).toBeGreaterThan(0);
    expect(display).toHaveBeenCalledWith(
      "events_display.ally_joined_war",
      expect.anything(),
      helper.id(),
      undefined,
      expect.anything(),
      undefined,
      expect.anything(),
    );
  });

  test("a nation in its own war stays out", async () => {
    const { game, helper, leader, nation, runnerUp, attack } = await allied();
    game.addExecution(new AttackExecution(100_000, helper, leader.id()));
    runnerUp.setTroops(runnerUp.troops() + 50_000);
    game.addExecution(new AttackExecution(50_000, runnerUp, nation.id()));
    game.executeNextTick();

    const display = vi.spyOn(game, "displayMessage");
    attack.maybeAttack();
    expect(display).not.toHaveBeenCalledWith(
      "events_display.ally_joined_war",
      expect.anything(),
      expect.anything(),
      undefined,
      expect.anything(),
      undefined,
      expect.anything(),
    );
  });

  test("a nation low on troops stays out", async () => {
    const { game, helper, leader, nation, attack } = await allied();
    nation.setTroops(Math.floor(game.config().maxTroops(nation) * 0.1));
    game.addExecution(new AttackExecution(100_000, helper, leader.id()));
    game.executeNextTick();

    const spy = vi.spyOn(game, "addExecution");
    attack.maybeAttack();
    expect(attacksOn(spy, leader)).toHaveLength(0);
  });
});

describe("diplomacy snapshot", () => {
  test("betrayals and reputation-lowered relations round-trip", async () => {
    const { game, ps } = await humans(2);
    const [a, b] = ps;
    const n = game.addPlayer(playerInfo("nation", PlayerType.Nation));
    n.conquer(game.ref(5, 5));
    ally(game, a, b);
    game.addExecution(new BreakAllianceExecution(a, b.id()));
    game.executeNextTick();
    game.executeNextTick();
    expect(a.betrayals()).toBe(1);

    const restored = await expectSnapshotRoundTrip(game, "plains", 5);
    const ra = restored.player(a.id());
    expect(ra.betrayals()).toBe(1);
    expect(ra.isTraitor()).toBe(true);
    expect(restored.player("nation").relation(ra)).toBe(
      n.relation(game.player(a.id())),
    );
  });
});
