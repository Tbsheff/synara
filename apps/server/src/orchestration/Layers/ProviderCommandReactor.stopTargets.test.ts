import * as betaOperationalIssue from "../../betaOperationalIssue";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ClaudeCacheObservation,
  ModelSelection,
  OrchestrationCommand,
  OrchestrationEvent,
  ProviderKind,
  ProviderForkThreadResult,
  ProviderRuntimeEvent,
  ProviderSession,
  ServerSettings,
} from "@synara/contracts";
import {
  ApprovalRequestId,
  type ChatAttachment,
  CommandId,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProjectId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import {
  formatProviderDeliveryBlockDetail,
  isProviderDeliveryBlockDetail,
  PROVIDER_DELIVERY_BLOCK_SUMMARY,
} from "@synara/shared/providerDeliveryBlock";
import type { DeepPartial } from "@synara/shared/Struct";
import { SIDECHAT_INACTIVITY_EXPIRY_MS } from "@synara/shared/sidechatExpiry";
import {
  Duration,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  ManagedRuntime,
  Option,
  PubSub,
  Scope,
  ServiceMap,
  Stream,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentGatewayOperationRepositoryLive } from "../../agentGateway/Layers/AgentGatewayOperationRepository.ts";
import { AgentGatewayOperationRepository } from "../../agentGateway/Services/AgentGatewayOperationRepository.ts";
import { makeAgentGatewaySessionRegistry } from "../../agentGateway/Layers/AgentGatewaySessionRegistry.ts";
import {
  AgentGatewaySessionRegistry,
  type AgentGatewaySessionRegistryShape,
} from "../../agentGateway/Services/AgentGatewaySessionRegistry.ts";
import { ComputerManager } from "../../computer/ComputerManager.ts";
import { FakeComputerBackend } from "../../computer/FakeComputerBackend.ts";
import {
  ComputerService,
  type ComputerServiceShape,
} from "../../computer/Services/ComputerService.ts";
import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { GitCommandError, TextGenerationError } from "../../git/Errors.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
  ProviderSessionDirectoryPersistenceError,
  ProviderValidationError,
} from "../../provider/Errors.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventDeliveryRepositoryLive } from "../../persistence/Layers/OrchestrationEventDeliveries.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import {
  OrchestrationEventDeliveryRepository,
  PROVIDER_COMMAND_REACTOR_CONSUMER,
  providerThreadProcessedConsumerName,
} from "../../persistence/Services/OrchestrationEventDeliveries.ts";
import { QueuedTurnPromotionRepository } from "../../persistence/Services/QueuedTurnPromotions.ts";
import { ProjectionPendingInteractionRepository } from "../../persistence/Services/ProjectionPendingInteractions.ts";
import { ManagedAttachmentRepository } from "../../persistence/Services/ManagedAttachments.ts";
import {
  ProviderRuntimeEventRepository,
  PROVIDER_RUNTIME_INGESTION_CONSUMER,
} from "../../persistence/Services/ProviderRuntimeEvents.ts";
import { ProviderRuntimeEventRepositoryLive } from "../../persistence/Layers/ProviderRuntimeEvents.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import {
  ProviderHealth,
  type ProviderHealthShape,
} from "../../provider/Services/ProviderHealth.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { TextGeneration, type TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { TurnCheckpointCoordinatorLive } from "./TurnCheckpointCoordinator.ts";
import { TurnCheckpointCoordinator } from "../Services/TurnCheckpointCoordinator.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { HubOutputReactorLive } from "./HubOutputReactor.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import {
  awaitInflightClaimSettlement,
  classifyProviderAttemptOutcome,
  hasBoundProviderSession,
  isSafeLegacyProviderBlocker,
  makeProviderCommandReactorLive,
  resolvePreTurnBaselineTimeoutMs,
} from "./ProviderCommandReactor.ts";
import * as groupsBetaGate from "../../projectAgent/groupsBetaGate.ts";
import { ProjectAgentService } from "../../projectAgent/Services/ProjectAgentService.ts";
import { ProjectAgentRepository } from "../../persistence/Services/ProjectAgentRepository.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  OrchestrationCommandInternalError,
  OrchestrationCommandInvariantError,
  type OrchestrationDispatchError,
} from "../Errors.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { HubOutputReactor, type HubOutputReactorShape } from "../Services/HubOutputReactor.ts";
import { attachmentRelativePath } from "../../attachmentStore.ts";
import { resolveProviderAttachmentPath } from "../../provider/providerAttachmentPaths.ts";
import { PROVIDER_DEBUG_MODE_PROMPT_PREFIX } from "../../provider/debugMode.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import {
  CheckpointStore,
  type CheckpointStoreShape,
} from "../../checkpointing/Services/CheckpointStore.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asApprovalRequestId = (value: string): ApprovalRequestId =>
  ApprovalRequestId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };

  return poll();
}

describe("ProviderCommandReactor stop targets", () => {
  const runtimes = new Set<{ dispose: () => Promise<void> }>();
  const scopes = new Set<Scope.Closeable>();
  let scope: Scope.Closeable | null = null;
  const createdStateDirs = new Set<string>();
  const createdBaseDirs = new Set<string>();

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const activeScope of scopes) {
      await Effect.runPromise(Scope.close(activeScope, Exit.void));
    }
    scopes.clear();
    scope = null;
    for (const runtime of runtimes) {
      await runtime.dispose();
    }
    runtimes.clear();
    for (const stateDir of createdStateDirs) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
    createdStateDirs.clear();
    for (const baseDir of createdBaseDirs) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
    createdBaseDirs.clear();
  });

  async function createHarness(input?: {
    readonly baseDir?: string;
    readonly threadModelSelection?: ModelSelection;
    readonly sessionModelSwitch?: "unsupported" | "in-session" | "restart-session";
    readonly conversationRollback?: "native" | "restart-session";
    readonly checkpointStore?: Partial<CheckpointStoreShape>;
    readonly hubOutputReactor?: Partial<HubOutputReactorShape>;
    readonly forkThreadResult?: ProviderForkThreadResult | null;
    readonly startReactor?: boolean;
    readonly interruptTurn?: ProviderServiceShape["interruptTurn"];
    readonly commandEventTimeout?: Duration.Duration;
    readonly preTurnBaselineTimeout?: Duration.Duration;
    readonly cacheResponseTimeout?: Duration.Duration;
    readonly gatewayOperationCompletionWaitTimeout?: Duration.Duration;
    readonly gatewayOperationCompletionNegativeCacheTtl?: Duration.Duration;
    readonly logMessages?: string[];
    readonly gatewayOperationId?: string;
    readonly gitWritingModelSelection?: ModelSelection;
    readonly omitStopRuntimeSession?: boolean;
    readonly serverSettings?: DeepPartial<ServerSettings>;
    readonly confirmNativeResume?: (resumeCursor: unknown) => boolean;
    readonly generateThreadTitle?: TextGenerationShape["generateThreadTitle"];
    readonly computerService?: ComputerServiceShape;
    readonly gatewaySessions?: AgentGatewaySessionRegistryShape;
    readonly getClaudeCacheObservation?: NonNullable<
      ProviderServiceShape["getClaudeCacheObservation"]
    >;
    readonly startClaudeCompaction?: NonNullable<ProviderServiceShape["startClaudeCompaction"]>;
    readonly coordinatorThreadIds?: readonly string[];
    readonly coordinatorConfigState?:
      | {
          readonly enabled?: boolean;
          readonly pausedAt?: string | null;
          readonly archivedAt?: string | null;
        }
      | undefined;
    readonly formatContextPacket?: string;
    readonly projectAdditionalFolders?: readonly string[];
    readonly getPersistedSessionProfile?: ProviderServiceShape["getPersistedSessionProfile"];
    readonly ingestRuntimeEvents?: boolean;
    readonly cancelClaudeCompactionDiscovery?: NonNullable<
      ProviderServiceShape["cancelClaudeCompactionDiscovery"]
    >;
  }) {
    const now = new Date().toISOString();
    const baseDir = input?.baseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "synara-reactor-"));
    createdBaseDirs.add(baseDir);
    const { stateDir } = deriveServerPathsSync(baseDir, undefined);
    createdStateDirs.add(stateDir);
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    let nextSessionIndex = 1;
    const runtimeSessions: Array<ProviderSession> = [];
    const persistedResumeCursors = new Map<ThreadId, unknown>();
    const persistedResumeCursorProviders = new Map<ThreadId, ProviderSession["provider"]>();
    const pendingPriorTranscriptBootstraps = new Set<ThreadId>();
    const listSessions = vi.fn<ProviderServiceShape["listSessions"]>(() =>
      Effect.succeed(runtimeSessions),
    );
    const modelSelection = input?.threadModelSelection ?? {
      provider: "codex",
      model: "gpt-5-codex",
    };
    const startSession = vi.fn<ProviderServiceShape["startSession"]>((_, input) => {
      const sessionIndex = nextSessionIndex++;
      const sessionModelSelection =
        typeof input === "object" && input !== null && "modelSelection" in input
          ? ((input as { modelSelection?: ModelSelection }).modelSelection ?? modelSelection)
          : modelSelection;
      const resumeCursor =
        typeof input === "object" && input !== null && "resumeCursor" in input
          ? input.resumeCursor
          : undefined;
      const threadId =
        typeof input === "object" &&
        input !== null &&
        "threadId" in input &&
        typeof input.threadId === "string"
          ? ThreadId.makeUnsafe(input.threadId)
          : ThreadId.makeUnsafe(`thread-${sessionIndex}`);
      const session: ProviderSession = {
        provider: sessionModelSelection.provider,
        status: "ready" as const,
        runtimeMode:
          typeof input === "object" &&
          input !== null &&
          "runtimeMode" in input &&
          (input.runtimeMode === "approval-required" || input.runtimeMode === "full-access")
            ? input.runtimeMode
            : "full-access",
        ...(sessionModelSelection.model !== undefined
          ? { model: sessionModelSelection.model }
          : {}),
        threadId,
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        resumeCursor: resumeCursor ?? { opaque: `resume-${sessionIndex}` },
        createdAt: now,
        updatedAt: now,
      };
      runtimeSessions.push(session);
      return Effect.succeed(session);
    });
    const startSessionWithOutcome = vi.fn<
      NonNullable<ProviderServiceShape["startSessionWithOutcome"]>
    >((threadId, sessionInput, outcomeOptions) => {
      const persistedCursor =
        persistedResumeCursorProviders.get(threadId) === sessionInput.provider
          ? persistedResumeCursors.get(threadId)
          : undefined;
      const effectiveResumeCursor = sessionInput.resumeCursor ?? persistedCursor;
      const nativeResumeAttempted =
        effectiveResumeCursor !== undefined && effectiveResumeCursor !== null;
      const nativeResumeSucceeded =
        nativeResumeAttempted && (input?.confirmNativeResume?.(effectiveResumeCursor) ?? true);
      if (
        (outcomeOptions?.registerPriorTranscriptBootstrapOnFreshStart === true ||
          (sessionInput.provider === "devin" && nativeResumeAttempted)) &&
        !nativeResumeSucceeded
      ) {
        pendingPriorTranscriptBootstraps.add(threadId);
      }
      return startSession(threadId, sessionInput).pipe(
        Effect.map((session) => {
          const resolvedSession = nativeResumeSucceeded
            ? { ...session, resumeCursor: effectiveResumeCursor }
            : session;
          const runtimeIndex = runtimeSessions.findIndex(
            (candidate) => candidate.threadId === threadId,
          );
          if (runtimeIndex >= 0) {
            runtimeSessions[runtimeIndex] = resolvedSession;
          }
          persistedResumeCursors.set(threadId, resolvedSession.resumeCursor);
          persistedResumeCursorProviders.set(threadId, resolvedSession.provider);
          return {
            session: resolvedSession,
            nativeResumeAttempted,
            nativeResumeSucceeded,
            priorTranscriptBootstrapPending: pendingPriorTranscriptBootstraps.has(threadId),
          };
        }),
      );
    });
    const completePriorTranscriptBootstrap = vi.fn<
      NonNullable<ProviderServiceShape["completePriorTranscriptBootstrap"]>
    >(({ threadId }) =>
      Effect.sync(() => {
        pendingPriorTranscriptBootstraps.delete(threadId);
      }),
    );
    const sendTurn = vi.fn<ProviderServiceShape["sendTurn"]>((_: unknown) =>
      Effect.succeed({
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
      }),
    );
    const setRuntimeSessionTurnState = (input: {
      readonly threadId: string;
      readonly status: ProviderSession["status"];
      readonly activeTurnId?: TurnId;
    }) => {
      const threadId = ThreadId.makeUnsafe(input.threadId);
      const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
      const base: ProviderSession = runtimeSessions[index] ?? {
        provider: modelSelection.provider,
        status: "ready",
        runtimeMode: "full-access",
        threadId,
        resumeCursor: { opaque: "resume-synthetic" },
        cwd: "/tmp/provider-project",
        createdAt: now,
        updatedAt: now,
      };
      const next: ProviderSession = {
        ...base,
        status: input.status,
        ...(input.activeTurnId !== undefined ? { activeTurnId: input.activeTurnId } : {}),
      };
      if (input.activeTurnId === undefined) {
        delete (next as { activeTurnId?: TurnId }).activeTurnId;
      }
      if (index >= 0) {
        runtimeSessions[index] = next;
      } else {
        runtimeSessions.push(next);
      }
    };
    const steerTurn = vi.fn<ProviderServiceShape["steerTurn"]>((_: unknown) =>
      Effect.succeed({
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-steer-1"),
      }),
    );
    const startReview = vi.fn<ProviderServiceShape["startReview"]>((input) =>
      Effect.succeed({
        threadId: input.threadId,
        turnId: asTurnId("turn-review-1"),
      }),
    );
    const forkThread = vi.fn<NonNullable<ProviderServiceShape["forkThread"]>>((forkInput) =>
      Effect.sync(() => {
        const result = input?.forkThreadResult ?? null;
        const forkModelSelection = forkInput.modelSelection ?? modelSelection;
        if (result && !runtimeSessions.some((session) => session.threadId === forkInput.threadId)) {
          runtimeSessions.push({
            provider: forkModelSelection.provider,
            status: "ready",
            runtimeMode: forkInput.runtimeMode,
            ...(forkModelSelection.model !== undefined ? { model: forkModelSelection.model } : {}),
            threadId: forkInput.threadId,
            ...(result.resumeCursor !== undefined ? { resumeCursor: result.resumeCursor } : {}),
            createdAt: now,
            updatedAt: now,
          });
        }
        return result;
      }),
    );
    const interruptTurn = vi.fn(input?.interruptTurn ?? ((_: unknown) => Effect.void));
    const stopTask = vi.fn<ProviderServiceShape["stopTask"]>(() => Effect.void);
    const backgroundTask = vi.fn<ProviderServiceShape["backgroundTask"]>(() => Effect.void);
    const hasLiveRuntimeTasks = vi.fn<NonNullable<ProviderServiceShape["hasLiveRuntimeTasks"]>>(
      () => Effect.succeed(false),
    );
    const steerSubagent = vi.fn<ProviderServiceShape["steerSubagent"]>(() => Effect.void);
    const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
    const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(() => Effect.void);
    const rollbackConversation = vi.fn<ProviderServiceShape["rollbackConversation"]>(
      () => Effect.void,
    );
    const restoreCheckpoint = vi.fn<CheckpointStoreShape["restoreCheckpoint"]>(() =>
      Effect.succeed(true),
    );
    const isGitRepository = vi.fn<CheckpointStoreShape["isGitRepository"]>(() =>
      Effect.succeed(false),
    );
    const captureCheckpoint = vi.fn<CheckpointStoreShape["captureCheckpoint"]>(() => Effect.void);
    const checkpointStore: CheckpointStoreShape = {
      isGitRepository,
      captureCheckpoint,
      copyCheckpointRef: () => Effect.succeed(true),
      hasCheckpointRef: () => Effect.succeed(false),
      restoreCheckpoint,
      reverseCheckpointDiff: () => Effect.succeed(true),
      diffCheckpoints: () => Effect.succeed(""),
      deleteCheckpointRefs: () => Effect.void,
      ...input?.checkpointStore,
    };
    const stopSession = vi.fn((input: unknown) =>
      Effect.sync(() => {
        const threadId =
          typeof input === "object" && input !== null && "threadId" in input
            ? (input as { threadId?: ThreadId }).threadId
            : undefined;
        if (!threadId) {
          return;
        }
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) {
          runtimeSessions.splice(index, 1);
        }
        persistedResumeCursors.delete(threadId);
        persistedResumeCursorProviders.delete(threadId);
        pendingPriorTranscriptBootstraps.delete(threadId);
      }),
    );
    const stopRuntimeSession = vi.fn((input: unknown) =>
      Effect.sync(() => {
        const threadId =
          typeof input === "object" && input !== null && "threadId" in input
            ? (input as { threadId?: ThreadId }).threadId
            : undefined;
        if (!threadId) {
          return;
        }
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) {
          runtimeSessions.splice(index, 1);
        }
      }),
    );
    const clearSessionResumeCursor = vi.fn<
      NonNullable<ProviderServiceShape["clearSessionResumeCursor"]>
    >((input) =>
      Effect.sync(() => {
        const preserveActiveRuntime =
          typeof input === "object" &&
          input !== null &&
          "preserveActiveRuntime" in input &&
          (input as { preserveActiveRuntime?: boolean }).preserveActiveRuntime === true;
        if (preserveActiveRuntime) {
          return;
        }
        const threadId =
          typeof input === "object" && input !== null && "threadId" in input
            ? (input as { threadId?: ThreadId }).threadId
            : undefined;
        if (!threadId) {
          return;
        }
        persistedResumeCursors.set(threadId, null);
        persistedResumeCursorProviders.delete(threadId);
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) {
          runtimeSessions.splice(index, 1);
        }
      }),
    );
    const renameBranch = vi.fn((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "newBranch" in input &&
          typeof input.newBranch === "string"
            ? input.newBranch
            : "renamed-branch",
      }),
    );
    const publishBranch = vi.fn(() => Effect.void);
    const withMutation: GitCoreShape["withMutation"] = (_cwd, effect) => effect;
    const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>(() =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "disabled in test harness",
        }),
      ),
    );
    const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>(
      input?.generateThreadTitle ??
        (() =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "disabled in test harness",
            }),
          )),
    );
    const captureStudioOutputBaseline = vi.fn<HubOutputReactorShape["captureBaselineBeforeTurn"]>(
      input?.hubOutputReactor?.captureBaselineBeforeTurn ??
        (() => Effect.succeed({ status: "completed" as const })),
    );
    const cancelPendingStudioOutputBaseline = vi.fn<
      HubOutputReactorShape["cancelPendingTurnBaseline"]
    >(input?.hubOutputReactor?.cancelPendingTurnBaseline ?? (() => Effect.void));
    const hubOutputReactor: HubOutputReactorShape = {
      captureBaselineBeforeTurn: captureStudioOutputBaseline,
      cancelPendingTurnBaseline: cancelPendingStudioOutputBaseline,
      start: input?.hubOutputReactor?.start ?? Effect.void,
      drain: input?.hubOutputReactor?.drain ?? Effect.void,
    };

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession: startSession as ProviderServiceShape["startSession"],
      startSessionWithOutcome,
      completePriorTranscriptBootstrap,
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      steerTurn: steerTurn as ProviderServiceShape["steerTurn"],
      startReview,
      forkThread,
      interruptTurn: interruptTurn as ProviderServiceShape["interruptTurn"],
      stopTask,
      backgroundTask,
      hasLiveRuntimeTasks,
      steerSubagent,
      respondToRequest: respondToRequest as ProviderServiceShape["respondToRequest"],
      respondToUserInput: respondToUserInput as ProviderServiceShape["respondToUserInput"],
      stopSession: stopSession as ProviderServiceShape["stopSession"],
      ...(input?.omitStopRuntimeSession
        ? {}
        : {
            stopRuntimeSession: stopRuntimeSession as NonNullable<
              ProviderServiceShape["stopRuntimeSession"]
            >,
          }),
      clearSessionResumeCursor,
      listSessions,
      getPersistedSessionProfile:
        input?.getPersistedSessionProfile ?? (() => Effect.succeed(undefined)),
      getCapabilities: (_provider) =>
        Effect.succeed({
          sessionModelSwitch: input?.sessionModelSwitch ?? "in-session",
          ...(input?.conversationRollback
            ? { conversationRollback: input.conversationRollback }
            : {}),
        }),
      rollbackConversation,
      compactThread: () => unsupported(),
      ...(input?.getClaudeCacheObservation
        ? { getClaudeCacheObservation: input.getClaudeCacheObservation }
        : {}),
      ...(input?.startClaudeCompaction
        ? { startClaudeCompaction: input.startClaudeCompaction }
        : {}),
      ...(input?.cancelClaudeCompactionDiscovery
        ? { cancelClaudeCompactionDiscovery: input.cancelClaudeCompactionDiscovery }
        : {}),
      closeRuntimeEvents: Effect.void,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    };

    const projectAgentLayer = Layer.succeed(ProjectAgentService, {
      formatContextPacketForTurn: () => Effect.succeed(input?.formatContextPacket ?? ""),
    } as unknown as (typeof ProjectAgentService)["Service"]);
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provideMerge(projectAgentLayer),
    );
    const projectAgentRepositoryLayer = Layer.succeed(ProjectAgentRepository, {
      getConfigByCoordinatorThread: (threadId: ThreadId) =>
        Effect.succeed(
          (input?.coordinatorThreadIds ?? []).includes(threadId)
            ? Option.some({
                projectId: asProjectId("project-1"),
                enabled: input?.coordinatorConfigState?.enabled ?? true,
                pausedAt: input?.coordinatorConfigState?.pausedAt ?? null,
                archivedAt: input?.coordinatorConfigState?.archivedAt ?? null,
              })
            : Option.none(),
        ),
    } as unknown as (typeof ProjectAgentRepository)["Service"]);
    const reactorLayer = makeProviderCommandReactorLive(input);
    const layer = Layer.mergeAll(reactorLayer, ProviderRuntimeIngestionLive).pipe(
      Layer.provideMerge(projectAgentLayer),
      Layer.provideMerge(projectAgentRepositoryLayer),
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(TurnCheckpointCoordinatorLive),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(
        input?.computerService
          ? Layer.succeed(ComputerService, input.computerService)
          : Layer.empty,
      ),
      Layer.provideMerge(
        input?.gatewaySessions
          ? Layer.succeed(AgentGatewaySessionRegistry, input.gatewaySessions)
          : Layer.empty,
      ),
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
          renameBranch,
          publishBranch,
          withMutation,
        } as unknown as GitCoreShape),
      ),
      Layer.provideMerge(
        Layer.succeed(TextGeneration, {
          generateBranchName,
          generateThreadTitle,
        } as unknown as TextGenerationShape),
      ),
      Layer.provideMerge(
        ServerSettingsService.layerTest({
          ...input?.serverSettings,
          ...(input?.gitWritingModelSelection
            ? { textGenerationModelSelection: input.gitWritingModelSelection }
            : {}),
        }),
      ),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(OrchestrationEventDeliveryRepositoryLive),
      Layer.provideMerge(ProviderRuntimeEventRepositoryLive),
      Layer.provideMerge(AgentGatewayOperationRepositoryLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );
    const runtime = ManagedRuntime.make(layer);
    runtimes.add(runtime);
    const emitRuntimeEvent = (event: ProviderRuntimeEvent) =>
      Effect.runPromise(PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid));

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const engineDispatchTarget = engine as {
      dispatch: OrchestrationEngineShape["dispatch"];
    };
    const passthroughDispatch = engineDispatchTarget.dispatch;
    const interceptEngineDispatch = (
      interceptor: (
        command: OrchestrationCommand,
      ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError> | undefined,
    ) => {
      engineDispatchTarget.dispatch = (command, context) =>
        interceptor(command) ?? passthroughDispatch(command, context);
    };
    const projectionSnapshotQuery = await runtime.runPromise(
      Effect.service(ProjectionSnapshotQuery),
    );
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    const checkpointCoordinator = await runtime.runPromise(
      Effect.service(TurnCheckpointCoordinator),
    );
    const serverSettings = await runtime.runPromise(Effect.service(ServerSettingsService));
    const deliveryRepository = await runtime.runPromise(
      Effect.service(OrchestrationEventDeliveryRepository),
    );
    const queuedTurnPromotionRepository = await runtime.runPromise(
      Effect.service(QueuedTurnPromotionRepository),
    );
    const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
    const managedAttachments = await runtime.runPromise(
      Effect.service(ManagedAttachmentRepository),
    );
    const pendingInteractionRepository = await runtime.runPromise(
      Effect.service(ProjectionPendingInteractionRepository),
    );
    const runtimeEventRepository = await runtime.runPromise(
      Effect.service(ProviderRuntimeEventRepository),
    );
    const gatewayOperations = await runtime.runPromise(
      Effect.service(AgentGatewayOperationRepository),
    );
    const harnessScope = await Effect.runPromise(Scope.make("sequential"));
    scopes.add(harnessScope);
    scope = harnessScope;
    if (input?.ingestRuntimeEvents) {
      const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
      await Effect.runPromise(ingestion.start.pipe(Scope.provide(harnessScope)));
    }
    let reactorStarted = false;
    const startReactor = async () => {
      if (reactorStarted) return;
      const start = reactor.start.pipe(Scope.provide(harnessScope));
      await Effect.runPromise(
        input?.logMessages
          ? start.pipe(
              Effect.provide(
                Logger.layer(
                  [Logger.make(({ message }) => input.logMessages!.push(String(message)))],
                  { mergeWithExisting: false },
                ),
              ),
            )
          : start,
      );
      reactorStarted = true;
    };
    if (input?.startReactor !== false) {
      await startReactor();
    }
    const drain = () => Effect.runPromise(reactor.drain);
    const restartReactor = async () => {
      await Effect.runPromise(Scope.close(harnessScope, Exit.void));
      const freshScope = await Effect.runPromise(Scope.make("sequential"));
      scopes.add(freshScope);
      const services = await Effect.runPromise(
        Layer.buildWithScope(
          Layer.fresh(reactorLayer).pipe(
            Layer.provide(Layer.succeedServices(await runtime.services())),
          ),
          freshScope,
        ),
      );
      const fresh = ServiceMap.get(services, ProviderCommandReactor);
      return {
        reactor: fresh,
        start: () => Effect.runPromise(fresh.start.pipe(Scope.provide(freshScope))),
      };
    };

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot: "/tmp/provider-project",
        ...(input?.projectAdditionalFolders
          ? { additionalFolders: input.projectAdditionalFolders }
          : {}),
        defaultModelSelection: modelSelection,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        ...(input?.gatewayOperationId
          ? {
              creationSource: "synara_mcp" as const,
              gatewayOperationId: input.gatewayOperationId,
              gatewayOperationIndex: 0,
            }
          : {}),
        createdAt: now,
      }),
    );

    return {
      engine,
      projectionSnapshotQuery,
      seedCompletion: () =>
        runtime!.runPromise(sql`
        INSERT INTO agent_gateway_completions
          (child_thread_id, creator_thread_id, initial_message_id, result_json, delivery_state, created_at)
        VALUES ('delegated-child', 'thread-1', 'delegated-initial', '{"summary":"delegated result","childThreadId":"delegated-child"}', 'delivered', ${new Date().toISOString()})
      `),
      completionState: () =>
        runtime!.runPromise(sql<{
          context_consumed: number;
          context_event_sequence: number | null;
        }>`
        SELECT context_consumed, context_event_sequence FROM agent_gateway_completions WHERE child_thread_id = 'delegated-child'
      `),
      reactor,
      checkpointCoordinator,
      serverSettings,
      startSession,
      startSessionWithOutcome,
      completePriorTranscriptBootstrap,
      pendingPriorTranscriptBootstraps,
      listSessions,
      sendTurn,
      steerTurn,
      startReview,
      forkThread,
      interruptTurn,
      stopTask,
      backgroundTask,
      hasLiveRuntimeTasks,
      steerSubagent,
      respondToRequest,
      respondToUserInput,
      rollbackConversation,
      isGitRepository,
      captureCheckpoint,
      restoreCheckpoint,
      stopSession,
      stopRuntimeSession,
      clearSessionResumeCursor,
      renameBranch,
      publishBranch,
      generateBranchName,
      generateThreadTitle,
      captureStudioOutputBaseline,
      cancelPendingStudioOutputBaseline,
      stateDir,
      stageAttachment: async (
        attachment: {
          readonly type: "image" | "file";
          readonly id: string;
          readonly name: string;
          readonly mimeType: string;
          readonly sizeBytes: number;
        },
        ownerThreadId = "thread-1",
      ) => {
        const flatRelativePath = attachmentRelativePath(attachment);
        const relativePath = attachment.id.startsWith("att_v2_")
          ? `objects/${attachment.id.slice(7, 9)}/${flatRelativePath}`
          : flatRelativePath;
        const attachmentPath = path.join(stateDir, "attachments", relativePath);
        fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
        if (!fs.existsSync(attachmentPath)) {
          fs.writeFileSync(attachmentPath, Buffer.alloc(attachment.sizeBytes));
        }
        const stagedAt = new Date().toISOString();
        await runtime.runPromise(
          managedAttachments
            .reserve({
              attachmentId: attachment.id,
              ownerThreadId,
              ownerKind: "local-loopback",
              ownerId: "local-loopback",
              kind: attachment.type,
              originalName: attachment.name,
              mimeType: attachment.mimeType,
              reservedBytes: attachment.sizeBytes,
              relativePath,
              now: stagedAt,
            })
            .pipe(
              Effect.andThen(
                managedAttachments.finalizeStaged({
                  attachmentId: attachment.id,
                  ownerThreadId,
                  ownerKind: "local-loopback",
                  ownerId: "local-loopback",
                  sizeBytes: attachment.sizeBytes,
                  sha256: "0".repeat(64),
                  stagingExpiresAt: new Date(Date.now() + 60_000).toISOString(),
                  now: stagedAt,
                }),
              ),
            ),
        );
        return attachmentPath;
      },
      drain,
      emitRuntimeEvent,
      setRuntimeSessionTurnState,
      startReactor,
      restartReactor,
      deliveryRepository,
      sql,
      pendingInteractionRepository,
      runtimeEventRepository,
      reserveGatewayOperation: (operationId: string) =>
        runtime.runPromise(
          gatewayOperations.reserve({
            operationId,
            callerThreadId: "caller-thread",
            callerTurnId: "caller-turn",
            operationKind: "create_threads",
            requestId: `request-${operationId}`,
            fingerprint: `fingerprint-${operationId}`,
            requestedCount: 1,
            planJson: "[]",
            now,
          }),
        ),
      markGatewayOperationDispatching: (operationId: string) =>
        runtime.runPromise(gatewayOperations.markDispatching({ operationId, now })),
      completeGatewayOperation: (operationId: string) =>
        runtime.runPromise(
          gatewayOperations.complete({
            operationId,
            resultJson: "{}",
            now: new Date().toISOString(),
          }),
        ),
      persistWithoutLivePublication: async (
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
      },
      persistSessionWithoutLivePublication: async (input: {
        readonly threadId: ThreadId;
        readonly turnId: TurnId;
        readonly updatedAt: string;
      }) =>
        runtime.runPromise(sql`
          INSERT INTO projection_thread_sessions (
            thread_id, status, provider_name, runtime_mode,
            active_turn_id, last_error, updated_at
          ) VALUES (
            ${input.threadId}, 'running', 'codex', 'approval-required',
            ${input.turnId}, NULL, ${input.updatedAt}
          )
          ON CONFLICT (thread_id) DO UPDATE SET
            status = excluded.status,
            provider_name = excluded.provider_name,
            runtime_mode = excluded.runtime_mode,
            active_turn_id = excluded.active_turn_id,
            last_error = excluded.last_error,
            updated_at = excluded.updated_at
        `),
      queuedTurnPromotionRepository,
      interceptEngineDispatch,
    };
  }

  async function readHarnessThread(
    harness: Awaited<ReturnType<typeof createHarness>>,
    threadId: ThreadId = ThreadId.makeUnsafe("thread-1"),
  ) {
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    return readModel.threads.find((thread) => thread.id === threadId);
  }

  async function seedLiveTurn(
    harness: Awaited<ReturnType<typeof createHarness>>,
    input: { readonly projectedTurnId: TurnId; readonly liveTurnId: TurnId; readonly now: string },
  ) {
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe(`cmd-session-set-${input.projectedTurnId}`),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: input.projectedTurnId,
          lastError: null,
          updatedAt: input.now,
        },
        createdAt: input.now,
      }),
    );
    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: input.liveTurnId,
    });
  }

  it.each([
    ["the projection already shows the newer turn", "turn-newer"],
    ["the projection still shows the ended turn", "turn-ended"],
  ] as const)(
    "does not interrupt a newer live turn when a delayed interrupt names an ended turn (%s)",
    async (_label, projectedTurnId) => {
      const harness = await createHarness();
      const now = new Date().toISOString();
      await seedLiveTurn(harness, {
        projectedTurnId: asTurnId(projectedTurnId),
        liveTurnId: asTurnId("turn-newer"),
        now,
      });

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("cmd-delayed-interrupt-ended-turn"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnId: asTurnId("turn-ended"),
          createdAt: now,
        }),
      );
      await harness.drain();

      expect(harness.interruptTurn).not.toHaveBeenCalled();
      expect(harness.stopSession).not.toHaveBeenCalled();
      expect(harness.stopRuntimeSession).not.toHaveBeenCalled();
      const thread = await readHarnessThread(harness);
      expect(thread?.session).toMatchObject({
        status: "running",
        activeTurnId: projectedTurnId,
      });
      expect(
        thread?.activities.some((activity) => activity.kind === "provider.turn.interrupt.failed"),
      ).toBe(false);
    },
  );

  it.each([
    ["a newer projected turn", "running", "turn-newer"],
    ["a session still starting the next turn", "starting", null],
  ] as const)(
    "leaves %s alone when a delayed interrupt names an ended turn and no turn is live",
    async (_label, status, activeTurnId) => {
      const harness = await createHarness();
      const now = new Date().toISOString();
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("cmd-session-set-no-live-turn"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          session: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            status,
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: activeTurnId === null ? null : asTurnId(activeTurnId),
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );
      harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("cmd-delayed-interrupt-no-live-turn"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnId: asTurnId("turn-ended"),
          createdAt: now,
        }),
      );
      await harness.drain();

      expect(harness.interruptTurn).not.toHaveBeenCalled();
      expect(harness.stopSession).not.toHaveBeenCalled();
      expect(harness.stopRuntimeSession).not.toHaveBeenCalled();
      expect((await readHarnessThread(harness))?.session).toMatchObject({ status, activeTurnId });
    },
  );

  it("interrupts the live turn when the explicit target is that turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    await seedLiveTurn(harness, {
      projectedTurnId: asTurnId("turn-live"),
      liveTurnId: asTurnId("turn-live"),
      now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-interrupt-matching-target"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-live"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      turnId: "turn-live",
    });
  });

  it("still stops the live turn on a desktop-quit interrupt with a stale recorded turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    await seedLiveTurn(harness, {
      projectedTurnId: asTurnId("turn-recorded"),
      liveTurnId: asTurnId("turn-live-at-quit"),
      now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("quit-resume-interrupt:record-1:thread-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-recorded"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      turnId: "turn-live-at-quit",
    });
  });

  it("bounds a task stop the provider never answers and keeps the thread deliverable", async () => {
    const harness = await createHarness({ commandEventTimeout: Duration.seconds(2) });
    const now = new Date().toISOString();
    harness.stopTask.mockImplementation(() => Effect.never);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-before-hung-task-stop"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-hung-task-stop"),
          role: "user",
          text: "spawn something",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.task.stop",
        commandId: CommandId.makeUnsafe("cmd-task-stop-hung"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        taskId: "task-stop-hung",
        createdAt: new Date().toISOString(),
      }),
    );

    await waitFor(async () => {
      const thread = await readHarnessThread(harness);
      return (
        thread?.activities.some((activity) => activity.kind === "provider.task.stop.failed") ??
        false
      );
    }, 5000);
    const failure = (await readHarnessThread(harness))?.activities.find(
      (activity) => activity.kind === "provider.task.stop.failed",
    );
    expect(failure?.payload).toMatchObject({
      detail: expect.stringContaining("did not respond within"),
      settlementStatus: "uncertain",
    });
    await harness.drain();
    expect(
      Option.isNone(
        await Effect.runPromise(
          harness.deliveryRepository.firstBlockingDeliveryForThread({
            consumerName: "provider-command-reactor.v1",
            threadId: "thread-1",
          }),
        ),
      ),
    ).toBe(true);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-interrupt-after-hung-task-stop"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: new Date().toISOString(),
      }),
    );
    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
  });
});
