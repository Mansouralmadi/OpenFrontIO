import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getGamesPlayed } = vi.hoisted(() => ({
  getGamesPlayed: vi.fn(() => 0),
}));
vi.mock("../../src/client/Utils", () => ({ getGamesPlayed }));

import {
  NavNotificationsController,
  navNotifications,
} from "../../src/client/components/NavNotificationsController";

function host() {
  const requestUpdate = vi.fn();
  const stub = {
    requestUpdate,
    addController: () => {},
    removeController: () => {},
    updateComplete: Promise.resolve(true),
  };
  const controller = new NavNotificationsController(stub as never);
  controller.hostConnected();
  return { controller, requestUpdate };
}

describe("nav notifications", () => {
  beforeEach(() => {
    navNotifications.reset();
    localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("shows the help dot to new players until help is opened, across components", () => {
    const desktop = host();
    const mobile = host();
    expect(desktop.controller.showHelpDot()).toBe(true);

    mobile.controller.onHelpClick();

    expect(desktop.controller.showHelpDot()).toBe(false);
    expect(desktop.requestUpdate).toHaveBeenCalled();
    expect(localStorage.getItem("helpSeen")).toBe("true");
  });

  it("hides the help dot for experienced players", () => {
    getGamesPlayed.mockReturnValue(10);
    expect(host().controller.showHelpDot()).toBe(false);
  });
});
