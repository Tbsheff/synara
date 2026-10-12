import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { additiveOnlyMigration } from "./additiveOnly.ts";

export default additiveOnlyMigration(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
    CREATE TABLE IF NOT EXISTS project_import_history (
      thread_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      PRIMARY KEY (thread_id, revision)
    )
  `;
  }),
);
