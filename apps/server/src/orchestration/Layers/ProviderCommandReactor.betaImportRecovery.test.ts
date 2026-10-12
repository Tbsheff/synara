import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ModelSelection,
  OrchestrationEvent,
  OrchestrationThread,
  ProviderRuntimeEvent,
  ProviderSession,
} from "@synara/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { BETA_IMPORT_RESULT_FILE_NAME } from "@synara/shared/betaChannel";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, ManagedRuntime, Option, PubSub, Scope, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentGatewayOperationRepositoryLive } from "../../agentGateway/Layers/AgentGatewayOperationRepository.ts";
import type { CheckpointStoreShape } from "../../checkpointing/Services/CheckpointStore.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { ServerConfig } from "../../config.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { TextGenerationError } from "../../git/Errors.ts";
import { TextGeneration, type TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventDeliveryRepositoryLive } from "../../persistence/Layers/OrchestrationEventDeliveries.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProviderRuntimeEventRepositoryLive } from "../../persistence/Layers/ProviderRuntimeEvents.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventDeliveryRepository,
  PROVIDER_COMMAND_REACTOR_CONSUMER,
} from "../../persistence/Services/OrchestrationEventDeliveries.ts";
import { ProjectAgentRepository } from "../../persistence/Services/ProjectAgentRepository.ts";
import { QueuedTurnPromotionRepository } from "../../persistence/Services/QueuedTurnPromotions.ts";
import { ProjectAgentService } from "../../projectAgent/Services/ProjectAgentService.ts";
import {
  ProviderHealth,
  type ProviderHealthShape,
} from "../../provider/Services/ProviderHealth.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { HubOutputReactor, type HubOutputReactorShape } from "../Services/HubOutputReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { makeProviderCommandReactorLive } from "./ProviderCommandReactor.ts";
import { TurnCheckpointCoordinatorLive } from "./TurnCheckpointCoordinator.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const asEventId = (value: string) => EventId.makeUnsafe(value);
const asMessageId = (value: string) => MessageId.makeUnsafe(value);

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

const withMutation: GitCoreShape["withMutation"] = (_cwd, effect) => effect;

const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

const notSentActivities = async (harness: {
  readonly readThread: () => Promise<OrchestrationThread | undefined>;
}) =>
  ((await harness.readThread())?.activities ?? []).filter(
    (activity) =>
      activity.kind === "provider.turn.start.failed" &&
      activity.summary === "Message not sent after copying to Synara Beta",
  );

describe("ProviderCommandReactor Beta import recovery", () => {
  const runtimes = new Set<{ dispose: () => Promise<void> }>();
  const scopes = new Set<Scope.Closeable>();
  const baseDirs = new Set<string>();

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const scope of scopes) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scopes.clear();
    for (const runtime of runtimes) {
      await runtime.dispose();
    }
    runtimes.clear();
    for (const baseDir of baseDirs) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
    baseDirs.clear();
  });

  async function createHarness(input: { readonly importCompletedAt?: string }) {
    const now = new Date().toISOString();
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-beta-import-recovery-"));
    baseDirs.add(baseDir);
    if (input.importCompletedAt !== undefined) {
      fs.writeFileSync(
        path.join(baseDir, BETA_IMPORT_RESULT_FILE_NAME),
        `${JSON.stringify({ version: 1, completedAt: input.importCompletedAt, ok: true })}\n`,
      );
    }
    const modelSelection: ModelSelection = { provider: "codex", model: "gpt-5-codex" };
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    const runtimeSessions: ProviderSession[] = [];
    const startSession = vi.fn<ProviderServiceShape["startSession"]>((threadId, sessionInput) => {
      const session: ProviderSession = {
        provider: modelSelection.provider,
        status: "ready",
        runtimeMode: sessionInput.runtimeMode ?? "full-access",
        model: modelSelection.model,
        threadId,
        ...(sessionInput.cwd !== undefined ? { cwd: sessionInput.cwd } : {}),
        resumeCursor: { opaque: `resume-${runtimeSessions.length + 1}` },
        createdAt: now,
        updatedAt: now,
      };
      runtimeSessions.push(session);
      return Effect.succeed(session);
    });
    const startSessionWithOutcome = vi.fn<
      NonNullable<ProviderServiceShape["startSessionWithOutcome"]>
    >((threadId, sessionInput) =>
      startSession(threadId, sessionInput).pipe(
        Effect.map((session) => ({
          session,
          nativeResumeAttempted: false,
          nativeResumeSucceeded: false,
          priorTranscriptBootstrapPending: false,
        })),
      ),
    );
    const sendTurn = vi.fn<ProviderServiceShape["sendTurn"]>(() =>
      Effect.succeed({ threadId: THREAD_ID, turnId: TurnId.makeUnsafe("turn-1") }),
    );
    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession,
      startSessionWithOutcome,
      completePriorTranscriptBootstrap: () => Effect.void,
      sendTurn,
      steerTurn: () => unsupported(),
      startReview: () => unsupported(),
      forkThread: () => Effect.succeed(null),
      interruptTurn: () => Effect.void,
      stopTask: () => Effect.void,
      backgroundTask: () => Effect.void,
      hasLiveRuntimeTasks: () => Effect.succeed(false),
      steerSubagent: () => Effect.void,
      respondToRequest: () => Effect.void,
      respondToUserInput: () => Effect.void,
      stopSession: () => Effect.void,
      stopRuntimeSession: () => Effect.void,
      clearSessionResumeCursor: () => Effect.void,
      listSessions: () => Effect.succeed(runtimeSessions),
      getPersistedSessionProfile: () => Effect.succeed(undefined),
      getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
      rollbackConversation: () => Effect.void,
      compactThread: () => unsupported(),
      closeRuntimeEvents: Effect.void,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    };
    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(false),
      captureCheckpoint: () => Effect.void,
      copyCheckpointRef: () => Effect.succeed(true),
      hasCheckpointRef: () => Effect.succeed(false),
      restoreCheckpoint: () => Effect.succeed(true),
      reverseCheckpointDiff: () => Effect.succeed(true),
      diffCheckpoints: () => Effect.succeed(""),
      diffCheckpointFiles: () => Effect.succeed([]),
      deleteCheckpointRefs: () => Effect.void,
    };
    const hubOutputReactor: HubOutputReactorShape = {
      captureBaselineBeforeTurn: () => Effect.succeed({ status: "completed" as const }),
      cancelPendingTurnBaseline: () => Effect.void,
      start: Effect.void,
      drain: Effect.void,
    };
    const textGenerationFailure = (operation: string) =>
      Effect.fail(new TextGenerationError({ operation, detail: "disabled in test harness" }));
    const projectAgentLayer = Layer.succeed(ProjectAgentService, {
      formatContextPacketForTurn: () => Effect.succeed(""),
    } as unknown as (typeof ProjectAgentService)["Service"]);
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provideMerge(projectAgentLayer),
    );
    const layer = makeProviderCommandReactorLive().pipe(
      Layer.provideMerge(projectAgentLayer),
      Layer.provideMerge(
        Layer.succeed(ProjectAgentRepository, {
          getConfigByCoordinatorThread: () => Effect.succeed(Option.none()),
        } as unknown as (typeof ProjectAgentRepository)["Service"]),
      ),
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(TurnCheckpointCoordinatorLive),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(
        Layer.succeed(ProviderHealth, {
          getStatuses: Effect.succeed([]),
          refresh: Effect.succeed([]),
          updateProvider: () => Effect.die("updateProvider unsupported in test"),
          streamChanges: Stream.empty,
        } as unknown as ProviderHealthShape),
      ),
      Layer.provideMerge(Layer.succeed(HubOutputReactor, hubOutputReactor)),
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(GitCore, {
          renameBranch: () => Effect.succeed({ branch: "renamed-branch" }),
          publishBranch: () => Effect.void,
          withMutation,
        } as unknown as GitCoreShape),
      ),
      Layer.provideMerge(
        Layer.succeed(TextGeneration, {
          generateBranchName: () => textGenerationFailure("generateBranchName"),
          generateThreadTitle: () => textGenerationFailure("generateThreadTitle"),
        } as unknown as TextGenerationShape),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest({})),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(OrchestrationEventDeliveryRepositoryLive),
      Layer.provideMerge(ProviderRuntimeEventRepositoryLive),
      Layer.provideMerge(AgentGatewayOperationRepositoryLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );
    const runtime = ManagedRuntime.make(layer);
    runtimes.add(runtime);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    const deliveryRepository = await runtime.runPromise(
      Effect.service(OrchestrationEventDeliveryRepository),
    );
    const queuedTurnPromotions = await runtime.runPromise(
      Effect.service(QueuedTurnPromotionRepository),
    );
    const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    scopes.add(scope);

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Provider Project",
        workspaceRoot: "/tmp/provider-project",
        defaultModelSelection: modelSelection,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        threadId: THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Thread",
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    const persistWithoutLivePublication = async (
      events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
    ) => {
      const persisted: OrchestrationEvent[] = [];
      for (const event of events) {
        const versions = await runtime.runPromise(sql<{ readonly version: number }>`
          SELECT COALESCE(MAX(stream_version), -1) + 1 AS version
          FROM orchestration_events
          WHERE aggregate_kind = ${event.aggregateKind}
            AND stream_id = ${event.aggregateId}
        `);
        const inserted = await runtime.runPromise(sql<{ readonly sequence: number }>`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, command_id, causation_event_id, correlation_id,
            actor_kind, payload_json, metadata_json
          ) VALUES (
            ${event.eventId}, ${event.aggregateKind}, ${event.aggregateId},
            ${versions[0]!.version}, ${event.type},
            ${event.occurredAt}, ${event.commandId}, ${event.causationEventId},
            ${event.correlationId}, 'user', ${JSON.stringify(event.payload)},
            ${JSON.stringify(event.metadata)}
          )
          RETURNING sequence
        `);
        const saved = { ...event, sequence: inserted[0]!.sequence } as OrchestrationEvent;
        persisted.push(saved);
        if (saved.type === "thread.message-sent") {
          await runtime.runPromise(sql`
            INSERT INTO projection_thread_messages (
              message_id, thread_id, turn_id, role, text, is_streaming,
              created_at, updated_at, source, sequence, dispatch_mode
            ) VALUES (
              ${saved.payload.messageId}, ${saved.payload.threadId}, ${saved.payload.turnId},
              ${saved.payload.role}, ${saved.payload.text},
              ${saved.payload.streaming ? 1 : 0}, ${saved.payload.createdAt},
              ${saved.payload.updatedAt}, ${saved.payload.source}, ${saved.sequence},
              ${saved.payload.dispatchMode ?? null}
            )
          `);
        }
      }
      return persisted;
    };

    const seedQueuedMessage = async (key: string, text: string, createdAt: string) => {
      const messageId = asMessageId(`message-${key}`);
      const commandId = CommandId.makeUnsafe(`cmd-${key}`);
      const messageEventId = asEventId(`evt-${key}-message`);
      const persisted = await persistWithoutLivePublication([
        {
          eventId: messageEventId,
          aggregateKind: "thread",
          aggregateId: THREAD_ID,
          occurredAt: createdAt,
          commandId,
          causationEventId: null,
          correlationId: commandId,
          metadata: {},
          type: "thread.message-sent",
          payload: {
            threadId: THREAD_ID,
            messageId,
            role: "user",
            text,
            dispatchMode: "queue",
            turnId: null,
            streaming: false,
            source: "native",
            createdAt,
            updatedAt: createdAt,
          },
        },
        {
          eventId: asEventId(`evt-${key}-queued`),
          aggregateKind: "thread",
          aggregateId: THREAD_ID,
          occurredAt: createdAt,
          commandId,
          causationEventId: messageEventId,
          correlationId: commandId,
          metadata: {},
          type: "thread.turn-queued",
          payload: {
            threadId: THREAD_ID,
            messageId,
            dispatchMode: "queue",
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt,
          },
        },
      ]);
      const queuedEvent = persisted[1]!;
      await Effect.runPromise(
        queuedTurnPromotions.enqueue({
          queuedEventSequence: queuedEvent.sequence,
          threadId: THREAD_ID,
          messageId,
          dispatchMode: "queue",
          createdAt,
        }),
      );
      return queuedEvent.sequence;
    };

    const seedTurnStartRequest = async (key: string, text: string, createdAt: string) => {
      const messageId = asMessageId(`message-${key}`);
      const commandId = CommandId.makeUnsafe(`cmd-${key}`);
      const messageEventId = asEventId(`evt-${key}-message`);
      await persistWithoutLivePublication([
        {
          eventId: messageEventId,
          aggregateKind: "thread",
          aggregateId: THREAD_ID,
          occurredAt: createdAt,
          commandId,
          causationEventId: null,
          correlationId: commandId,
          metadata: {},
          type: "thread.message-sent",
          payload: {
            threadId: THREAD_ID,
            messageId,
            role: "user",
            text,
            dispatchMode: "queue",
            turnId: null,
            streaming: false,
            source: "native",
            createdAt,
            updatedAt: createdAt,
          },
        },
        {
          eventId: asEventId(`evt-${key}-start`),
          aggregateKind: "thread",
          aggregateId: THREAD_ID,
          occurredAt: createdAt,
          commandId,
          causationEventId: messageEventId,
          correlationId: commandId,
          metadata: {},
          type: "thread.turn-start-requested",
          payload: {
            threadId: THREAD_ID,
            messageId,
            dispatchMode: "queue",
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt,
          },
        },
      ]);
    };

    const acknowledgeAllEvents = async () => {
      const allEvents = await Effect.runPromise(
        Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((events) => Array.from(events))),
      );
      for (const event of allEvents) {
        await Effect.runPromise(
          deliveryRepository.advanceCursor({
            consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
            eventSequence: event.sequence,
            updatedAt: now,
          }),
        );
      }
    };

    const readThread = async () =>
      (await Effect.runPromise(engine.getReadModel())).threads.find(
        (thread) => thread.id === THREAD_ID,
      );

    const promotionState = async (sequence: number) =>
      (await Effect.runPromise(queuedTurnPromotions.getBySequence(sequence))).pipe(
        Option.getOrThrow,
      ).state;

    return {
      engine,
      sendTurn,
      seedQueuedMessage,
      seedTurnStartRequest,
      acknowledgeAllEvents,
      readThread,
      promotionState,
      startReactor: () => Effect.runPromise(reactor.start.pipe(Scope.provide(scope))),
    };
  }

  it("settles queued Stable messages copied into Beta instead of sending them at startup", async () => {
    const harness = await createHarness({ importCompletedAt: minutesFromNow(-1) });
    const stableTime = minutesFromNow(-5);
    const first = await harness.seedQueuedMessage(
      "stable-queued-1",
      "stable queued one",
      stableTime,
    );
    const second = await harness.seedQueuedMessage(
      "stable-queued-2",
      "stable queued two",
      stableTime,
    );
    await harness.acknowledgeAllEvents();

    await harness.startReactor();

    await waitFor(
      async () =>
        harness.sendTurn.mock.calls.length > 0 || (await notSentActivities(harness)).length === 2,
    );
    expect(harness.sendTurn).not.toHaveBeenCalled();
    await waitFor(
      async () =>
        (await harness.promotionState(first)) !== "queued" &&
        (await harness.promotionState(second)) !== "queued",
    );
    await settle();
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(await harness.promotionState(first)).not.toBe("promoting");
    expect(await harness.promotionState(second)).not.toBe("promoting");
    const thread = await harness.readThread();
    expect(thread?.session?.status).not.toBe("starting");
  });

  it("settles an unacknowledged Stable send copied into Beta instead of replaying it", async () => {
    const harness = await createHarness({ importCompletedAt: minutesFromNow(-1) });
    await harness.acknowledgeAllEvents();
    await harness.seedTurnStartRequest("stable-send", "stable pending send", minutesFromNow(-5));

    await harness.startReactor();

    await waitFor(
      async () =>
        harness.sendTurn.mock.calls.length > 0 || (await notSentActivities(harness)).length === 1,
    );
    await settle();
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect((await harness.readThread())?.session?.status).not.toBe("starting");
  });

  it("pauses an active Stable goal copied into Beta instead of continuing it", async () => {
    const harness = await createHarness({ importCompletedAt: minutesFromNow(5) });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-goal-before-import"),
        threadId: THREAD_ID,
        goal: "Finish the Stable goal",
        goalStartBehavior: "defer",
      }),
    );

    await harness.startReactor();

    await waitFor(
      async () =>
        harness.sendTurn.mock.calls.length > 0 ||
        (await harness.readThread())?.goalPausedAt != null,
    );
    await settle();
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("still sends a queued message created in Beta after the import", async () => {
    const harness = await createHarness({ importCompletedAt: minutesFromNow(-5) });
    const sequence = await harness.seedQueuedMessage(
      "beta-queued",
      "beta queued message",
      minutesFromNow(-1),
    );
    await harness.acknowledgeAllEvents();

    await harness.startReactor();

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: THREAD_ID,
      input: "beta queued message",
    });
    expect(await harness.promotionState(sequence)).toBe("promoted");
    expect(await notSentActivities(harness)).toHaveLength(0);
  });

  it("still sends a recovered queued message when no Beta import happened", async () => {
    const harness = await createHarness({});
    await harness.seedQueuedMessage("plain-queued", "plain queued message", minutesFromNow(-5));
    await harness.acknowledgeAllEvents();

    await harness.startReactor();

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({ input: "plain queued message" });
  });

  it("still continues an active goal set in Beta after the import", async () => {
    const harness = await createHarness({ importCompletedAt: minutesFromNow(-5) });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-goal-after-import"),
        threadId: THREAD_ID,
        goal: "Continue the Beta goal",
        goalStartBehavior: "defer",
      }),
    );

    await harness.startReactor();

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect((await harness.readThread())?.goalPausedAt ?? null).toBeNull();
  });
});
