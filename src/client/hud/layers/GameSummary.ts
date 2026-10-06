import { html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { UnitType } from "../../../core/game/Game";
import { GameUpdateType } from "../../../core/game/GameUpdates";
import { PlayerStats } from "../../../core/StatsSchemas";
import { UNIT_LABEL_KEYS } from "../../components/baseComponents/stats/PlayerStatsTable";
import { encodeTerrainTile } from "../../render/gl/utils/ColorUtils";
import {
  renderDuration,
  renderNumber,
  renderTroops,
  translateText,
} from "../../Utils";
import { GameView } from "../../view";

// Unit types counted as "built/launched" in the summary, keyed by the stats
// abbreviation so labels come from the same table as PlayerStatsTable.
const BUILD_KEYS = {
  [UnitType.City]: "city",
  [UnitType.Farm]: "farm",
  [UnitType.Port]: "port",
  [UnitType.Factory]: "fact",
  [UnitType.DefensePost]: "defp",
  [UnitType.MissileSilo]: "silo",
  [UnitType.SAMLauncher]: "saml",
  [UnitType.Warship]: "wshp",
  [UnitType.AtomBomb]: "abomb",
  [UnitType.HydrogenBomb]: "hbomb",
  [UnitType.MIRV]: "mirv",
  [UnitType.AntimatterBomb]: "amb",
  [UnitType.LandBomb]: "lbomb",
  [UnitType.TransportShip]: "trans",
} as const satisfies Partial<Record<UnitType, keyof typeof UNIT_LABEL_KEYS>>;
type BuildKey = (typeof BUILD_KEYS)[keyof typeof BUILD_KEYS];
const BUILD_COLUMNS: BuildKey[] = Object.values(BUILD_KEYS).filter(
  (k) => k !== "trans",
);
const NUKE_KEYS = new Set<BuildKey>(["abomb", "hbomb", "mirv", "amb", "lbomb"]);

const MAP_MAX_SIZE = 800;
const TOP_PLAYERS = 8;

/**
 * Render the whole map with territories to a PNG data URL. Samples every
 * `step`-th tile so the image is at most MAP_MAX_SIZE px on its long side.
 */
export function renderTerritoryMap(game: GameView): string {
  const w = game.width();
  const h = game.height();
  const step = Math.max(1, Math.ceil(Math.max(w, h) / MAP_MAX_SIZE));
  const cw = Math.ceil(w / step);
  const ch = Math.ceil(h / step);
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const img = ctx.createImageData(cw, ch);
  const px = new Uint8Array(img.data.buffer);
  const colors = new Map<number, [number, number, number] | null>();
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const ref = game.ref(x * step, y * step);
      const o = (y * cw + x) * 4;
      encodeTerrainTile(game.terrainByte(ref), px, o);
      if (!game.hasOwner(ref)) continue;
      const id = game.ownerID(ref);
      let c = colors.get(id);
      if (c === undefined) {
        const p = game.playerBySmallID(id);
        const rgb = p.isPlayer() ? p.territoryColor().toRgb() : null;
        c = rgb ? [rgb.r, rgb.g, rgb.b] : null;
        colors.set(id, c);
      }
      if (c === null) continue;
      // Mostly territory color, with a hint of the terrain underneath.
      px[o] = c[0] * 0.8 + px[o] * 0.2;
      px[o + 1] = c[1] * 0.8 + px[o + 1] * 0.2;
      px[o + 2] = c[2] * 0.8 + px[o + 2] * 0.2;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

export interface SummaryRow {
  name: string;
  color: string;
  alive: boolean;
  isMe: boolean;
  tiles: number;
  peakTiles: number;
  troops: number;
  goldEarned: number;
  conquests: number;
  rebellions: number;
  built: Partial<Record<BuildKey, number>>;
}

/** Everything the summary shows, frozen at the moment the game ended. */
export interface SummaryResult {
  endMap: string;
  seconds: number;
  landTiles: number;
  rows: SummaryRow[];
  myStats: PlayerStats | null;
}

/**
 * Per-player counters the stats system does not keep for bots/nations
 * (it is keyed by clientID), derived client-side from the update stream.
 */
export class GameSummaryTracker {
  startMap: string | null = null;
  private readonly peakTiles = new Map<number, number>();
  private readonly built = new Map<number, Partial<Record<BuildKey, number>>>();
  private readonly conquests = new Map<number, number>();
  private readonly rebellions = new Map<number, number>();
  private readonly seenUnits = new Set<number>();

  tick(game: GameView): void {
    if (this.startMap === null && !game.inSpawnPhase()) {
      this.startMap = renderTerritoryMap(game);
    }
    for (const p of game.players()) {
      const tiles = p.numTilesOwned();
      if (tiles > (this.peakTiles.get(p.smallID()) ?? 0)) {
        this.peakTiles.set(p.smallID(), tiles);
      }
    }
    const updates = game.updatesSinceLastTick();
    if (!updates) return;
    for (const u of updates[GameUpdateType.Unit] ?? []) {
      const key = (BUILD_KEYS as Partial<Record<UnitType, BuildKey>>)[
        u.unitType
      ];
      if (key === undefined || this.seenUnits.has(u.id)) continue;
      this.seenUnits.add(u.id);
      const counts = this.built.get(u.ownerID) ?? {};
      counts[key] = (counts[key] ?? 0) + 1;
      this.built.set(u.ownerID, counts);
    }
    for (const c of updates[GameUpdateType.ConquestEvent] ?? []) {
      if (!game.hasPlayer(c.conquerorId)) continue;
      const id = game.player(c.conquerorId).smallID();
      this.conquests.set(id, (this.conquests.get(id) ?? 0) + 1);
    }
    for (const d of updates[GameUpdateType.DisplayEvent] ?? []) {
      if (d.message !== "events_display.rebellion" || d.playerID === null) {
        continue;
      }
      const n = this.rebellions.get(d.playerID) ?? 0;
      this.rebellions.set(d.playerID, n + 1);
    }
  }

  /** Snapshot the top players (plus the local player) and the end map. */
  finish(game: GameView, myStats: PlayerStats | null): SummaryResult {
    const me = game.myPlayer();
    const top = game
      .players()
      .filter((p) => p.hasSpawned())
      .sort((a, b) => b.numTilesOwned() - a.numTilesOwned())
      .slice(0, TOP_PLAYERS);
    if (me?.hasSpawned() && !top.includes(me)) top.push(me);
    return {
      endMap: renderTerritoryMap(game),
      seconds: game.elapsedGameSeconds(),
      landTiles: Math.max(1, game.numLandTiles()),
      myStats,
      rows: top.map((p) => {
        const id = p.smallID();
        return {
          name: p.displayName(),
          color: p.territoryColor().toHex(),
          alive: p.isAlive(),
          isMe: p === me,
          tiles: p.numTilesOwned(),
          peakTiles: Math.max(this.peakTiles.get(id) ?? 0, p.numTilesOwned()),
          troops: p.troops(),
          goldEarned: p.goldEarned(),
          conquests: this.conquests.get(id) ?? 0,
          rebellions: this.rebellions.get(id) ?? 0,
          built: { ...this.built.get(id) },
        };
      }),
    };
  }
}

type Tab = "overview" | "builds" | "mine";

const CELL = "px-2 py-1 text-right";

@customElement("game-summary")
export class GameSummary extends LitElement {
  @property({ attribute: false }) startMap: string | null = null;
  @property({ attribute: false }) result: SummaryResult | null = null;

  @state() private tab: Tab = "overview";
  @state() private enlarged: string | null = null;

  createRenderRoot() {
    return this;
  }

  render() {
    const r = this.result;
    if (!r) return nothing;
    const tabs: [Tab, string][] = [
      ["overview", "game_summary.tab_overview"],
      ["builds", "game_summary.tab_builds"],
    ];
    if (r.myStats) tabs.push(["mine", "game_summary.tab_mine"]);
    const tab = this.tab === "mine" && !r.myStats ? "overview" : this.tab;
    return html`
      <div class="flex flex-col gap-3">
        <div class="text-center text-sm text-white/70">
          ${translateText("game_summary.duration", {
            time: renderDuration(r.seconds),
          })}
        </div>
        <div class="flex gap-1 border-b border-white/10" role="tablist">
          ${tabs.map(
            ([id, key]) => html`
              <button
                role="tab"
                aria-selected=${tab === id}
                class="px-3 py-1.5 text-sm rounded-t ${tab === id
                  ? "bg-white/15 text-white font-semibold"
                  : "text-white/60 hover:text-white"}"
                @click=${() => (this.tab = id)}
              >
                ${translateText(key)}
              </button>
            `,
          )}
        </div>
        ${tab === "overview"
          ? this.renderOverview(r)
          : tab === "builds"
            ? this.renderBuilds(r)
            : html`<player-stats-table
                .stats=${r.myStats}
              ></player-stats-table>`}
      </div>
      <!-- A modal <dialog> renders in the top layer, so it covers the whole
      screen despite the win modal's transform. -->
      <dialog
        class="m-auto p-0 bg-transparent backdrop:bg-black/80 cursor-zoom-out"
        @click=${(e: Event) => (e.currentTarget as HTMLDialogElement).close()}
      >
        <img
          src=${this.enlarged ?? ""}
          alt=""
          class="block w-[95vw] max-h-[95dvh] object-contain [image-rendering:pixelated]"
        />
      </dialog>
    `;
  }

  private async enlarge(src: string) {
    this.enlarged = src;
    await this.updateComplete;
    this.querySelector("dialog")?.showModal();
  }

  private renderMap(label: string, src: string | null, file: string) {
    return html`
      <figure class="flex-1 min-w-0 m-0 flex flex-col gap-1">
        <figcaption class="text-xs uppercase tracking-wider text-white/60">
          ${translateText(label)}
        </figcaption>
        ${src
          ? html`<img
                src=${src}
                alt=${translateText(label)}
                class="w-full rounded border border-white/10 bg-black cursor-zoom-in [image-rendering:pixelated]"
                @click=${() => this.enlarge(src)}
              />
              <a
                href=${src}
                download=${file}
                class="text-xs text-blue-300 hover:underline self-start"
                >${translateText("game_summary.save_image")}</a
              >`
          : html`<div
              class="aspect-video rounded border border-white/10 bg-black/40"
            ></div>`}
      </figure>
    `;
  }

  private table(
    headers: TemplateResult[],
    rows: SummaryRow[],
    cells: (row: SummaryRow) => TemplateResult[],
    small = false,
  ) {
    return html`
      <div class="overflow-x-auto rounded border border-white/5 bg-black/20">
        <table
          class="w-full whitespace-nowrap ${small ? "text-xs" : "text-sm"}"
        >
          <thead>
            <tr class="bg-white/5">
              <th class="px-2 py-1.5 text-left font-semibold text-white/60">
                ${translateText("game_summary.player")}
              </th>
              ${headers}
            </tr>
          </thead>
          <tbody class="divide-y divide-white/5">
            ${rows.map(
              (row) => html`
                <tr class=${row.isMe ? "bg-white/10" : ""}>
                  <td class="px-2 py-1 text-left">
                    <span
                      class="inline-block w-2.5 h-2.5 rounded-sm mr-1.5 align-middle"
                      style="background:${row.color}"
                    ></span
                    >${row.name}${row.alive ? "" : " †"}
                  </td>
                  ${cells(row)}
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    `;
  }

  private renderOverview(r: SummaryResult) {
    const head = (key: string) =>
      html`<th class="px-2 py-1.5 font-semibold text-white/60 text-right">
        ${translateText(key)}
      </th>`;
    return html`
      <div class="flex gap-3">
        ${this.renderMap(
          "game_summary.map_start",
          this.startMap,
          "map-start.png",
        )}
        ${this.renderMap("game_summary.map_end", r.endMap, "map-end.png")}
      </div>
      ${this.table(
        [
          "game_summary.tiles",
          "game_summary.peak_tiles",
          "game_summary.troops",
          "game_summary.gold_earned",
          "game_summary.conquests",
          "game_summary.boats_sent",
          "game_summary.rebellions",
        ].map(head),
        r.rows,
        (row) => [
          html`<td class=${CELL}>
            ${renderNumber(row.tiles)}
            <span class="text-white/50"
              >(${((row.tiles / r.landTiles) * 100).toFixed(1)}%)</span
            >
          </td>`,
          html`<td class=${CELL}>${renderNumber(row.peakTiles)}</td>`,
          html`<td class=${CELL}>${renderTroops(row.troops)}</td>`,
          html`<td class=${CELL}>${renderNumber(row.goldEarned)}</td>`,
          html`<td class=${CELL}>${row.conquests}</td>`,
          html`<td class=${CELL}>${row.built.trans ?? 0}</td>`,
          html`<td class=${CELL}>${row.rebellions}</td>`,
        ],
      )}
    `;
  }

  private renderBuilds(r: SummaryResult) {
    return html`
      <div class="text-xs text-white/50">
        ${translateText("game_summary.builds_note")}
      </div>
      ${this.table(
        BUILD_COLUMNS.map(
          (k) =>
            html`<th
              class="px-2 py-1.5 font-semibold text-right ${NUKE_KEYS.has(k)
                ? "text-red-300/80"
                : "text-white/60"}"
            >
              ${translateText(UNIT_LABEL_KEYS[k])}
            </th>`,
        ),
        r.rows,
        (row) =>
          BUILD_COLUMNS.map(
            (k) => html`<td class=${CELL}>${row.built[k] ?? 0}</td>`,
          ),
        true,
      )}
    `;
  }
}
