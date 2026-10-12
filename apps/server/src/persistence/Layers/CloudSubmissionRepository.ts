import { CloudSubmission } from "@synara/contracts";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  CloudSubmissionKey,
  CloudSubmissionListQuery,
  CloudSubmissionRepository,
  type CloudSubmissionRepositoryShape,
  CloudSubmissionTaskStatusUpdate,
} from "../Services/CloudSubmissionRepository.ts";

const InterruptedSubmitSweep = Schema.Struct({
  updatedAt: Schema.String,
  errorDetail: Schema.String,
});

const makeCloudSubmissionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectColumns = sql`
    provider AS "provider",
    request_id AS "requestId",
    project_id AS "projectId",
    environment AS "environment",
    branch AS "branch",
    prompt_summary AS "promptSummary",
    state AS "state",
    task_id AS "taskId",
    task_url AS "taskUrl",
    last_status AS "lastStatus",
    error_detail AS "errorDetail",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  `;

  const getRow = SqlSchema.findOneOption({
    Request: CloudSubmissionKey,
    Result: CloudSubmission,
    execute: ({ provider, requestId }) => sql`
      SELECT ${selectColumns}
      FROM cloud_submissions
      WHERE provider = ${provider} AND request_id = ${requestId}
    `,
  });

  const listRows = SqlSchema.findAll({
    Request: CloudSubmissionListQuery,
    Result: CloudSubmission,
    execute: ({ projectId, limit }) =>
      projectId === null
        ? sql`
            SELECT ${selectColumns}
            FROM cloud_submissions
            ORDER BY created_at DESC, request_id ASC
            LIMIT ${limit}
          `
        : sql`
            SELECT ${selectColumns}
            FROM cloud_submissions
            WHERE project_id = ${projectId}
            ORDER BY created_at DESC, request_id ASC
            LIMIT ${limit}
          `,
  });

  const insertRow = SqlSchema.void({
    Request: CloudSubmission,
    execute: (row) => sql`
      INSERT INTO cloud_submissions (
        provider,
        request_id,
        project_id,
        environment,
        branch,
        prompt_summary,
        state,
        task_id,
        task_url,
        last_status,
        error_detail,
        created_at,
        updated_at
      )
      VALUES (
        ${row.provider},
        ${row.requestId},
        ${row.projectId},
        ${row.environment},
        ${row.branch},
        ${row.promptSummary},
        ${row.state},
        ${row.taskId},
        ${row.taskUrl},
        ${row.lastStatus},
        ${row.errorDetail},
        ${row.createdAt},
        ${row.updatedAt}
      )
    `,
  });

  const updateRow = SqlSchema.void({
    Request: CloudSubmission,
    execute: (row) => sql`
      UPDATE cloud_submissions
      SET
        state = ${row.state},
        task_id = ${row.taskId},
        task_url = ${row.taskUrl},
        last_status = ${row.lastStatus},
        error_detail = ${row.errorDetail},
        updated_at = ${row.updatedAt}
      WHERE provider = ${row.provider} AND request_id = ${row.requestId}
    `,
  });

  const deleteRow = SqlSchema.void({
    Request: CloudSubmissionKey,
    execute: ({ provider, requestId }) => sql`
      DELETE FROM cloud_submissions
      WHERE provider = ${provider} AND request_id = ${requestId}
    `,
  });

  const sweepRows = SqlSchema.void({
    Request: InterruptedSubmitSweep,
    execute: ({ updatedAt, errorDetail }) => sql`
      UPDATE cloud_submissions
      SET state = 'uncertain', error_detail = ${errorDetail}, updated_at = ${updatedAt}
      WHERE state = 'submitting'
    `,
  });

  const recordStatusRow = SqlSchema.void({
    Request: CloudSubmissionTaskStatusUpdate,
    execute: ({ provider, taskId, lastStatus, updatedAt }) => sql`
      UPDATE cloud_submissions
      SET last_status = ${lastStatus}, updated_at = ${updatedAt}
      WHERE provider = ${provider}
        AND task_id = ${taskId}
        AND (last_status IS NULL OR last_status <> ${lastStatus})
    `,
  });

  const mapErrors = (operation: string, encodeStage: string) =>
    Effect.mapError(
      toPersistenceSqlOrDecodeError(
        `CloudSubmissionRepository.${operation}:query`,
        `CloudSubmissionRepository.${operation}:${encodeStage}`,
      ),
    );

  return {
    get: (key) => getRow(key).pipe(mapErrors("get", "decodeRow")),
    insert: (submission) => insertRow(submission).pipe(mapErrors("insert", "encodeRequest")),
    update: (submission) => updateRow(submission).pipe(mapErrors("update", "encodeRequest")),
    delete: (key) => deleteRow(key).pipe(mapErrors("delete", "encodeRequest")),
    list: (query) => listRows(query).pipe(mapErrors("list", "decodeRows")),
    markInterruptedSubmitsUncertain: (input) =>
      sweepRows(input).pipe(mapErrors("markInterruptedSubmitsUncertain", "encodeRequest")),
    recordTaskStatus: (update) =>
      recordStatusRow(update).pipe(mapErrors("recordTaskStatus", "encodeRequest")),
  } satisfies CloudSubmissionRepositoryShape;
});

export const CloudSubmissionRepositoryLive = Layer.effect(
  CloudSubmissionRepository,
  makeCloudSubmissionRepository,
);
