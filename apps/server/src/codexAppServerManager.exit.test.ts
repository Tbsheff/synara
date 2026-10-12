import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { ThreadId, TurnId, type ProviderEvent } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { CodexAppServerManager } from "./codexAppServerManager";
import { CodexJsonlFramer, CodexJsonlWriter } from "./codexAppServerTransport";

class FakeCodexChild extends EventEmitter {
  readonly pid = 6262;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

function attachSpontaneousExitHarness(options: { activeTurnId?: string } = {}) {
  const child = new FakeCodexChild();
  const teardownProcessTree = vi.fn(async () => ({
    escalated: false,
    signalErrors: [],
    capturedBeforeRootExit: false,
  }));
  const manager = new CodexAppServerManager(undefined, { teardownProcessTree });
  const threadId = ThreadId.makeUnsafe("thread-codex-crash");
  const context = {
    session: {
      provider: "codex",
      status: options.activeTurnId ? "running" : "ready",
      threadId,
      runtimeMode: "full-access",
      ...(options.activeTurnId ? { activeTurnId: TurnId.makeUnsafe(options.activeTurnId) } : {}),
      createdAt: "2026-10-11T00:00:00.000Z",
      updatedAt: "2026-10-11T00:00:00.000Z",
    },
    account: { type: "unknown", planType: null, sparkEnabled: true },
    child,
    stdoutFramer: new CodexJsonlFramer(),
    stdinWriter: new CodexJsonlWriter(child.stdin),
    pending: new Map(),
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    collabReceiverTurns: new Map(),
    collabReceiverParents: new Map(),
    reviewTurnIds: new Set(),
    nextRequestId: 1,
    stopping: false,
    sessionAttemptId: "attempt-1",
  };
  const internals = manager as unknown as {
    sessions: Map<ThreadId, unknown>;
    attachProcessListeners: (context: unknown) => void;
  };
  internals.sessions.set(threadId, context);
  internals.attachProcessListeners(context);
  const events: ProviderEvent[] = [];
  manager.on("event", (event: ProviderEvent) => events.push(event));
  const exitedEvents = () => events.filter((event) => event.method === "session/exited");
  return { child, context, exitedEvents };
}

describe("CodexAppServerManager spontaneous exit", () => {
  it("reports a mid-turn crash once with its exit code, signal, and turn", () => {
    const { child, exitedEvents } = attachSpontaneousExitHarness({ activeTurnId: "turn-live" });

    child.exitCode = 1;
    child.emit("exit", 1, null);
    child.emit("exit", 1, null);

    expect(exitedEvents()).toHaveLength(1);
    expect(exitedEvents()[0]?.payload).toEqual({
      exitCode: 1,
      signal: null,
      exitKind: "error",
      turnId: "turn-live",
    });
  });

  it("reports a signal kill while idle as an error exit", () => {
    const { child, exitedEvents } = attachSpontaneousExitHarness();

    child.signalCode = "SIGKILL";
    child.emit("exit", null, "SIGKILL");

    expect(exitedEvents()[0]?.payload).toEqual({
      exitCode: null,
      signal: "SIGKILL",
      exitKind: "error",
    });
  });

  it("keeps a clean idle exit graceful", () => {
    const { child, exitedEvents } = attachSpontaneousExitHarness();

    child.exitCode = 0;
    child.emit("exit", 0, null);

    expect(exitedEvents()[0]?.payload).toEqual({
      exitCode: 0,
      signal: null,
      exitKind: "graceful",
    });
  });

  it("marks an exit after a reported transport failure so the cause is not reported twice", () => {
    const { child, context, exitedEvents } = attachSpontaneousExitHarness({
      activeTurnId: "turn-live",
    });

    child.stdout.emit("end");
    expect(context.stopping).toBe(true);
    child.signalCode = "SIGTERM";
    child.emit("exit", null, "SIGTERM");

    expect(exitedEvents()).toHaveLength(1);
    expect(exitedEvents()[0]?.payload).toMatchObject({
      exitKind: "error",
      causeAlreadyReported: true,
    });
  });
});
