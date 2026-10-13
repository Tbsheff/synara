import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { additiveOnlyMigration } from "./additiveOnly";

export default additiveOnlyMigration(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
    if (!columns.some((column) => column.name === "archived_by_thread_id")) {
      yield* sql`ALTER TABLE projection_threads ADD COLUMN archived_by_thread_id TEXT`;
    }
  }),
);
