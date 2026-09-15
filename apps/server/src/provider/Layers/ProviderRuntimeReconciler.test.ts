import {
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  type ProviderSession,
} from "@synara/contracts";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../../orchestration/Services/OrchestrationReactor.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProviderRuntimeEventRepository,
  type ProviderRuntimeEventRepositoryShape,
} from "../../persistence/Services/ProviderRuntimeEvents.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import type { ProviderThreadActivity } from "../Services/ProviderAdapter.ts";
import { ProviderRuntimeReconciler } from "../Services/ProviderRuntimeReconciler.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory.ts";
import { makeProviderRuntimeReconcilerLive } from "./ProviderRuntimeReconciler.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-runtime-reconciler");
const TURN_ID = TurnId.makeUnsafe("turn-runtime-reconciler");

function staleShellSnapshot(): OrchestrationShellSnapshot {
  const updatedAt = "2026-07-23T19:00:00.000Z";
  return {
    snapshotSequence: 1,
    spaces: [],
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-runtime-reconciler"),
        runtimeMode: "full-access",
        updatedAt,
        latestTurn: {
          turnId: TURN_ID,
          state: "running",
          requestedAt: updatedAt,
          startedAt: updatedAt,
          completedAt: null,
          assistantMessageId: null,
        },
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt,
        },
      },
    ],
    updatedAt,
  } as unknown as OrchestrationShellSnapshot;
}

function readyProviderSession(): ProviderSession {
  return {
    provider: "codex",
    status: "ready",
    runtimeMode: "full-access",
    threadId: THREAD_ID,
    createdAt: "2026-07-23T19:00:00.000Z",
    updatedAt: "2026-07-23T20:00:00.000Z",
  };
}

describe("ProviderRuntimeReconcilerLive", () => {
  it("keeps one activity identity while a stale-turn repair is retried and refined", async () => {
    const commands: OrchestrationCommand[] = [];
    const reconcileSettledOpenTurns = vi.fn();
    let bindingStatus: "stopped" | "error" = "stopped";
    let providerSession = readyProviderSession();

    const engine = {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
    } as unknown as OrchestrationEngineShape;
    const reactor = {
      start: Effect.void,
      reconcileSettledOpenTurns: Effect.sync(reconcileSettledOpenTurns),
    } satisfies OrchestrationReactorShape;
    const snapshotQuery = {
      listStaleInFlightThreadIds: () => Effect.succeed([THREAD_ID]),
      listThreadProgressIncludingNativeChildren: () => Effect.succeed([]),
      getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
      getThreadShellById: () => Effect.succeed(Option.some(staleShellSnapshot().threads[0]!)),
      getShellSnapshot: () => Effect.die("full shell snapshot should not be loaded"),
    } as unknown as ProjectionSnapshotQueryShape;
    const directory = {
      listBindings: () =>
        Effect.succeed([
          {
            threadId: THREAD_ID,
            provider: "codex" as const,
            status: bindingStatus,
            runtimePayload: { activeTurnId: null },
          },
        ]),
    } as unknown as ProviderSessionDirectoryShape;
    const provider = {
      listSessions: () => Effect.succeed([providerSession]),
      getRuntimeEventPumpHealth: () =>
        Effect.succeed([
          {
            provider: "codex" as const,
            status: "recovering" as const,
            consecutiveFailures: 1,
            updatedAt: "2026-07-23T20:00:00.000Z",
          },
        ]),
    } as unknown as ProviderServiceShape;

    const runtimeEvents = {
      hasPendingEventsForThreads: (input: { readonly threadIds: ReadonlyArray<string> }) =>
        Effect.sync(() => {
          expect(input.threadIds).toEqual([THREAD_ID]);
          return false;
        }),
    } as unknown as ProviderRuntimeEventRepositoryShape;

    const layer = makeProviderRuntimeReconcilerLive({ staleAfterMs: 1 }).pipe(
      Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
      Layer.provide(Layer.succeed(OrchestrationReactor, reactor)),
      Layer.provide(Layer.succeed(ProjectionSnapshotQuery, snapshotQuery)),
      Layer.provide(Layer.succeed(ProviderSessionDirectory, directory)),
      Layer.provide(Layer.succeed(ProviderService, provider)),
      Layer.provide(Layer.succeed(ProviderRuntimeEventRepository, runtimeEvents)),
    );

    await Effect.gen(function* () {
      const reconciler = yield* ProviderRuntimeReconciler;
      yield* reconciler.reconcileNow;
      // The projection can remain stale for another observation cycle.
      yield* reconciler.reconcileNow;
      bindingStatus = "error";
      providerSession = {
        ...providerSession,
        status: "error",
        activeTurnId: TURN_ID,
        lastError: "Provider stream failed.",
      };
      yield* reconciler.reconcileNow;
    }).pipe(Effect.provide(layer), Effect.runPromise);

    // Session repair dispatches first so a partial failure still unsticks the
    // thread, and `updatedAt` is the dispatch time rather than the terminal
    // session's original timestamp (which would freeze the staleness clock).
    expect(commands.map((command) => command.type)).toEqual([
      "thread.session.set",
      "thread.activity.append",
      "thread.session.set",
      "thread.activity.append",
      "thread.session.set",
      "thread.activity.append",
    ]);
    const activityCommand = commands[1];
    expect(activityCommand?.type).toBe("thread.activity.append");
    if (activityCommand?.type === "thread.activity.append") {
      expect(activityCommand.activity.kind).toBe("provider.runtime.reconciled");
      expect(activityCommand.activity.summary).toContain("recovered");
      expect(activityCommand.activity.payload).toMatchObject({
        action: "settle-terminal-projection",
      });
    }
    const sessionCommand = commands[0];
    expect(sessionCommand?.type).toBe("thread.session.set");
    if (sessionCommand?.type === "thread.session.set") {
      expect(sessionCommand.session).toMatchObject({
        status: "ready",
        activeTurnId: null,
        lastError: null,
      });
      expect(sessionCommand.session.updatedAt).not.toBe("2026-07-23T19:00:00.000Z");
    }
    const errorActivityCommand = commands[5];
    expect(errorActivityCommand?.type).toBe("thread.activity.append");
    if (errorActivityCommand?.type === "thread.activity.append") {
      expect(errorActivityCommand.activity.payload).toMatchObject({
        action: "settle-error",
      });
    }
    const errorSessionCommand = commands[4];
    expect(errorSessionCommand?.type).toBe("thread.session.set");
    if (errorSessionCommand?.type === "thread.session.set") {
      expect(errorSessionCommand.session).toMatchObject({
        status: "error",
        activeTurnId: TURN_ID,
        lastError: "Provider stream failed.",
      });
    }
    const activityCommands = commands.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.activity.append" }> =>
        command.type === "thread.activity.append",
    );
    const sessionCommands = commands.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.session.set" }> =>
        command.type === "thread.session.set",
    );
    expect(activityCommands[0]?.activity.id).toBe(activityCommands[1]?.activity.id);
    expect(activityCommands[0]?.activity.id).toBe(activityCommands[2]?.activity.id);
    expect(activityCommands[0]?.commandId).not.toBe(activityCommands[1]?.commandId);
    expect(activityCommands[1]?.commandId).not.toBe(activityCommands[2]?.commandId);
    expect(sessionCommands[0]?.commandId).not.toBe(sessionCommands[1]?.commandId);
    expect(sessionCommands[1]?.commandId).not.toBe(sessionCommands[2]?.commandId);
    expect(reconcileSettledOpenTurns).toHaveBeenCalledTimes(3);
  });

  it("loads candidate progress and leaves a quiet-looking running turn alone while a native child progresses", async () => {
    const runReconcile = async (
      threadProgress: ReadonlyArray<{
        readonly threadId: ThreadId;
        readonly parentThreadId: ThreadId | null;
        readonly lastProgressAt: string;
      }>,
    ) => {
      const commands: OrchestrationCommand[] = [];
      const progressRequests: Array<ReadonlyArray<ThreadId>> = [];
      const quietThread = staleShellSnapshot().threads[0]!;
      const runningQuietThread = {
        ...quietThread,
        session: { ...quietThread.session!, status: "running" as const },
      };
      const engine = {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          }),
      } as unknown as OrchestrationEngineShape;
      const reactor = {
        start: Effect.void,
        reconcileSettledOpenTurns: Effect.void,
      } satisfies OrchestrationReactorShape;
      const snapshotQuery = {
        listStaleInFlightThreadIds: () => Effect.succeed([THREAD_ID]),
        listThreadProgressIncludingNativeChildren: (input: {
          readonly threadIds: ReadonlyArray<ThreadId>;
        }) =>
          Effect.sync(() => {
            progressRequests.push(input.threadIds);
            return threadProgress;
          }),
        getThreadShellById: () => Effect.succeed(Option.some(runningQuietThread)),
      } as unknown as ProjectionSnapshotQueryShape;
      const directory = {
        listBindings: () =>
          Effect.succeed([
            {
              threadId: THREAD_ID,
              provider: "codex" as const,
              status: "running" as const,
              runtimePayload: { activeTurnId: TURN_ID },
            },
          ]),
      } as unknown as ProviderSessionDirectoryShape;
      const provider = {
        listSessions: () => Effect.succeed([{ ...readyProviderSession(), status: "running" }]),
        getRuntimeEventPumpHealth: () => Effect.succeed([]),
      } as unknown as ProviderServiceShape;
      const runtimeEvents = {
        hasPendingEventsForThreads: () => Effect.succeed(false),
      } as unknown as ProviderRuntimeEventRepositoryShape;

      const layer = makeProviderRuntimeReconcilerLive({ staleAfterMs: 15_000 }).pipe(
        Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
        Layer.provide(Layer.succeed(OrchestrationReactor, reactor)),
        Layer.provide(Layer.succeed(ProjectionSnapshotQuery, snapshotQuery)),
        Layer.provide(Layer.succeed(ProviderSessionDirectory, directory)),
        Layer.provide(Layer.succeed(ProviderService, provider)),
        Layer.provide(Layer.succeed(ProviderRuntimeEventRepository, runtimeEvents)),
      );
      await Effect.gen(function* () {
        const reconciler = yield* ProviderRuntimeReconciler;
        yield* reconciler.reconcileNow;
      }).pipe(Effect.provide(layer), Effect.runPromise);
      return { commands, progressRequests };
    };

    const childProgressAt = (minutes: number) => [
      {
        threadId: ThreadId.makeUnsafe(`subagent:${THREAD_ID}:child`),
        parentThreadId: THREAD_ID,
        lastProgressAt: new Date(Date.now() - minutes * 60_000).toISOString(),
      },
    ];

    const childProgressing = await runReconcile(childProgressAt(44));
    expect(childProgressing.progressRequests).toEqual([[THREAD_ID]]);
    expect(childProgressing.commands).toEqual([]);

    const childAbandoned = await runReconcile(childProgressAt(46));
    expect(childAbandoned.commands.map((command) => command.type)).toEqual([
      "thread.session.set",
      "thread.activity.append",
    ]);
  });
});

describe("ProviderRuntimeReconcilerLive provider activity probe", () => {
  const SETTLED = ["thread.session.set", "thread.activity.append"];

  const liveSession = (status: ProviderSession["status"]): ProviderSession => ({
    ...readyProviderSession(),
    status,
  });

  const runAbandonedRunningTurn = async (input: {
    readonly liveSessions: ReadonlyArray<ProviderSession>;
    readonly readThreadActivity?: ProviderServiceShape["readThreadActivity"];
  }) => {
    const commands: OrchestrationCommand[] = [];
    const quietThread = staleShellSnapshot().threads[0]!;
    const runningThread = {
      ...quietThread,
      session: { ...quietThread.session!, status: "running" as const, activeTurnId: TURN_ID },
    };
    const engine = {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
    } as unknown as OrchestrationEngineShape;
    const reactor = {
      start: Effect.void,
      reconcileSettledOpenTurns: Effect.void,
    } satisfies OrchestrationReactorShape;
    const snapshotQuery = {
      listStaleInFlightThreadIds: () => Effect.succeed([THREAD_ID]),
      listThreadProgressIncludingNativeChildren: () => Effect.succeed([]),
      getThreadShellById: () => Effect.succeed(Option.some(runningThread)),
    } as unknown as ProjectionSnapshotQueryShape;
    const directory = {
      listBindings: () =>
        Effect.succeed([
          {
            threadId: THREAD_ID,
            provider: "codex" as const,
            status: "running" as const,
            runtimePayload: { activeTurnId: TURN_ID },
          },
        ]),
      upsert: () => Effect.void,
    } as unknown as ProviderSessionDirectoryShape;
    const provider = {
      listSessions: () => Effect.succeed(input.liveSessions),
      getRuntimeEventPumpHealth: () => Effect.succeed([]),
      ...(input.readThreadActivity !== undefined
        ? { readThreadActivity: input.readThreadActivity }
        : {}),
    } as unknown as ProviderServiceShape;
    const runtimeEvents = {
      hasPendingEventsForThreads: () => Effect.succeed(false),
    } as unknown as ProviderRuntimeEventRepositoryShape;

    const layer = makeProviderRuntimeReconcilerLive({
      staleAfterMs: 1,
      activityProbeTimeoutMs: 20,
    }).pipe(
      Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
      Layer.provide(Layer.succeed(OrchestrationReactor, reactor)),
      Layer.provide(Layer.succeed(ProjectionSnapshotQuery, snapshotQuery)),
      Layer.provide(Layer.succeed(ProviderSessionDirectory, directory)),
      Layer.provide(Layer.succeed(ProviderService, provider)),
      Layer.provide(Layer.succeed(ProviderRuntimeEventRepository, runtimeEvents)),
    );
    await Effect.gen(function* () {
      const reconciler = yield* ProviderRuntimeReconciler;
      yield* reconciler.reconcileNow;
    }).pipe(Effect.provide(layer), Effect.runPromise);
    return commands.map((command) => command.type);
  };

  it("leaves the turn running while the provider reports the thread active", async () => {
    for (const status of ["running", "connecting"] as const) {
      const probe = vi.fn((_input: { readonly threadId: ThreadId; readonly provider: string }) =>
        Effect.succeed<ProviderThreadActivity>("active"),
      );
      const commands = await runAbandonedRunningTurn({
        liveSessions: [liveSession(status)],
        readThreadActivity: probe,
      });
      expect(commands).toEqual([]);
      expect(probe).toHaveBeenCalledWith({ threadId: THREAD_ID, provider: "codex" });
    }
  });

  it("settles when the provider reports the thread idle, not loaded, or errored", async () => {
    for (const activity of ["idle", "not-loaded", "error"] as const) {
      const probe = vi.fn(() => Effect.succeed<ProviderThreadActivity>(activity));
      const commands = await runAbandonedRunningTurn({
        liveSessions: [liveSession("running")],
        readThreadActivity: probe,
      });
      expect(commands).toEqual(SETTLED);
      expect(probe).toHaveBeenCalledTimes(1);
    }
  });

  it("settles when the activity probe fails or times out", async () => {
    const failing = vi.fn(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "thread/read",
          detail: "Codex app-server is unresponsive.",
        }),
      ),
    );
    expect(
      await runAbandonedRunningTurn({
        liveSessions: [liveSession("running")],
        readThreadActivity: failing,
      }),
    ).toEqual(SETTLED);
    expect(failing).toHaveBeenCalledTimes(1);

    const hanging = vi.fn(() => Effect.never);
    expect(
      await runAbandonedRunningTurn({
        liveSessions: [liveSession("running")],
        readThreadActivity: hanging,
      }),
    ).toEqual(SETTLED);
    expect(hanging).toHaveBeenCalledTimes(1);
  });

  it("does not probe when the live session is missing or already settled", async () => {
    for (const liveSessions of [[], [liveSession("ready")]]) {
      const probe = vi.fn(() => Effect.succeed<ProviderThreadActivity>("active"));
      expect(await runAbandonedRunningTurn({ liveSessions, readThreadActivity: probe })).toEqual(
        SETTLED,
      );
      expect(probe).not.toHaveBeenCalled();
    }
  });

  it("keeps settling for providers that cannot report thread activity", async () => {
    expect(await runAbandonedRunningTurn({ liveSessions: [liveSession("running")] })).toEqual(
      SETTLED,
    );
  });
});

describe("ProviderRuntimeReconcilerLive plan application", () => {
  const threadIdAt = (index: number) => ThreadId.makeUnsafe(`thread-runtime-reconciler-${index}`);

  const runningShell = (threadId: ThreadId, turnId: TurnId = TURN_ID): OrchestrationThreadShell => {
    const quietThread = staleShellSnapshot().threads[0]!;
    return {
      ...quietThread,
      id: threadId,
      latestTurn: { ...quietThread.latestTurn!, turnId },
      session: {
        ...quietThread.session!,
        threadId,
        status: "running",
        activeTurnId: turnId,
      },
    };
  };

  const runReconcile = async (input: {
    readonly threadIds: ReadonlyArray<ThreadId>;
    readonly getThreadShellById: (threadId: ThreadId) => OrchestrationThreadShell;
    readonly readThreadActivity?: (input: {
      readonly threadId: ThreadId;
      readonly provider: string;
    }) => Effect.Effect<ProviderThreadActivity>;
    readonly activityProbeTimeoutMs?: number;
  }) => {
    const commands: OrchestrationCommand[] = [];
    const engine = {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
    } as unknown as OrchestrationEngineShape;
    const reactor = {
      start: Effect.void,
      reconcileSettledOpenTurns: Effect.void,
    } satisfies OrchestrationReactorShape;
    const snapshotQuery = {
      listStaleInFlightThreadIds: () => Effect.succeed(input.threadIds),
      listThreadProgressIncludingNativeChildren: () => Effect.succeed([]),
      getThreadShellById: (threadId: ThreadId) =>
        Effect.sync(() => Option.some(input.getThreadShellById(threadId))),
    } as unknown as ProjectionSnapshotQueryShape;
    const directory = {
      listBindings: () =>
        Effect.succeed(
          input.threadIds.map((threadId) => ({
            threadId,
            provider: "codex" as const,
            status: "running" as const,
            runtimePayload: { activeTurnId: TURN_ID },
          })),
        ),
      upsert: () => Effect.void,
    } as unknown as ProviderSessionDirectoryShape;
    const provider = {
      listSessions: () =>
        Effect.succeed(
          input.threadIds.map((threadId) => ({
            ...readyProviderSession(),
            threadId,
            status: "running" as const,
          })),
        ),
      getRuntimeEventPumpHealth: () => Effect.succeed([]),
      ...(input.readThreadActivity !== undefined
        ? { readThreadActivity: input.readThreadActivity }
        : {}),
    } as unknown as ProviderServiceShape;
    const runtimeEvents = {
      hasPendingEventsForThreads: () => Effect.succeed(false),
    } as unknown as ProviderRuntimeEventRepositoryShape;

    const layer = makeProviderRuntimeReconcilerLive({
      staleAfterMs: 1,
      ...(input.activityProbeTimeoutMs !== undefined
        ? { activityProbeTimeoutMs: input.activityProbeTimeoutMs }
        : {}),
    }).pipe(
      Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
      Layer.provide(Layer.succeed(OrchestrationReactor, reactor)),
      Layer.provide(Layer.succeed(ProjectionSnapshotQuery, snapshotQuery)),
      Layer.provide(Layer.succeed(ProviderSessionDirectory, directory)),
      Layer.provide(Layer.succeed(ProviderService, provider)),
      Layer.provide(Layer.succeed(ProviderRuntimeEventRepository, runtimeEvents)),
    );
    await Effect.gen(function* () {
      const reconciler = yield* ProviderRuntimeReconciler;
      yield* reconciler.reconcileNow;
    }).pipe(Effect.provide(layer), Effect.runPromise);
    return commands;
  };

  it("runs slow activity probes concurrently before applying plans", async () => {
    const probeTimeoutMs = 1_000;
    const threadIds = [0, 1, 2, 3].map(threadIdAt);
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseProbes: (() => void) | undefined;
    const probesReleased = new Promise<void>((resolve) => {
      releaseProbes = resolve;
    });
    const probe = vi.fn(() =>
      Effect.gen(function* () {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (inFlight === threadIds.length) releaseProbes?.();
        yield* Effect.promise(() => probesReleased).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              inFlight -= 1;
            }),
          ),
        );
        return "idle" as const;
      }),
    );

    const startedAt = Date.now();
    const commands = await runReconcile({
      threadIds,
      getThreadShellById: (threadId) => runningShell(threadId),
      readThreadActivity: probe,
      activityProbeTimeoutMs: probeTimeoutMs,
    });

    expect(maxInFlight).toBe(threadIds.length);
    expect(probe).toHaveBeenCalledTimes(threadIds.length);
    expect(Date.now() - startedAt).toBeLessThan(threadIds.length * probeTimeoutMs);
    expect(
      commands
        .filter((command) => command.type === "thread.session.set")
        .map((command) => command.threadId),
    ).toEqual(threadIds);
  });

  it("does not settle a thread whose projected turn or session status changed after planning", async () => {
    const plannedShell = runningShell(THREAD_ID);
    const changedShells = [
      runningShell(THREAD_ID, TurnId.makeUnsafe("turn-runtime-reconciler-new")),
      { ...plannedShell, session: { ...plannedShell.session!, status: "ready" as const } },
    ];
    for (const changedShell of changedShells) {
      let reads = 0;
      const commands = await runReconcile({
        threadIds: [THREAD_ID],
        getThreadShellById: () => {
          reads += 1;
          return reads === 1 ? plannedShell : changedShell;
        },
      });
      expect(reads).toBe(2);
      expect(commands).toEqual([]);
    }
  });
});
