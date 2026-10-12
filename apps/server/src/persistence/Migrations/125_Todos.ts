import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { additiveOnlyMigration } from "./additiveOnly.ts";

export default additiveOnlyMigration(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE IF NOT EXISTS todos (
    todo_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'none'
      CHECK (priority IN ('none', 'low', 'medium', 'high', 'urgent')),
    project_id TEXT,
    due_date TEXT,
    thread_id TEXT,
    delegation_base_turn_id TEXT,
    linked_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
    yield* sql`CREATE INDEX IF NOT EXISTS idx_todos_created_at ON todos(created_at)`;
    yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_open_thread
    ON todos(thread_id) WHERE thread_id IS NOT NULL AND completed_at IS NULL`;
  }),
);
