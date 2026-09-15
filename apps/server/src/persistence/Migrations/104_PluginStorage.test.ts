import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../NodeSqliteClient";
import PluginStorageMigration from "./104_PluginStorage";

it.layer(NodeSqliteClient.layerMemory())("plugin storage migration", (it) => {
  it.effect("creates namespaced durable storage", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* PluginStorageMigration;
      yield* sql`
        INSERT INTO plugin_storage (plugin_id, key, value_json, updated_at)
        VALUES ('plugin-a', 'items', '[]', '2026-01-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO plugin_storage (plugin_id, key, value_json, updated_at)
        VALUES ('plugin-b', 'items', '[1]', '2026-01-01T00:00:00.000Z')
      `;

      const rows = yield* sql<{ readonly pluginId: string; readonly valueJson: string }>`
        SELECT plugin_id AS "pluginId", value_json AS "valueJson"
        FROM plugin_storage ORDER BY plugin_id
      `;
      assert.deepStrictEqual(rows, [
        { pluginId: "plugin-a", valueJson: "[]" },
        { pluginId: "plugin-b", valueJson: "[1]" },
      ]);
    }),
  );
});
