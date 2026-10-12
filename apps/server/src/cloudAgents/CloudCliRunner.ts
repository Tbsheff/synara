import { ExecutableNotFoundError } from "@synara/shared/platformProcess";
import { Effect, Layer, Schema, ServiceMap } from "effect";

import { runProcess } from "../processRunner.ts";

export interface CloudCliInvocation {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly stdin?: string | undefined;
  readonly maxOutputBytes?: number | undefined;
}

export interface CloudCliOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

export class CloudCliSpawnError extends Schema.TaggedErrorClass<CloudCliSpawnError>()(
  "CloudCliSpawnError",
  {
    executable: Schema.String,
    executableMissing: Schema.Boolean,
    detail: Schema.String,
  },
) {}

export interface CloudCliRunnerShape {
  readonly run: (
    invocation: CloudCliInvocation,
  ) => Effect.Effect<CloudCliOutput, CloudCliSpawnError>;
}

export class CloudCliRunner extends ServiceMap.Service<CloudCliRunner, CloudCliRunnerShape>()(
  "synara/cloudAgents/CloudCliRunner",
) {}

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const COMMAND_NOT_FOUND_PREFIX = "Command not found:";

const EXECUTABLE_MISSING_DETAIL = "executable not found";
const PROCESS_ABORTED_DETAIL = "process was aborted";
const PROCESS_FAILED_DETAIL = "process failed to start or its output could not be read";

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function toCloudCliSpawnError(executable: string, error: unknown): CloudCliSpawnError {
  const message = error instanceof Error ? error.message : "";
  const executableMissing =
    error instanceof ExecutableNotFoundError || message.startsWith(COMMAND_NOT_FOUND_PREFIX);
  const detail = executableMissing
    ? EXECUTABLE_MISSING_DETAIL
    : isAbortError(error)
      ? PROCESS_ABORTED_DETAIL
      : PROCESS_FAILED_DETAIL;
  return new CloudCliSpawnError({ executable, executableMissing, detail });
}

export const runCloudCliProcess: CloudCliRunnerShape["run"] = (invocation) =>
  Effect.tryPromise({
    try: (signal) =>
      runProcess(invocation.executable, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        timeoutMs: invocation.timeoutMs,
        signal,
        allowNonZeroExit: true,
        maxBufferBytes: invocation.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        ...(invocation.stdin !== undefined ? { stdin: invocation.stdin } : {}),
      }),
    catch: (error) => toCloudCliSpawnError(invocation.executable, error),
  }).pipe(
    Effect.map(
      (result): CloudCliOutput => ({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.code,
        timedOut: result.timedOut,
      }),
    ),
  );

export const CloudCliRunnerLive = Layer.succeed(CloudCliRunner, { run: runCloudCliProcess });
