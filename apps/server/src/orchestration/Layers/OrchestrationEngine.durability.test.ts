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
import { Effect, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

type AppendInput = Parameters<OrchestrationEventStoreShape["append"]>[0];
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type ThreadEvent = DistributiveOmit<
  AppendInput,
  | "eventId"
  | "commandId"
  | "correlationId"
  | "causationEventId"
  | "metadata"
  | "aggregateKind"
  | "aggregateId"
  | "occurredAt"
>;

async function createSystem(prefix: string) {
  const layer = OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(ServerSettingsService.layerTest()),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  const run = <A, E>(effect: Effect.Effect<A, E, never>) => runtime.runPromise(effect);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  const eventStore = await runtime.runPromise(Effect.service(OrchestrationEventStore));
  const pipeline = await runtime.runPromise(Effect.service(OrchestrationProjectionPipeline));
  const serverConfig = await runtime.runPromise(Effect.service(ServerConfig));
  let counter = 0;
  const projectThreadEvent = (threadId: ThreadId, at: string, event: ThreadEvent) => {
    counter += 1;
    return run(
      eventStore
        .append({
          ...event,
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: at,
          eventId: EventId.makeUnsafe(`evt-${prefix}-${counter}`),
          commandId: CommandId.makeUnsafe(`cmd-${prefix}-${counter}`),
          correlationId: CommandId.makeUnsafe(`cmd-${prefix}-${counter}`),
          causationEventId: null,
          metadata: {},
        } as AppendInput)
        .pipe(Effect.flatMap((saved) => pipeline.projectEvent(saved))),
    );
  };
  const createThread = async (projectId: ProjectId, threadId: ThreadId, at: string) => {
    await run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe(`${prefix}-project`),
        projectId,
        title: "Project",
        workspaceRoot: `/tmp/${prefix}`,
        defaultModelSelection: null,
        createdAt: at,
      }),
    );
    await run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe(`${prefix}-thread`),
        threadId,
        projectId,
        title: "Thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: at,
      }),
    );
  };
  const seedSummaryRows = async (threadId: ThreadId, at: string) => {
    await projectThreadEvent(threadId, at, {
      type: "thread.session-set",
      payload: {
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.makeUnsafe("turn-1"),
          lastError: null,
          updatedAt: at,
        },
      },
    });
    await projectThreadEvent(threadId, at, {
      type: "thread.activity-appended",
      payload: {
        threadId,
        activity: {
          id: EventId.makeUnsafe(`${prefix}-approval`),
          tone: "approval",
          kind: "approval.requested",
          summary: "Approve command",
          payload: { requestId: `${prefix}-request`, requestKind: "command" },
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: at,
        },
      },
    });
    await projectThreadEvent(threadId, at, {
      type: "thread.proposed-plan-upserted",
      payload: {
        threadId,
        proposedPlan: {
          id: `${prefix}-plan`,
          turnId: TurnId.makeUnsafe("turn-1"),
          planMarkdown: "Do the thing",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: at,
          updatedAt: at,
        },
      },
    });
  };
  const readThreadRow = (threadId: ThreadId) =>
    run(
      sql<Record<string, unknown>>`SELECT * FROM projection_threads WHERE thread_id = ${threadId}`,
    );
  const readSummary = (threadId: ThreadId) =>
    run(sql<{
      readonly latestTurnId: string | null;
      readonly pendingApprovalCount: number;
      readonly hasActionableProposedPlan: number;
    }>`
      SELECT latest_turn_id AS "latestTurnId",
        pending_approval_count AS "pendingApprovalCount",
        has_actionable_proposed_plan AS "hasActionableProposedPlan"
      FROM projection_threads WHERE thread_id = ${threadId}
    `);
  return {
    run,
    engine,
    sql,
    attachmentsDir: serverConfig.attachmentsDir,
    projectThreadEvent,
    createThread,
    seedSummaryRows,
    readThreadRow,
    readSummary,
    dispose: () => runtime.dispose(),
  };
}

const exists = (filePath: string) =>
  fs.stat(filePath).then(
    () => true,
    () => false,
  );

describe("OrchestrationEngine durability", () => {
  it("rebuilds thread summaries when repair replays thread rows", async () => {
    const system = await createSystem("synara-w1-repair-summary-");
    const threadId = ThreadId.makeUnsafe("thread-repair-summary");
    const at = new Date().toISOString();
    try {
      await system.createThread(ProjectId.makeUnsafe("project-repair-summary"), threadId, at);
      await system.seedSummaryRows(threadId, at);
      const expected = [
        { latestTurnId: "turn-1", pendingApprovalCount: 1, hasActionableProposedPlan: 1 },
      ];
      expect(await system.readSummary(threadId)).toEqual(expected);

      await system.run(system.engine.repairState());

      expect(await system.readSummary(threadId)).toEqual(expected);
    } finally {
      await system.dispose();
    }
  });

  it("restores replayed rows together with cursors when repair fails", async () => {
    const system = await createSystem("synara-w1-repair-rollback-");
    const threadId = ThreadId.makeUnsafe("thread-repair-rollback");
    const at = new Date().toISOString();
    try {
      await system.createThread(ProjectId.makeUnsafe("project-repair-rollback"), threadId, at);
      await system.seedSummaryRows(threadId, at);
      const threadBefore = await system.readThreadRow(threadId);
      const cursorsBefore = await system.run(
        system.sql`SELECT * FROM projection_state ORDER BY projector`,
      );
      const readModelBefore = await system.run(system.engine.getReadModel());
      await system.run(system.sql`
        CREATE TRIGGER fail_repair_session_replay
        BEFORE UPDATE ON projection_thread_sessions
        BEGIN
          SELECT RAISE(ABORT, 'forced-repair-failure');
        END;
      `);

      await expect(system.run(system.engine.repairState())).rejects.toThrow();

      await system.run(system.sql`DROP TRIGGER fail_repair_session_replay`);
      expect(await system.readThreadRow(threadId)).toEqual(threadBefore);
      expect(
        await system.run(system.sql`SELECT * FROM projection_state ORDER BY projector`),
      ).toEqual(cursorsBefore);
      expect(await system.run(system.engine.getReadModel())).toEqual(readModelBefore);
    } finally {
      await system.dispose();
    }
  });

  it("validates recovered user-message commands against the stored message", async () => {
    const system = await createSystem("synara-w1-recovered-steer-");
    const threadId = ThreadId.makeUnsafe("thread-recovered-steer");
    const messageId = MessageId.makeUnsafe("message-recovered-steer");
    const at = new Date().toISOString();
    try {
      await system.createThread(ProjectId.makeUnsafe("project-recovered-steer"), threadId, at);
      await system.run(
        system.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("recovered-steer-start"),
          threadId,
          message: { messageId, role: "user", text: "Steer this", attachments: [] },
          interactionMode: "default",
          runtimeMode: "full-access",
          createdAt: at,
        }),
      );
      await system.run(system.engine.refreshCommandReadModel());
      const cachedThread = (await system.run(system.engine.getReadModel())).threads.find(
        (thread) => thread.id === threadId,
      );
      expect(cachedThread?.messages.some((entry) => entry.id === messageId)).toBe(false);

      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.message.user.set-turn-boundary",
            commandId: CommandId.makeUnsafe("recovered-steer-boundary"),
            threadId,
            messageId,
            startsNewTurn: true,
            createdAt: at,
          }),
        ),
      ).resolves.toMatchObject({ sequence: expect.any(Number) });

      await system.run(system.engine.refreshCommandReadModel());
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.message.user.bind-turn",
            commandId: CommandId.makeUnsafe("recovered-steer-bind"),
            threadId,
            messageId,
            turnId: TurnId.makeUnsafe("turn-recovered-steer"),
            createdAt: at,
          }),
        ),
      ).resolves.toMatchObject({ sequence: expect.any(Number) });

      const stored = await system.run(system.sql<{
        readonly turnId: string | null;
        readonly text: string;
      }>`
        SELECT turn_id AS "turnId", text FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND message_id = ${messageId}
      `);
      expect(stored).toEqual([{ turnId: "turn-recovered-steer", text: "Steer this" }]);
    } finally {
      await system.dispose();
    }
  });

  it("deletes pruned legacy attachment files only after the command commits", async () => {
    const system = await createSystem("synara-w1-commit-prune-");
    const threadId = ThreadId.makeUnsafe("thread-commit-prune");
    const at = new Date().toISOString();
    const keepId = "thread-commit-prune-00000000-0000-4000-8000-000000000001";
    const removeId = "thread-commit-prune-00000000-0000-4000-8000-000000000002";
    try {
      await system.createThread(ProjectId.makeUnsafe("project-commit-prune"), threadId, at);
      for (const [turn, attachmentId] of [
        [1, keepId],
        [2, removeId],
      ] as const) {
        await system.projectThreadEvent(threadId, at, {
          type: "thread.turn-diff-completed",
          payload: {
            threadId,
            turnId: TurnId.makeUnsafe(`turn-${turn}`),
            checkpointTurnCount: turn,
            checkpointRef: CheckpointRef.makeUnsafe(`refs/synara/checkpoints/commit-prune/${turn}`),
            status: "ready",
            files: [],
            assistantMessageId: null,
            completedAt: at,
          },
        });
        await system.projectThreadEvent(threadId, at, {
          type: "thread.message-sent",
          payload: {
            threadId,
            messageId: MessageId.makeUnsafe(`assistant-${turn}`),
            role: "assistant",
            text: `answer ${turn}`,
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "a.png",
                mimeType: "image/png",
                sizeBytes: 1,
              },
            ],
            turnId: TurnId.makeUnsafe(`turn-${turn}`),
            streaming: false,
            createdAt: at,
            updatedAt: at,
          },
        });
      }
      await fs.mkdir(system.attachmentsDir, { recursive: true });
      const keepPath = path.join(system.attachmentsDir, `${keepId}.png`);
      const removePath = path.join(system.attachmentsDir, `${removeId}.png`);
      await fs.writeFile(keepPath, "keep");
      await fs.writeFile(removePath, "remove");

      await system.run(system.sql`
        CREATE TRIGGER fail_revert_receipt
        BEFORE INSERT ON orchestration_command_receipts
        BEGIN
          SELECT RAISE(ABORT, 'forced-receipt-failure');
        END;
      `);
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.revert.complete",
            commandId: CommandId.makeUnsafe("commit-prune-revert-failed"),
            threadId,
            turnCount: 1,
            createdAt: at,
          }),
        ),
      ).rejects.toThrow();
      expect(await exists(removePath)).toBe(true);
      const retained = await system.run(system.sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND message_id = 'assistant-2'
      `);
      expect(retained).toEqual([{ count: 1 }]);

      await system.run(system.sql`DROP TRIGGER fail_revert_receipt`);
      await system.run(
        system.engine.dispatch({
          type: "thread.revert.complete",
          commandId: CommandId.makeUnsafe("commit-prune-revert"),
          threadId,
          turnCount: 1,
          createdAt: at,
        }),
      );
      expect(await exists(removePath)).toBe(false);
      expect(await exists(keepPath)).toBe(true);
    } finally {
      await system.dispose();
    }
  });
});
