import type { TerminalEvent } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  overrides: {} as Record<string, unknown>,
  scrollbackLines: 2_000,
  create: vi.fn(),
  dispose: vi.fn(),
}));

const events = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: unknown) => void>>(),
  ackOutput: vi.fn(async () => undefined),
}));

vi.mock("./terminalRuntime", () => ({
  createRuntimeEntry: runtime.create,
  disposeRuntimeEntry: runtime.dispose,
  attachRuntimeToContainer: vi.fn(),
  detachRuntimeFromContainer: vi.fn(),
  syncRuntimeConfig: vi.fn(),
  updateRuntimeViewState: vi.fn(),
}));

vi.mock("./terminalEventDispatcher", () => ({
  terminalEventDispatcher: {
    subscribe: (threadId: string, terminalId: string, listener: (event: unknown) => void) => {
      const key = `${threadId}::${terminalId}`;
      const listeners = events.listeners.get(key) ?? new Set();
      listeners.add(listener);
      events.listeners.set(key, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) events.listeners.delete(key);
      };
    },
  },
}));

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({ terminal: { ackOutput: events.ackOutput } }),
}));

import { buildTerminalRuntimeKey, terminalRuntimeRegistry } from "./terminalRuntimeRegistry";
import { TERMINAL_RUNTIME_RETENTION_LIMITS } from "./terminalRuntimeRetention";

const onSessionExited = vi.fn();

function attach(threadId: string, providerAuthInstanceId?: string): string {
  const runtimeKey = buildTerminalRuntimeKey(threadId, "terminal-1");
  terminalRuntimeRegistry.attach(
    {
      runtimeKey,
      threadId,
      terminalId: "terminal-1",
      terminalLabel: "Terminal",
      cwd: "/tmp",
      ...(providerAuthInstanceId ? { providerAuthInstanceId } : {}),
      callbacks: {
        onSessionExited,
        onTerminalMetadataChange: vi.fn(),
        onTerminalActivityChange: vi.fn(),
      },
    },
    { autoFocus: false, isVisible: true },
    {} as HTMLDivElement,
  );
  return runtimeKey;
}

function visitAndLeave(threadId: string, providerAuthInstanceId?: string): string {
  const runtimeKey = attach(threadId, providerAuthInstanceId);
  terminalRuntimeRegistry.detach(runtimeKey);
  vi.advanceTimersByTime(1_000);
  return runtimeKey;
}

function retainedRuntimes() {
  const disposed = new Set(runtime.dispose.mock.calls.map(([entry]) => entry));
  const live = runtime.create.mock.results
    .map((result) => result.value as { threadId: string; terminal: unknown })
    .filter((entry) => !disposed.has(entry));
  return {
    count: live.length,
    scrollbackLines: live.length * runtime.scrollbackLines,
    threadIds: live.map((entry) => entry.threadId),
  };
}

function emit(threadId: string, event: Partial<TerminalEvent>): void {
  const listeners = events.listeners.get(buildTerminalRuntimeKey(threadId, "terminal-1"));
  for (const listener of listeners ?? []) {
    listener({ threadId, terminalId: "terminal-1", createdAt: "", ...event });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  runtime.overrides = {};
  runtime.scrollbackLines = 2_000;
  runtime.create.mockImplementation((config) => ({
    ...config,
    terminal: { focus: vi.fn(), buffer: { normal: { length: runtime.scrollbackLines } } },
    searchAddon: {},
    runtimeStatus: "ready",
    pendingWriteBytes: 0,
    ...runtime.overrides,
  }));
});

afterEach(() => {
  terminalRuntimeRegistry.disposeOrphanedThreads(new Set());
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
  events.listeners.clear();
});

describe("detached terminal runtime retention", () => {
  it("disposes the least recently used detached runtimes beyond the count budget", () => {
    for (let index = 0; index < 20; index += 1) visitAndLeave(`thread-${index}`);
    const retained = retainedRuntimes();
    expect(retained.count).toBe(TERMINAL_RUNTIME_RETENTION_LIMITS.maxDetachedRuntimes);
    expect(retained.threadIds).toEqual(
      Array.from(
        { length: TERMINAL_RUNTIME_RETENTION_LIMITS.maxDetachedRuntimes },
        (_, index) =>
          `thread-${20 - TERMINAL_RUNTIME_RETENTION_LIMITS.maxDetachedRuntimes + index}`,
      ),
    );
  });

  it("disposes detached runtimes beyond the scrollback budget", () => {
    runtime.scrollbackLines = 5_000;
    for (let index = 0; index < 20; index += 1) visitAndLeave(`thread-${index}`);
    const retained = retainedRuntimes();
    expect(retained.scrollbackLines).toBe(
      TERMINAL_RUNTIME_RETENTION_LIMITS.maxDetachedScrollbackLines,
    );
    expect(retained.count).toBe(4);
  });

  it("disposes a detached runtime after the idle age", () => {
    visitAndLeave("idle");
    vi.advanceTimersByTime(TERMINAL_RUNTIME_RETENTION_LIMITS.maxIdleMs);
    expect(retainedRuntimes().count).toBe(0);
  });

  it("never disposes attached, settings-owned, or unsettled runtimes", () => {
    attach("visible");
    visitAndLeave("auth", "codex_work");
    runtime.overrides = { runtimeStatus: "replaying" };
    visitAndLeave("replaying");
    runtime.overrides = { pendingWriteBytes: 64 };
    visitAndLeave("pending-output");
    runtime.overrides = {};
    for (let index = 0; index < 20; index += 1) visitAndLeave(`thread-${index}`);
    vi.advanceTimersByTime(TERMINAL_RUNTIME_RETENTION_LIMITS.maxIdleMs * 2);
    expect(retainedRuntimes().threadIds).toEqual([
      "visible",
      "auth",
      "replaying",
      "pending-output",
    ]);
  });

  it("recreates an evicted runtime on reattach so the server snapshot rehydrates it", () => {
    visitAndLeave("evicted");
    vi.advanceTimersByTime(TERMINAL_RUNTIME_RETENTION_LIMITS.maxIdleMs);
    attach("evicted");
    expect(runtime.create).toHaveBeenCalledTimes(2);
    expect(retainedRuntimes().threadIds).toEqual(["evicted"]);
  });

  it("keeps acknowledging output and forwards exit while a terminal is evicted", () => {
    visitAndLeave("background");
    vi.advanceTimersByTime(TERMINAL_RUNTIME_RETENTION_LIMITS.maxIdleMs);
    emit("background", { type: "output", data: "héllo", byteLength: 6 });
    emit("background", { type: "output", data: "héllo" });
    expect(events.ackOutput.mock.calls).toEqual([
      [{ threadId: "background", terminalId: "terminal-1", bytes: 6 }],
      [{ threadId: "background", terminalId: "terminal-1", bytes: 6 }],
    ]);
    emit("background", { type: "exited", exitCode: 0, exitSignal: null });
    expect(onSessionExited).toHaveBeenCalledTimes(1);
    expect(events.listeners.size).toBe(0);
  });

  it("stops acknowledging for an evicted terminal once it reattaches or its thread is removed", () => {
    visitAndLeave("reattached");
    visitAndLeave("removed");
    vi.advanceTimersByTime(TERMINAL_RUNTIME_RETENTION_LIMITS.maxIdleMs);
    expect(events.listeners.size).toBe(2);
    attach("reattached");
    terminalRuntimeRegistry.disposeThread("removed");
    expect(events.listeners.size).toBe(0);
  });
});
