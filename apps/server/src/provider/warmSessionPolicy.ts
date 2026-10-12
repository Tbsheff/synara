import type { ThreadId } from "@synara/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const WARM_SESSION_MEMORY_CHECK_MS = 15_000;
const MAX_IDLE_WARM_SESSIONS = 2;
const LOW_MEMORY_IDLE_TIMEOUT_MS = 60_000;
const MIN_FREE_MEMORY_BYTES = 1.5 * 1024 ** 3;
const MIN_FREE_MEMORY_RATIO = 0.1;

export function resolveWarmSessionLimit(limit: number): number {
  return Math.min(MAX_IDLE_WARM_SESSIONS, limit);
}

export function resolveWarmSessionIdleTimeoutMs(
  normalTimeoutMs: number,
  freeBytes: number,
  totalBytes: number,
): number {
  const lowMemory = freeBytes < Math.max(MIN_FREE_MEMORY_BYTES, totalBytes * MIN_FREE_MEMORY_RATIO);
  return lowMemory
    ? Math.min(normalTimeoutMs > 0 ? normalTimeoutMs : Infinity, LOW_MEMORY_IDLE_TIMEOUT_MS)
    : normalTimeoutMs;
}

export const canStopIdleSessionWithDurableWork = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly busy: number }>`
      SELECT (
        EXISTS (SELECT 1 FROM projection_turns
          WHERE thread_id = ${threadId} AND state IN ('pending', 'running'))
        OR EXISTS (SELECT 1 FROM projection_pending_interactions
          WHERE thread_id = ${threadId} AND status != 'confirmed')
        OR EXISTS (SELECT 1 FROM queued_turn_promotions
          WHERE thread_id = ${threadId} AND state IN ('queued', 'promoting'))
      ) AS busy
    `;
    return rows[0]?.busy === 0;
  });

export function selectWarmSessionEvictions(input: {
  readonly idleThreadIds: ReadonlyArray<ThreadId>;
  readonly threadId: ThreadId;
  readonly limit: number;
  readonly reserving: boolean;
}): ReadonlyArray<ThreadId> | null {
  const limit = resolveWarmSessionLimit(input.limit);
  if (limit <= 0 && input.reserving) return null;
  const others = input.reserving
    ? input.idleThreadIds.filter((id) => id !== input.threadId)
    : input.idleThreadIds;
  const required = Math.max(0, others.length + (input.reserving ? 1 : 0) - limit);
  return others.slice(0, required);
}
