import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { GameType } from "../core/game/Game";
import { getDesktopSessionState } from "./Auth";
import "./components/IOSAddToHomeScreenBanner";
import {
  getDesktopUpdateState,
  isDesktopShell,
  multiplayerAllowed,
  multiplayerAllowedForSession,
  type DesktopSessionState,
  type DesktopUpdateState,
} from "./DesktopShell";
import { HostLobbyModal } from "./HostLobbyModal";
import { JoinLobbyModal } from "./JoinLobbyModal";
import { JoinLobbyEvent } from "./Main";
import {
  backendUnreachableConfirmed,
  manualRetryAvailable,
  retryServerList,
  type BackendReachabilityDetail,
} from "./ServerList";
import { SinglePlayerModal } from "./SinglePlayerModal";
import { UsernameInput } from "./UsernameInput";
import { showToast, translateText } from "./Utils";

const PRIMARY_ACTION =
  "bg-malibu-blue hover:bg-aquarius active:bg-malibu-blue/80 hover:scale-y-105 hover:scale-x-[1.01]";
const SECONDARY_ACTION =
  "bg-surface hover:brightness-[1.08] active:brightness-[0.95] hover:scale-105 hover:shadow-[var(--shadow-action-card-hover)]";
const DISABLED = "opacity-50 cursor-not-allowed pointer-events-none";
/** Tutorial card: the panel's gold, dark text for contrast. */
const TUTORIAL_ACTION =
  "bg-cyber-yellow hover:bg-yellow-300 active:bg-cyber-yellow/80 !text-gray-900 hover:scale-y-105 hover:scale-x-[1.01]";

/**
 * THE REACHABILITY RULE (OPE-439). Stated once, here; every other call site
 * in this feature points back at this comment rather than restating it.
 *
 * The backend-reachability signal is the health of ONE thing: the server-list
 * API (`/cluster.json`), as observed by ServerList's heartbeat. It is not a
 * general "is the internet up" light, and in particular it says nothing about
 * whether any given GAME server is up.
 *
 * So it may gate exactly one category of action: the ones that cannot even
 * begin without that API answering first, because nothing has yet told the
 * client which server to talk to.
 *
 *   GATED (API-dependent): creating/hosting a lobby, entering matchmaking,
 *   opening the join-by-code modal. Each has to resolve a server for
 *   something the client has heard nothing about, so a dead list API really
 *   does mean the click cannot work. These dim, and refuse with
 *   reportMultiplayerRefusal.
 *
 *   NOT GATED (socket-sourced): anything whose target arrived over a live
 *   game-server socket -- every card in the public lobby feed, in both the
 *   homepage selector and the detailed browser -- and every join that reaches
 *   Main's funnel (shouldBlockJoin). The card's very existence is proof that
 *   the game server behind it is up and talking to us, which is the only
 *   liveness that join needs. Refusing there could only ever reject a join
 *   that is already under way, over the health of an unrelated API. These
 *   neither dim nor refuse on reachability: they call
 *   shouldBlockSocketSourcedAction, which is the same predicate with the
 *   reachability input nailed shut.
 *
 * The other two inputs (desktop update state, desktop session state) apply to
 * both categories, which is why the two predicates differ only in this one
 * argument.
 *
 * ---
 *
 * Whether multiplayer should be available given what we know about the
 * backend.
 *
 * The parameter is ServerList.backendUnreachableConfirmed(), NOT the raw
 * backendReachable(), and the difference is load-bearing. That accessor is
 * already false for the two states this must never gate:
 *
 *   - before the first attempt settles. A page is in that state for its first
 *     few hundred milliseconds, and gating there would lock every player out
 *     of multiplayer on every load over a suspicion we have not tested yet.
 *   - after a single missed heartbeat. The cached list is still serving and
 *     the next request would very likely have worked; taking the game away
 *     for a retry interval over one blip is worse than the blip.
 *
 * It is also false when the API answered with anything short of a 5xx -- a
 * 404 for a site with no list is a reachable backend.
 */
export function multiplayerAllowedForBackend(backendOutage: boolean): boolean {
  return !backendOutage;
}

/**
 * Whether a multiplayer entry point should refuse to act. Exported for tests
 * and kept free of component state so the rule is checkable in isolation.
 * A null update/session means that bridge is absent (the web build), so it
 * gates nothing; any one of the three alone is enough to block.
 *
 * `backendOutage` is the only one of the three that also applies on the web,
 * which is why it is a required parameter rather than an optional one: an
 * entry point that forgets to pass it would silently stay ungated, and a
 * compile error is the cheapest way to notice. Pass
 * backendUnreachableConfirmed() only from an API-dependent entry point; a
 * socket-sourced one calls shouldBlockSocketSourcedAction instead, so that
 * "reachability does not apply here" is a named decision rather than a
 * `false` literal someone has to interpret.
 */
export function shouldBlockMultiplayerAction(
  update: DesktopUpdateState | null,
  session: DesktopSessionState | null,
  backendOutage: boolean,
): boolean {
  if (update !== null && !multiplayerAllowed(update)) return true;
  if (session !== null && !multiplayerAllowedForSession(session)) return true;
  if (!multiplayerAllowedForBackend(backendOutage)) return true;
  return false;
}

/**
 * The same gate for an action whose target arrived over a live game-server
 * socket: a public or hosted lobby card, in either browser, and every join
 * that reaches Main's funnel (shouldBlockJoin below wraps this).
 *
 * Reachability is not an input, by the rule at the top of this file: the card
 * is in front of the player because a game server sent it over a socket that
 * is still open, so the server-list API's health cannot make joining it
 * wrong. The desktop update and session states still apply -- they are
 * statements about this client, not about any server.
 *
 * A function rather than `shouldBlockMultiplayerAction(u, s, false)` at four
 * call sites so the dimming and the click-through of a given control cannot
 * drift apart, and so grep finds every place the rule is exercised.
 */
export function shouldBlockSocketSourcedAction(
  update: DesktopUpdateState | null,
  session: DesktopSessionState | null,
): boolean {
  return shouldBlockMultiplayerAction(update, session, false);
}

/**
 * Tells the player why a multiplayer action was refused -- and, on the web,
 * acts as the retry it tells them to make.
 *
 * On desktop the status bar is already showing the reason and its remedy, so
 * the click lands there as a wiggle rather than as a message that would say
 * the same thing twice. The web has no status bar, so an unreachable backend
 * would refuse in complete silence -- which reads as a broken button -- and
 * gets a transient message instead.
 *
 * Only reachability needs the web half: every other reason to refuse here is
 * desktop-only, and on desktop the bar always carries it.
 *
 * The refused click also PROBES on the web, and that is the point rather than
 * a nicety. Desktop has a Retry button; the web has nothing, so without this
 * the only way out of the gated state is the heartbeat's own next beat --
 * which backs off to as much as RETRY_MAX_MS once an outage has run a while.
 * A message reading "try again" over a button where trying again provably did
 * nothing is worse than no message. So the click the player makes IS the
 * retry, and the message is true.
 *
 * Throttled by ServerList.manualRetryAvailable(), the same policy (and the
 * same clock) as the desktop button's disabled state: nothing while an
 * attempt is already out, nothing for MANUAL_RETRY_COOLDOWN_MS after the last
 * one. A player clicking at an outage gets the message every time and a
 * request at most every few seconds. Nothing is rendered from the result: a
 * successful probe flips the reachability signal, which is what un-dims the
 * buttons -- the feedback is the gate going away.
 */
export function reportMultiplayerRefusal(backendOutage: boolean): void {
  // Optional-call the method rather than dispatching an event: the bar is a
  // sibling custom element that may not have upgraded yet, and `?.wiggle?.()`
  // degrades to a silent no-op in that case instead of firing an event with
  // no listener.
  (
    document.querySelector("desktop-status-bar") as
      | (HTMLElement & { wiggle?: () => void })
      | null
  )?.wiggle?.();
  // Keyed on the shell, not on the element: <desktop-status-bar> is in
  // index.html on every build and simply renders nothing on the web, so its
  // presence proves nothing about whether the player can see a reason.
  if (!isDesktopShell() && backendOutage) {
    if (manualRetryAvailable()) {
      retryServerList().catch((err: unknown) => {
        // retryServerList never rejects; belt and braces, so a change there
        // cannot surface as an unhandled rejection from a click handler.
        console.warn("server list retry from a refused click failed", err);
      });
    }
    showToast(translateText("common.backend_unreachable"), "red");
  }
}

/**
 * Whether the multiplayer gate applies to a given join at all. Single-player
 * runs entirely in-client and a replay simulates from an archived record, so
 * neither needs a session, an up-to-date build, or a backend that is up.
 * getTurnstileToken in Main.ts exempts the same pair (alongside two
 * conditions irrelevant here), and calls this so the two cannot drift.
 * Exported for tests and kept free of component state, like
 * shouldBlockMultiplayerAction above.
 */
export function joinIsGateable(lobby: JoinLobbyEvent): boolean {
  return (
    lobby.gameStartInfo?.config.gameType !== GameType.Singleplayer &&
    lobby.gameRecord === undefined
  );
}

/**
 * The whole gate decision for one join, as a pure function so it is testable
 * without mounting Main's client. Main adds only the shell check (which
 * decides whether the two desktop states are even read) and the refusal
 * feedback around it. Both halves it does weigh -- the update state and the
 * session state -- are desktop-only.
 *
 * Backend reachability is deliberately NOT an input here -- the rule at the
 * top of this file, which is why this defers to
 * shouldBlockSocketSourcedAction. Every source that dispatches a join has
 * already reached a server to produce it: "private" only after
 * checkActiveLobby read `exists` from the game's own server, "host" only
 * after createLobby minted the id, "public" from a lobby list arriving over a
 * live server socket, and "matchmaking" only after the queue matched and
 * checkGame confirmed the game exists. The outage signal tracks the separate
 * server-list API, whose health says nothing about those servers, so refusing
 * here could only reject a join that is already under way. Worst case it
 * ejects a player mid-game: a reload during a list-API blip proves the game
 * is live, then the refusal closes the join modal, which leaves the lobby and
 * resets the URL.
 */
export function shouldBlockJoin(
  lobby: JoinLobbyEvent,
  update: DesktopUpdateState | null,
  session: DesktopSessionState | null,
): boolean {
  if (!joinIsGateable(lobby)) return false;
  return shouldBlockSocketSourcedAction(update, session);
}

/**
 * The home screen's play buttons. Single-player first: no public-lobby feed,
 * just Solo and Tutorial, then the private/ranked multiplayer entry points.
 */
@customElement("game-mode-selector")
export class GameModeSelector extends LitElement {
  @state() private inputValid: boolean = true;
  @state() private desktopUpdateState: DesktopUpdateState | null = null;
  @state() private desktopSessionState: DesktopSessionState | null = null;
  // The DEBOUNCED outage signal, not the raw per-attempt one: see
  // multiplayerAllowedForBackend for why one missed heartbeat must not dim
  // these buttons.
  @state() private backendOutage = false;

  createRenderRoot() {
    return this;
  }

  // Silent backstop; the buttons are already disabled while input is invalid.
  private validateUsername(): boolean {
    const usernameInput = document.querySelector(
      "username-input",
    ) as UsernameInput | null;
    return usernameInput ? usernameInput.canPlay() : true;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener(
      "username-validity-change",
      this.handleValidityChange,
    );
    document.addEventListener(
      "desktop-update-state",
      this.onDesktopUpdateState,
    );
    document.addEventListener(
      "desktop-session-state",
      this.onDesktopSessionState,
    );
    if (isDesktopShell()) {
      // Seed from the current values: the status bar dispatches the bridge's
      // synchronous replay before this element exists (OPE-396).
      this.desktopUpdateState = getDesktopUpdateState();
      this.desktopSessionState = getDesktopSessionState();
    }
    // Seeded unconditionally: the heartbeat's first attempts often settle
    // before this element exists, so the event alone would miss them.
    this.backendOutage = backendUnreachableConfirmed();
    document.addEventListener(
      "backend-reachability",
      this.onBackendReachability,
    );
    // Pick up the current value in case username-input validated before us.
    const usernameInput = document.querySelector(
      "username-input",
    ) as UsernameInput | null;
    if (usernameInput) {
      this.inputValid = usernameInput.canPlay();
    }
  }

  disconnectedCallback() {
    window.removeEventListener(
      "username-validity-change",
      this.handleValidityChange,
    );
    document.removeEventListener(
      "desktop-update-state",
      this.onDesktopUpdateState,
    );
    document.removeEventListener(
      "desktop-session-state",
      this.onDesktopSessionState,
    );
    document.removeEventListener(
      "backend-reachability",
      this.onBackendReachability,
    );
    super.disconnectedCallback();
  }

  private handleValidityChange = (e: Event) => {
    this.inputValid = (e as CustomEvent).detail?.isValid ?? true;
  };

  private onDesktopUpdateState = (e: Event) => {
    this.desktopUpdateState = (e as CustomEvent<DesktopUpdateState>).detail;
  };

  private onDesktopSessionState = (e: Event) => {
    this.desktopSessionState = (e as CustomEvent<DesktopSessionState>).detail;
  };

  private onBackendReachability = (e: Event) => {
    this.backendOutage = (
      e as CustomEvent<BackendReachabilityDetail>
    ).detail.confirmed;
  };

  render() {
    const multiplayer: [string, () => void][] = [
      [translateText("main.create"), this.openHostLobby],
      [translateText("mode_selector.ranked_title"), this.openRankedMenu],
      [translateText("main.join"), this.openJoinLobby],
    ];
    return html`
      <div
        class="flex flex-col gap-3 sm:gap-4 w-full max-w-2xl mx-auto px-4 pb-4 sm:px-0"
      >
        <ios-add-to-home-screen-banner
          class="no-crazygames [&:empty]:hidden"
        ></ios-add-to-home-screen-banner>

        <div class="flex flex-col sm:flex-row gap-3 sm:gap-4">
          <div class="h-16 sm:flex-[2]">
            ${this.renderActionCard(
              translateText("main.solo"),
              this.openSinglePlayerModal,
              PRIMARY_ACTION,
            )}
          </div>
          <div class="h-14 sm:h-16 sm:flex-1">
            ${this.renderActionCard(
              translateText("main.tutorial"),
              this.startTutorial,
              TUTORIAL_ACTION,
            )}
          </div>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
          ${multiplayer.map(
            ([title, onClick]) =>
              html`<div class="h-14">
                ${this.renderActionCard(title, onClick, SECONDARY_ACTION, true)}
              </div>`,
          )}
        </div>
      </div>
    `;
  }

  /**
   * Refuses an API-DEPENDENT action (Create, Ranked, Join by code) and tells
   * the player why. Returns true when the caller should stop.
   *
   * Deliberately NOT implemented with the `disabled` attribute: a disabled
   * control swallows the click, leaving nothing to trigger the desktop wiggle
   * or the web retry that reportMultiplayerRefusal makes of it.
   */
  private blockedFromApiAction(): boolean {
    if (
      !shouldBlockMultiplayerAction(
        this.desktopUpdateState,
        this.desktopSessionState,
        this.backendOutage,
      )
    )
      return false;
    reportMultiplayerRefusal(this.backendOutage);
    return true;
  }

  private openRankedMenu = () => {
    if (this.blockedFromApiAction()) return;
    if (!this.validateUsername()) return;
    window.showPage?.("page-ranked");
  };

  private openSinglePlayerModal = () => {
    if (!this.validateUsername()) return;
    (
      document.querySelector("single-player-modal") as SinglePlayerModal
    )?.open();
  };

  // Handled in Main, which also serves the help page's tutorial button.
  private startTutorial = () => {
    if (!this.validateUsername()) return;
    document.dispatchEvent(new CustomEvent("start-tutorial"));
  };

  private openHostLobby = () => {
    if (this.blockedFromApiAction()) return;
    if (!this.validateUsername()) return;
    (document.querySelector("host-lobby-modal") as HostLobbyModal)?.open();
  };

  private openJoinLobby = () => {
    if (this.blockedFromApiAction()) return;
    if (!this.validateUsername()) return;
    (document.querySelector("join-lobby-modal") as JoinLobbyModal)?.open();
  };

  private renderActionCard(
    title: string,
    onClick: () => void,
    bgClass: string,
    // Only the three multiplayer cards (create/ranked/join) pass this; solo
    // and tutorial are never gated.
    gated: boolean = false,
  ) {
    const blocked =
      gated &&
      shouldBlockMultiplayerAction(
        this.desktopUpdateState,
        this.desktopSessionState,
        this.backendOutage,
      );
    return html`
      <button
        @click=${onClick}
        ?disabled=${!this.inputValid}
        aria-disabled=${blocked}
        class="relative flex items-center justify-center w-full h-full rounded-lg ${bgClass} transition-all duration-200 text-sm lg:text-base font-medium text-white uppercase tracking-wider text-center ${!this
          .inputValid
          ? DISABLED
          : blocked
            ? "opacity-50 cursor-not-allowed"
            : ""}"
      >
        ${title}
      </button>
    `;
  }
}
