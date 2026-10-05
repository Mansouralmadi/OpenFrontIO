import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { zPlayerRef } from "../snapshot/SnapshotType";

/** Pays gold for a temporary batch of troops (see Player.hireMercenaries). */
export class HireMercenariesExecution implements Execution {
  private active = true;

  constructor(private player: Player) {}

  init(mg: Game, ticks: number): void {}

  tick(ticks: number): void {
    if (!this.player.hireMercenaries()) {
      console.warn(`${this.player.displayName()} cannot hire mercenaries`);
    }
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return HireMercenariesExecutionSnapshot.write({
      active: this.active,
      player: w.player(this.player),
    });
  }

  restoreSnapshot(s: HireMercenariesState, r: SnapshotReader): void {
    this.active = s.active;
    this.player = r.player(s.player);
  }
}

const HireMercenariesStateSchema = z.object({
  active: z.boolean(),
  player: zPlayerRef(),
});
type HireMercenariesState = z.infer<typeof HireMercenariesStateSchema>;

export const HireMercenariesExecutionSnapshot = execSnapshotType({
  name: "HireMercenaries",
  version: 1,
  schema: HireMercenariesStateSchema,
  cls: () => HireMercenariesExecution,
});
