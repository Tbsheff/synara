import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SERVER_DESKTOP_FLAVOR } from "../betaFeatureGate";

const ACTIVATION_KEY = "stable-hubs-activation-v1";

export const prepareStableHubs = (flavor = SERVER_DESKTOP_FLAVOR) =>
  Effect.gen(function* () {
    if (flavor !== "production") return;
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const marker = yield* sql`
          SELECT setting_key FROM automation_settings WHERE setting_key = ${ACTIVATION_KEY}
        `;
        if (marker.length > 0) return;
        const now = new Date().toISOString();
        const configs = yield* sql<{ readonly project_id: string }>`
          SELECT project_id FROM project_agent_configs
          WHERE paused_at IS NULL AND archived_at IS NULL
        `;
        for (const config of configs) {
          const definitions = yield* sql<{ readonly automation_id: string }>`
            SELECT automation_id FROM automation_definitions
            WHERE project_id = ${config.project_id} AND enabled = 1 AND archived_at IS NULL
          `;
          yield* sql`
            UPDATE project_agent_configs
            SET paused_at = ${now}, paused_automation_ids = ${JSON.stringify(definitions.map((definition) => definition.automation_id))},
                revision = revision + 1, updated_at = ${now}
            WHERE project_id = ${config.project_id}
          `;
          yield* sql`
            UPDATE automation_definitions
            SET completion_policy_version = completion_policy_version + 1,
                completion_policy_updated_at = ${now}, updated_at = ${now}
            WHERE project_id = ${config.project_id} AND archived_at IS NULL
          `;
          yield* sql`
            UPDATE automation_definitions
            SET enabled = 0, next_run_at = NULL, disabled_reason = 'user', disabled_at = ${now}, updated_at = ${now}
            WHERE project_id = ${config.project_id} AND enabled = 1 AND archived_at IS NULL
          `;
          yield* sql`
            UPDATE automation_runs
            SET status = 'cancelled', finished_at = ${now}, deferred_until = NULL,
                error = 'Saved Hub paused on first Stable launch. Resume the Hub to start fresh work.',
                updated_at = ${now}
            WHERE project_id = ${config.project_id} AND status IN ('pending', 'deferred')
          `;
          yield* sql`
            INSERT INTO project_agent_activity
              (activity_id, project_id, sequence, kind, actor_kind, summary, created_at)
            SELECT ${`${ACTIVATION_KEY}:${config.project_id}`}, ${config.project_id},
              COALESCE(MAX(sequence), 0) + 1, 'config-updated', 'system',
              'Saved Hub paused on first Stable launch. Review its state, then select Resume.', ${now}
            FROM project_agent_activity WHERE project_id = ${config.project_id}
          `;
        }
        yield* sql`
          INSERT INTO automation_settings (setting_key, setting_value, updated_at)
          VALUES (${ACTIVATION_KEY}, 'complete', ${now})
        `;
      }),
    );
  });
