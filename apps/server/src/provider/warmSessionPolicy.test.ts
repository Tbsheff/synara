import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  resolveWarmSessionLimit,
  resolveWarmSessionIdleTimeoutMs,
  canStopIdleSessionWithDurableWork,
  selectWarmSessionEvictions,
} from "./warmSessionPolicy.ts";

const ids = ["a", "b", "c", "d"].map((id) => ThreadId.makeUnsafe(id));
const next = ThreadId.makeUnsafe("e");

describe("warm session capacity", () => {
  it("caps idle warm sessions at two even with an older saved limit", () => {
    expect(resolveWarmSessionLimit(32)).toBe(2);
    expect(resolveWarmSessionLimit(0)).toBe(0);
    expect(
      selectWarmSessionEvictions({
        idleThreadIds: ids,
        threadId: next,
        limit: 32,
        reserving: true,
      }),
    ).toEqual(ids.slice(0, 3));
  });
  it("shortens idle expiry below 10 percent free RAM or 1.5 GiB", () => {
    const gib = 1024 ** 3;
    expect(resolveWarmSessionIdleTimeoutMs(900_000, 2 * gib, 32 * gib)).toBe(60_000);
    expect(resolveWarmSessionIdleTimeoutMs(900_000, gib, 8 * gib)).toBe(60_000);
    expect(resolveWarmSessionIdleTimeoutMs(900_000, 4 * gib, 32 * gib)).toBe(900_000);
    expect(resolveWarmSessionIdleTimeoutMs(100, gib, 8 * gib)).toBe(100);
    expect(resolveWarmSessionIdleTimeoutMs(0, gib, 8 * gib)).toBe(60_000);
  });
  it("reserves a slot by evicting the least recently used idle session", () => {
    expect(
      selectWarmSessionEvictions({
        idleThreadIds: ids.slice(0, 2),
        threadId: next,
        limit: 2,
        reserving: true,
      }),
    ).toEqual([ids[0]]);
  });
  it("touches an existing idle session without taking a second slot", () => {
    expect(
      selectWarmSessionEvictions({
        idleThreadIds: ids.slice(0, 2),
        threadId: ids[0]!,
        limit: 2,
        reserving: true,
      }),
    ).toEqual([]);
  });
  it("enforces a smaller limit after turns settle", () => {
    expect(
      selectWarmSessionEvictions({
        idleThreadIds: ids,
        threadId: ids[3]!,
        limit: 2,
        reserving: false,
      }),
    ).toEqual(ids.slice(0, 2));
  });
  it("disables pre-warm at zero and retires all idle sessions", () => {
    expect(
      selectWarmSessionEvictions({ idleThreadIds: ids, threadId: next, limit: 0, reserving: true }),
    ).toBeNull();
    expect(
      selectWarmSessionEvictions({
        idleThreadIds: ids,
        threadId: next,
        limit: 0,
        reserving: false,
      }),
    ).toEqual(ids);
  });
});

it("blocks idle teardown for durable turns, approvals and queued or promoting messages", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("warm-work");
      const allowed = () => canStopIdleSessionWithDurableWork(threadId);
      expect(yield* allowed()).toBe(true);
      yield* sql`INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, checkpoint_files_json)
        VALUES (${threadId}, 'turn', 'pending', '2026-10-12T00:00:00.000Z', '[]')`;
      for (const state of ["pending", "running", "completed"] as const) {
        yield* sql`UPDATE projection_turns SET state = ${state} WHERE thread_id = ${threadId}`;
        expect(yield* allowed()).toBe(state === "completed");
      }
      yield* sql`INSERT INTO projection_pending_interactions (interaction_kind, request_id, thread_id, status, created_at)
        VALUES ('approval', 'request', ${threadId}, 'pending', '2026-10-12T00:00:00.000Z')`;
      for (const status of [
        "pending",
        "responding",
        "retryable",
        "uncertain",
        "confirmed",
      ] as const) {
        yield* sql`UPDATE projection_pending_interactions SET status = ${status} WHERE thread_id = ${threadId}`;
        expect(yield* allowed()).toBe(status === "confirmed");
      }
      const events = yield* sql<{ readonly sequence: number }>`
        INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, actor_kind, payload_json, metadata_json)
        VALUES ('warm-queue', 'thread', ${threadId}, 0, 'thread.turn-queued',
          '2026-10-12T00:00:00.000Z', 'warm-command', 'server', '{}', '{}') RETURNING sequence`;
      yield* sql`INSERT INTO queued_turn_promotions (queued_event_sequence, thread_id, message_id, dispatch_mode, state, created_at, updated_at)
        VALUES (${events[0]!.sequence}, ${threadId}, 'message', 'queue', 'queued', '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z')`;
      for (const state of ["queued", "promoting", "promoted", "cancelled"] as const) {
        yield* sql`UPDATE queued_turn_promotions SET state = ${state} WHERE thread_id = ${threadId}`;
        expect(yield* allowed()).toBe(state === "promoted" || state === "cancelled");
        expect(yield* canStopIdleSessionWithDurableWork(next)).toBe(true);
      }
    }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
  );
});
