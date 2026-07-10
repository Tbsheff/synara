// FILE: main.updateController.test.ts
// Purpose: Lock auto-updater state transitions and the install handshake with a fake autoUpdater.

import { EventEmitter } from "node:events";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DesktopUpdateController, type DesktopUpdateControllerDeps } from "./main.updateController";
import { DESKTOP_UPDATE_CHANNEL } from "./main.constants";
import { createUpdateInstallMarker, readInstallMarker, writeInstallMarker } from "./updateInstallMarker";

const temporaryDirectories: string[] = [];

function createInstallMarkerPath(): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-update-controller-"));
  temporaryDirectories.push(directory);
  return Path.join(directory, "pending-update-install.json");
}

class FakeAutoUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  channel = "";
  allowPrerelease = false;
  allowDowngrade = true;
  disableDifferentialDownload = false;
  checkForUpdates = vi.fn(async () => ({}) as never);
  downloadUpdate = vi.fn(async () => [] as never);
  quitAndInstall = vi.fn();
  setFeedURL = vi.fn();
}

function createController(overrides: Partial<DesktopUpdateControllerDeps> = {}) {
  const autoUpdater = new FakeAutoUpdater();
  const installMarkerPath = createInstallMarkerPath();
  let quitting = false;
  const deps: DesktopUpdateControllerDeps = {
    autoUpdater: autoUpdater as unknown as DesktopUpdateControllerDeps["autoUpdater"],
    createCancellationToken: () =>
      ({ cancel: vi.fn() }) as unknown as ReturnType<
        DesktopUpdateControllerDeps["createCancellationToken"]
      >,
    getAppVersion: vi.fn(() => "1.0.0"),
    getAppName: vi.fn(() => "Synara"),
    desktopRuntimeInfo: {
      platform: "darwin",
      arch: "arm64",
      runningUnderArm64Translation: false,
    } as unknown as DesktopUpdateControllerDeps["desktopRuntimeInfo"],
    getAllWindows: vi.fn(() => []),
    resolveAutoUpdateDisabledReason: vi.fn(() => null),
    readAppUpdateYml: vi.fn(() => ({
      provider: "github",
      owner: "x",
      repo: "y",
    })),
    getIsQuitting: () => quitting,
    setIsQuitting: vi.fn((value: boolean) => {
      quitting = value;
    }),
    stopBackendAndWaitForExit: vi.fn(async () => {}),
    restartBackend: vi.fn(),
    getInstallMarkerPath: vi.fn(() => installMarkerPath),
    logInstallDiagnostics: vi.fn(async () => {}),
    clearNotificationBadge: vi.fn(),
    formatErrorMessage: vi.fn((e) => (e instanceof Error ? e.message : String(e))),
    githubToken: vi.fn(() => ""),
    constants: {
      stateChannel: "update:state",
      updateChannel: "stable",
      allowPrerelease: false,
      checkTimeoutMs: 30_000,
      downloadSettleTimeoutMs: 5_000,
      downloadStallTimeoutMs: 60_000,
      feedCacheTtlMs: 300_000,
      feedRefreshTimeoutMs: 10_000,
      foregroundRecheckMinBackgroundMs: 60_000,
      foregroundRecheckMinIntervalMs: 300_000,
      installWatchdogMs: 15_000,
      pollIntervalMs: 3_600_000,
      stalledCancellationSuppressionMs: 5_000,
      startupDelayMs: 10_000,
    },
    ...overrides,
  };
  const controller = new DesktopUpdateController(deps);
  const setQuitting = (v: boolean): void => {
    quitting = v;
  };
  return { controller, deps, autoUpdater, setQuitting };
}

describe("DesktopUpdateController", () => {
  it("uses the dedicated Synara update channel", () => {
    expect(DESKTOP_UPDATE_CHANNEL).toBe("synara");
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    for (const directory of temporaryDirectories.splice(0)) {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("configure() enables updates, configures autoUpdater, and arms the poll timers", () => {
    const { controller, autoUpdater } = createController();
    controller.configure();

    expect(controller.getState().enabled).toBe(true);
    expect(controller.getState().status).toBe("idle");
    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
    expect(autoUpdater.channel).toBe("stable");

    // startup timer fires a check; status flips to "checking" synchronously before any await
    vi.advanceTimersByTime(10_000);
    expect(controller.getState().status).toBe("checking");
  });

  it("configure() with a disabled reason yields disabled state and no autoUpdater wiring", () => {
    const { controller, autoUpdater } = createController({
      resolveAutoUpdateDisabledReason: vi.fn(() => "running in dev"),
    });
    controller.configure();
    expect(controller.getState().enabled).toBe(false);
    expect(controller.getState().status).toBe("disabled");
    expect(autoUpdater.listenerCount("update-available")).toBe(0);
  });

  it("update-available transitions state and broadcasts to windows", () => {
    const send = vi.fn();
    const window = { isDestroyed: () => false, webContents: { send } } as never;
    const { controller, autoUpdater } = createController({
      getAllWindows: vi.fn(() => [window]),
    });
    controller.configure();
    send.mockClear();

    autoUpdater.emit("update-available", { version: "2.0.0" });
    expect(controller.getState().status).toBe("available");
    expect(controller.getState().availableVersion).toBe("2.0.0");
    expect(send).toHaveBeenCalledWith(
      "update:state",
      expect.objectContaining({ status: "available" }),
    );
  });

  it("ignores a non-newer update-available", () => {
    const { controller, autoUpdater } = createController();
    controller.configure();
    autoUpdater.emit("update-available", { version: "0.9.0" });
    expect(controller.getState().status).not.toBe("available");
  });

  it("checkForUpdates is skipped while already busy and while quitting", async () => {
    const { controller, deps, setQuitting } = createController();
    controller.configure();
    deps.autoUpdater.checkForUpdates = vi.fn(async () => ({}) as never);

    setQuitting(true);
    await controller.checkForUpdates("renderer");
    expect(deps.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("install handshake stops the backend, flips flags, and calls quitAndInstall", async () => {
    const { controller, deps, autoUpdater } = createController();
    controller.configure();
    autoUpdater.emit("update-available", { version: "2.0.0" });
    autoUpdater.emit("update-downloaded", { version: "2.0.0" });
    expect(controller.getState().status).toBe("downloaded");

    const result = await controller.installDownloadedUpdate();
    expect(result).toEqual({ accepted: true, completed: false });
    expect(deps.stopBackendAndWaitForExit).toHaveBeenCalled();
    expect(deps.setIsQuitting).toHaveBeenCalledWith(true);
    expect(autoUpdater.quitAndInstall).toHaveBeenCalled();
    expect(controller.isInstallPreparing()).toBe(true);
    expect(controller.isQuitAndInstallInFlight()).toBe(true);
    expect(readInstallMarker(deps.getInstallMarkerPath()).status).toBe("valid");
  });

  it("recovers the backend and records a durable failure when quitAndInstall hangs", async () => {
    const markerPath = createInstallMarkerPath();
    const { controller, deps, autoUpdater } = createController({
      getInstallMarkerPath: vi.fn(() => markerPath),
      readAppUpdateYml: vi.fn(() => null),
    });
    controller.configure();
    autoUpdater.emit("update-available", { version: "2.0.0" });
    autoUpdater.emit("update-downloaded", { version: "2.0.0" });

    await controller.installDownloadedUpdate();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(deps.restartBackend).toHaveBeenCalledOnce();
    expect(deps.setIsQuitting).toHaveBeenLastCalledWith(false);
    expect(controller.getState()).toMatchObject({
      status: "downloaded",
      errorContext: "install",
      installFailureCount: 1,
    });
    expect(readInstallMarker(markerPath)).toMatchObject({
      status: "valid",
      marker: { phase: "failed", consecutiveFailures: 1 },
    });
  });

  it("marks the durable install attempt as handed off when updater-owned quit begins", async () => {
    const markerPath = createInstallMarkerPath();
    const { controller, autoUpdater } = createController({
      getInstallMarkerPath: vi.fn(() => markerPath),
    });
    controller.configure();
    autoUpdater.emit("update-available", { version: "2.0.0" });
    autoUpdater.emit("update-downloaded", { version: "2.0.0" });
    await controller.installDownloadedUpdate();

    controller.markInstallHandoff();

    expect(readInstallMarker(markerPath)).toMatchObject({
      status: "valid",
      marker: { phase: "handoff", handoffAt: expect.any(String) },
    });
  });

  it("clears a verified install marker after starting the installed version", () => {
    const markerPath = createInstallMarkerPath();
    writeInstallMarker(
      markerPath,
      createUpdateInstallMarker({
        fromVersion: "1.0.0",
        toVersion: "2.0.0",
        requestedAt: new Date().toISOString(),
        consecutiveFailures: 0,
      }),
    );
    const { controller } = createController({
      getAppVersion: vi.fn(() => "2.0.0"),
      getInstallMarkerPath: vi.fn(() => markerPath),
      readAppUpdateYml: vi.fn(() => null),
    });

    controller.configure();

    expect(readInstallMarker(markerPath).status).toBe("missing");
    expect(controller.getState()).toMatchObject({ status: "idle", installFailureCount: 0 });
  });

  it("surfaces a failed prior install at startup and suppresses automatic checks", async () => {
    const markerPath = createInstallMarkerPath();
    writeInstallMarker(
      markerPath,
      createUpdateInstallMarker({
        fromVersion: "0.9.0",
        toVersion: "2.0.0",
        requestedAt: new Date().toISOString(),
        consecutiveFailures: 0,
      }),
    );
    const { controller, deps, autoUpdater } = createController({
      getInstallMarkerPath: vi.fn(() => markerPath),
      readAppUpdateYml: vi.fn(() => null),
    });

    controller.configure();
    expect(controller.getState()).toMatchObject({
      status: "error",
      availableVersion: "2.0.0",
      errorContext: "install",
      installFailureCount: 1,
    });
    expect(deps.logInstallDiagnostics).toHaveBeenCalledWith(
      "startup install verification failure",
    );

    await controller.checkForUpdates("poll");
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    await controller.checkForUpdates("renderer");
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
  });

  it("install is refused when not in downloaded state", async () => {
    const { controller } = createController();
    controller.configure();
    const result = await controller.installDownloadedUpdate();
    expect(result).toEqual({ accepted: false, completed: false });
  });

  it("handleForegrounded clears the notification badge", () => {
    const { controller, deps } = createController();
    controller.configure();
    controller.handleForegrounded();
    expect(deps.clearNotificationBadge).toHaveBeenCalled();
  });
});
