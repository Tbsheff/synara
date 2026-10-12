import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { additiveOnlyMigration } from "./additiveOnly.ts";

export default additiveOnlyMigration(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
    CREATE TABLE IF NOT EXISTS plugin_storage (
      plugin_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (plugin_id, key)
    ) WITHOUT ROWID
  `;
  }),
);
