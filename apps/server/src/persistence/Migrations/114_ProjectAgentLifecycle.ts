import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { additiveOnlyMigration } from "./additiveOnly.ts";

import { columnExists } from "./schemaHelpers.ts";

export default additiveOnlyMigration(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    if (!(yield* columnExists(sql, "project_agent_configs", "paused_at"))) {
      yield* sql.unsafe(`
      ALTER TABLE project_agent_configs
      ADD COLUMN paused_at TEXT
    `);
    }

    if (!(yield* columnExists(sql, "project_agent_configs", "archived_at"))) {
      yield* sql.unsafe(`
      ALTER TABLE project_agent_configs
      ADD COLUMN archived_at TEXT
    `);
    }

    if (!(yield* columnExists(sql, "project_agent_configs", "paused_automation_ids"))) {
      yield* sql.unsafe(`
      ALTER TABLE project_agent_configs
      ADD COLUMN paused_automation_ids TEXT
    `);
    }
  }),
);
