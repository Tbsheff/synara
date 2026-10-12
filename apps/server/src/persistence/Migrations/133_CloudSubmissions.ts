import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS cloud_submissions (
      provider TEXT NOT NULL,
      request_id TEXT NOT NULL,
      project_id TEXT,
      environment TEXT NOT NULL,
      branch TEXT NOT NULL,
      prompt_summary TEXT NOT NULL,
      state TEXT NOT NULL,
      task_id TEXT,
      task_url TEXT,
      last_status TEXT,
      error_detail TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (provider, request_id)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS cloud_submissions_task
    ON cloud_submissions (provider, task_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS cloud_submissions_created
    ON cloud_submissions (created_at)`;
});
