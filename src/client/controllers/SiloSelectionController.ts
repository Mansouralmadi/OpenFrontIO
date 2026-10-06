/**
 * SiloSelectionController — lets the player pick which missile silo fires.
 *
 * Left-click one of your own silos (no build ghost active) to select it;
 * click it again, press Escape, or hit the hint's X to clear. While a silo
 * is selected every nuke/MIRV launch carries its id (see launchSiloFor) and
 * the sim fires from that silo or refuses — it never swaps in another one.
 *
 * Owns two screen-space DOM overlays: a ring that tracks the silo on the map
 * and a small hint bar ("Launching from: silo at (x, y)" + reason it can't
 * fire, if any).
 */

import { EventBus } from "../../core/EventBus";
import { siloLaunchBlocker } from "../../core/execution/Util";
import { Cell, SiloNukes, UnitType } from "../../core/game/Game";
import { Controller } from "../Controller";
import { CloseViewEvent, MouseUpEvent } from "../InputHandler";
import { TransformHandler } from "../TransformHandler";
import { UIState } from "../UIState";
import { translateText } from "../Utils";
import { GameView, UnitView } from "../view";

const SELECT_RADIUS = 4;

/** The silo a launch of `type` should carry, if the player picked one. */
export function launchSiloFor(
  uiState: UIState | undefined,
  type: UnitType,
): number | undefined {
  return SiloNukes.has(type) || type === UnitType.MIRV
    ? uiState?.selectedSilo
    : undefined;
}

export class SiloSelectionController implements Controller {
  private ring: HTMLDivElement | null = null;
  private hint: HTMLDivElement | null = null;
  private hintText: HTMLSpanElement | null = null;

  constructor(
    private game: GameView,
    private eventBus: EventBus,
    private uiState: UIState,
    private transformHandler: TransformHandler,
  ) {}

  init() {
    this.eventBus.on(MouseUpEvent, (e) => this.onMouseUp(e));
    this.eventBus.on(CloseViewEvent, () => this.select(undefined));
    const loop = () => {
      this.positionRing();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  tick() {
    this.renderHint();
  }

  private silo(): UnitView | undefined {
    const id = this.uiState.selectedSilo;
    return id === undefined ? undefined : this.game.unit(id);
  }

  private onMouseUp(e: MouseUpEvent) {
    if (this.uiState.ghostStructure !== null || this.game.inSpawnPhase()) {
      return;
    }
    const myPlayer = this.game.myPlayer();
    if (!myPlayer) return;
    const cell = this.transformHandler.screenToWorldCoordinates(e.x, e.y);
    if (!this.game.isValidCoord(cell.x, cell.y)) return;
    const tile = this.game.ref(cell.x, cell.y);
    // Clicks on other land are attacks (ClientGameRunner); leave them be.
    if (this.game.owner(tile) !== myPlayer) return;
    let best: UnitView | undefined;
    let bestDist = SELECT_RADIUS + 1;
    for (const s of myPlayer.units(UnitType.MissileSilo)) {
      const d = this.game.manhattanDist(s.tile(), tile);
      if (s.isActive() && d < bestDist) {
        best = s;
        bestDist = d;
      }
    }
    if (best === undefined) return;
    this.select(
      best.id() === this.uiState.selectedSilo ? undefined : best.id(),
    );
  }

  private select(id: number | undefined) {
    if (this.uiState.selectedSilo === id) return;
    this.uiState.selectedSilo = id;
    this.renderHint();
    this.positionRing();
  }

  private renderHint() {
    const silo = this.silo();
    const myPlayer = this.game.myPlayer();
    if (this.uiState.selectedSilo === undefined || !myPlayer) {
      if (this.hint) this.hint.style.display = "none";
      return;
    }
    this.ensureElements();
    const parts: string[] = [];
    if (silo !== undefined) {
      parts.push(
        translateText("silo_select.launching_from", {
          x: this.game.x(silo.tile()),
          y: this.game.y(silo.tile()),
        }),
      );
    }
    const reason = siloLaunchBlocker(silo, myPlayer.id());
    if (reason !== null) parts.push(translateText(`silo_select.${reason}`));
    this.hintText!.textContent = parts.join(" — ");
    this.hint!.style.borderColor = reason === null ? "#f59e0b" : "#ef4444";
    this.hint!.style.display = "flex";
  }

  private positionRing() {
    const silo = this.silo();
    if (silo === undefined || !silo.isActive()) {
      if (this.ring) this.ring.style.display = "none";
      return;
    }
    this.ensureElements();
    const p = this.transformHandler.worldToScreenCoordinates(
      new Cell(this.game.x(silo.tile()) + 0.5, this.game.y(silo.tile()) + 0.5),
    );
    const r = Math.max(14, 4 * this.transformHandler.scale);
    const ring = this.ring!;
    ring.style.left = `${p.x - r}px`;
    ring.style.top = `${p.y - r}px`;
    ring.style.width = ring.style.height = `${2 * r}px`;
    ring.style.display = "block";
  }

  private ensureElements() {
    if (this.ring !== null) return;
    const ring = document.createElement("div");
    ring.id = "silo-select-ring";
    Object.assign(ring.style, {
      position: "fixed",
      pointerEvents: "none",
      display: "none",
      zIndex: "30",
      borderRadius: "50%",
      border: "3px solid #f59e0b",
      boxShadow: "0 0 10px 2px rgba(245, 158, 11, 0.7)",
      boxSizing: "border-box",
    });
    document.body.appendChild(ring);
    this.ring = ring;

    const hint = document.createElement("div");
    hint.id = "silo-select-hint";
    Object.assign(hint.style, {
      position: "fixed",
      top: "64px",
      left: "50%",
      transform: "translateX(-50%)",
      display: "none",
      alignItems: "center",
      gap: "8px",
      zIndex: "1000",
      maxWidth: "calc(100vw - 32px)",
      padding: "6px 10px",
      borderRadius: "8px",
      border: "2px solid #f59e0b",
      background: "rgba(17, 24, 39, 0.85)",
      color: "white",
      font: "14px sans-serif",
    });
    const text = document.createElement("span");
    const clear = document.createElement("button");
    clear.textContent = "✕";
    clear.title = translateText("silo_select.clear");
    clear.setAttribute("aria-label", clear.title);
    Object.assign(clear.style, {
      background: "none",
      border: "none",
      color: "white",
      cursor: "pointer",
      fontSize: "16px",
      lineHeight: "1",
    });
    clear.addEventListener("click", () => this.select(undefined));
    hint.append(text, clear);
    document.body.appendChild(hint);
    this.hint = hint;
    this.hintText = text;
  }
}
