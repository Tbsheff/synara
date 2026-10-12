import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { isAdditiveOnlyMigration } from "./additiveOnly.ts";

it.effect("drops only the receipt sequence index on upgrade and tolerates replay", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 134 });
    yield* sql`
      INSERT INTO orchestration_command_receipts (
        command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence,
        status, error, fingerprint_version, command_fingerprint
      ) VALUES ('receipt-index-test', 'thread', 'test-thread', '2026-10-12', 42,
        'accepted', NULL, 1, ${"a".repeat(64)})
    `;
    const before = yield* sql`SELECT * FROM orchestration_command_receipts`;
    const oldIndexes = yield* sql<{
      name: string;
    }>`PRAGMA index_list(orchestration_command_receipts)`;
    assert.include(
      oldIndexes.map((row) => row.name),
      "idx_orch_command_receipts_sequence",
    );
    yield* runMigrations();
    const indexes = yield* sql<{ name: string }>`PRAGMA index_list(orchestration_command_receipts)`;
    assert.notInclude(
      indexes.map((row) => row.name),
      "idx_orch_command_receipts_sequence",
    );
    assert.include(
      indexes.map((row) => row.name),
      "idx_orch_command_receipts_aggregate",
    );
    assert.include(
      indexes.map((row) => row.name),
      "sqlite_autoindex_orchestration_command_receipts_1",
    );
    const migration = migrationEntries.find(([id]) => id === 135);
    assert.isDefined(migration);
    assert.isFalse(isAdditiveOnlyMigration(migration![2]));
    yield* migration![2];
    assert.deepStrictEqual(yield* sql`SELECT * FROM orchestration_command_receipts`, before);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("omits the receipt sequence index on a fresh database", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    const indexes = yield* sql<{ name: string }>`PRAGMA index_list(orchestration_command_receipts)`;
    assert.notInclude(
      indexes.map((row) => row.name),
      "idx_orch_command_receipts_sequence",
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
