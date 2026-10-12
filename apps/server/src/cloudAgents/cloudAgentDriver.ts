import {
  CloudCliFailedError,
  CloudCliTimeoutError,
  CloudCliUnavailableError,
  CloudOperationUnsupportedError,
  type CloudAgentError,
  type CloudApplyResult,
  type CloudCapabilities,
  type CloudEnvironment,
  type CloudFollowUpReceipt,
  type CloudProvider,
  type CloudSubmitInput,
  type CloudSubmitReceipt,
  type CloudTask,
  type CloudTaskId,
  type CloudTaskPage,
  type CloudUnavailableKind,
} from "@synara/contracts";
import type { Effect } from "effect";

import type { CloudCliOutput, CloudCliSpawnError } from "./CloudCliRunner.ts";
import { capCliDetail } from "./codexCloudCli.ts";

export type CloudCapabilityFlag =
  | "canSubmit"
  | "canList"
  | "canStatus"
  | "canDiff"
  | "canApply"
  | "canFollowUp";

export interface CloudAgentsTimeouts {
  readonly probeMs: number;
  readonly readMs: number;
  readonly submitMs: number;
  readonly applyMs: number;
  readonly followUpMs: number;
}

export const DEFAULT_CLOUD_AGENTS_TIMEOUTS: CloudAgentsTimeouts = {
  probeMs: 15_000,
  readMs: 60_000,
  submitMs: 90_000,
  applyMs: 120_000,
  followUpMs: 60_000,
};

export interface CloudCliCall {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly timeoutMs: number;
  readonly cwd?: string | undefined;
  readonly stdin?: string | undefined;
}

export interface CloudDriverContext {
  readonly provider: CloudProvider;
  readonly scratchDir: string;
  readonly timeouts: CloudAgentsTimeouts;
  readonly runCli: (call: CloudCliCall) => Effect.Effect<CloudCliOutput, CloudCliSpawnError>;
  readonly requireCli: (
    flag: CloudCapabilityFlag,
    operation: string,
  ) => Effect.Effect<string, CloudAgentError>;
  readonly capabilities: Effect.Effect<CloudCapabilities>;
  readonly resolveExecutable: (command: string) => string | null;
  readonly nowIso: Effect.Effect<string>;
}

export interface CloudListTasksInput {
  readonly environment?: string | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface CloudListAllTasksInput {
  readonly environment?: string | undefined;
  readonly maxPages?: number | undefined;
}

export interface CloudTaskLookupInput {
  readonly taskId: CloudTaskId;
}

export interface CloudDiffInput extends CloudTaskLookupInput {
  readonly attempt?: number | undefined;
}

export interface CloudApplyInput extends CloudDiffInput {
  readonly worktreePath: string;
}

export interface CloudFollowUpInput {
  readonly sessionReference: string;
  readonly message: string;
}

export interface CloudAgentDriver {
  readonly provider: CloudProvider;
  readonly detectCapabilities: Effect.Effect<CloudCapabilities>;
  readonly listEnvironments: Effect.Effect<ReadonlyArray<CloudEnvironment>, CloudAgentError>;
  readonly submit: (input: CloudSubmitInput) => Effect.Effect<CloudSubmitReceipt, CloudAgentError>;
  readonly listTasks: (input: CloudListTasksInput) => Effect.Effect<CloudTaskPage, CloudAgentError>;
  readonly listAllTasks: (
    input: CloudListAllTasksInput,
  ) => Effect.Effect<ReadonlyArray<CloudTask>, CloudAgentError>;
  readonly getTask: (input: CloudTaskLookupInput) => Effect.Effect<CloudTask, CloudAgentError>;
  readonly status: (input: CloudTaskLookupInput) => Effect.Effect<CloudTask, CloudAgentError>;
  readonly diff: (input: CloudDiffInput) => Effect.Effect<string, CloudAgentError>;
  readonly apply: (input: CloudApplyInput) => Effect.Effect<CloudApplyResult, CloudAgentError>;
  readonly sendFollowUp: (
    input: CloudFollowUpInput,
  ) => Effect.Effect<CloudFollowUpReceipt, CloudAgentError>;
}

export function spawnFailure(
  provider: CloudProvider,
  operation: string,
  error: CloudCliSpawnError,
): CloudCliUnavailableError | CloudCliFailedError {
  return error.executableMissing
    ? new CloudCliUnavailableError({ provider, detail: capCliDetail(error.detail) })
    : new CloudCliFailedError({
        provider,
        operation,
        exitCode: null,
        detail: capCliDetail(error.detail),
      });
}

export function exitFailure(
  provider: CloudProvider,
  operation: string,
  timeoutMs: number,
  output: CloudCliOutput,
): CloudCliTimeoutError | CloudCliFailedError {
  return output.timedOut
    ? new CloudCliTimeoutError({ provider, operation, timeoutMs })
    : new CloudCliFailedError({
        provider,
        operation,
        exitCode: output.exitCode,
        detail: capCliDetail(output.stderr),
      });
}

export function unsupportedOperation(
  provider: CloudProvider,
  operation: string,
  reason: CloudOperationUnsupportedError["reason"],
  detail: string,
): CloudOperationUnsupportedError {
  return new CloudOperationUnsupportedError({ provider, operation, reason, detail });
}

export function unavailableCapabilities(
  provider: CloudProvider,
  executablePath: string | null,
  cliVersion: string | null,
  unavailableKind: CloudUnavailableKind,
  unavailableReason: string,
): CloudCapabilities {
  return {
    provider,
    executablePath,
    cliVersion,
    available: false,
    unavailableKind,
    unavailableReason,
    canSubmit: false,
    canList: false,
    canStatus: false,
    canDiff: false,
    canApply: false,
    canFollowUp: false,
    canCancel: false,
    canListEnvironments: false,
    maxAttempts: 0,
  };
}
