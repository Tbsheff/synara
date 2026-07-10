// FILE: main.updateController.ts
// Purpose: Orchestrate electron-updater event wiring, update state, timers, and install handshake.
// Layer: Desktop main process
// Exports: DesktopUpdateController, DesktopUpdateControllerDeps.

import * as FS from "node:fs";
import * as OS from "node:os";

import type { AppUpdater, CancellationToken as CancellationTokenType } from "electron-updater";
import type { DesktopRuntimeInfo, DesktopUpdateState } from "@t3tools/contracts";

import {
  type DownloadProgressSample,
  getDownloadStallTimeoutMessage,
  hasDownloadProgressAdvanced,
  isExpectedStalledDownloadCancellationError,
  isUpdateVersionNewer,
  shouldBroadcastDownloadProgress,
  shouldCheckForUpdatesOnForeground,
} from "./updateState";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnInstallRestartFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine";
import {
  PendingUpdateCacheClearQueue,
  resolveElectronUpdaterCacheDirName,
  resolveElectronUpdaterLegacyZipPath,
  resolveElectronUpdaterPendingCacheDir,
} from "./updatePendingCache";
import {
  buildGitHubReleaseDownloadBaseUrl,
  type LatestGitHubRelease,
  resolveGitHubUpdateSource,
  resolveLatestStableGitHubRelease,
} from "./githubUpdateFeed";
import { CachedGitHubUpdateFeedRefresher } from "./updateFeedCache";
import { isArm64HostRunningIntelBuild } from "./runtimeArch";
import { StalledDownloadCancellationSuppression } from "./updateStallSuppression";
import {
  clearInstallMarker,
  createUpdateInstallMarker,
  markInstallHandoffSync,
  readInstallMarker,
  resolveInstallMarkerOutcome,
  writeInstallMarker,
  type UpdateInstallMarker,
} from "./updateInstallMarker";

type DesktopUpdateErrorContext = DesktopUpdateState["errorContext"];

interface UpdateActionResult {
  readonly accepted: boolean;
  readonly completed: boolean;
}

export interface DesktopUpdateControllerDeps {
  readonly autoUpdater: AppUpdater;
  readonly createCancellationToken: () => CancellationTokenType;
  readonly getAppVersion: () => string;
  readonly getAppName: () => string;
  readonly desktopRuntimeInfo: DesktopRuntimeInfo;
  readonly getAllWindows: () => Electron.BrowserWindow[];
  readonly resolveAutoUpdateDisabledReason: () => string | null;
  readonly readAppUpdateYml: () => Record<string, string> | null;
  readonly getIsQuitting: () => boolean;
  readonly setIsQuitting: (value: boolean) => void;
  readonly stopBackendAndWaitForExit: () => Promise<void>;
  readonly restartBackend: () => void;
  readonly getInstallMarkerPath: () => string;
  readonly logInstallDiagnostics: (context: string) => Promise<void>;
  readonly clearNotificationBadge: () => void;
  readonly formatErrorMessage: (error: unknown) => string;
  readonly githubToken: () => string;
  readonly constants: {
    readonly stateChannel: string;
    readonly updateChannel: string;
    readonly allowPrerelease: boolean;
    readonly checkTimeoutMs: number;
    readonly downloadSettleTimeoutMs: number;
    readonly downloadStallTimeoutMs: number;
    readonly feedCacheTtlMs: number;
    readonly feedRefreshTimeoutMs: number;
    readonly foregroundRecheckMinBackgroundMs: number;
    readonly foregroundRecheckMinIntervalMs: number;
    readonly installWatchdogMs: number;
    readonly pollIntervalMs: number;
    readonly stalledCancellationSuppressionMs: number;
    readonly startupDelayMs: number;
  };
}

export class DesktopUpdateController {
  private updateState: DesktopUpdateState;
  private updaterConfigured = false;
  private updateCheckInFlight = false;
  private updateDownloadInFlight = false;
  private isUpdaterInstallPreparing = false;
  private isUpdaterQuitAndInstallInFlight = false;
  private updatePollTimer: ReturnType<typeof setInterval> | null = null;
  private updateStartupTimer: ReturnType<typeof setTimeout> | null = null;
  private updateCheckTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private updateDownloadStallTimer: ReturnType<typeof setTimeout> | null = null;
  private updateInstallWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private updateBackgroundBlurTimer: ReturnType<typeof setTimeout> | null = null;
  private updateBackgroundedAtMs: number | null = null;
  private updateDownloadCancellationToken: CancellationTokenType | null = null;
  private rejectUpdateDownloadStall: ((error: Error) => void) | null = null;
  private lastUpdateDownloadProgressSample: DownloadProgressSample | null = null;
  private configuredGitHubUpdateSource: ReturnType<typeof resolveGitHubUpdateSource> = null;
  private configuredGitHubUpdateToken = "";
  private configuredGitHubUpdateFeedRefresher: CachedGitHubUpdateFeedRefresher | null = null;
  private configuredUpdaterCacheDirName: string | null = null;
  private automaticUpdateActivitySuppressed = false;
  private readonly stalledDownloadCancellationSuppression: StalledDownloadCancellationSuppression;
  private readonly pendingUpdateCacheClearQueue = new PendingUpdateCacheClearQueue();

  constructor(private readonly deps: DesktopUpdateControllerDeps) {
    this.stalledDownloadCancellationSuppression = new StalledDownloadCancellationSuppression(
      deps.constants.stalledCancellationSuppressionMs,
    );
    this.updateState = createInitialDesktopUpdateState(
      deps.getAppVersion(),
      deps.desktopRuntimeInfo,
    );
  }

  getState(): DesktopUpdateState {
    return this.updateState;
  }

  isInstallPreparing(): boolean {
    return this.isUpdaterInstallPreparing;
  }

  isQuitAndInstallInFlight(): boolean {
    return this.isUpdaterQuitAndInstallInFlight;
  }

  emitState(): void {
    for (const window of this.deps.getAllWindows()) {
      if (window.isDestroyed()) continue;
      window.webContents.send(this.deps.constants.stateChannel, this.updateState);
    }
  }

  private setUpdateState(patch: Partial<DesktopUpdateState>): void {
    this.updateState = { ...this.updateState, ...patch };
    this.emitState();
  }

  private shouldEnableAutoUpdates(): boolean {
    return this.deps.resolveAutoUpdateDisabledReason() === null;
  }

  private resolveUpdaterErrorContext(): DesktopUpdateErrorContext {
    if (this.isUpdaterInstallPreparing || this.isUpdaterQuitAndInstallInFlight) return "install";
    if (this.updateDownloadInFlight) return "download";
    if (this.updateCheckInFlight) return "check";
    return this.updateState.errorContext;
  }

  private clearUpdaterInstallInFlightAfterError(): void {
    if (!this.isUpdaterInstallPreparing && !this.isUpdaterQuitAndInstallInFlight) {
      return;
    }
    this.isUpdaterInstallPreparing = false;
    this.isUpdaterQuitAndInstallInFlight = false;
    this.clearInstallWatchdog();
    this.deps.setIsQuitting(false);
  }

  private recordInstallMarkerFailure(nowIso: string): number {
    const result = readInstallMarker(this.deps.getInstallMarkerPath());
    if (result.status !== "valid") {
      console.error(
        `[desktop-updater] Could not record durable install failure: marker is ${result.status}${result.status === "invalid" ? ` (${result.error})` : ""}.`,
      );
      return Math.max(1, this.updateState.installFailureCount + 1);
    }
    if (result.marker.phase === "failed") {
      return result.marker.consecutiveFailures;
    }
    const failedMarker: UpdateInstallMarker = {
      ...result.marker,
      phase: "failed",
      consecutiveFailures: result.marker.consecutiveFailures + 1,
      lastFailureAt: nowIso,
    };
    try {
      writeInstallMarker(this.deps.getInstallMarkerPath(), failedMarker);
    } catch (error) {
      console.error(
        `[desktop-updater] Failed to persist install failure marker: ${this.deps.formatErrorMessage(error)}`,
      );
    }
    return failedMarker.consecutiveFailures;
  }

  private clearInstallWatchdog(): void {
    if (this.updateInstallWatchdogTimer) {
      clearTimeout(this.updateInstallWatchdogTimer);
      this.updateInstallWatchdogTimer = null;
    }
  }

  private scheduleUpdatePoll(): void {
    if (this.updatePollTimer || this.automaticUpdateActivitySuppressed) {
      return;
    }
    this.updatePollTimer = setInterval(() => {
      void this.checkForUpdates("poll");
    }, this.deps.constants.pollIntervalMs);
    this.updatePollTimer.unref();
  }

  private armInstallWatchdog(): void {
    this.clearInstallWatchdog();
    this.updateInstallWatchdogTimer = setTimeout(() => {
      this.updateInstallWatchdogTimer = null;
      if (!this.isUpdaterQuitAndInstallInFlight) {
        return;
      }
      this.clearUpdaterInstallInFlightAfterError();
      this.deps.restartBackend();
      this.scheduleUpdatePoll();
      const consecutiveFailures = this.recordInstallMarkerFailure(new Date().toISOString());
      this.setUpdateState({
        ...reduceDesktopUpdateStateOnInstallFailure(
          this.updateState,
          "The update couldn’t be installed automatically.",
        ),
        installFailureCount: consecutiveFailures,
      });
      console.error(
        "[desktop-updater] quitAndInstall did not exit the app within the watchdog window; surfacing manual-download fallback.",
      );
    }, this.deps.constants.installWatchdogMs);
    this.updateInstallWatchdogTimer.unref();
  }

  private clearLegacyUpdaterZipAfterVerifiedInstall(): void {
    const legacyZipPath = resolveElectronUpdaterLegacyZipPath({
      cacheDirName: this.configuredUpdaterCacheDirName,
      platform: process.platform,
      homeDir: OS.homedir(),
      localAppData: process.env.LOCALAPPDATA ?? null,
      xdgCacheHome: process.env.XDG_CACHE_HOME ?? null,
    });
    if (!legacyZipPath) return;
    try {
      FS.rmSync(legacyZipPath, { force: true });
      console.info("[desktop-updater] Cleared legacy top-level update.zip after verified install.");
    } catch (error) {
      console.warn(
        `[desktop-updater] Failed to clear legacy top-level update.zip: ${this.deps.formatErrorMessage(error)}`,
      );
    }
  }

  private quarantineInstallMarker(reason: string): void {
    console.warn(`[desktop-updater] Discarding update install marker (${reason}).`);
    try {
      clearInstallMarker(this.deps.getInstallMarkerPath());
    } catch (error) {
      console.warn(
        `[desktop-updater] Failed to delete quarantined update install marker: ${this.deps.formatErrorMessage(error)}`,
      );
    }
  }

  private processInstallMarkerOnStartup(): void {
    const filePath = this.deps.getInstallMarkerPath();
    const readResult = readInstallMarker(filePath);
    if (readResult.status === "missing") return;
    if (readResult.status === "invalid") {
      this.quarantineInstallMarker(`invalid or unreadable: ${readResult.error}`);
      return;
    }

    const marker = readResult.marker;
    const nowIso = new Date().toISOString();
    const outcome = resolveInstallMarkerOutcome(marker, this.deps.getAppVersion(), nowIso);
    if (outcome === "success") {
      console.info(
        `[desktop-updater] Update to ${marker.toVersion} installed successfully (from ${marker.fromVersion})`,
      );
      try {
        clearInstallMarker(filePath);
      } catch (error) {
        console.warn(
          `[desktop-updater] Failed to clear successful update install marker: ${this.deps.formatErrorMessage(error)}`,
        );
      }
      this.clearLegacyUpdaterZipAfterVerifiedInstall();
      return;
    }
    if (outcome === "stale" || outcome === "invalid") {
      this.quarantineInstallMarker(outcome);
      return;
    }

    let consecutiveFailures = marker.consecutiveFailures;
    if (outcome === "failure") {
      consecutiveFailures += 1;
      try {
        writeInstallMarker(filePath, {
          ...marker,
          phase: "failed",
          consecutiveFailures,
          lastFailureAt: nowIso,
        });
      } catch (error) {
        console.error(
          `[desktop-updater] Failed to persist restart install failure: ${this.deps.formatErrorMessage(error)}`,
        );
      }
    }

    this.automaticUpdateActivitySuppressed = true;
    const message = `Synara restarted, but update ${marker.toVersion} was not installed. Try again.`;
    this.setUpdateState(
      reduceDesktopUpdateStateOnInstallRestartFailure(
        this.updateState,
        marker.toVersion,
        consecutiveFailures,
        message,
      ),
    );
    console.error(
      `[desktop-updater] UPDATE INSTALL FAILED: still running ${this.deps.getAppVersion()} after attempting ${marker.toVersion}; consecutive failures=${consecutiveFailures}. Automatic update checks are suppressed until the user retries.`,
    );
    void this.deps.logInstallDiagnostics("startup install verification failure");
  }

  markInstallHandoff(): void {
    markInstallHandoffSync(this.deps.getInstallMarkerPath());
  }

  private applyConfiguredGitHubUpdateFeed(latestRelease: LatestGitHubRelease): void {
    if (this.configuredGitHubUpdateSource === null) {
      return;
    }
    this.deps.autoUpdater.setFeedURL({
      provider: "generic",
      url: buildGitHubReleaseDownloadBaseUrl(this.configuredGitHubUpdateSource, latestRelease.tag),
      ...(this.configuredGitHubUpdateToken
        ? {
            requestHeaders: {
              authorization: `token ${this.configuredGitHubUpdateToken}`,
            },
          }
        : {}),
    });
  }

  private async resolveLatestConfiguredGitHubRelease(): Promise<LatestGitHubRelease | null> {
    if (this.configuredGitHubUpdateSource === null) {
      return null;
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.deps.constants.feedRefreshTimeoutMs);
    timeoutTimer.unref();

    try {
      return await resolveLatestStableGitHubRelease(
        this.configuredGitHubUpdateSource,
        this.configuredGitHubUpdateToken,
        { signal: controller.signal },
      );
    } catch (error) {
      if (timedOut) {
        throw new Error("Timed out while refreshing the desktop update feed.");
      }
      throw error;
    } finally {
      clearTimeout(timeoutTimer);
    }
  }

  private shouldForceUpdateFeedRefresh(reason: string): boolean {
    return reason === "menu" || reason === "renderer";
  }

  // Explicit user checks bypass the feed TTL; automatic checks keep startup/foreground latency low.
  private async refreshConfiguredUpdateFeed(
    options: { readonly force?: boolean } = {},
  ): Promise<void> {
    await this.configuredGitHubUpdateFeedRefresher?.refresh(options);
  }

  private isKnownUpdateVersionNewer(version: string | null | undefined): version is string {
    return typeof version === "string" && isUpdateVersionNewer(this.deps.getAppVersion(), version);
  }

  private getPendingUpdateCacheDir(): string | null {
    return resolveElectronUpdaterPendingCacheDir({
      cacheDirName: this.configuredUpdaterCacheDirName,
      platform: process.platform,
      homeDir: OS.homedir(),
      localAppData: process.env.LOCALAPPDATA ?? null,
      xdgCacheHome: process.env.XDG_CACHE_HOME ?? null,
    });
  }

  // electron-updater can leave a same-version ZIP in `pending` after a restart or
  // a failed install attempt. Clearing it prevents stale "ready" states.
  private async clearPendingUpdateCache(reason: string): Promise<void> {
    const pendingDir = this.getPendingUpdateCacheDir();
    if (!pendingDir || this.updateDownloadInFlight) {
      return;
    }
    try {
      await FS.promises.rm(pendingDir, { recursive: true, force: true });
      console.info(`[desktop-updater] Cleared pending update cache (${reason}).`);
    } catch (error) {
      console.warn(
        `[desktop-updater] Failed to clear pending update cache (${reason}): ${this.deps.formatErrorMessage(error)}`,
      );
    }
  }

  // Terminal updater events can arrive before downloadUpdate() settles; defer cache deletion
  // until the updater has released its in-flight download bookkeeping.
  private clearPendingUpdateCacheWhenSafe(reason: string): void {
    this.pendingUpdateCacheClearQueue.request(reason, this.updateDownloadInFlight, (safeReason) => {
      void this.clearPendingUpdateCache(safeReason);
    });
  }

  clearBackgroundBlurTimer(): void {
    if (this.updateBackgroundBlurTimer) {
      clearTimeout(this.updateBackgroundBlurTimer);
      this.updateBackgroundBlurTimer = null;
    }
  }

  // Fail closed if electron-updater never emits a terminal check outcome.
  clearCheckTimeoutTimer(): void {
    if (this.updateCheckTimeoutTimer) {
      clearTimeout(this.updateCheckTimeoutTimer);
      this.updateCheckTimeoutTimer = null;
    }
  }

  private armUpdateCheckTimeout(reason: string): void {
    this.clearCheckTimeoutTimer();
    this.updateCheckTimeoutTimer = setTimeout(() => {
      this.updateCheckTimeoutTimer = null;
      if (this.updateState.status !== "checking") {
        return;
      }
      this.updateCheckInFlight = false;
      this.setUpdateState(
        reduceDesktopUpdateStateOnCheckFailure(
          this.updateState,
          "Timed out while checking for updates. Try again.",
          new Date().toISOString(),
        ),
      );
      console.error(`[desktop-updater] Update check timed out (${reason}).`);
    }, this.deps.constants.checkTimeoutMs);
    this.updateCheckTimeoutTimer.unref();
  }

  private clearUpdateDownloadStallTimer(): void {
    if (this.updateDownloadStallTimer) {
      clearTimeout(this.updateDownloadStallTimer);
      this.updateDownloadStallTimer = null;
    }
  }

  // Bounds a silent updater download while allowing slow downloads that keep making progress.
  private armUpdateDownloadStallTimer(reason: string): void {
    this.clearUpdateDownloadStallTimer();
    this.updateDownloadStallTimer = setTimeout(() => {
      this.updateDownloadStallTimer = null;
      if (!this.updateDownloadInFlight || this.updateState.status !== "downloading") {
        return;
      }

      const error = new Error(
        getDownloadStallTimeoutMessage(this.deps.constants.downloadStallTimeoutMs),
      );
      console.error(`[desktop-updater] ${error.message} (${reason}).`);
      this.stalledDownloadCancellationSuppression.arm();
      this.rejectUpdateDownloadStall?.(error);
      this.updateDownloadCancellationToken?.cancel();
    }, this.deps.constants.downloadStallTimeoutMs);
    this.updateDownloadStallTimer.unref();
  }

  private updateDownloadStallTimerOnProgress(progress: DownloadProgressSample): void {
    if (!this.updateDownloadInFlight) {
      return;
    }
    if (!hasDownloadProgressAdvanced(this.lastUpdateDownloadProgressSample, progress)) {
      return;
    }
    this.lastUpdateDownloadProgressSample = {
      percent: progress.percent ?? null,
      transferred: progress.transferred ?? null,
    };
    this.armUpdateDownloadStallTimer(`download progress ${Math.floor(progress.percent ?? 0)}%`);
  }

  private isDesktopAppForegrounded(): boolean {
    return this.deps.getAllWindows().some((window) => !window.isDestroyed() && window.isFocused());
  }

  markBackgrounded(): void {
    this.clearBackgroundBlurTimer();
    this.updateBackgroundBlurTimer = setTimeout(() => {
      this.updateBackgroundBlurTimer = null;
      if (this.isDesktopAppForegrounded()) {
        return;
      }
      this.updateBackgroundedAtMs = Date.now();
    }, 0);
  }

  handleForegrounded(): void {
    this.clearBackgroundBlurTimer();
    this.deps.clearNotificationBadge();
    const foregroundedAtMs = Date.now();
    const backgroundedAtMs = this.updateBackgroundedAtMs;
    this.updateBackgroundedAtMs = null;
    const shouldCheck = shouldCheckForUpdatesOnForeground({
      checkedAt: this.updateState.checkedAt,
      backgroundedAtMs,
      foregroundedAtMs,
      minBackgroundDurationMs: this.deps.constants.foregroundRecheckMinBackgroundMs,
      minIntervalMs: this.deps.constants.foregroundRecheckMinIntervalMs,
    });
    if (!shouldCheck) {
      return;
    }
    void this.checkForUpdates("foreground");
  }

  async checkForUpdates(reason: string): Promise<void> {
    if (this.deps.getIsQuitting() || !this.updaterConfigured || this.updateCheckInFlight) return;
    if (this.automaticUpdateActivitySuppressed) {
      if (!this.shouldForceUpdateFeedRefresh(reason)) {
        console.info(
          `[desktop-updater] Skipping automatic update check (${reason}) after an unverified install failure.`,
        );
        return;
      }
      this.automaticUpdateActivitySuppressed = false;
      console.info(
        `[desktop-updater] User requested update recovery (${reason}); automatic checks are enabled for this session.`,
      );
      this.scheduleUpdatePoll();
    }
    if (
      this.updateState.status === "checking" ||
      this.updateState.status === "downloading" ||
      this.updateState.status === "downloaded"
    ) {
      console.info(
        `[desktop-updater] Skipping update check (${reason}) while status=${this.updateState.status}.`,
      );
      return;
    }
    this.updateCheckInFlight = true;
    this.setUpdateState(
      reduceDesktopUpdateStateOnCheckStart(this.updateState, new Date().toISOString()),
    );
    this.armUpdateCheckTimeout(reason);
    console.info(`[desktop-updater] Checking for updates (${reason})...`);

    try {
      await this.refreshConfiguredUpdateFeed({
        force: this.shouldForceUpdateFeedRefresh(reason),
      });
      await this.deps.autoUpdater.checkForUpdates();
    } catch (error: unknown) {
      this.clearCheckTimeoutTimer();
      const message = error instanceof Error ? error.message : String(error);
      this.setUpdateState(
        reduceDesktopUpdateStateOnCheckFailure(this.updateState, message, new Date().toISOString()),
      );
      console.error(`[desktop-updater] Failed to check for updates: ${message}`);
    } finally {
      this.updateCheckInFlight = false;
    }
  }

  async downloadAvailableUpdate(): Promise<UpdateActionResult> {
    if (
      !this.updaterConfigured ||
      this.updateDownloadInFlight ||
      this.updateState.status !== "available"
    ) {
      return { accepted: false, completed: false };
    }
    if (!this.isKnownUpdateVersionNewer(this.updateState.availableVersion)) {
      await this.clearPendingUpdateCache("available version is not newer than current app");
      this.setUpdateState(
        reduceDesktopUpdateStateOnNoUpdate(this.updateState, new Date().toISOString()),
      );
      console.info(
        `[desktop-updater] Ignoring stale available update ${this.updateState.availableVersion ?? "unknown"} for current ${this.deps.getAppVersion()}.`,
      );
      return { accepted: false, completed: false };
    }
    this.updateDownloadInFlight = true;
    this.setUpdateState(reduceDesktopUpdateStateOnDownloadStart(this.updateState));
    this.deps.autoUpdater.disableDifferentialDownload = true;
    // Keep existing cancellation suppressions across immediate retries; the old
    // updater cancellation can arrive after a new download has already started.
    this.lastUpdateDownloadProgressSample = null;
    const cancellationToken = this.deps.createCancellationToken();
    this.updateDownloadCancellationToken = cancellationToken;
    const downloadStalled = new Promise<never>((_, reject) => {
      this.rejectUpdateDownloadStall = reject;
    });
    this.armUpdateDownloadStallTimer("download start");
    console.info("[desktop-updater] Downloading update...");

    // Track electron-updater's own download promise separately from the stall race.
    // When the stall timer wins the race it cancels this promise, but the updater
    // keeps its internal download promise set until that cancellation unwinds. We
    // observe its settlement here (so a late rejection can't surface as an unhandled
    // rejection) and wait on it before releasing the in-flight flag below.
    let updaterDownloadSettled = false;
    const updaterDownloadPromise = this.deps.autoUpdater.downloadUpdate(cancellationToken);
    const updaterDownloadSettledPromise = updaterDownloadPromise.then(
      () => {
        updaterDownloadSettled = true;
      },
      () => {
        updaterDownloadSettled = true;
      },
    );

    try {
      await Promise.race([updaterDownloadPromise, downloadStalled]);
      return { accepted: true, completed: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.setUpdateState(reduceDesktopUpdateStateOnDownloadFailure(this.updateState, message));
      console.error(`[desktop-updater] Failed to download update: ${message}`);
      return { accepted: true, completed: false };
    } finally {
      this.clearUpdateDownloadStallTimer();
      // Hold the in-flight flag until the updater download actually settles, so an
      // immediate retry can't grab the still-cancelling promise (which would reject
      // as "cancelled"). Bounded so a stuck updater promise can't wedge updates.
      if (!updaterDownloadSettled) {
        await Promise.race([
          updaterDownloadSettledPromise,
          new Promise<void>((resolve) => {
            setTimeout(resolve, this.deps.constants.downloadSettleTimeoutMs).unref();
          }),
        ]);
      }
      if (this.updateDownloadCancellationToken === cancellationToken) {
        this.updateDownloadCancellationToken = null;
      }
      this.rejectUpdateDownloadStall = null;
      this.lastUpdateDownloadProgressSample = null;
      this.updateDownloadInFlight = false;
      const pendingCacheClearReason = this.pendingUpdateCacheClearQueue.consumeAfterDownload();
      if (pendingCacheClearReason) {
        await this.clearPendingUpdateCache(pendingCacheClearReason);
      }
    }
  }

  async installDownloadedUpdate(): Promise<UpdateActionResult> {
    if (
      this.deps.getIsQuitting() ||
      !this.updaterConfigured ||
      this.updateState.status !== "downloaded"
    ) {
      return { accepted: false, completed: false };
    }
    const versionToInstall =
      this.updateState.downloadedVersion ?? this.updateState.availableVersion;
    if (!this.isKnownUpdateVersionNewer(versionToInstall)) {
      await this.clearPendingUpdateCache("downloaded version is not newer than current app");
      this.setUpdateState(
        reduceDesktopUpdateStateOnNoUpdate(this.updateState, new Date().toISOString()),
      );
      console.info(
        `[desktop-updater] Ignoring stale downloaded update ${versionToInstall ?? "unknown"} for current ${this.deps.getAppVersion()}.`,
      );
      return { accepted: false, completed: false };
    }

    const markerPath = this.deps.getInstallMarkerPath();
    const existingMarkerResult = readInstallMarker(markerPath);
    const existingMarker =
      existingMarkerResult.status === "valid" &&
      existingMarkerResult.marker.toVersion === versionToInstall
        ? existingMarkerResult.marker
        : null;
    const marker = createUpdateInstallMarker({
      fromVersion: this.deps.getAppVersion(),
      toVersion: versionToInstall,
      requestedAt: new Date().toISOString(),
      consecutiveFailures: existingMarker?.consecutiveFailures ?? 0,
      lastFailureAt: existingMarker?.lastFailureAt ?? null,
    });
    let markerWritten = false;
    try {
      writeInstallMarker(markerPath, marker);
      markerWritten = true;
      this.deps.setIsQuitting(true);
      this.isUpdaterInstallPreparing = true;
      this.clearPollTimer();
      await this.deps.stopBackendAndWaitForExit();
      await this.deps.logInstallDiagnostics("before install handoff");
      this.isUpdaterQuitAndInstallInFlight = true;
      this.deps.autoUpdater.quitAndInstall();
      this.armInstallWatchdog();
      return { accepted: true, completed: false };
    } catch (error: unknown) {
      const message = this.deps.formatErrorMessage(error);
      this.isUpdaterInstallPreparing = false;
      this.isUpdaterQuitAndInstallInFlight = false;
      this.deps.setIsQuitting(false);
      const consecutiveFailures = markerWritten
        ? this.recordInstallMarkerFailure(new Date().toISOString())
        : this.updateState.installFailureCount;
      this.deps.restartBackend();
      this.scheduleUpdatePoll();
      this.setUpdateState({
        ...reduceDesktopUpdateStateOnInstallFailure(this.updateState, message),
        installFailureCount: consecutiveFailures,
      });
      console.error(`[desktop-updater] Failed to install update: ${message}`);
      return { accepted: true, completed: false };
    }
  }

  clearPollTimer(): void {
    this.clearInstallWatchdog();
    if (this.updateStartupTimer) {
      clearTimeout(this.updateStartupTimer);
      this.updateStartupTimer = null;
    }
    if (this.updatePollTimer) {
      clearInterval(this.updatePollTimer);
      this.updatePollTimer = null;
    }
  }

  configure(): void {
    const appUpdateYml = this.deps.readAppUpdateYml();
    this.configuredUpdaterCacheDirName = resolveElectronUpdaterCacheDirName(
      appUpdateYml,
      this.deps.getAppName(),
    );
    const enabled = this.shouldEnableAutoUpdates();
    this.setUpdateState({
      ...createInitialDesktopUpdateState(this.deps.getAppVersion(), this.deps.desktopRuntimeInfo),
      enabled,
      status: enabled ? "idle" : "disabled",
    });
    this.processInstallMarkerOnStartup();
    if (!enabled) {
      this.configuredGitHubUpdateSource = null;
      this.configuredGitHubUpdateToken = "";
      this.configuredGitHubUpdateFeedRefresher = null;
      this.configuredUpdaterCacheDirName = null;
      return;
    }
    this.updaterConfigured = true;
    this.configuredGitHubUpdateSource = resolveGitHubUpdateSource(appUpdateYml);

    const githubToken = this.deps.githubToken();
    this.configuredGitHubUpdateToken = githubToken;
    this.configuredGitHubUpdateFeedRefresher =
      this.configuredGitHubUpdateSource === null
        ? null
        : new CachedGitHubUpdateFeedRefresher({
            cacheTtlMs: this.deps.constants.feedCacheTtlMs,
            resolveLatestRelease: () => this.resolveLatestConfiguredGitHubRelease(),
            applyRelease: (release) => this.applyConfiguredGitHubUpdateFeed(release),
            onStaleRefreshFailure: (error, release) => {
              console.warn(
                `[desktop-updater] Failed to refresh update feed; using cached ${release.tag}: ${this.deps.formatErrorMessage(error)}`,
              );
            },
          });

    const autoUpdater = this.deps.autoUpdater;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    // Keep alpha branding, but force all installs onto the stable update track.
    autoUpdater.channel = this.deps.constants.updateChannel;
    autoUpdater.allowPrerelease = this.deps.constants.allowPrerelease;
    autoUpdater.allowDowngrade = false;
    // We resolve the exact latest stable release when the feed cache is cold/stale
    // and point the updater at that tag directly, so full downloads are more reliable
    // than blockmap-based patching against a moving "latest" target.
    autoUpdater.disableDifferentialDownload = true;
    let lastLoggedDownloadMilestone = -1;

    if (isArm64HostRunningIntelBuild(this.deps.desktopRuntimeInfo)) {
      console.info(
        "[desktop-updater] Apple Silicon host detected while running Intel build; updates will switch to arm64 packages.",
      );
    }

    autoUpdater.on("checking-for-update", () => {
      console.info("[desktop-updater] Looking for updates...");
    });
    autoUpdater.on("update-available", (info) => {
      this.clearCheckTimeoutTimer();
      if (!isUpdateVersionNewer(this.deps.getAppVersion(), info.version)) {
        void this.clearPendingUpdateCache("available version is not newer than current app");
        this.setUpdateState(
          reduceDesktopUpdateStateOnNoUpdate(this.updateState, new Date().toISOString()),
        );
        lastLoggedDownloadMilestone = -1;
        console.info(
          `[desktop-updater] Ignoring non-newer update ${info.version}; current version is ${this.deps.getAppVersion()}.`,
        );
        return;
      }
      this.setUpdateState(
        reduceDesktopUpdateStateOnUpdateAvailable(
          this.updateState,
          info.version,
          new Date().toISOString(),
        ),
      );
      lastLoggedDownloadMilestone = -1;
      console.info(`[desktop-updater] Update available: ${info.version}`);
    });
    autoUpdater.on("update-not-available", () => {
      this.clearCheckTimeoutTimer();
      void this.clearPendingUpdateCache("no newer update available");
      this.setUpdateState(
        reduceDesktopUpdateStateOnNoUpdate(this.updateState, new Date().toISOString()),
      );
      lastLoggedDownloadMilestone = -1;
      console.info("[desktop-updater] No updates available.");
    });
    autoUpdater.on("error", (error) => {
      this.clearCheckTimeoutTimer();
      const message = this.deps.formatErrorMessage(error);
      const errorContext = this.resolveUpdaterErrorContext();
      if (
        isExpectedStalledDownloadCancellationError({
          suppressionArmed: this.stalledDownloadCancellationSuppression.isArmed(),
          errorContext,
          message,
        })
      ) {
        this.stalledDownloadCancellationSuppression.consume();
        console.warn("[desktop-updater] Ignored expected cancellation after stalled download.");
        return;
      }
      this.clearUpdaterInstallInFlightAfterError();
      const installFailureCount =
        errorContext === "install"
          ? this.recordInstallMarkerFailure(new Date().toISOString())
          : this.updateState.installFailureCount;
      if (errorContext === "install") {
        this.deps.restartBackend();
        this.scheduleUpdatePoll();
      }
      if (!this.updateCheckInFlight && !this.updateDownloadInFlight) {
        this.setUpdateState({
          status: "error",
          message,
          checkedAt: new Date().toISOString(),
          downloadPercent: null,
          errorContext,
          canRetry:
            this.updateState.availableVersion !== null ||
            this.updateState.downloadedVersion !== null,
          installFailureCount,
        });
      }
      console.error(`[desktop-updater] Updater error: ${message}`);
    });
    autoUpdater.on("download-progress", (progress) => {
      const percent = Math.floor(progress.percent);
      this.updateDownloadStallTimerOnProgress(progress);
      if (
        shouldBroadcastDownloadProgress(this.updateState, progress.percent) ||
        this.updateState.message !== null
      ) {
        this.setUpdateState(
          reduceDesktopUpdateStateOnDownloadProgress(this.updateState, progress.percent),
        );
      }
      const milestone = percent - (percent % 10);
      if (milestone > lastLoggedDownloadMilestone) {
        lastLoggedDownloadMilestone = milestone;
        console.info(`[desktop-updater] Download progress: ${percent}%`);
      }
    });
    autoUpdater.on("update-downloaded", (info) => {
      this.clearUpdateDownloadStallTimer();
      if (!isUpdateVersionNewer(this.deps.getAppVersion(), info.version)) {
        this.clearPendingUpdateCacheWhenSafe("downloaded version is not newer than current app");
        this.setUpdateState(
          reduceDesktopUpdateStateOnNoUpdate(this.updateState, new Date().toISOString()),
        );
        console.info(
          `[desktop-updater] Ignoring downloaded non-newer update ${info.version}; current version is ${this.deps.getAppVersion()}.`,
        );
        return;
      }
      this.setUpdateState(
        reduceDesktopUpdateStateOnDownloadComplete(this.updateState, info.version),
      );
      console.info(`[desktop-updater] Update downloaded: ${info.version}`);
    });

    this.clearPollTimer();

    this.updateStartupTimer = setTimeout(() => {
      this.updateStartupTimer = null;
      void this.checkForUpdates("startup");
    }, this.deps.constants.startupDelayMs);
    this.updateStartupTimer.unref();

    if (this.automaticUpdateActivitySuppressed) {
      console.info(
        "[desktop-updater] Startup and periodic update checks suppressed after failed install verification.",
      );
      return;
    }
    this.scheduleUpdatePoll();
  }
}
