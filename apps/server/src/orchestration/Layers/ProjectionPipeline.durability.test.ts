import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ManagedAttachmentRepository } from "../../persistence/Services/ManagedAttachments.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";

const makeLayer = (prefix: string) =>
  Layer.fresh(
    OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

type AppendInput = Parameters<OrchestrationEventStoreShape["append"]>[0];
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type ScenarioEvent = DistributiveOmit<
  AppendInput,
  | "eventId"
  | "commandId"
  | "correlationId"
  | "causationEventId"
  | "metadata"
  | "aggregateKind"
  | "aggregateId"
>;

const makeScenario = (prefix: string) =>
  Effect.gen(function* () {
    const eventStore = yield* OrchestrationEventStore;
    const pipeline = yield* OrchestrationProjectionPipeline;
    let counter = 0;
    const envelope = (event: ScenarioEvent): AppendInput => {
      counter += 1;
      const aggregate =
        event.type === "project.created"
          ? {
              aggregateKind: "project" as const,
              aggregateId: (event.payload as { readonly projectId: ProjectId }).projectId,
            }
          : {
              aggregateKind: "thread" as const,
              aggregateId: (event.payload as { readonly threadId: ThreadId }).threadId,
            };
      return {
        ...event,
        ...aggregate,
        eventId: EventId.makeUnsafe(`evt-${prefix}-${counter}`),
        commandId: CommandId.makeUnsafe(`cmd-${prefix}-${counter}`),
        correlationId: CommandId.makeUnsafe(`cmd-${prefix}-${counter}`),
        causationEventId: null,
        metadata: {},
      } as AppendInput;
    };
    const append = (event: ScenarioEvent) => eventStore.append(envelope(event));
    const project = (event: ScenarioEvent) =>
      append(event).pipe(Effect.flatMap((saved) => pipeline.projectEvent(saved)));
    return { append, project, pipeline, eventStore };
  });

const createThread = (
  project: (event: ScenarioEvent) => Effect.Effect<void, unknown>,
  input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly at: string;
    readonly modelSelection?: { readonly provider: "codex"; readonly model: string };
  },
) =>
  Effect.gen(function* () {
    yield* project({
      type: "project.created",
      occurredAt: input.at,
      payload: {
        projectId: input.projectId,
        title: "Project",
        workspaceRoot: `/tmp/${input.projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: input.at,
        updatedAt: input.at,
      },
    });
    yield* project({
      type: "thread.created",
      occurredAt: input.at,
      payload: {
        threadId: input.threadId,
        projectId: input.projectId,
        title: "Thread",
        modelSelection: input.modelSelection ?? { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: input.at,
        updatedAt: input.at,
      },
    });
  });

const exists = (filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return (yield* Effect.result(fileSystem.stat(filePath)))._tag === "Success";
  });

const legacyAttachmentId = (threadId: string, index: number) =>
  `${threadId}-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

const checkpoint = (input: {
  readonly threadId: ThreadId;
  readonly turnId: string;
  readonly count: number;
  readonly at: string;
  readonly ref?: string;
  readonly status?: "ready" | "missing" | "error";
  readonly assistantMessageId?: string | null;
}): ScenarioEvent => ({
  type: "thread.turn-diff-completed",
  occurredAt: input.at,
  payload: {
    threadId: input.threadId,
    turnId: TurnId.makeUnsafe(input.turnId),
    checkpointTurnCount: input.count,
    checkpointRef: CheckpointRef.makeUnsafe(
      input.ref ?? `refs/synara/checkpoints/${input.threadId}/turn/${input.count}`,
    ),
    status: input.status ?? "ready",
    files: [],
    assistantMessageId:
      input.assistantMessageId === undefined
        ? null
        : input.assistantMessageId === null
          ? null
          : MessageId.makeUnsafe(input.assistantMessageId),
    completedAt: input.at,
  },
});

const message = (input: {
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly role: "user" | "assistant";
  readonly turnId: string | null;
  readonly at: string;
  readonly text?: string;
  readonly attachments?: ReadonlyArray<{
    readonly type: "image" | "file";
    readonly id: string;
    readonly name: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
  }>;
}): ScenarioEvent => ({
  type: "thread.message-sent",
  occurredAt: input.at,
  payload: {
    threadId: input.threadId,
    messageId: MessageId.makeUnsafe(input.messageId),
    role: input.role,
    text: input.text ?? input.messageId,
    ...(input.attachments ? { attachments: [...input.attachments] } : {}),
    turnId: input.turnId === null ? null : TurnId.makeUnsafe(input.turnId),
    streaming: false,
    createdAt: input.at,
    updatedAt: input.at,
  },
});

const toolImageActivity = (input: {
  readonly threadId: ThreadId;
  readonly activityId: string;
  readonly turnId: string;
  readonly imagePath: string;
  readonly at: string;
}): ScenarioEvent => ({
  type: "thread.activity-appended",
  occurredAt: input.at,
  payload: {
    threadId: input.threadId,
    activity: {
      id: EventId.makeUnsafe(input.activityId),
      tone: "tool",
      kind: "tool.completed",
      summary: "Read screenshot",
      payload: {
        itemType: "dynamic_tool_call",
        toolCall: {
          toolName: "Read",
          images: [{ source: "file", path: input.imagePath, mediaType: "image/png" }],
        },
      },
      turnId: TurnId.makeUnsafe(input.turnId),
      createdAt: input.at,
    },
  },
});

const sessionSet = (input: {
  readonly threadId: ThreadId;
  readonly status: "running" | "ready" | "interrupted";
  readonly activeTurnId: string | null;
  readonly at: string;
  readonly providerName?: string;
}): ScenarioEvent => ({
  type: "thread.session-set",
  occurredAt: input.at,
  payload: {
    threadId: input.threadId,
    session: {
      threadId: input.threadId,
      status: input.status,
      providerName: input.providerName ?? "codex",
      runtimeMode: "full-access",
      activeTurnId: input.activeTurnId === null ? null : TurnId.makeUnsafe(input.activeTurnId),
      lastError: null,
      updatedAt: input.at,
    },
  },
});

const keepOnly = (
  rows: ReadonlyArray<{ readonly id: string; readonly rowId: number }>,
  ids: ReadonlyArray<string>,
) => rows.filter((row) => ids.includes(row.id));

const readTurn = (threadId: ThreadId, turnId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly state: string;
      readonly completedAt: string | null;
      readonly checkpointRef: string | null;
      readonly checkpointStatus: string | null;
    }>`
      SELECT state, completed_at AS "completedAt", checkpoint_ref AS "checkpointRef",
        checkpoint_status AS "checkpointStatus"
      FROM projection_turns WHERE thread_id = ${threadId} AND turn_id = ${turnId}
    `;
    return rows[0];
  });

it.layer(makeLayer("synara-w1-hot-prune-"))("ProjectionPipeline hot attachment cleanup", (it) => {
  it.effect("keeps pruned legacy files until the hot projection transaction commits", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const { attachmentsDir } = yield* ServerConfig;
      const { project, append, pipeline } = yield* makeScenario("hot-prune");
      const threadId = ThreadId.makeUnsafe("thread-hot-prune");
      const at = "2026-10-01T10:00:00.000Z";
      const keepId = legacyAttachmentId("thread-hot-prune", 1);
      const removeId = legacyAttachmentId("thread-hot-prune", 2);
      yield* createThread(project, {
        projectId: ProjectId.makeUnsafe("project-hot"),
        threadId,
        at,
      });
      yield* project(checkpoint({ threadId, turnId: "turn-1", count: 1, at }));
      yield* project(checkpoint({ threadId, turnId: "turn-2", count: 2, at }));
      for (const [messageId, turnId, attachmentId] of [
        ["message-keep", "turn-1", keepId],
        ["message-remove", "turn-2", removeId],
      ] as const) {
        yield* project(
          message({
            threadId,
            messageId,
            role: "assistant",
            turnId,
            at,
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "a.png",
                mimeType: "image/png",
                sizeBytes: 1,
              },
            ],
          }),
        );
      }
      const keepPath = path.join(attachmentsDir, `${keepId}.png`);
      const removePath = path.join(attachmentsDir, `${removeId}.png`);
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(keepPath, "keep");
      yield* fileSystem.writeFileString(removePath, "remove");

      const reverted = yield* append({
        type: "thread.reverted",
        occurredAt: at,
        payload: { threadId, turnCount: 1 },
      });

      const failed = yield* Effect.result(
        sql.withTransaction(
          pipeline
            .projectHotEventInCurrentTransaction(reverted)
            .pipe(Effect.andThen(Effect.fail("forced-commit-failure"))),
        ),
      );
      assert.equal(failed._tag, "Failure");
      assert.isTrue(yield* exists(removePath));
      const removedRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_messages WHERE message_id = 'message-remove'
      `;
      assert.equal(removedRows[0]?.count, 1);

      const cleanup = yield* sql.withTransaction(
        pipeline.projectHotEventInCurrentTransaction(reverted),
      );
      assert.isTrue(yield* exists(removePath));
      yield* cleanup;
      assert.isFalse(yield* exists(removePath));
      assert.isTrue(yield* exists(keepPath));
    }),
  );
});

it.layer(makeLayer("synara-w1-replay-prune-"))(
  "ProjectionPipeline replay attachment cleanup",
  (it) => {
    it.effect("prunes replayed attachments against final message and activity references", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const managedAttachments = yield* ManagedAttachmentRepository;
        const { attachmentsDir } = yield* ServerConfig;
        const { project, pipeline } = yield* makeScenario("replay-prune");
        const threadId = ThreadId.makeUnsafe("thread-replay-prune");
        const at = "2026-10-01T10:00:00.000Z";
        const keptId = legacyAttachmentId("thread-replay-prune", 1);
        const revertedId = legacyAttachmentId("thread-replay-prune", 2);
        const laterId = legacyAttachmentId("thread-replay-prune", 3);
        const keptToolImageId = legacyAttachmentId("thread-replay-prune", 4);
        const laterToolImageId = legacyAttachmentId("thread-replay-prune", 5);
        const managedId = "att_v2_55555555555555555555555555555555";
        const managedRelativePath = `objects/55/${managedId}.txt`;
        const keptToolImagePath = path.join(attachmentsDir, `${keptToolImageId}.png`);
        const laterToolImagePath = path.join(attachmentsDir, `${laterToolImageId}.png`);

        yield* createThread(project, {
          projectId: ProjectId.makeUnsafe("project-replay-prune"),
          threadId,
          at,
        });
        yield* project(checkpoint({ threadId, turnId: "turn-1", count: 1, at }));
        yield* project(
          message({
            threadId,
            messageId: "message-1",
            role: "assistant",
            turnId: "turn-1",
            at,
            attachments: [
              { type: "image", id: keptId, name: "a.png", mimeType: "image/png", sizeBytes: 1 },
            ],
          }),
        );
        yield* project(
          toolImageActivity({
            threadId,
            activityId: "activity-kept-image",
            turnId: "turn-1",
            imagePath: keptToolImagePath,
            at,
          }),
        );
        yield* project(checkpoint({ threadId, turnId: "turn-2", count: 2, at }));
        yield* project(
          message({
            threadId,
            messageId: "message-2",
            role: "assistant",
            turnId: "turn-2",
            at,
            attachments: [
              { type: "image", id: revertedId, name: "b.png", mimeType: "image/png", sizeBytes: 1 },
            ],
          }),
        );
        yield* project({
          type: "thread.reverted",
          occurredAt: at,
          payload: { threadId, turnCount: 1 },
        });

        assert.strictEqual(
          (yield* managedAttachments.reserve({
            attachmentId: managedId,
            ownerThreadId: threadId,
            ownerKind: "principal",
            ownerId: "principal-replay-prune",
            kind: "file",
            originalName: "managed.txt",
            mimeType: "text/plain",
            reservedBytes: 5,
            relativePath: managedRelativePath,
            now: at,
          })).status,
          "reserved",
        );
        yield* managedAttachments.finalizeStaged({
          attachmentId: managedId,
          ownerThreadId: threadId,
          ownerKind: "principal",
          ownerId: "principal-replay-prune",
          sizeBytes: 5,
          sha256: "c".repeat(64),
          stagingExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          now: at,
        });
        yield* managedAttachments.claimForAcceptedTurn({
          attachmentIds: [managedId],
          ownerThreadId: threadId,
          ownerKind: "principal",
          ownerId: "principal-replay-prune",
          commandId: "command-replay-prune-managed",
          messageId: "message-3",
          now: at,
        });

        yield* project(checkpoint({ threadId, turnId: "turn-3", count: 2, at }));
        yield* project(
          message({
            threadId,
            messageId: "message-3",
            role: "assistant",
            turnId: "turn-3",
            at,
            attachments: [
              { type: "image", id: laterId, name: "c.png", mimeType: "image/png", sizeBytes: 1 },
              {
                type: "file",
                id: managedId,
                name: "managed.txt",
                mimeType: "text/plain",
                sizeBytes: 5,
              },
            ],
          }),
        );
        yield* project(
          toolImageActivity({
            threadId,
            activityId: "activity-later-image",
            turnId: "turn-3",
            imagePath: laterToolImagePath,
            at,
          }),
        );

        const keptPath = path.join(attachmentsDir, `${keptId}.png`);
        const revertedPath = path.join(attachmentsDir, `${revertedId}.png`);
        const laterPath = path.join(attachmentsDir, `${laterId}.png`);
        yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
        for (const filePath of [
          keptPath,
          revertedPath,
          laterPath,
          keptToolImagePath,
          laterToolImagePath,
        ]) {
          yield* fileSystem.writeFileString(filePath, "bytes");
        }

        yield* sql`DELETE FROM projection_state`;
        yield* pipeline.bootstrap;

        assert.isTrue(yield* exists(keptPath));
        assert.isTrue(yield* exists(laterPath));
        assert.isTrue(yield* exists(keptToolImagePath));
        assert.isTrue(yield* exists(laterToolImagePath));
        assert.isFalse(yield* exists(revertedPath));
        const managedState = yield* sql<{ readonly state: string }>`
        SELECT state FROM managed_attachment_blobs WHERE attachment_id = ${managedId}
      `;
        assert.deepStrictEqual(managedState, [{ state: "claimed" }]);
        const messages = yield* sql<{ readonly messageId: string }>`
        SELECT message_id AS "messageId" FROM projection_thread_messages
        WHERE thread_id = ${threadId} ORDER BY message_id
      `;
        assert.deepStrictEqual(
          messages.map((row) => row.messageId),
          ["message-1", "message-3"],
        );
      }),
    );
  },
);

it.layer(makeLayer("synara-w1-provider-replay-"))("ProjectionPipeline provider replay", (it) => {
  it.effect("replays a first-turn provider switch with the state at that event", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { project, pipeline } = yield* makeScenario("provider-replay");
      const threadId = ThreadId.makeUnsafe("thread-provider-replay");
      const at = "2026-10-01T10:00:00.000Z";
      const later = "2026-10-01T10:00:05.000Z";
      yield* createThread(project, {
        projectId: ProjectId.makeUnsafe("project-provider-replay"),
        threadId,
        at,
      });
      yield* project(message({ threadId, messageId: "user-1", role: "user", turnId: null, at }));
      yield* project({
        type: "thread.turn-start-requested",
        occurredAt: at,
        payload: {
          threadId,
          messageId: MessageId.makeUnsafe("user-1"),
          modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: at,
        },
      });
      yield* project(
        sessionSet({
          threadId,
          status: "running",
          activeTurnId: "turn-1",
          at: later,
          providerName: "claudeAgent",
        }),
      );
      yield* project(
        message({
          threadId,
          messageId: "assistant-1",
          role: "assistant",
          turnId: "turn-1",
          at: later,
        }),
      );
      yield* project(
        sessionSet({
          threadId,
          status: "ready",
          activeTurnId: null,
          at: later,
          providerName: "claudeAgent",
        }),
      );

      const readSelection = sql<{ readonly modelSelectionJson: string }>`
        SELECT model_selection_json AS "modelSelectionJson" FROM projection_threads
        WHERE thread_id = ${threadId}
      `.pipe(Effect.map((rows) => JSON.parse(rows[0]!.modelSelectionJson).provider));
      assert.equal(yield* readSelection, "claudeAgent");

      yield* sql`DELETE FROM projection_state`;
      yield* pipeline.bootstrap;
      assert.equal(yield* readSelection, "claudeAgent");

      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_state`;
      yield* pipeline.bootstrap;
      assert.equal(yield* readSelection, "claudeAgent");
    }),
  );
});

it.layer(makeLayer("synara-w1-turn-lifecycle-"))("ProjectionPipeline turn lifecycle", (it) => {
  it.effect("keeps the provider's terminal turn state when a checkpoint completes", () =>
    Effect.gen(function* () {
      const { project } = yield* makeScenario("checkpoint-lifecycle");
      const threadId = ThreadId.makeUnsafe("thread-checkpoint-lifecycle");
      const t0 = "2026-10-01T10:00:00.000Z";
      const t1 = "2026-10-01T10:00:01.000Z";
      const t2 = "2026-10-01T10:00:02.000Z";
      const t3 = "2026-10-01T10:00:03.000Z";
      yield* createThread(project, {
        projectId: ProjectId.makeUnsafe("project-checkpoint-lifecycle"),
        threadId,
        at: t0,
      });
      yield* project(sessionSet({ threadId, status: "running", activeTurnId: "turn-1", at: t1 }));
      yield* project(sessionSet({ threadId, status: "interrupted", activeTurnId: null, at: t2 }));
      yield* project(
        checkpoint({ threadId, turnId: "turn-1", count: 1, at: t3, status: "missing" }),
      );
      const interrupted = yield* readTurn(threadId, "turn-1");
      assert.equal(interrupted?.state, "interrupted");
      assert.equal(interrupted?.completedAt, t2);
      assert.equal(interrupted?.checkpointStatus, "missing");
      assert.equal(interrupted?.checkpointRef, `refs/synara/checkpoints/${threadId}/turn/1`);

      yield* project(sessionSet({ threadId, status: "running", activeTurnId: "turn-2", at: t1 }));
      yield* project(sessionSet({ threadId, status: "ready", activeTurnId: null, at: t2 }));
      yield* project(checkpoint({ threadId, turnId: "turn-2", count: 2, at: t3, status: "error" }));
      const completed = yield* readTurn(threadId, "turn-2");
      assert.equal(completed?.state, "completed");
      assert.equal(completed?.completedAt, t2);
      assert.equal(completed?.checkpointStatus, "error");

      yield* project(checkpoint({ threadId, turnId: "turn-imported", count: 3, at: t3 }));
      const imported = yield* readTurn(threadId, "turn-imported");
      assert.equal(imported?.state, "completed");
      assert.equal(imported?.completedAt, t3);
    }),
  );

  it.effect("keeps a saved checkpoint when a late diff placeholder arrives", () =>
    Effect.gen(function* () {
      const { project } = yield* makeScenario("late-placeholder");
      const threadId = ThreadId.makeUnsafe("thread-late-placeholder");
      const t0 = "2026-10-01T10:00:00.000Z";
      const t1 = "2026-10-01T10:00:01.000Z";
      const t2 = "2026-10-01T10:00:02.000Z";
      const t3 = "2026-10-01T10:00:03.000Z";
      yield* createThread(project, {
        projectId: ProjectId.makeUnsafe("project-late-placeholder"),
        threadId,
        at: t0,
      });
      yield* project(sessionSet({ threadId, status: "running", activeTurnId: "turn-1", at: t1 }));
      yield* project(sessionSet({ threadId, status: "ready", activeTurnId: null, at: t2 }));
      yield* project(checkpoint({ threadId, turnId: "turn-1", count: 1, at: t2 }));
      yield* project(
        checkpoint({
          threadId,
          turnId: "turn-1",
          count: 1,
          at: t3,
          status: "missing",
          ref: "provider-diff:turn-1",
        }),
      );
      const turn = yield* readTurn(threadId, "turn-1");
      assert.equal(turn?.checkpointRef, `refs/synara/checkpoints/${threadId}/turn/1`);
      assert.equal(turn?.checkpointStatus, "ready");
      assert.equal(turn?.state, "completed");
    }),
  );

  it.effect("keeps an interrupted turn terminal when a delayed running session arrives", () =>
    Effect.gen(function* () {
      const { project } = yield* makeScenario("delayed-running");
      const threadId = ThreadId.makeUnsafe("thread-delayed-running");
      const t0 = "2026-10-01T10:00:00.000Z";
      const t1 = "2026-10-01T10:00:01.000Z";
      const t2 = "2026-10-01T10:00:02.000Z";
      yield* createThread(project, {
        projectId: ProjectId.makeUnsafe("project-delayed-running"),
        threadId,
        at: t0,
      });
      yield* project(sessionSet({ threadId, status: "running", activeTurnId: "turn-1", at: t1 }));
      yield* project(sessionSet({ threadId, status: "interrupted", activeTurnId: null, at: t2 }));
      yield* project(sessionSet({ threadId, status: "running", activeTurnId: "turn-1", at: t1 }));
      const turn = yield* readTurn(threadId, "turn-1");
      assert.equal(turn?.state, "interrupted");
      assert.equal(turn?.completedAt, t2);
    }),
  );

  it.effect("settles the open turn without decoding unrelated turn history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { project } = yield* makeScenario("settle-open");
      const threadId = ThreadId.makeUnsafe("thread-settle-open");
      const t0 = "2026-10-01T10:00:00.000Z";
      const t1 = "2026-10-01T10:00:01.000Z";
      const t2 = "2026-10-01T10:00:02.000Z";
      yield* createThread(project, {
        projectId: ProjectId.makeUnsafe("project-settle-open"),
        threadId,
        at: t0,
      });
      yield* project(checkpoint({ threadId, turnId: "turn-old", count: 1, at: t0 }));
      yield* sql`UPDATE projection_turns SET checkpoint_files_json = '{not-json'
        WHERE thread_id = ${threadId} AND turn_id = 'turn-old'`;
      yield* project(sessionSet({ threadId, status: "running", activeTurnId: "turn-new", at: t1 }));
      yield* project(sessionSet({ threadId, status: "ready", activeTurnId: null, at: t2 }));
      const turn = yield* readTurn(threadId, "turn-new");
      assert.equal(turn?.state, "completed");
      assert.equal(turn?.completedAt, t2);
    }),
  );
});

it.layer(makeLayer("synara-w1-rollback-rows-"))("ProjectionPipeline rollback writes", (it) => {
  it.effect("deletes only removed rows and leaves retained rows in place", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { project } = yield* makeScenario("rollback-rows");
      const threadId = ThreadId.makeUnsafe("thread-rollback-rows");
      const otherThreadId = ThreadId.makeUnsafe("thread-rollback-rows-other");
      const at = "2026-10-01T10:00:00.000Z";
      yield* createThread(project, {
        projectId: ProjectId.makeUnsafe("project-rollback-rows"),
        threadId,
        at,
      });
      for (const turn of [1, 2, 3]) {
        const turnId = `turn-${turn}`;
        yield* project(message({ threadId, messageId: `user-${turn}`, role: "user", turnId, at }));
        yield* project(checkpoint({ threadId, turnId, count: turn, at }));
        yield* project(
          message({ threadId, messageId: `assistant-${turn}`, role: "assistant", turnId, at }),
        );
        yield* project({
          type: "thread.activity-appended",
          occurredAt: at,
          payload: {
            threadId,
            activity: {
              id: EventId.makeUnsafe(`activity-${turn}`),
              tone: "info",
              kind: "note",
              summary: `activity ${turn}`,
              payload: {},
              turnId: TurnId.makeUnsafe(turnId),
              createdAt: at,
            },
          },
        });
        yield* project({
          type: "thread.proposed-plan-upserted",
          occurredAt: at,
          payload: {
            threadId,
            proposedPlan: {
              id: `plan-${turn}`,
              turnId: TurnId.makeUnsafe(turnId),
              planMarkdown: `plan ${turn}`,
              implementedAt: null,
              implementationThreadId: null,
              createdAt: at,
              updatedAt: at,
            },
          },
        });
      }
      yield* project({
        type: "thread.created",
        occurredAt: at,
        payload: {
          threadId: otherThreadId,
          projectId: ProjectId.makeUnsafe("project-rollback-rows"),
          title: "Other",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: at,
          updatedAt: at,
        },
      });
      yield* project(
        message({
          threadId: otherThreadId,
          messageId: "other-user",
          role: "user",
          turnId: null,
          at,
        }),
      );
      yield* project({
        type: "thread.activity-appended",
        occurredAt: at,
        payload: {
          threadId: otherThreadId,
          activity: {
            id: EventId.makeUnsafe("activity-other"),
            tone: "info",
            kind: "note",
            summary: "other",
            payload: {},
            turnId: null,
            createdAt: at,
          },
        },
      });
      yield* project({
        type: "thread.proposed-plan-upserted",
        occurredAt: at,
        payload: {
          threadId: otherThreadId,
          proposedPlan: {
            id: "plan-other",
            turnId: null,
            planMarkdown: "other plan",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: at,
            updatedAt: at,
          },
        },
      });

      const snapshotRowIds = Effect.gen(function* () {
        const messages = yield* sql<{ readonly id: string; readonly rowId: number }>`
          SELECT message_id AS id, rowid AS "rowId" FROM projection_thread_messages
          WHERE thread_id = ${threadId} ORDER BY message_id`;
        const activities = yield* sql<{ readonly id: string; readonly rowId: number }>`
          SELECT activity_id AS id, rowid AS "rowId" FROM projection_thread_activities
          WHERE thread_id = ${threadId} ORDER BY activity_id`;
        const plans = yield* sql<{ readonly id: string; readonly rowId: number }>`
          SELECT plan_id AS id, rowid AS "rowId" FROM projection_thread_proposed_plans
          WHERE thread_id = ${threadId} ORDER BY plan_id`;
        const turns = yield* sql<{ readonly id: string; readonly rowId: number }>`
          SELECT turn_id AS id, row_id AS "rowId" FROM projection_turns
          WHERE thread_id = ${threadId} AND turn_id IS NOT NULL ORDER BY turn_id`;
        return { messages, activities, plans, turns };
      });
      const before = yield* snapshotRowIds;
      yield* project({
        type: "thread.conversation-rolled-back",
        occurredAt: at,
        payload: {
          threadId,
          messageId: MessageId.makeUnsafe("user-3"),
          numTurns: 1,
          removedTurnIds: [TurnId.makeUnsafe("turn-3")],
        },
      });
      const afterRollback = yield* snapshotRowIds;
      assert.deepStrictEqual(afterRollback, {
        messages: keepOnly(before.messages, ["assistant-1", "assistant-2", "user-1", "user-2"]),
        activities: keepOnly(before.activities, ["activity-1", "activity-2"]),
        plans: keepOnly(before.plans, ["plan-1", "plan-2"]),
        turns: keepOnly(before.turns, ["turn-1", "turn-2"]),
      });

      yield* project({
        type: "thread.reverted",
        occurredAt: at,
        payload: { threadId, turnCount: 1 },
      });
      const afterRevert = yield* snapshotRowIds;
      assert.deepStrictEqual(afterRevert, {
        messages: keepOnly(before.messages, ["assistant-1", "user-1"]),
        activities: keepOnly(before.activities, ["activity-1"]),
        plans: keepOnly(before.plans, ["plan-1"]),
        turns: keepOnly(before.turns, ["turn-1"]),
      });
      const texts = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages WHERE thread_id = ${threadId} ORDER BY message_id`;
      assert.deepStrictEqual(
        texts.map((row) => row.text),
        ["assistant-1", "user-1"],
      );
    }),
  );
});
