import { ReactiveController, ReactiveControllerHost } from "lit";
import { getGamesPlayed } from "../Utils";

const HELP_SEEN_KEY = "helpSeen";

/**
 * Shared dot state for the nav: the "?" button nudges new players until they
 * have opened help once. One store rather than one per component, so every
 * mounted copy of the button clears together.
 */
class NavNotificationsStore {
  private hosts = new Set<ReactiveControllerHost>();
  private loaded = false;

  private _helpSeen = false;

  subscribe(host: ReactiveControllerHost): void {
    this.hosts.add(host);
    if (this.loaded) return;
    this.loaded = true;
    this._helpSeen = localStorage.getItem(HELP_SEEN_KEY) === "true";
  }

  unsubscribe(host: ReactiveControllerHost): void {
    this.hosts.delete(host);
  }

  showHelpDot(): boolean {
    return getGamesPlayed() < 10 && !this._helpSeen;
  }

  onHelpClick = (): void => {
    localStorage.setItem(HELP_SEEN_KEY, "true");
    this._helpSeen = true;
    for (const host of this.hosts) host.requestUpdate();
  };

  /** Test seam: drop all state so a fresh load re-reads localStorage. */
  reset(): void {
    this.hosts.clear();
    this.loaded = false;
    this._helpSeen = false;
  }
}

export const navNotifications = new NavNotificationsStore();

/**
 * Host-facing view of {@link navNotifications}: keeps the component subscribed
 * for its lifetime and forwards the dot query and click handler.
 */
export class NavNotificationsController implements ReactiveController {
  private host: ReactiveControllerHost;

  constructor(host: ReactiveControllerHost) {
    this.host = host;
    host.addController(this);
  }

  hostConnected(): void {
    navNotifications.subscribe(this.host);
  }

  hostDisconnected(): void {
    navNotifications.unsubscribe(this.host);
  }

  showHelpDot(): boolean {
    return navNotifications.showHelpDot();
  }

  onHelpClick = (): void => navNotifications.onHelpClick();
}
