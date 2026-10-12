import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";

export const CloudProvider = Schema.Literals(["codex", "claude"]);
export type CloudProvider = typeof CloudProvider.Type;

export const CloudTaskId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/),
).pipe(Schema.brand("CloudTaskId"));
export type CloudTaskId = typeof CloudTaskId.Type;

export const CloudRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(200)).pipe(
  Schema.brand("CloudRequestId"),
);
export type CloudRequestId = typeof CloudRequestId.Type;

export const CloudEnvironmentId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/),
).pipe(Schema.brand("CloudEnvironmentId"));
export type CloudEnvironmentId = typeof CloudEnvironmentId.Type;

export const CloudTaskStatus = Schema.Literals([
  "pending",
  "ready",
  "error",
  "cancelled",
  "unknown",
]);
export type CloudTaskStatus = typeof CloudTaskStatus.Type;

export const CLOUD_TASK_TERMINAL_STATUSES: ReadonlySet<CloudTaskStatus> = new Set([
  "ready",
  "error",
  "cancelled",
]);

export const CloudDiffSummary = Schema.Struct({
  filesChanged: NonNegativeInt,
  linesAdded: NonNegativeInt,
  linesRemoved: NonNegativeInt,
});
export type CloudDiffSummary = typeof CloudDiffSummary.Type;

export const CloudEnvironmentSource = Schema.Literals(["configured", "observed"]);
export type CloudEnvironmentSource = typeof CloudEnvironmentSource.Type;

export const CloudEnvironment = Schema.Struct({
  provider: CloudProvider,
  id: Schema.NullOr(CloudEnvironmentId),
  label: Schema.NullOr(TrimmedNonEmptyString),
  source: CloudEnvironmentSource,
});
export type CloudEnvironment = typeof CloudEnvironment.Type;

export const CloudTask = Schema.Struct({
  provider: CloudProvider,
  id: CloudTaskId,
  url: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  status: CloudTaskStatus,
  rawStatus: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(IsoDateTime),
  environmentId: Schema.NullOr(CloudEnvironmentId),
  environmentLabel: Schema.NullOr(Schema.String),
  diffSummary: Schema.NullOr(CloudDiffSummary),
  attemptTotal: Schema.NullOr(NonNegativeInt),
  isReview: Schema.Boolean,
});
export type CloudTask = typeof CloudTask.Type;

export const CloudTaskPage = Schema.Struct({
  tasks: Schema.Array(CloudTask),
  cursor: Schema.NullOr(Schema.String),
});
export type CloudTaskPage = typeof CloudTaskPage.Type;

export const CloudUnavailableKind = Schema.Literals([
  "not-found",
  "unreadable-version",
  "too-old",
  "missing-cloud-command",
]);
export type CloudUnavailableKind = typeof CloudUnavailableKind.Type;

export const CloudCapabilities = Schema.Struct({
  provider: CloudProvider,
  executablePath: Schema.NullOr(Schema.String),
  cliVersion: Schema.NullOr(Schema.String),
  available: Schema.Boolean,
  unavailableKind: Schema.NullOr(CloudUnavailableKind),
  unavailableReason: Schema.NullOr(Schema.String),
  canSubmit: Schema.Boolean,
  canList: Schema.Boolean,
  canStatus: Schema.Boolean,
  canDiff: Schema.Boolean,
  canApply: Schema.Boolean,
  canFollowUp: Schema.Boolean,
  canCancel: Schema.Boolean,
  canListEnvironments: Schema.Boolean,
  maxAttempts: NonNegativeInt,
});
export type CloudCapabilities = typeof CloudCapabilities.Type;

export const CLOUD_SUBMIT_PROMPT_MAX_LENGTH = 20_000;
export const CLOUD_FOLLOW_UP_MESSAGE_MAX_LENGTH = 20_000;

export const CloudSubmitInput = Schema.Struct({
  provider: CloudProvider,
  requestId: CloudRequestId,
  environment: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(CLOUD_SUBMIT_PROMPT_MAX_LENGTH)),
  branch: TrimmedNonEmptyString,
  attempts: Schema.optional(PositiveInt),
});
export type CloudSubmitInput = typeof CloudSubmitInput.Type;

export const CloudSubmitReceipt = Schema.Struct({
  provider: CloudProvider,
  requestId: CloudRequestId,
  taskId: CloudTaskId,
  url: Schema.String,
  submittedAt: IsoDateTime,
});
export type CloudSubmitReceipt = typeof CloudSubmitReceipt.Type;

export const CloudFollowUpReceipt = Schema.Struct({
  provider: CloudProvider,
  sessionId: CloudTaskId,
  url: Schema.NullOr(Schema.String),
});
export type CloudFollowUpReceipt = typeof CloudFollowUpReceipt.Type;

export const CloudApplyOutcome = Schema.Literals(["applied", "partial", "failed"]);
export type CloudApplyOutcome = typeof CloudApplyOutcome.Type;

export const CloudApplyResult = Schema.Struct({
  provider: CloudProvider,
  taskId: CloudTaskId,
  attempt: Schema.NullOr(PositiveInt),
  worktreePath: Schema.String,
  outcome: CloudApplyOutcome,
  detail: Schema.String,
});
export type CloudApplyResult = typeof CloudApplyResult.Type;

export const CloudTaskStatusChange = Schema.Struct({
  task: CloudTask,
  previousStatus: Schema.NullOr(CloudTaskStatus),
  observedAt: IsoDateTime,
});
export type CloudTaskStatusChange = typeof CloudTaskStatusChange.Type;

export class CloudCliUnavailableError extends Schema.TaggedErrorClass<CloudCliUnavailableError>()(
  "CloudCliUnavailableError",
  {
    provider: CloudProvider,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.provider} cloud CLI is unavailable: ${this.detail}`;
  }
}

export class CloudOperationUnsupportedError extends Schema.TaggedErrorClass<CloudOperationUnsupportedError>()(
  "CloudOperationUnsupportedError",
  {
    provider: CloudProvider,
    operation: Schema.String,
    reason: Schema.Literals(["interactive-only", "no-cli-command", "capability-missing"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.provider} cloud ${this.operation} is not supported: ${this.detail}`;
  }
}

export class CloudInvalidInputError extends Schema.TaggedErrorClass<CloudInvalidInputError>()(
  "CloudInvalidInputError",
  {
    provider: CloudProvider,
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid ${this.provider} cloud ${this.operation} input: ${this.detail}`;
  }
}

export class CloudTaskNotFoundError extends Schema.TaggedErrorClass<CloudTaskNotFoundError>()(
  "CloudTaskNotFoundError",
  {
    provider: CloudProvider,
    taskId: Schema.String,
  },
) {
  override get message(): string {
    return `${this.provider} cloud task ${this.taskId} was not found.`;
  }
}

export class CloudNoDiffError extends Schema.TaggedErrorClass<CloudNoDiffError>()(
  "CloudNoDiffError",
  {
    provider: CloudProvider,
    taskId: Schema.String,
    reason: Schema.Literals(["no-changes", "not-ready", "unavailable"]),
  },
) {
  override get message(): string {
    return `${this.provider} cloud task ${this.taskId} has no diff (${this.reason}).`;
  }
}

export class CloudCliFailedError extends Schema.TaggedErrorClass<CloudCliFailedError>()(
  "CloudCliFailedError",
  {
    provider: CloudProvider,
    operation: Schema.String,
    exitCode: Schema.NullOr(Schema.Finite),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.provider} cloud ${this.operation} failed (exit ${this.exitCode ?? "null"}): ${this.detail}`;
  }
}

export class CloudCliTimeoutError extends Schema.TaggedErrorClass<CloudCliTimeoutError>()(
  "CloudCliTimeoutError",
  {
    provider: CloudProvider,
    operation: Schema.String,
    timeoutMs: Schema.Finite,
  },
) {
  override get message(): string {
    return `${this.provider} cloud ${this.operation} timed out after ${this.timeoutMs} ms.`;
  }
}

export class CloudOutputParseError extends Schema.TaggedErrorClass<CloudOutputParseError>()(
  "CloudOutputParseError",
  {
    provider: CloudProvider,
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Could not read ${this.provider} cloud ${this.operation} output: ${this.detail}`;
  }
}

export class CloudSubmitUncertainError extends Schema.TaggedErrorClass<CloudSubmitUncertainError>()(
  "CloudSubmitUncertainError",
  {
    provider: CloudProvider,
    requestId: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.provider} cloud submit ${this.requestId} has an unknown outcome: ${this.detail}`;
  }
}

export class CloudSubmitInFlightError extends Schema.TaggedErrorClass<CloudSubmitInFlightError>()(
  "CloudSubmitInFlightError",
  {
    provider: CloudProvider,
    requestId: Schema.String,
  },
) {
  override get message(): string {
    return `${this.provider} cloud submit ${this.requestId} is already in progress.`;
  }
}

export const CLOUD_AGENTS_WS_METHODS = {
  getCapabilities: "cloud.getCapabilities",
  listEnvironments: "cloud.listEnvironments",
  listTasks: "cloud.listTasks",
  getTask: "cloud.getTask",
  submit: "cloud.submit",
  listSubmissions: "cloud.listSubmissions",
  getDiff: "cloud.getDiff",
  applyToWorktree: "cloud.applyToWorktree",
  sendFollowUp: "cloud.sendFollowUp",
  watchTask: "cloud.watchTask",
} as const;

export const CODEX_CLOUD_MINIMUM_CLI_VERSION = "0.162.0";

export const CLOUD_AGENTS_UNAVAILABLE_ERROR_CODE = "CLOUD_AGENTS_UNAVAILABLE";

export const CLOUD_AGENTS_BETA_ONLY_MESSAGE = "Cloud agents are available in Synara Beta.";

export const CLOUD_DIFF_MAX_BYTES = 4 * 1024 * 1024;

export const CLOUD_PROMPT_SUMMARY_MAX_LENGTH = 280;

export const CloudProviderInput = Schema.Struct({
  provider: CloudProvider,
});
export type CloudProviderInput = typeof CloudProviderInput.Type;

export const CloudGetCapabilitiesInput = Schema.Struct({
  provider: CloudProvider,
  refresh: Schema.optional(Schema.Boolean),
});
export type CloudGetCapabilitiesInput = typeof CloudGetCapabilitiesInput.Type;

export const CloudListEnvironmentsResult = Schema.Struct({
  environments: Schema.Array(CloudEnvironment),
});
export type CloudListEnvironmentsResult = typeof CloudListEnvironmentsResult.Type;

export const CloudListTasksRpcInput = Schema.Struct({
  provider: CloudProvider,
  environment: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(20))),
  cursor: Schema.optional(TrimmedNonEmptyString),
});
export type CloudListTasksRpcInput = typeof CloudListTasksRpcInput.Type;

export const CloudTaskRefInput = Schema.Struct({
  provider: CloudProvider,
  taskId: CloudTaskId,
});
export type CloudTaskRefInput = typeof CloudTaskRefInput.Type;

export const CloudGetDiffInput = Schema.Struct({
  provider: CloudProvider,
  taskId: CloudTaskId,
  attempt: Schema.optional(PositiveInt),
});
export type CloudGetDiffInput = typeof CloudGetDiffInput.Type;

export const CloudGetDiffResult = Schema.Struct({
  provider: CloudProvider,
  taskId: CloudTaskId,
  attempt: Schema.NullOr(PositiveInt),
  patch: Schema.String,
  truncated: Schema.Boolean,
});
export type CloudGetDiffResult = typeof CloudGetDiffResult.Type;

export const CloudApplyToWorktreeInput = Schema.Struct({
  provider: CloudProvider,
  taskId: CloudTaskId,
  attempt: Schema.optional(PositiveInt),
  worktreePath: TrimmedNonEmptyString,
});
export type CloudApplyToWorktreeInput = typeof CloudApplyToWorktreeInput.Type;

export const CloudSendFollowUpInput = Schema.Struct({
  provider: CloudProvider,
  sessionReference: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(CLOUD_FOLLOW_UP_MESSAGE_MAX_LENGTH)),
});
export type CloudSendFollowUpInput = typeof CloudSendFollowUpInput.Type;

export const CloudSubmitRpcInput = Schema.Struct({
  provider: CloudProvider,
  requestId: CloudRequestId,
  environment: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(CLOUD_SUBMIT_PROMPT_MAX_LENGTH)),
  branch: TrimmedNonEmptyString,
  attempts: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(4))),
  projectId: Schema.optional(TrimmedNonEmptyString),
});
export type CloudSubmitRpcInput = typeof CloudSubmitRpcInput.Type;

export const CloudSubmissionState = Schema.Literals([
  "submitting",
  "submitted",
  "uncertain",
  "failed",
]);
export type CloudSubmissionState = typeof CloudSubmissionState.Type;

export const CloudSubmission = Schema.Struct({
  provider: CloudProvider,
  requestId: CloudRequestId,
  projectId: Schema.NullOr(Schema.String),
  environment: Schema.String,
  branch: Schema.String,
  promptSummary: Schema.String,
  state: CloudSubmissionState,
  taskId: Schema.NullOr(CloudTaskId),
  taskUrl: Schema.NullOr(Schema.String),
  lastStatus: Schema.NullOr(CloudTaskStatus),
  errorDetail: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CloudSubmission = typeof CloudSubmission.Type;

export const CloudListSubmissionsInput = Schema.Struct({
  projectId: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(500))),
});
export type CloudListSubmissionsInput = typeof CloudListSubmissionsInput.Type;

export const CloudListSubmissionsResult = Schema.Struct({
  submissions: Schema.Array(CloudSubmission),
});
export type CloudListSubmissionsResult = typeof CloudListSubmissionsResult.Type;

export const CloudWatchTaskEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("status"),
    change: CloudTaskStatusChange,
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    code: Schema.String,
    message: Schema.String,
  }),
]);
export type CloudWatchTaskEvent = typeof CloudWatchTaskEvent.Type;

export const CloudAgentError = Schema.Union([
  CloudCliUnavailableError,
  CloudOperationUnsupportedError,
  CloudInvalidInputError,
  CloudTaskNotFoundError,
  CloudNoDiffError,
  CloudCliFailedError,
  CloudCliTimeoutError,
  CloudOutputParseError,
  CloudSubmitUncertainError,
  CloudSubmitInFlightError,
]);
export type CloudAgentError = typeof CloudAgentError.Type;
