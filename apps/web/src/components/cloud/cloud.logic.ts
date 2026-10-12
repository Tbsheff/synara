import {
  CLOUD_AGENTS_BETA_ONLY_MESSAGE,
  CLOUD_AGENTS_UNAVAILABLE_ERROR_CODE,
  CLOUD_TASK_TERMINAL_STATUSES,
  CODEX_CLOUD_MINIMUM_CLI_VERSION,
  type CloudCapabilities,
  type CloudDiffSummary,
  type CloudProvider,
  type CloudSubmission,
  type CloudTask,
  type CloudTaskId,
  type CloudTaskStatus,
} from "@synara/contracts";

import type { TaskStatusKind } from "../tasks/tasks.logic";

export const CLOUD_PROVIDER_LABELS: Record<CloudProvider, string> = {
  codex: "Codex",
  claude: "Claude",
};

export const CLOUD_TASK_LIST_REFRESH_MS = 60_000;
export const CLOUD_TASK_STATUS_POLL_MS = 20_000;
export const CLOUD_TASK_PAGE_SIZE = 20;

export const CLAUDE_CLOUD_START_NOTE =
  'Start a Claude cloud session in a terminal with `claude --cloud "<task>"` or at claude.ai/code, then paste its session ID or URL here.';

export type CloudEntryStatus = {
  readonly kind: TaskStatusKind;
  readonly label: string;
};

export type CloudListEntry = {
  readonly key: string;
  readonly taskId: CloudTaskId | null;
  readonly title: string;
  readonly status: CloudEntryStatus;
  readonly taskStatus: CloudTaskStatus | null;
  readonly environmentLabel: string | null;
  readonly branch: string | null;
  readonly updatedAt: string | null;
  readonly diffSummary: CloudDiffSummary | null;
  readonly attemptTotal: number | null;
  readonly url: string | null;
  readonly submission: CloudSubmission | null;
  readonly problem: string | null;
};

const TASK_STATUS_PRESENTATION: Record<CloudTaskStatus, CloudEntryStatus> = {
  pending: { kind: "running", label: "Running" },
  ready: { kind: "review", label: "Ready" },
  error: { kind: "stopped", label: "Error" },
  cancelled: { kind: "starting", label: "Cancelled" },
  unknown: { kind: "starting", label: "Unknown" },
};

export function cloudTaskStatusPresentation(status: CloudTaskStatus): CloudEntryStatus {
  return TASK_STATUS_PRESENTATION[status];
}

export function isCloudTaskTerminal(status: CloudTaskStatus | null | undefined): boolean {
  return status !== null && status !== undefined && CLOUD_TASK_TERMINAL_STATUSES.has(status);
}

function submissionStatus(submission: CloudSubmission): CloudEntryStatus {
  switch (submission.state) {
    case "submitting":
      return { kind: "starting", label: "Submitting" };
    case "uncertain":
      return { kind: "needs", label: "Uncertain" };
    case "failed":
      return { kind: "stopped", label: "Failed" };
    case "submitted":
      return submission.lastStatus
        ? cloudTaskStatusPresentation(submission.lastStatus)
        : { kind: "starting", label: "Submitted" };
  }
}

export function cloudSubmissionProblem(submission: CloudSubmission): string | null {
  if (submission.state === "uncertain") {
    return (
      submission.errorDetail ??
      "Synara could not confirm whether Codex created this task. Check Codex before you submit again."
    );
  }
  if (submission.state === "failed") return submission.errorDetail ?? "The submit failed.";
  return null;
}

function compareUpdatedDescending(left: CloudListEntry, right: CloudListEntry): number {
  if (left.updatedAt === right.updatedAt) return 0;
  if (left.updatedAt === null) return 1;
  if (right.updatedAt === null) return -1;
  return left.updatedAt < right.updatedAt ? 1 : -1;
}

function taskEntry(task: CloudTask, submission: CloudSubmission | null): CloudListEntry {
  return {
    key: `task:${task.id}`,
    taskId: task.id,
    title: task.title?.trim() || submission?.promptSummary || task.id,
    status: cloudTaskStatusPresentation(task.status),
    taskStatus: task.status,
    environmentLabel:
      task.environmentLabel ?? task.environmentId ?? submission?.environment ?? null,
    branch: submission?.branch ?? null,
    updatedAt: task.updatedAt ?? submission?.updatedAt ?? null,
    diffSummary: task.diffSummary,
    attemptTotal: task.attemptTotal,
    url: task.url ?? submission?.taskUrl ?? null,
    submission,
    problem: null,
  };
}

function submissionEntry(submission: CloudSubmission): CloudListEntry {
  return {
    key: submission.taskId ? `task:${submission.taskId}` : `submission:${submission.requestId}`,
    taskId: submission.taskId,
    title: submission.promptSummary,
    status: submissionStatus(submission),
    taskStatus: submission.lastStatus,
    environmentLabel: submission.environment,
    branch: submission.branch,
    updatedAt: submission.updatedAt,
    diffSummary: null,
    attemptTotal: null,
    url: submission.taskUrl,
    submission,
    problem: cloudSubmissionProblem(submission),
  };
}

export function mergeCloudEntries(input: {
  provider: CloudProvider;
  submissions: ReadonlyArray<CloudSubmission>;
  tasks: ReadonlyArray<CloudTask>;
}): CloudListEntry[] {
  const tasksById = new Map<string, CloudTask>();
  for (const task of input.tasks) {
    if (task.provider === input.provider && !tasksById.has(task.id)) tasksById.set(task.id, task);
  }
  const entries: CloudListEntry[] = [];
  const claimedTaskIds = new Set<string>();
  for (const submission of input.submissions) {
    if (submission.provider !== input.provider) continue;
    const task = submission.taskId ? tasksById.get(submission.taskId) : undefined;
    if (submission.taskId) {
      if (claimedTaskIds.has(submission.taskId)) continue;
      claimedTaskIds.add(submission.taskId);
    }
    entries.push(task ? taskEntry(task, submission) : submissionEntry(submission));
  }
  for (const task of tasksById.values()) {
    if (!claimedTaskIds.has(task.id)) entries.push(taskEntry(task, null));
  }
  return entries.toSorted(compareUpdatedDescending);
}

export function withLatestTask(entry: CloudListEntry, task: CloudTask | undefined): CloudListEntry {
  if (!task || task.id !== entry.taskId) return entry;
  return { ...taskEntry(task, entry.submission), key: entry.key };
}

function versionParts(version: string): number[] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareCliVersions(left: string, right: string): number | null {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export type CloudCapabilityNotice = {
  readonly title: string;
  readonly detail: string;
};

function cliName(provider: CloudProvider): string {
  return `${CLOUD_PROVIDER_LABELS[provider]} CLI`;
}

function binaryOverrideHint(provider: CloudProvider): string {
  return provider === "codex"
    ? "Update Codex or set SYNARA_CLOUD_CODEX_BIN to a newer binary."
    : "Update Claude Code or set SYNARA_CLOUD_CLAUDE_BIN to a newer binary.";
}

export function cloudCapabilityNotice(
  capabilities: CloudCapabilities,
): CloudCapabilityNotice | null {
  const cli = cliName(capabilities.provider);
  const location = capabilities.executablePath ? ` at ${capabilities.executablePath}` : "";
  const versionLabel = capabilities.cliVersion ? ` ${capabilities.cliVersion}` : "";
  const isTooOld =
    capabilities.unavailableKind === "too-old" ||
    (capabilities.provider === "codex" &&
      capabilities.cliVersion !== null &&
      compareCliVersions(capabilities.cliVersion, CODEX_CLOUD_MINIMUM_CLI_VERSION) === -1);
  if (isTooOld) {
    return {
      title: `${cli} is too old`,
      detail: `${cli}${versionLabel}${location} is too old. Cloud needs ${CODEX_CLOUD_MINIMUM_CLI_VERSION} or newer. ${binaryOverrideHint(capabilities.provider)}`,
    };
  }
  switch (capabilities.unavailableKind) {
    case "not-found":
      return {
        title: `${cli} not found`,
        detail:
          capabilities.provider === "codex"
            ? `Synara could not find the Codex CLI. Cloud needs ${CODEX_CLOUD_MINIMUM_CLI_VERSION} or newer. Install Codex or set SYNARA_CLOUD_CODEX_BIN to its path.`
            : "Synara could not find the Claude CLI. Install Claude Code or set SYNARA_CLOUD_CLAUDE_BIN to its path.",
      };
    case "unreadable-version":
      return {
        title: `${cli} version unknown`,
        detail: `Synara could not read the version of ${cli}${location}. ${binaryOverrideHint(capabilities.provider)}`,
      };
    case "missing-cloud-command":
      return {
        title: `${cli} has no cloud command`,
        detail: `${cli}${versionLabel}${location} has no cloud command. ${binaryOverrideHint(capabilities.provider)}`,
      };
    case null:
      break;
  }
  if (!capabilities.available) {
    return {
      title: `${CLOUD_PROVIDER_LABELS[capabilities.provider]} cloud is unavailable`,
      detail: capabilities.unavailableReason ?? `${cli}${location} cannot run cloud tasks.`,
    };
  }
  return null;
}

export function cloudErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    if (typeof error.message === "string" && error.message.length > 0) return error.message;
  }
  return "The request failed.";
}

export function cloudErrorMessage(error: unknown): string {
  const message = errorText(error);
  switch (cloudErrorCode(error)) {
    case CLOUD_AGENTS_UNAVAILABLE_ERROR_CODE:
      return CLOUD_AGENTS_BETA_ONLY_MESSAGE;
    case "CloudSubmitInFlightError":
      return "This submit is still running. Wait for it to finish.";
    case "CloudCliTimeoutError":
      return `${message} Try again.`;
    case "CloudTaskNotFoundError":
      return "The cloud task was not found. It may have been deleted.";
    default:
      return message;
  }
}

export function isCloudAgentsUnavailableError(error: unknown): boolean {
  return cloudErrorCode(error) === CLOUD_AGENTS_UNAVAILABLE_ERROR_CODE;
}

export type CloudNoDiffReason = "no-changes" | "not-ready" | "unavailable";

export function cloudNoDiffReason(error: unknown): CloudNoDiffReason | null {
  if (cloudErrorCode(error) !== "CloudNoDiffError") return null;
  const match = /\((no-changes|not-ready|unavailable)\)/.exec(errorText(error));
  return (match?.[1] as CloudNoDiffReason | undefined) ?? "unavailable";
}

export function cloudNoDiffLabel(reason: CloudNoDiffReason): string {
  switch (reason) {
    case "no-changes":
      return "No changes.";
    case "not-ready":
      return "The diff is not ready yet.";
    case "unavailable":
      return "The diff is unavailable.";
  }
}

export function shouldLoadCloudDiff(entry: CloudListEntry, canDiff: boolean): boolean {
  if (!canDiff || entry.taskId === null || entry.taskStatus !== "ready") return false;
  return entry.diffSummary === null || entry.diffSummary.filesChanged > 0;
}

export function cloudAttemptOptions(maxAttempts: number): number[] {
  const limit = Math.max(1, Math.min(4, maxAttempts));
  return Array.from({ length: limit }, (_, index) => index + 1);
}

export function cloudEnvironmentSuggestions(
  environments: ReadonlyArray<{ id: string | null; label: string | null }>,
): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const environment of environments) {
    for (const candidate of [environment.id, environment.label]) {
      const value = candidate?.trim();
      if (value && !seen.has(value)) {
        seen.add(value);
        values.push(value);
      }
    }
  }
  return values;
}

export function currentBranchName(
  branches: ReadonlyArray<{ name: string; current: boolean; isRemote?: boolean | undefined }>,
): string {
  return branches.find((branch) => branch.current && branch.isRemote !== true)?.name ?? "";
}
