import { describe, expect, it, vi } from "vitest";
import { GameSummaryTracker } from "../../src/client/hud/layers/GameSummary";
import type { GameView } from "../../src/client/view";
import { UnitType } from "../../src/core/game/Game";
import { GameUpdateType } from "../../src/core/game/GameUpdates";

function fakePlayer(smallID: number, id: string, tiles: () => number) {
  return {
    smallID: () => smallID,
    id: () => id,
    numTilesOwned: tiles,
    hasSpawned: () => true,
    isAlive: () => true,
    displayName: () => id,
    territoryColor: () => ({ toHex: () => "#000000" }),
    troops: () => 0,
    goldEarned: () => 0,
  };
}

describe("GameSummaryTracker", () => {
  it("counts builds once per unit, conquests, rebellions and peak tiles", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    let aTiles = 50;
    const a = fakePlayer(1, "a", () => aTiles);
    const b = fakePlayer(2, "b", () => 10);
    let updates: Record<number, unknown[]> = {};
    const game = {
      inSpawnPhase: () => true,
      players: () => [a, b],
      myPlayer: () => b,
      hasPlayer: (id: string) => id === "a" || id === "b",
      player: (id: string) => (id === "a" ? a : b),
      updatesSinceLastTick: () => updates,
      width: () => 0,
      height: () => 0,
      elapsedGameSeconds: () => 42,
      numLandTiles: () => 100,
    } as unknown as GameView;

    const t = new GameSummaryTracker();
    const city = { unitType: UnitType.City, id: 7, ownerID: 1 };
    updates = {
      [GameUpdateType.Unit]: [
        city,
        { unitType: UnitType.AtomBomb, id: 8, ownerID: 1 },
        { unitType: UnitType.Shell, id: 9, ownerID: 1 },
      ],
      [GameUpdateType.ConquestEvent]: [{ conquerorId: "a", conqueredId: "x" }],
      [GameUpdateType.DisplayEvent]: [
        { message: "events_display.rebellion", playerID: 2 },
      ],
    };
    t.tick(game);
    // Same city again (e.g. moved/upgraded) must not count twice.
    updates = { [GameUpdateType.Unit]: [city] };
    aTiles = 20;
    t.tick(game);

    const r = t.finish(game, null);
    expect(r.seconds).toBe(42);
    expect(r.rows.map((x) => x.name)).toEqual(["a", "b"]);
    const [ra, rb] = r.rows;
    expect(ra.built).toEqual({ city: 1, abomb: 1 });
    expect(ra.peakTiles).toBe(50);
    expect(ra.tiles).toBe(20);
    expect(ra.conquests).toBe(1);
    expect(rb.rebellions).toBe(1);
    expect(rb.isMe).toBe(true);
  });
});
