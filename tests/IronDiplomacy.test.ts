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
import { TestConfig } from "./util/TestConfig";

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

describe("alliance gold cost", () => {
  test("both humans pay the cost when the alliance forms", async () => {
    const { game, ps } = await humans(2);
    const [a, b] = ps;
    (game.config() as TestConfig).enableAllianceGoldCost();
    const cost = game.config().allianceGoldCost(a);
    expect(cost).toBeGreaterThanOrEqual(50_000n);
    a.addGold(cost + 7n);
    b.addGold(cost + 9n);

    game.addExecution(new AllianceRequestExecution(a, b.id()));
    game.executeNextTick();
    // Nothing is charged while the request is pending
    expect(a.gold()).toBe(cost + 7n);

    game.addExecution(new AllianceRequestExecution(b, a.id()));
    game.executeNextTick();
    expect(a.isAlliedWith(b)).toBe(true);
    expect(a.gold()).toBe(7n);
    expect(b.gold()).toBe(9n);
  });

  test("a rejected request costs nothing", async () => {
    const { game, ps } = await humans(2);
    const [a, b] = ps;
    (game.config() as TestConfig).enableAllianceGoldCost();
    a.addGold(1_000_000n);
    const req = (game as GameImpl).createAllianceRequest(a, b)!;
    req.reject();
    expect(a.gold()).toBe(1_000_000n);
  });

  test("blocks sending a request the player can't afford", async () => {
    const { game, ps } = await humans(2);
    const [a, b] = ps;
    (game.config() as TestConfig).enableAllianceGoldCost();
    a.addGold(game.config().allianceGoldCost(a) - 1n);
    expect(a.canSendAllianceRequest(b)).toBe(false);
    expect(a.allianceRequestBlocker(b)).toBe("gold");

    a.addGold(1n);
    expect(a.allianceRequestBlocker(b)).toBeNull();
    expect(a.canSendAllianceRequest(b)).toBe(true);
  });

  test("fails on acceptance if a human spent the gold meanwhile", async () => {
    const { game, ps } = await humans(2);
    const [a, b] = ps;
    (game.config() as TestConfig).enableAllianceGoldCost();
    a.addGold(game.config().allianceGoldCost(a));
    const req = (game as GameImpl).createAllianceRequest(a, b)!;
    b.addGold(game.config().allianceGoldCost(b));
    a.removeGold(1n);
    req.accept();
    expect(req.status()).toBe("rejected");
    expect(a.isAlliedWith(b)).toBe(false);
    expect(b.gold()).toBe(game.config().allianceGoldCost(b));
  });

  test("nations ally for free", async () => {
    const game = await setup("plains", {}, [
      playerInfo("n1", PlayerType.Nation),
    ]);
    const n = game.player("n1");
    expect(game.config().allianceGoldCost(n)).toBe(0n);
  });
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

describe("longer commitments", () => {
  test("default alliance lasts 10 minutes, traitor debuff 2 minutes", async () => {
    const { game, ps } = await humans(2);
    const [a, b] = ps;
    expect(game.config().allianceDuration()).toBe(600 * 10);
    ally(game, a, b);
    expect(a.allianceWith(b)!.expiresAt()).toBe(game.ticks() + 600 * 10);

    game.addExecution(new BreakAllianceExecution(a, b.id()));
    game.executeNextTick();
    game.executeNextTick();
    expect(a.isTraitor()).toBe(true);
    expect((a as PlayerImpl).getTraitorRemainingTicks()).toBeGreaterThan(
      110 * 10,
    );
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

describe("anti-snowball coalition", () => {
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

  test("nations refuse the dominant player even when it's a threat", async () => {
    const { game, leader, nation, alliance } = await stripes(
      Difficulty.Medium,
      DOMINANT,
    );
    leader.setTroops(1_000_000);
    nation.setTroops(100_000);
    const request = requestFrom(game, leader, nation);
    alliance.handleAllianceRequests();
    expect(request.accept).not.toHaveBeenCalled();
    expect(request.reject).toHaveBeenCalled();
  });

  test.each([
    [DOMINANT, true],
    [CONTESTED, false],
  ])(
    "nations ally with a distrusted player only against a dominant one",
    async (widths, expected) => {
      const { game, helper, nation, alliance } = await stripes(
        Difficulty.Medium,
        widths,
      );
      nation.updateRelation(helper, -30); // Distrustful
      const request = requestFrom(game, helper, nation);
      alliance.handleAllianceRequests();
      expect(vi.mocked(request.accept).mock.calls.length > 0).toBe(expected);
    },
  );

  test("nations walk out of alliances with the dominant player, no betrayal", async () => {
    const { game, leader, nation, alliance } = await stripes(
      Difficulty.Medium,
      DOMINANT,
    );
    ally(game, leader, nation);
    for (let i = 0; i < 500 && nation.isAlliedWith(leader); i++) {
      alliance.maybeLeaveDominantAlly();
    }
    expect(nation.isAlliedWith(leader)).toBe(false);
    expect(nation.isTraitor()).toBe(false);
    expect(nation.betrayals()).toBe(0);
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
