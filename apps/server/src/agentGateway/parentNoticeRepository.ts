import {
  CommandId,
  MessageId,
  ThreadId,
  type ChildThreadNotice,
  type OrchestrationCommand,
} from "@synara/contracts";
import { renderChildThreadNotices } from "@synara/shared/threadNotice";
import { Effect, Semaphore } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export interface ParentNoticeCandidate {
  readonly parentThreadId: string;
  readonly childThreadId: string;
  readonly turnId: string | null;
  readonly messageId: string | null;
  readonly state: string;
  readonly attention: number;
  readonly sourceSequence: number;
  readonly completedAt: string | null;
}
interface NoticeRow {
  readonly parentThreadId: string;
  readonly childThreadId: string;
  readonly turnKey: string;
  readonly resultJson: string;
  readonly createdAt: string;
}

export const makeParentNoticeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const lock = yield* Semaphore.make(1);
  const setLink = (
    parentThreadId: string,
    childThreadId: string,
    messageId: string,
    enabled: boolean,
    createdAt: string,
  ) =>
    lock.withPermits(1)(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO agent_parent_notify_links (parent_thread_id, child_thread_id, first_message_id, enabled, created_at)
      VALUES (${parentThreadId}, ${childThreadId}, ${messageId}, ${enabled ? 1 : 0}, ${createdAt})
      ON CONFLICT (parent_thread_id, child_thread_id) DO UPDATE SET created_at = CASE WHEN enabled = 0 AND excluded.enabled = 1 THEN excluded.created_at ELSE created_at END, enabled = excluded.enabled`.pipe(
            Effect.asVoid,
          );
          if (!enabled)
            yield* sql`UPDATE agent_parent_notices SET state = 'acknowledged' WHERE parent_thread_id = ${parentThreadId} AND child_thread_id = ${childThreadId} AND state IN ('pending', 'delivered')`;
        }),
      ),
    );
  const isChild = (parentThreadId: string, childThreadId: string) =>
    sql`SELECT 1 FROM agent_parent_notify_links WHERE parent_thread_id = ${parentThreadId} AND child_thread_id = ${childThreadId}`.pipe(
      Effect.map((rows) => rows.length > 0),
    );
  const candidates = () =>
    sql<ParentNoticeCandidate>`
    SELECT link.parent_thread_id AS "parentThreadId", link.child_thread_id AS "childThreadId",
      t.turn_id AS "turnId", t.pending_message_id AS "messageId", t.state,
      EXISTS (SELECT 1 FROM projection_pending_interactions a
        WHERE a.thread_id = t.thread_id AND (a.turn_id = t.turn_id OR a.turn_id IS NULL)
          AND a.status IN ('pending', 'retryable', 'uncertain')) AS attention,
      COALESCE((SELECT MAX(e.sequence) FROM orchestration_events e WHERE e.stream_id = t.thread_id
        AND (json_extract(e.payload_json, '$.turnId') = t.turn_id
          OR json_extract(e.payload_json, '$.activity.turnId') = t.turn_id
          OR (t.turn_id IS NULL AND e.event_type = 'thread.session-set' AND e.occurred_at >= t.requested_at))), 0) AS "sourceSequence",
      t.completed_at AS "completedAt"
    FROM agent_parent_notify_links link JOIN projection_turns t ON t.thread_id = link.child_thread_id
    WHERE link.enabled = 1 AND (t.turn_id IS NOT NULL OR t.pending_message_id IS NOT NULL)
      AND t.requested_at >= link.created_at
      AND NOT EXISTS (SELECT 1 FROM agent_parent_notices n
        WHERE n.parent_thread_id = link.parent_thread_id AND n.child_thread_id = t.thread_id AND (n.turn_key = COALESCE(t.turn_id, t.pending_message_id) OR n.turn_key = t.pending_message_id))
      AND (t.turn_id IS NULL OR t.state IN ('completed', 'error', 'interrupted') OR EXISTS (
        SELECT 1 FROM projection_pending_interactions a WHERE a.thread_id = t.thread_id AND (a.turn_id = t.turn_id OR a.turn_id IS NULL)
          AND a.status IN ('pending', 'retryable', 'uncertain')))
    ORDER BY t.requested_at, link.child_thread_id`.pipe(Effect.map((rows) => rows));
  const save = (candidate: ParentNoticeCandidate, result: ChildThreadNotice, createdAt: string) =>
    sql`INSERT OR IGNORE INTO agent_parent_notices
      (parent_thread_id, child_thread_id, turn_key, result_json, source_sequence, state, created_at)
      SELECT ${candidate.parentThreadId}, ${candidate.childThreadId}, ${candidate.turnId ?? candidate.messageId!},
        ${JSON.stringify(result)}, ${candidate.sourceSequence},
        CASE WHEN acknowledged_sequence > 0 AND acknowledged_sequence >= ${candidate.sourceSequence} THEN 'acknowledged' ELSE 'pending' END, ${createdAt}
      FROM agent_parent_notify_links WHERE parent_thread_id = ${candidate.parentThreadId}
        AND child_thread_id = ${candidate.childThreadId} AND enabled = 1`.pipe(Effect.asVoid);
  const acknowledge = (
    parentThreadId: string,
    childThreadId: string,
    throughSequence: number,
    turnKey?: string,
  ) =>
    lock.withPermits(1)(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE agent_parent_notify_links SET acknowledged_sequence = MAX(acknowledged_sequence, ${turnKey === undefined ? throughSequence : 0})
        WHERE parent_thread_id = ${parentThreadId} AND child_thread_id = ${childThreadId}`;
          yield* sql`UPDATE agent_parent_notices SET state = 'acknowledged'
        WHERE parent_thread_id = ${parentThreadId} AND child_thread_id = ${childThreadId} AND source_sequence <= ${throughSequence} AND (${turnKey ?? null} IS NULL OR turn_key = ${turnKey ?? null})`;
          if (turnKey !== undefined)
            yield* sql`INSERT OR IGNORE INTO agent_parent_notices (parent_thread_id, child_thread_id, turn_key, source_sequence, state, created_at)
        SELECT ${parentThreadId}, ${childThreadId}, ${turnKey}, ${throughSequence}, 'acknowledged', ${new Date().toISOString()}
        FROM agent_parent_notify_links WHERE parent_thread_id = ${parentThreadId} AND child_thread_id = ${childThreadId}`;
        }),
      ),
    );
  const batchPending = () =>
    sql.withTransaction(
      Effect.gen(function* () {
        const rows =
          yield* sql<NoticeRow>`SELECT parent_thread_id AS "parentThreadId", child_thread_id AS "childThreadId",
      turn_key AS "turnKey", result_json AS "resultJson", created_at AS "createdAt"
      FROM agent_parent_notices WHERE state = 'pending' AND batch_id IS NULL AND result_json IS NOT NULL
      ORDER BY created_at, parent_thread_id, child_thread_id`;
        const parents = new Map<string, NoticeRow[]>();
        for (const row of rows)
          parents.set(row.parentThreadId, [...(parents.get(row.parentThreadId) ?? []), row]);
        for (const [parentThreadId, notices] of parents) {
          for (let offset = 0; offset < notices.length; offset += 20) {
            const chunk = notices.slice(offset, offset + 20);
            const batchId = `parent-notice:${crypto.randomUUID()}`;
            const command = {
              type: "thread.turn.start",
              commandId: CommandId.makeUnsafe(batchId),
              threadId: ThreadId.makeUnsafe(parentThreadId),
              message: {
                messageId: MessageId.makeUnsafe(batchId),
                role: "user",
                text: renderChildThreadNotices(
                  chunk.map((row) => JSON.parse(row.resultJson) as ChildThreadNotice),
                ),
                attachments: [],
              },
              runtimeMode: "approval-required",
              interactionMode: "default",
              dispatchMode: "steer",
              dispatchOrigin: "notification",
              createdAt: chunk[0]!.createdAt,
            } satisfies OrchestrationCommand;
            yield* sql`INSERT INTO agent_parent_notice_batches (batch_id, command_json) VALUES (${batchId}, ${JSON.stringify(command)})`;
            for (const row of chunk)
              yield* sql`UPDATE agent_parent_notices SET batch_id = ${batchId}
          WHERE parent_thread_id = ${parentThreadId} AND child_thread_id = ${row.childThreadId} AND turn_key = ${row.turnKey}`;
          }
        }
      }),
    );
  const batches = () =>
    sql<{
      commandJson: string;
    }>`SELECT command_json AS "commandJson" FROM agent_parent_notice_batches WHERE state = 'pending' ORDER BY rowid`.pipe(
      Effect.map((rows) =>
        rows.map(
          (row) =>
            JSON.parse(row.commandJson) as Extract<
              OrchestrationCommand,
              { type: "thread.turn.start" }
            >,
        ),
      ),
    );
  const settleBatch = (batchId: string, available: boolean) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE agent_parent_notice_batches SET state = ${available ? "delivered" : "unavailable"} WHERE batch_id = ${batchId}`;
        yield* sql`UPDATE agent_parent_notices SET state = ${available ? "delivered" : "unavailable"} WHERE batch_id = ${batchId} AND state = 'pending'`;
      }),
    );
  const deliveryText = (messageId: string) =>
    lock.withPermits(1)(
      sql.withTransaction(
        Effect.gen(function* () {
          const batch = yield* sql<{
            text: string | null;
          }>`SELECT delivery_text AS text FROM agent_parent_notice_batches WHERE batch_id = ${messageId}`;
          if (!batch[0]) return null;
          if (batch[0].text !== null) return batch[0].text || null;
          const rows = yield* sql<{
            resultJson: string;
          }>`SELECT result_json AS "resultJson" FROM agent_parent_notices
      WHERE batch_id = ${messageId} AND state NOT IN ('acknowledged', 'unavailable') ORDER BY created_at, child_thread_id`;
          const text = rows.length
            ? renderChildThreadNotices(
                rows.map((row) => JSON.parse(row.resultJson) as ChildThreadNotice),
              )
            : "";
          yield* sql`UPDATE agent_parent_notice_batches SET delivery_text = ${text} WHERE batch_id = ${messageId}`;
          return text || null;
        }),
      ),
    );
  const hasUnacknowledged = (batchId: string) =>
    sql`SELECT 1 FROM agent_parent_notices WHERE batch_id = ${batchId} AND state = 'pending' LIMIT 1`.pipe(
      Effect.map((rows) => rows.length > 0),
    );
  return {
    setLink,
    isChild,
    candidates,
    save,
    acknowledge,
    batchPending,
    batches,
    settleBatch,
    deliveryText,
    hasUnacknowledged,
    withLock: lock.withPermits(1),
  };
});
export type ParentNoticeRepository = Effect.Success<typeof makeParentNoticeRepository>;
