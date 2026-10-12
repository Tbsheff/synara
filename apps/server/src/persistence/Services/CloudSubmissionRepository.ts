import {
  CloudProvider,
  CloudRequestId,
  CloudTaskId,
  CloudTaskStatus,
  TrimmedNonEmptyString,
  type CloudSubmission,
} from "@synara/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export type CloudSubmissionRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export const CloudSubmissionKey = Schema.Struct({
  provider: CloudProvider,
  requestId: CloudRequestId,
});
export type CloudSubmissionKey = typeof CloudSubmissionKey.Type;

export const CloudSubmissionListQuery = Schema.Struct({
  projectId: Schema.NullOr(TrimmedNonEmptyString),
  limit: Schema.Int,
});
export type CloudSubmissionListQuery = typeof CloudSubmissionListQuery.Type;

export const CloudSubmissionTaskStatusUpdate = Schema.Struct({
  provider: CloudProvider,
  taskId: CloudTaskId,
  lastStatus: CloudTaskStatus,
  updatedAt: Schema.String,
});
export type CloudSubmissionTaskStatusUpdate = typeof CloudSubmissionTaskStatusUpdate.Type;

export interface CloudSubmissionRepositoryShape {
  readonly get: (
    key: CloudSubmissionKey,
  ) => Effect.Effect<Option.Option<CloudSubmission>, CloudSubmissionRepositoryError>;
  readonly insert: (
    submission: CloudSubmission,
  ) => Effect.Effect<void, CloudSubmissionRepositoryError>;
  readonly update: (
    submission: CloudSubmission,
  ) => Effect.Effect<void, CloudSubmissionRepositoryError>;
  readonly delete: (key: CloudSubmissionKey) => Effect.Effect<void, CloudSubmissionRepositoryError>;
  readonly list: (
    query: CloudSubmissionListQuery,
  ) => Effect.Effect<ReadonlyArray<CloudSubmission>, CloudSubmissionRepositoryError>;
  readonly markInterruptedSubmitsUncertain: (input: {
    readonly updatedAt: string;
    readonly errorDetail: string;
  }) => Effect.Effect<void, CloudSubmissionRepositoryError>;
  readonly recordTaskStatus: (
    update: CloudSubmissionTaskStatusUpdate,
  ) => Effect.Effect<void, CloudSubmissionRepositoryError>;
}

export class CloudSubmissionRepository extends ServiceMap.Service<
  CloudSubmissionRepository,
  CloudSubmissionRepositoryShape
>()("synara/persistence/Services/CloudSubmissionRepository/CloudSubmissionRepository") {}
