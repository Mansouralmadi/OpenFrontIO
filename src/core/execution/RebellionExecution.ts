import { z } from "zod";
import {
  Execution,
  Game,
  GameMode,
  MessageType,
  Nation,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../game/Game";
import { TileRef } from "../game/GameMap";
import {
  bumpTraversalGeneration,
  tileTraversalScratch,
} from "../game/TileTraversalScratch";
import { PseudoRandom } from "../PseudoRandom";
import { GameID } from "../Schemas";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { zInt, zPlayerRef, zRandom } from "../snapshot/SnapshotType";
import { simpleHash } from "../Util";
import { NationExecution } from "./NationExecution";
import { PlayerExecution } from "./PlayerExecution";

interface Watch {
  cooldownUntil: number;
  // (tick, integration queue end) pairs, oldest first: everything queued
  // before a sample's position was taken before its tick.
  samples: number[];
}

/**
 * Rebellions (see REBELLION in Config): a large connected region of a
 * player's land that has stayed unintegrated for too long breaks away as a
 * new AI nation, preferring detached land, then land far from cities.
 */
export class RebellionExecution implements Execution {
  private active = true;
  private mg: Game;
  private startTick = -1;
  private random: PseudoRandom;
  private watches = new Map<Player, Watch>();
  private nbuf: TileRef[] = [0, 0, 0, 0];

  constructor(private gameID: GameID) {
    this.random = new PseudoRandom(simpleHash(gameID) + 3);
  }

  init(mg: Game): void {
    this.mg = mg;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  isActive(): boolean {
    return this.active;
  }

  tick(ticks: number): void {
    if (this.mg.config().gameConfig().gameMode !== GameMode.FFA) {
      this.active = false;
      return;
    }
    if (this.startTick < 0) this.startTick = ticks;
    const interval = this.mg.config().rebellion().checkIntervalTicks;
    for (const p of this.mg.players()) {
      if (p.type() === PlayerType.Bot) continue;
      if ((ticks + p.smallID()) % interval !== 0) continue;
      this.check(p, ticks);
    }
  }

  private check(p: Player, ticks: number): void {
    const cfg = this.mg.config().rebellion();
    let watch = this.watches.get(p);
    if (watch === undefined) {
      watch = { cooldownUntil: 0, samples: [] };
      this.watches.set(p, watch);
    }
    const samples = watch.samples;
    samples.push(ticks, p.integrationQueueEnd());
    // Happier players tolerate unintegrated land longer (see HAPPINESS).
    const config = this.mg.config();
    const happiness = p.happiness();
    const need = config.rebellionUnintegratedTicks(happiness);
    const longest = config.rebellionUnintegratedTicks(100);
    // Keep the newest sample old enough for any happiness, and everything
    // after; `old` is the newest sample old enough for the current one.
    let keep = -1;
    let old = -1;
    for (let i = 0; i < samples.length; i += 2) {
      if (samples[i] <= ticks - longest) keep = i;
      if (samples[i] <= ticks - need) old = i;
    }
    if (keep > 0) {
      samples.splice(0, keep);
      old -= keep;
    }
    if (old < 0) return;

    if (ticks - this.startTick < cfg.graceTicks) return;
    if (ticks < watch.cooldownUntil) return;
    const minTiles = config.rebellionMinTiles(
      this.mg.numLandTiles(),
      happiness,
    );
    if (p.unintegratedTiles() < minTiles) return;
    const region = this.findRegion(p, samples[old + 1], minTiles);
    if (region === null) return;
    this.rebel(p, region);
    watch.cooldownUntil = ticks + cfg.cooldownTicks;
  }

  /**
   * The region to rebel: among the 4-connected clusters of p's tiles queued
   * before `before` (so unintegrated at least that long) with at least
   * minTiles, the detached one, then the one farthest from p's cities, then
   * the largest. Capped at the share of p's backlog, grown from its tile
   * farthest from the cities.
   */
  private findRegion(
    p: Player,
    before: number,
    minTiles: number,
  ): TileRef[] | null {
    const mg = this.mg;
    const me = p.smallID();
    const scratch = tileTraversalScratch(mg);
    const visited = scratch.visited;

    // A tile retaken recently also has an older stale entry: it's young.
    const youngGen = bumpTraversalGeneration(scratch);
    p.forEachIntegrationEntry((t, i) => {
      if (i >= before) visited[t] = youngGen;
    });
    const candidates: TileRef[] = [];
    p.forEachIntegrationEntry((t, i) => {
      if (
        i < before &&
        visited[t] !== youngGen &&
        mg.ownerID(t) === me &&
        mg.isUnintegrated(t)
      ) {
        candidates.push(t);
      }
    });
    if (candidates.length < minTiles) return null;
    const oldGen = bumpTraversalGeneration(scratch);
    for (const t of candidates) visited[t] = oldGen;

    const refs: TileRef[] = p
      .units(UnitType.City)
      .filter((c) => !c.isUnderConstruction())
      .map((c) => c.tile());
    if (refs.length === 0 && p.spawnTile() !== undefined) {
      refs.push(p.spawnTile()!);
    }
    const distToRefs = (x: number, y: number): number => {
      let best = Infinity;
      for (const r of refs) {
        const dx = mg.x(r) - x;
        const dy = mg.y(r) - y;
        best = Math.min(best, dx * dx + dy * dy);
      }
      return best;
    };

    const doneGen = bumpTraversalGeneration(scratch);
    let best: TileRef[] | null = null;
    let bestDetached = false;
    let bestDist = -1;
    for (const start of candidates) {
      if (visited[start] !== oldGen) continue;
      const cluster = this.flood(start, oldGen, doneGen, Infinity);
      if (cluster.length < minTiles) continue;
      let sx = 0;
      let sy = 0;
      for (const t of cluster) {
        sx += mg.x(t);
        sy += mg.y(t);
      }
      const detached = mg.isDetached(cluster[0]);
      const dist = distToRefs(
        Math.floor(sx / cluster.length),
        Math.floor(sy / cluster.length),
      );
      const better =
        best === null ||
        (detached !== bestDetached
          ? detached
          : dist !== bestDist
            ? dist > bestDist
            : cluster.length > best.length);
      if (better) {
        best = cluster;
        bestDetached = detached;
        bestDist = dist;
      }
    }
    if (best === null) return null;

    const cap = Math.max(
      minTiles,
      Math.floor(
        p.unintegratedTiles() * mg.config().rebellion().maxShareOfUnintegrated,
      ),
    );
    if (best.length <= cap) return best;
    let far = best[0];
    let farDist = -1;
    for (const t of best) {
      const d = distToRefs(mg.x(t), mg.y(t));
      if (d > farDist) {
        farDist = d;
        far = t;
      }
    }
    const inRegion = bumpTraversalGeneration(scratch);
    for (const t of best) visited[t] = inRegion;
    return this.flood(far, inRegion, bumpTraversalGeneration(scratch), cap);
  }

  /** Breadth-first through tiles stamped `from`, restamping them `to`, up to max tiles. */
  private flood(
    start: TileRef,
    from: number,
    to: number,
    max: number,
  ): TileRef[] {
    const visited = tileTraversalScratch(this.mg).visited;
    const map = this.mg.map();
    const out: TileRef[] = [start];
    visited[start] = to;
    for (let head = 0; head < out.length && out.length < max; head++) {
      const n = map.neighbors4(out[head], this.nbuf);
      for (let i = 0; i < n && out.length < max; i++) {
        const t = this.nbuf[i];
        if (visited[t] !== from) continue;
        visited[t] = to;
        out.push(t);
      }
    }
    return out;
  }

  private rebel(owner: Player, region: TileRef[]): void {
    const mg = this.mg;
    let name = `${owner.name()} Rebels`;
    for (let n = 2; mg.players().some((p) => p.name() === name); n++) {
      name = `${owner.name()} Rebels ${n}`;
    }
    let id = this.random.nextID();
    while (mg.hasPlayer(id)) id = this.random.nextID();
    const info = new PlayerInfo(name, PlayerType.Nation, null, id);
    const rebel = mg.addPlayer(info);

    const troops = Math.floor(
      (owner.troops() * region.length) / owner.numTilesOwned(),
    );
    for (const t of region) rebel.conquer(t);
    // The rebels already run their land.
    rebel.integrateTiles(Number.MAX_SAFE_INTEGER);
    rebel.setSpawnTile(region[0]);
    rebel.removeTroops(rebel.troops());
    rebel.addTroops(owner.removeTroops(troops));
    rebel.updateRelation(owner, -200);
    owner.updateRelation(rebel, -200);

    mg.addExecution(
      new PlayerExecution(rebel),
      new NationExecution(this.gameID, new Nation(undefined, info)),
    );
    mg.displayMessage(
      "events_display.rebellion",
      MessageType.ATTACK_FAILED,
      owner.id(),
      undefined,
      { name },
    );
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return RebellionExecutionSnapshot.write({
      active: this.active,
      gameID: this.gameID,
      startTick: this.startTick,
      random: w.random(this.random),
      watches: [...this.watches].map(([p, watch]) => ({
        player: w.player(p),
        cooldownUntil: watch.cooldownUntil,
        samples: [...watch.samples],
      })),
    });
  }

  restoreSnapshot(s: RebellionState, r: SnapshotReader): void {
    this.active = s.active;
    this.gameID = s.gameID;
    this.mg = r.game;
    this.startTick = s.startTick;
    this.random = r.random(s.random);
    this.watches = new Map(
      s.watches.map((e) => [
        r.player(e.player),
        { cooldownUntil: e.cooldownUntil, samples: [...e.samples] },
      ]),
    );
    this.nbuf = [0, 0, 0, 0];
  }
}

const RebellionStateSchema = z.object({
  active: z.boolean(),
  gameID: z.string(),
  startTick: zInt(),
  random: zRandom(),
  watches: z.array(
    z.object({
      player: zPlayerRef(),
      cooldownUntil: zInt(),
      samples: z.array(zInt()),
    }),
  ),
});
type RebellionState = z.infer<typeof RebellionStateSchema>;

export const RebellionExecutionSnapshot = execSnapshotType({
  name: "Rebellion",
  version: 1,
  schema: RebellionStateSchema,
  cls: () => RebellionExecution,
});
