/**
 * Provider event logger helper.
 *
 * Best-effort writer for observability logs. Each record is formatted as a
 * single effect-style text line in a thread-scoped file. Failures are
 * downgraded to warnings so provider runtime behavior is unaffected.
 */
import fs from "node:fs";
import path from "node:path";

import type { ThreadId } from "@synara/contracts";
import { RotatingFileSink } from "@synara/shared/logging";
import { Clock, Effect, Fiber } from "effect";

import { stripDiagnosticImages } from "../stripDiagnosticImages.ts";
import { toSafeThreadAttachmentSegment } from "../../attachmentStore.ts";
import {
  ensurePrivateDirectorySync,
  repairPrivateFile,
  PRIVATE_FILE_MODE,
} from "../../privatePathPermissions.ts";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const DEFAULT_BATCH_WINDOW_MS = 200;
const DEFAULT_WRITER_IDLE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_OPEN_WRITERS = 64;
const RETENTION_CHECK_FRACTION = 16;
const THREAD_LOG_FILE_PATTERN = /\.log(?:\.(\d+))?$/;
const GLOBAL_THREAD_SEGMENT = "_global";
const LOG_SCOPE = "provider-observability";

export type EventNdjsonStream = "native" | "canonical" | "orchestration";

export interface EventNdjsonLogger {
  readonly filePath: string;
  write: (
    event: unknown,
    threadId: ThreadId | null,
    stream?: EventNdjsonStream,
  ) => Effect.Effect<void>;
  close: () => Effect.Effect<void>;
}

export interface EventNdjsonLoggerOptions {
  readonly stream: EventNdjsonStream;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
  readonly batchWindowMs?: number;
  readonly writerIdleMs?: number;
  readonly maxOpenWriters?: number;
}

interface ThreadWriter {
  readonly filePath: string;
  sink?: RotatingFileSink;
  pending: string[];
  lastWriteAt: number;
}

interface PendingWarning {
  readonly message: string;
  readonly context: Record<string, unknown>;
}

function logWarning(message: string, context: Record<string, unknown>): Effect.Effect<void> {
  return Effect.logWarning(message, context).pipe(Effect.annotateLogs({ scope: LOG_SCOPE }));
}

function resolveThreadSegment(raw: string | null | undefined): string {
  const normalized = typeof raw === "string" ? toSafeThreadAttachmentSegment(raw) : null;
  return normalized ?? GLOBAL_THREAD_SEGMENT;
}

function resolveStreamLabel(stream: EventNdjsonStream): string {
  switch (stream) {
    case "native":
      return "NTIVE";
    case "canonical":
    case "orchestration":
    default:
      return "CANON";
  }
}

function toLogMessage(event: unknown): Effect.Effect<string | undefined> {
  return Effect.gen(function* () {
    const serialized = yield* Effect.sync(() => {
      try {
        return { ok: true as const, value: JSON.stringify(stripDiagnosticImages(event)) };
      } catch (error) {
        return { ok: false as const, error };
      }
    });

    if (!serialized.ok) {
      yield* logWarning("failed to serialize provider event log record", {
        error: serialized.error,
      });
      return undefined;
    }

    if (typeof serialized.value !== "string") {
      return undefined;
    }

    return serialized.value;
  });
}

function backupIndex(fileName: string): number {
  const suffix = THREAD_LOG_FILE_PATTERN.exec(fileName)?.[1];
  return suffix === undefined ? 0 : Number(suffix);
}

async function enforceThreadLogBudget(directory: string, maxTotalBytes: number): Promise<unknown> {
  let firstError: unknown;
  try {
    const files: Array<{ filePath: string; name: string; size: number; mtimeMs: number }> = [];
    let totalBytes = 0;
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !THREAD_LOG_FILE_PATTERN.test(entry.name)) continue;
      const filePath = path.join(directory, entry.name);
      try {
        const stat = await fs.promises.stat(filePath);
        files.push({ filePath, name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs });
        totalBytes += stat.size;
      } catch {
        continue;
      }
    }
    if (totalBytes <= maxTotalBytes) return undefined;

    files.sort(
      (left, right) =>
        left.mtimeMs - right.mtimeMs || backupIndex(right.name) - backupIndex(left.name),
    );
    for (const file of files) {
      if (totalBytes <= maxTotalBytes) break;
      try {
        await fs.promises.rm(file.filePath, { force: true });
        totalBytes -= file.size;
      } catch (error) {
        firstError ??= error;
      }
    }
  } catch (error) {
    firstError ??= error;
  }
  return firstError;
}

export function makeEventNdjsonLogger(
  filePath: string,
  options: EventNdjsonLoggerOptions,
): Effect.Effect<EventNdjsonLogger | undefined> {
  return Effect.gen(function* () {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    const batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
    const writerIdleMs = options.writerIdleMs ?? DEFAULT_WRITER_IDLE_MS;
    const maxOpenWriters = Math.max(1, options.maxOpenWriters ?? DEFAULT_MAX_OPEN_WRITERS);
    const retentionCheckBytes = Math.max(1, Math.floor(maxTotalBytes / RETENTION_CHECK_FRACTION));
    const streamLabel = resolveStreamLabel(options.stream);
    const directory = path.dirname(filePath);

    const directoryReady = yield* Effect.sync(() => {
      try {
        ensurePrivateDirectorySync(directory);
        return true;
      } catch (error) {
        return { ok: false as const, error };
      }
    });
    if (directoryReady !== true) {
      yield* logWarning("failed to create provider event log directory", {
        filePath,
        error: directoryReady.error,
      });
      return undefined;
    }

    const writers = new Map<string, ThreadWriter>();
    let closed = false;
    let queuedBytes = 0;
    let droppedRecords = 0;
    const maxQueuedBytes = Math.min(maxTotalBytes, 8 * 1024 * 1024);
    let writeTail = Promise.resolve();
    const warnings: PendingWarning[] = [];
    let flushScheduled = false;
    let flushFiber: Fiber.Fiber<void> | undefined;
    let bytesSinceBudgetCheck = 0;

    const checkBudget = async () => {
      bytesSinceBudgetCheck = 0;
      const error = await enforceThreadLogBudget(directory, maxTotalBytes);
      if (error !== undefined) {
        warnings.push({
          message: "failed to enforce provider event log size budget",
          context: { directory, maxTotalBytes, error },
        });
      }
    };

    const flushWriter = (writer: ThreadWriter) => {
      if (writer.pending.length === 0) return;
      const lines = writer.pending;
      const bytes = lines.reduce((total, line) => total + Buffer.byteLength(line), 0);
      writer.pending = [];
      writeTail = writeTail.then(async () => {
        try {
          if (!writer.sink) {
            const handle = await fs.promises.open(
              writer.filePath,
              fs.constants.O_WRONLY |
                fs.constants.O_CREAT |
                fs.constants.O_APPEND |
                fs.constants.O_NOFOLLOW,
              PRIVATE_FILE_MODE,
            );
            await handle.close();
            await repairPrivateFile(writer.filePath);
            writer.sink = await RotatingFileSink.createAsync({
              filePath: writer.filePath,
              maxBytes,
              maxFiles,
              throwOnError: true,
              mode: PRIVATE_FILE_MODE,
              onRotationError: (error) =>
                warnings.push({
                  message: "provider event log rotation failed; truncating the current file",
                  context: { filePath: writer.filePath, maxBytes, error },
                }),
            });
          }
          bytesSinceBudgetCheck += await writer.sink.writeManyAsync(lines);
          if (bytesSinceBudgetCheck >= retentionCheckBytes) await checkBudget();
        } catch (error) {
          warnings.push({
            message: "provider event log batch flush failed",
            context: { filePath: writer.filePath, error },
          });
        } finally {
          queuedBytes -= bytes;
        }
      });
    };

    const flushAll = async (now: number) => {
      flushScheduled = false;
      for (const [segment, writer] of writers) {
        flushWriter(writer);
        if (now - writer.lastWriteAt >= writerIdleMs) writers.delete(segment);
      }
      await writeTail;
    };

    const enqueue = (segment: string, line: string, now: number): boolean => {
      const bytes = Buffer.byteLength(line);
      if (closed) return false;
      if (queuedBytes + bytes > maxQueuedBytes) {
        droppedRecords += 1;
        return false;
      }
      queuedBytes += bytes;
      let writer = writers.get(segment);
      if (writer) {
        writers.delete(segment);
      } else {
        writer = {
          filePath: path.join(directory, `${segment}.log`),
          pending: [],
          lastWriteAt: now,
        };
        for (const [evictedSegment, evicted] of writers) {
          if (writers.size < maxOpenWriters) break;
          flushWriter(evicted);
          writers.delete(evictedSegment);
        }
      }
      writers.set(segment, writer);
      writer.pending.push(line);
      writer.lastWriteAt = now;
      if (flushScheduled) return false;
      flushScheduled = true;
      return true;
    };

    const drainWarnings = Effect.suspend(() => {
      if (droppedRecords > 0) {
        warnings.push({
          message: "provider event log queue is full; records dropped",
          context: { droppedRecords, maxQueuedBytes },
        });
        droppedRecords = 0;
      }
      return warnings.length === 0
        ? Effect.void
        : Effect.forEach(
            warnings.splice(0),
            (warning) => logWarning(warning.message, warning.context),
            { discard: true },
          );
    });

    const runScheduledFlush = Effect.sleep(batchWindowMs).pipe(
      Effect.andThen(Clock.currentTimeMillis),
      Effect.flatMap((now) => Effect.promise(() => flushAll(now))),
      Effect.andThen(drainWarnings),
    );

    yield* Effect.promise(checkBudget);
    yield* drainWarnings;

    return {
      filePath,
      write(event: unknown, threadId: ThreadId | null, stream = options.stream) {
        return Effect.gen(function* () {
          const message = yield* toLogMessage(event);
          if (!message) {
            return;
          }

          const now = yield* Clock.currentTimeMillis;
          const segment = resolveThreadSegment(threadId);
          const line = `[${new Date(now).toISOString()}] ${stream === options.stream ? streamLabel : resolveStreamLabel(stream)}: ${message}\n`;
          const startFlush = yield* Effect.sync(() => enqueue(segment, line, now));
          if (startFlush) {
            const fiber = yield* Effect.forkDetach(runScheduledFlush);
            if (flushScheduled) {
              flushFiber = fiber;
            }
          }
          yield* drainWarnings;
        });
      },
      close() {
        return Effect.gen(function* () {
          closed = true;
          const fiber = flushFiber;
          flushFiber = undefined;
          if (fiber) {
            yield* Fiber.interrupt(fiber);
          }
          yield* Effect.promise(() => flushAll(Number.POSITIVE_INFINITY));
          yield* Effect.promise(checkBudget);
          yield* drainWarnings;
        });
      },
    } satisfies EventNdjsonLogger;
  });
}
