import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { additiveOnlyMigration } from "./additiveOnly.ts";

export default additiveOnlyMigration(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE IF NOT EXISTS agent_parent_notify_links (
    parent_thread_id TEXT NOT NULL,
    child_thread_id TEXT NOT NULL,
    first_message_id TEXT NOT NULL,
    acknowledged_sequence INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    PRIMARY KEY (parent_thread_id, child_thread_id)
  )`;
    yield* sql`CREATE TABLE IF NOT EXISTS agent_parent_notices (
    parent_thread_id TEXT NOT NULL,
    child_thread_id TEXT NOT NULL,
    turn_key TEXT NOT NULL,
    result_json TEXT,
    source_sequence INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'acknowledged', 'delivered', 'unavailable')),
    batch_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (parent_thread_id, child_thread_id, turn_key)
  )`;
    yield* sql`CREATE INDEX IF NOT EXISTS idx_agent_parent_notices_pending
    ON agent_parent_notices(state, batch_id, parent_thread_id, created_at)`;
    yield* sql`CREATE TABLE IF NOT EXISTS agent_parent_notice_batches (
    batch_id TEXT PRIMARY KEY,
    command_json TEXT NOT NULL,
    delivery_text TEXT,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'unavailable'))
  )`;
  }),
);
