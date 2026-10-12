import { DatabaseSync } from "node:sqlite";

import { ThreadId } from "@synara/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it, vi } from "vitest";

import { OrchestrationEventStoreLive } from "../Layers/OrchestrationEventStore.ts";
import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { isAdditiveOnlyMigration } from "./additiveOnly.ts";

it("uses the title index for the real repository query and preserves title versions on upgrade", async () => {
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* OrchestrationEventStore;
        const threadId = ThreadId.makeUnsafe("title-index-test");
        yield* runMigrations({ toMigrationInclusive: 135 });
        const changes = [
          ["thread.created", {}, 1],
          ["thread.assistant-message-delta", { delta: "body" }, 1],
          ["thread.meta-updated", { title: null }, 1],
          ["thread.meta-updated", { title: 123 }, 1],
          ["thread.meta-updated", { title: "Generated title" }, 5],
          ["thread.meta-updated", { model: "other" }, 5],
          ["thread.meta-updated", { title: "Regenerated title" }, 7],
          ["thread.archived", {}, 8],
          ["thread.deleted", {}, 9],
        ] as const;
        for (const [index, [eventType, payload, expected]] of changes.entries()) {
          yield* sql`
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type,
              occurred_at, actor_kind, payload_json, metadata_json
            ) VALUES (${`title-${index}`}, 'thread', ${threadId}, ${index + 1}, ${eventType},
              '2026-10-12', 'server', ${JSON.stringify(payload)}, '{}')
          `;
          expect(yield* store.getThreadTitleHighWaterSequence(threadId)).toBe(expected);
        }
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, actor_kind, payload_json, metadata_json
          ) VALUES ('other-title', 'thread', 'other-thread', 1, 'thread.created',
            '2026-10-12', 'server', '{}', '{}')
        `;
        const rowsBefore = yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`;
        const query = prepare.mock.calls.find(
          ([query]) =>
            query.includes('AS "highWaterSequence"') &&
            query.includes("json_type(payload_json, '$.title')"),
        )?.[0];
        expect(query).toBeDefined();
        const beforePlan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query!}`, [
          threadId,
        ]);
        expect(
          beforePlan.some((row) => row.detail.includes("idx_orch_events_thread_title_sequence")),
        ).toBe(false);
        yield* runMigrations();
        const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query!}`, [
          threadId,
        ]);
        expect(
          plan.some((row) => row.detail.includes("idx_orch_events_thread_title_sequence")),
        ).toBe(true);
        expect(yield* store.getThreadTitleHighWaterSequence(threadId)).toBe(9);
        expect(yield* store.getThreadTitleHighWaterSequence(ThreadId.makeUnsafe("missing"))).toBe(
          0,
        );
        expect(yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`).toEqual(
          rowsBefore,
        );
        const migration = migrationEntries.find(([id]) => id === 136);
        expect(migration).toBeDefined();
        expect(isAdditiveOnlyMigration(migration![2])).toBe(true);
        yield* migration![2];
        expect(yield* runMigrations()).toEqual([]);
        expect(yield* store.getThreadTitleHighWaterSequence(threadId)).toBe(9);
      }).pipe(
        Effect.provide(
          OrchestrationEventStoreLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
        ),
      ),
    );
  } finally {
    prepare.mockRestore();
  }
});

it("creates the title index on a fresh database", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const indexes = yield* sql<{ name: string }>`PRAGMA index_list(orchestration_events)`;
      expect(indexes.map((row) => row.name)).toContain("idx_orch_events_thread_title_sequence");
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
