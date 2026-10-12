import type { ChildProcess as ChildProcessHandle } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { isCommandNotFoundExit } from "@synara/shared/platformProcess";
import { spawnProcess } from "@synara/shared/processRuntime";

import {
  signalOwnedChildProcess,
  signalOwnedProcessGroup,
  stopProcessGroupWithin,
} from "./platform/processTreeController.ts";

export interface ProcessRunOptions {
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  stdin?: string | undefined;
  signal?: AbortSignal | undefined;
  allowNonZeroExit?: boolean | undefined;
  maxBufferBytes?: number | undefined;
  ownProcessGroup?: boolean | undefined;
  outputMode?: "error" | "truncate" | undefined;
  onStdoutChunk?: ((chunk: string) => void) | undefined;
  onStderrChunk?: ((chunk: string) => void) | undefined;
}

export interface ProcessRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdoutTruncated?: boolean | undefined;
  stderrTruncated?: boolean | undefined;
}

function commandLabel(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
}

function normalizeSpawnError(command: string, args: readonly string[], error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(`Failed to run ${commandLabel(command, args)}.`);
  }

  const maybeCode = (error as NodeJS.ErrnoException).code;
  if (maybeCode === "ENOENT") {
    return new Error(`Command not found: ${command}`);
  }

  return new Error(`Failed to run ${commandLabel(command, args)}: ${error.message}`);
}

function normalizeExitError(
  command: string,
  args: readonly string[],
  result: ProcessRunResult,
): Error {
  if (isCommandNotFoundExit({ code: result.code, stderr: result.stderr })) {
    return new Error(`Command not found: ${command}`);
  }

  const reason = result.timedOut
    ? "timed out"
    : `failed (code=${result.code ?? "null"}, signal=${result.signal ?? "null"})`;
  const stderr = result.stderr.trim();
  const detail = stderr.length > 0 ? ` ${stderr}` : "";
  return new Error(`${commandLabel(command, args)} ${reason}.${detail}`);
}

function normalizeStdinError(command: string, args: readonly string[], error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(`Failed to write stdin for ${commandLabel(command, args)}.`);
  }
  return new Error(`Failed to write stdin for ${commandLabel(command, args)}: ${error.message}`);
}

function normalizeBufferError(
  command: string,
  args: readonly string[],
  stream: "stdout" | "stderr",
  maxBufferBytes: number,
): Error {
  return new Error(
    `${commandLabel(command, args)} exceeded ${stream} buffer limit (${maxBufferBytes} bytes).`,
  );
}

const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const FORCE_KILL_DELAY_MS = 1_000;
const STOPPED_PIPE_CLOSE_DEADLINE_MS = 2_000;
const STOPPED_PROCESS_GROUP_EXIT_DEADLINE_MS = 2_000;

function processAbortError(): Error {
  const error = new Error("Process execution was aborted.");
  error.name = "AbortError";
  return error;
}

// The platform boundary decides whether a kill needs tree traversal (Windows
// batch shims) or Node's direct signal (POSIX); application code never invokes
// OS tree commands itself.
function killChild(
  child: ChildProcessHandle,
  signal: "SIGTERM" | "SIGKILL",
  ownsProcessGroup: boolean,
): void {
  if (ownsProcessGroup) {
    signalOwnedProcessGroup(child, signal);
    return;
  }
  signalOwnedChildProcess(child, signal);
}

function processGroupExitUnprovenError(
  command: string,
  args: readonly string[],
  processGroupId: number,
): Error {
  return new Error(
    `${commandLabel(command, args)} was stopped, but process group ${processGroupId} did not exit.`,
  );
}

function appendChunkWithinLimit(
  target: string,
  currentBytes: number,
  chunk: Buffer,
  maxBytes: number,
  decoder: StringDecoder,
): {
  next: string;
  nextBytes: number;
  truncated: boolean;
} {
  const remaining = maxBytes - currentBytes;
  if (remaining <= 0) {
    return { next: target, nextBytes: currentBytes, truncated: true };
  }
  const accepted = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  return {
    next: `${target}${decoder.write(accepted)}`,
    nextBytes: currentBytes + accepted.length,
    truncated: chunk.length > remaining,
  };
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessRunOptions = {},
): Promise<ProcessRunResult> {
  if (options.signal?.aborted) {
    throw processAbortError();
  }

  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const outputMode = options.outputMode ?? "error";
  const ownsProcessGroup = options.ownProcessGroup === true && process.platform !== "win32";

  return new Promise<ProcessRunResult>((resolve, reject) => {
    const child = spawnProcess(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
      requireExecutable: true,
      ...(options.ownProcessGroup ? { ownProcessGroup: true } : {}),
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let pipeCloseTimer: ReturnType<typeof setTimeout> | null = null;
    let stopRequested = false;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const stdoutObserverDecoder = options.onStdoutChunk ? new StringDecoder("utf8") : null;
    const stderrObserverDecoder = options.onStderrChunk ? new StringDecoder("utf8") : null;

    const kill = (signal: "SIGTERM" | "SIGKILL"): void => {
      killChild(child, signal, ownsProcessGroup);
    };

    const rootExited = (): boolean => child.exitCode !== null || child.signalCode !== null;

    const armStoppedPipeCloseDeadline = (): void => {
      if (process.platform === "win32" || !stopRequested || !rootExited() || pipeCloseTimer) {
        return;
      }
      pipeCloseTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, STOPPED_PIPE_CLOSE_DEADLINE_MS);
    };

    const stop = (): void => {
      stopRequested = true;
      kill("SIGTERM");
      if (forceKillTimer) clearTimeout(forceKillTimer);
      forceKillTimer = setTimeout(() => {
        kill("SIGKILL");
      }, FORCE_KILL_DELAY_MS);
      armStoppedPipeCloseDeadline();
    };

    const onAbort = (): void => {
      // The first terminal cause wins: a signal that arrives after the timeout fired must not
      // relabel the already-timed-out process as an explicit cancellation.
      if (settled || aborted || timedOut) return;
      aborted = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      stop();
    };

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);

    const finalize = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (pipeCloseTimer) {
        clearTimeout(pipeCloseTimer);
      }
      options.signal?.removeEventListener("abort", onAbort);
      callback();
    };

    const fail = (error: Error): void => {
      kill("SIGTERM");
      finalize(() => {
        reject(error);
      });
    };

    const appendOutput = (stream: "stdout" | "stderr", chunk: Buffer | string): Error | null => {
      if (aborted) return null;
      const chunkBuffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      const byteLength = chunkBuffer.length;
      if (stream === "stdout") {
        if (outputMode === "truncate") {
          const appended = appendChunkWithinLimit(
            stdout,
            stdoutBytes,
            chunkBuffer,
            maxBufferBytes,
            stdoutDecoder,
          );
          stdout = appended.next;
          stdoutBytes = appended.nextBytes;
          stdoutTruncated = stdoutTruncated || appended.truncated;
          return null;
        }
        stdout += stdoutDecoder.write(chunkBuffer);
        stdoutBytes += byteLength;
        if (stdoutBytes > maxBufferBytes) {
          return normalizeBufferError(command, args, "stdout", maxBufferBytes);
        }
      } else {
        if (outputMode === "truncate") {
          const appended = appendChunkWithinLimit(
            stderr,
            stderrBytes,
            chunkBuffer,
            maxBufferBytes,
            stderrDecoder,
          );
          stderr = appended.next;
          stderrBytes = appended.nextBytes;
          stderrTruncated = stderrTruncated || appended.truncated;
          return null;
        }
        stderr += stderrDecoder.write(chunkBuffer);
        stderrBytes += byteLength;
        if (stderrBytes > maxBufferBytes) {
          return normalizeBufferError(command, args, "stderr", maxBufferBytes);
        }
      }
      return null;
    };

    const notifyOutputObserver = (
      observer: ((chunk: string) => void) | undefined,
      decoder: StringDecoder | null,
      chunk: Buffer | string,
    ): void => {
      if (!observer || !decoder) return;
      try {
        const text = decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        if (text.length > 0) observer(text);
      } catch {
        // Live-output observers are best effort and must never crash the child-process lifecycle.
      }
    };

    const flushOutputObserver = (
      observer: ((chunk: string) => void) | undefined,
      decoder: StringDecoder | null,
    ): void => {
      if (!observer || !decoder) return;
      try {
        const text = decoder.end();
        if (text.length > 0) observer(text);
      } catch {
        // Live-output observers are best effort and must never crash the child-process lifecycle.
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      notifyOutputObserver(options.onStdoutChunk, stdoutObserverDecoder, chunk);
      const error = appendOutput("stdout", chunk);
      if (error) {
        fail(error);
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      notifyOutputObserver(options.onStderrChunk, stderrObserverDecoder, chunk);
      const error = appendOutput("stderr", chunk);
      if (error) {
        fail(error);
      }
    });

    child.once("error", (error) => {
      finalize(() => {
        reject(aborted ? processAbortError() : normalizeSpawnError(command, args, error));
      });
    });

    child.once("exit", armStoppedPipeCloseDeadline);

    const settleClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (!stdoutTruncated) stdout += stdoutDecoder.end();
      if (!stderrTruncated) stderr += stderrDecoder.end();
      flushOutputObserver(options.onStdoutChunk, stdoutObserverDecoder);
      flushOutputObserver(options.onStderrChunk, stderrObserverDecoder);

      const result: ProcessRunResult = {
        stdout,
        stderr,
        code,
        signal,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      };

      finalize(() => {
        if (aborted) {
          reject(processAbortError());
          return;
        }
        if (!options.allowNonZeroExit && (timedOut || (code !== null && code !== 0))) {
          reject(normalizeExitError(command, args, result));
          return;
        }
        resolve(result);
      });
    };

    child.once("close", (code, signal) => {
      if (!stopRequested || !ownsProcessGroup || child.pid === undefined) {
        settleClose(code, signal);
        return;
      }
      const processGroupId = child.pid;
      void stopProcessGroupWithin(processGroupId, {
        deadlineMs: STOPPED_PROCESS_GROUP_EXIT_DEADLINE_MS,
      }).then((stopped) => {
        if (stopped) {
          settleClose(code, signal);
          return;
        }
        finalize(() => {
          reject(processGroupExitUnprovenError(command, args, processGroupId));
        });
      });
    });

    child.stdin.once("error", (error) => {
      if (aborted) return;
      fail(normalizeStdinError(command, args, error));
    });

    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin, (error) => {
        if (aborted) return;
        if (error) {
          fail(normalizeStdinError(command, args, error));
          return;
        }
        child.stdin.end();
      });
      return;
    }
    child.stdin.end();
  });
}
