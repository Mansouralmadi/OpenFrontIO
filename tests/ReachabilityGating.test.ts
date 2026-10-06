import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientEnv } from "../src/client/ClientEnv";
import { shouldBlockMultiplayerAction } from "../src/client/GameModeSelector";
import {
  backendUnreachableConfirmed,
  ensureServerList,
  resetServerList,
  retryServerList,
} from "../src/client/ServerList";

// Registers <game-mode-selector> as a side effect.
import "../src/client/GameModeSelector";

/**
 * OPE-439. The server-list heartbeat already knows whether the API answers;
 * this is the half that turns that into something the player can see, on the
 * WEB as well as on desktop -- which is what separates it from the desktop
 * update/session gates the sibling files cover.
 *
 * Everything here runs against the real ServerList module, driven by a
 * stubbed fetch. A mocked backendReachable() would prove the call sites
 * consult *something*, but not that the signal the heartbeat actually
 * produces is the one they consult, nor that a component mounting after the
 * first attempt settles can still find it.
 */
let selector: HTMLElement & { updateComplete: Promise<unknown> };
let joinOpen: ReturnType<typeof vi.fn>;
let hostOpen: ReturnType<typeof vi.fn>;
let wiggle: ReturnType<typeof vi.fn>;
let messages: string[];
let fetchMock: ReturnType<typeof vi.fn>;
// Added to the real clock, so a test can step past the manual-retry cooldown
// without waiting out five real seconds. Only Date.now is moved: ServerList's
// throttles are all clock comparisons, and faking timers wholesale would
// stall Lit's own scheduling.
let clockOffset: number;

function stub(tag: string, methods: Record<string, unknown>): void {
  const el = document.createElement(tag);
  Object.assign(el, methods);
  document.body.appendChild(el);
}

/** Mounts <game-mode-selector>. */
async function mountSelector(): Promise<
  HTMLElement & { updateComplete: Promise<unknown> }
> {
  const el = document.createElement("game-mode-selector") as HTMLElement & {
    updateComplete: Promise<unknown>;
  };
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

/** Clicks every button the selector renders. Returns how many it clicked. */
function clickEveryButton(): number {
  const buttons = Array.from(selector.querySelectorAll("button"));
  for (const button of buttons) button.click();
  return buttons.length;
}

/** Announces a reachability change the way the heartbeat does. */
async function announce(reachable: boolean, confirmed = false): Promise<void> {
  document.dispatchEvent(
    new CustomEvent("backend-reachability", {
      detail: { reachable, confirmed },
    }),
  );
  await selector.updateComplete;
}

/**
 * Drives the real module through enough failed attempts that the outage is
 * confirmed. Uses the manual retry for the second one so the test does not
 * have to wait out the heartbeat's retry interval.
 */
async function confirmOutage(): Promise<void> {
  fetchMock.mockImplementation(async () => {
    throw new TypeError("network down");
  });
  await ensureServerList();
  await retryServerList();
  expect(backendUnreachableConfirmed()).toBe(true);
}

beforeEach(() => {
  // No serverHost and no openfrontDesktop: this is the web build, where the update and session
  // gates do not exist and reachability is the only one that can fire.
  window.BOOTSTRAP_CONFIG = {
    gameEnv: "dev",
    numWorkers: 1,
    turnstileSiteKey: "",
    jwtAudience: "test",
    instanceId: "test",
    gitCommit: "test",
  };
  ClientEnv.reset();
  resetServerList();

  fetchMock = vi.fn(async () => new Response("{}", { status: 404 }));
  vi.stubGlobal("fetch", fetchMock);
  clockOffset = 0;
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});

  joinOpen = vi.fn();
  hostOpen = vi.fn();
  wiggle = vi.fn();
  stub("join-lobby-modal", { open: joinOpen });
  stub("host-lobby-modal", { open: hostOpen });
  stub("single-player-modal", { open: vi.fn() });
  // Present on the web too -- index.html mounts it on every build and it
  // simply renders nothing there -- which is exactly why the web message
  // cannot key on whether this element exists.
  stub("desktop-status-bar", { wiggle });
  (window as { showPage?: (id: string) => void }).showPage = vi.fn();

  messages = [];
  window.addEventListener("show-message", (e) => {
    messages.push((e as CustomEvent).detail?.message);
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  window.BOOTSTRAP_CONFIG = undefined;
  ClientEnv.reset();
  resetServerList();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the multiplayer entry points while the backend is unreachable", () => {
  it("lets everything through before the first attempt has settled", async () => {
    // The rule that matters most: a player must never be locked out of
    // multiplayer on a suspicion we have not even tested yet. Every page is
    // in this state for its first few hundred milliseconds.
    selector = await mountSelector();
    expect(backendUnreachableConfirmed()).toBe(false);

    expect(clickEveryButton()).toBeGreaterThan(0);

    expect(joinOpen).toHaveBeenCalled();
    expect(hostOpen).toHaveBeenCalled();
    expect(
      selector.querySelectorAll('button[aria-disabled="true"]').length,
    ).toBe(0);
    expect(messages).toEqual([]);
  });

  it("lets everything through after a SINGLE missed attempt", async () => {
    // One timed-out heartbeat is a blip. The cached list is still serving,
    // the next request would very likely work, and dimming every button for
    // a retry interval over it -- with no Retry on the web to escape with --
    // takes the game away for no good reason.
    selector = await mountSelector();
    await announce(false, false);

    expect(
      selector.querySelectorAll('button[aria-disabled="true"]').length,
    ).toBe(0);
    expect(clickEveryButton()).toBeGreaterThan(0);
    expect(joinOpen).toHaveBeenCalled();
    expect(hostOpen).toHaveBeenCalled();
    expect(messages).toEqual([]);
  });

  it("never gates multiplayer, even on a confirmed outage (Iron has no API)", async () => {
    // The fork has no closed-source API, so the server-list fetch always
    // fails; lobbies still work through our own game server.
    selector = await mountSelector();
    await confirmOutage();

    expect(
      selector.querySelectorAll('button[aria-disabled="true"]').length,
    ).toBe(0);
    expect(clickEveryButton()).toBeGreaterThan(0);
    expect(joinOpen).toHaveBeenCalled();
    expect(hostOpen).toHaveBeenCalled();
    expect(messages).toEqual([]);
  });

  it("leaves single-player alone", async () => {
    selector = await mountSelector();
    const soloOpen = vi.fn();
    (
      document.querySelector("single-player-modal") as unknown as {
        open: () => void;
      }
    ).open = soloOpen;
    await announce(false, true);

    clickEveryButton();

    // Bot games run entirely in-client: an unreachable backend is no reason
    // to refuse one, and refusing would break the desktop build's core
    // offline promise.
    expect(soloOpen).toHaveBeenCalled();
  });

  it("does not gate a selector that mounted after an attempt SUCCEEDED", async () => {
    // The control for the seed: a 404 is an answer, so a site with no list
    // at all is still a reachable backend.
    await ensureServerList();
    expect(backendUnreachableConfirmed()).toBe(false);

    selector = await mountSelector();

    expect(clickEveryButton()).toBeGreaterThan(0);
    expect(joinOpen).toHaveBeenCalled();
    expect(hostOpen).toHaveBeenCalled();
  });
});

/**
 * The web's escape hatch. Desktop has the status bar's Retry button; the web
 * has no bar at all, so without this the only way out of a gated state is the
 * heartbeat's next beat -- and that backs off to as much as RETRY_MAX_MS once
 * an outage has run a while. A toast reading "Check your connection and try
 * again" over a button where trying again provably does nothing is worse than
 * no toast, so on the web the refused click IS the retry.
 *
 * Driven through the real ServerList module: the point is that the click
 * reaches the same probe the desktop button does, throttled by the same
 * policy (manualRetryAvailable) and the same clock.
 */
/**
 * `multiplayerAllowedForSession` refuses every `signed-out` state regardless
 * of `reason`, so "needs-account" gates multiplayer for free and needed no
 * production change here. This pins that: if the rule is ever narrowed to an
 * allowlist of reasons, this is what would catch a player with no account yet
 * slipping through.
 */
describe("shouldBlockMultiplayerAction with a needs-account session", () => {
  it("blocks multiplayer when no account exists yet, online or offline", () => {
    for (const backendOutage of [false, true]) {
      expect(
        shouldBlockMultiplayerAction(
          null,
          { status: "signed-out", reason: "needs-account" },
          backendOutage,
        ),
      ).toBe(true);
    }
  });
});
