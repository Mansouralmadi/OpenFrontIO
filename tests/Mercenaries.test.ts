import { HireMercenariesExecution } from "../src/core/execution/HireMercenariesExecution";
import { PlayerExecution } from "../src/core/execution/PlayerExecution";
import { Game, Player, PlayerInfo, PlayerType } from "../src/core/game/Game";
import { setup } from "./util/Setup";
import { diffGraphs, roundTrip } from "./util/Snapshot";

const MAP = "plains";

async function game(): Promise<{ game: Game; p: Player }> {
  const game = await setup(
    MAP,
    { infiniteGold: false },
    [],
    undefined,
    undefined,
    false,
  );
  const p = game.addPlayer(
    new PlayerInfo("merc", PlayerType.Human, "client_merc", "merc"),
  );
  for (let x = 0; x < 20; x++) {
    for (let y = 0; y < 20; y++) p.conquer(game.ref(x, y));
  }
  game.endSpawnPhase();
  return { game, p };
}

// Executions are initialized on the next tick and run on the one after.
function hire(g: Game, p: Player) {
  g.addExecution(new HireMercenariesExecution(p));
  g.executeNextTick();
  g.executeNextTick();
}

describe("mercenaries", () => {
  test("a hire costs gold and adds a quarter of max troops above the cap", async () => {
    const { game: g, p } = await game();
    const max = Math.floor(g.config().maxTroops(p));
    p.setTroops(max);
    const batch = g.config().mercenaryBatch(p);
    const price = g.config().mercenaryPrice(p);
    expect(batch).toBe(Math.floor(g.config().maxTroops(p) / 4));
    expect(price).toBe(BigInt(batch));
    p.addGold(price + 5n);

    hire(g, p);
    expect(p.gold()).toBe(5n);
    expect(p.mercenaries()).toBe(batch);
    expect(p.troops()).toBe(max + batch);
  });

  test("blocked without the gold or during the spawn phase", async () => {
    const { game: g, p } = await game();
    p.addGold(g.config().mercenaryPrice(p) - 1n);
    expect(p.canHireMercenaries()).toBe(false);
    hire(g, p);
    expect(p.mercenaries()).toBe(0);

    const spawning = await setup(
      MAP,
      { infiniteGold: true },
      [],
      undefined,
      undefined,
      false,
    );
    const q = spawning.addPlayer(
      new PlayerInfo("q", PlayerType.Human, "client_q", "q"),
    );
    q.conquer(spawning.ref(50, 50));
    expect(spawning.inSpawnPhase()).toBe(true);
    expect(q.canHireMercenaries()).toBe(false);
  });

  test("the price rises 50% per hire in the last 5 minutes", async () => {
    const { game: g, p } = await game();
    p.addGold(100_000_000n);
    const base = g.config().mercenaryPrice(p);
    hire(g, p);
    expect(p.recentMercenaryHires()).toBe(1);
    const second = g.config().mercenaryPrice(p);
    expect(second).toBe(BigInt(Math.floor(Number(base) * 1.5)));
    hire(g, p);
    expect(g.config().mercenaryPrice(p)).toBe(BigInt(Number(base) * 2));

    for (let i = 0; i < g.config().mercenaryPriceWindowTicks(); i++) {
      g.executeNextTick();
    }
    expect(p.recentMercenaryHires()).toBe(0);
  });

  test("troop growth ignores mercenaries, so they don't melt to the cap", async () => {
    const { game: g, p } = await game();
    g.addExecution(new PlayerExecution(p));
    p.setTroops(Math.floor(g.config().maxTroops(p)));
    p.addGold(100_000_000n);
    hire(g, p);
    const after = p.troops();
    for (let i = 0; i < 50; i++) g.executeNextTick();
    expect(p.troops()).toBeGreaterThanOrEqual(after - 1);
  });

  test("spent troops come out of the pool first; the rest disband at contract end", async () => {
    const { game: g, p } = await game();
    g.addExecution(new PlayerExecution(p));
    p.setTroops(10_000);
    p.addGold(100_000_000n);
    hire(g, p);
    const pool = p.mercenaries();

    const spent = Math.floor(pool / 2);
    p.removeTroops(spent);
    expect(p.mercenaries()).toBe(pool - spent);
    const own = p.troops() - p.mercenaries();

    for (let i = 0; i < g.config().mercenaryContractTicks() + 1; i++) {
      g.executeNextTick();
    }
    expect(p.mercenaries()).toBe(0);
    // Own troops untouched (they may have grown, never shrunk below).
    expect(p.troops()).toBeGreaterThanOrEqual(own);
  });

  test("the pool, contract and hire history survive a snapshot", async () => {
    const { game: g, p } = await game();
    p.addGold(100_000_000n);
    hire(g, p);
    const { restored } = await roundTrip(g, MAP);
    expect(diffGraphs(g, restored)).toEqual([]);
    const r = restored.player(p.id());
    expect(r.mercenaries()).toBe(p.mercenaries());
    expect(r.mercenaryExpiresAt()).toBe(p.mercenaryExpiresAt());
    expect(r.recentMercenaryHires()).toBe(1);
  });

  test("player updates carry the mercenary state", async () => {
    const { p } = await game();
    p.addGold(100_000_000n);
    expect(p.hireMercenaries()).toBe(true);
    // First emission is the full update.
    const u = p.toUpdate();
    expect(u?.mercenaries).toBe(p.mercenaries());
    expect(u?.mercenaryExpiresAt).toBe(p.mercenaryExpiresAt());
    expect(u?.recentMercenaryHires).toBe(1);
  });
});
