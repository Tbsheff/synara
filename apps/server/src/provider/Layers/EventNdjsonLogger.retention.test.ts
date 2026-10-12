import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ThreadId } from "@synara/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { vi } from "vitest";

import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const THREAD_LOG_PATTERN = /\.log(?:\.\d+)?$/;

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function threadLogBytes(dir: string): number {
  return fs
    .readdirSync(dir)
    .filter((entry) => THREAD_LOG_PATTERN.test(entry))
    .reduce((total, entry) => total + fs.statSync(path.join(dir, entry)).size, 0);
}

async function waitForLines(filePath: string, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(filePath) && readLines(filePath).length === count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function readLines(filePath: string): string[] {
  return fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
}

describe("EventNdjsonLogger batching and retention", () => {
  it.effect("writes each flushed batch with one append per thread file", () =>
    Effect.gen(function* () {
      const tempDir = makeTempDir("synara-provider-log-batch-");
      const appendSpy = vi.spyOn(fs.promises, "appendFile");
      try {
        const logger = yield* makeEventNdjsonLogger(path.join(tempDir, "events.log"), {
          stream: "native",
        });
        assert.isDefined(logger);
        if (!logger) return;

        for (let index = 0; index < 100; index += 1) {
          yield* logger.write({ id: `a-${index}` }, ThreadId.makeUnsafe("thread-a"));
        }
        for (let index = 0; index < 50; index += 1) {
          yield* logger.write({ id: `b-${index}` }, ThreadId.makeUnsafe("thread-b"));
        }
        yield* logger.close();

        const appendedBytes = appendSpy.mock.calls.reduce((total, call) => {
          const data = call[1];
          return (
            total + (typeof data === "string" ? Buffer.byteLength(data) : (data as Buffer).length)
          );
        }, 0);
        assert.equal(appendSpy.mock.calls.length, 2);
        assert.equal(readLines(path.join(tempDir, "thread-a.log")).length, 100);
        assert.equal(readLines(path.join(tempDir, "thread-b.log")).length, 50);
        assert.equal(appendedBytes, threadLogBytes(tempDir));
      } finally {
        appendSpy.mockRestore();
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("flushes buffered events after the batch window without close", () =>
    Effect.gen(function* () {
      const tempDir = makeTempDir("synara-provider-log-window-");
      try {
        const logger = yield* makeEventNdjsonLogger(path.join(tempDir, "events.log"), {
          stream: "native",
          batchWindowMs: 200,
        });
        assert.isDefined(logger);
        if (!logger) return;

        yield* logger.write({ id: "evt-1" }, ThreadId.makeUnsafe("thread-window"));
        yield* TestClock.adjust("250 millis");

        yield* Effect.promise(() => waitForLines(path.join(tempDir, "thread-window.log"), 1));
        assert.equal(readLines(path.join(tempDir, "thread-window.log")).length, 1);
        yield* logger.close();
        assert.equal(readLines(path.join(tempDir, "thread-window.log")).length, 1);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("deletes the oldest thread log files to stay within the total byte budget", () =>
    Effect.gen(function* () {
      const tempDir = makeTempDir("synara-provider-log-budget-");
      try {
        const oldTime = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
        const olderTime = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
        const seed = [
          { name: "stale-thread.log.1", time: olderTime },
          { name: "stale-thread.log", time: oldTime },
          { name: "other-thread.log", time: oldTime },
        ];
        for (const file of seed) {
          const filePath = path.join(tempDir, file.name);
          fs.writeFileSync(filePath, "x".repeat(3000));
          fs.utimesSync(filePath, file.time, file.time);
        }
        fs.writeFileSync(path.join(tempDir, "notes.txt"), "y".repeat(10_000));

        const logger = yield* makeEventNdjsonLogger(path.join(tempDir, "events.log"), {
          stream: "native",
          maxBytes: 2000,
          maxFiles: 3,
          maxTotalBytes: 8000,
        });
        assert.isDefined(logger);
        if (!logger) return;

        for (let index = 0; index < 60; index += 1) {
          yield* logger.write(
            { id: `evt-${index}`, payload: "z".repeat(60) },
            ThreadId.makeUnsafe("fresh-thread"),
          );
        }
        yield* logger.close();

        assert.isAtMost(threadLogBytes(tempDir), 8000);
        assert.equal(fs.existsSync(path.join(tempDir, "stale-thread.log.1")), false);
        assert.equal(fs.existsSync(path.join(tempDir, "fresh-thread.log")), true);
        assert.equal(fs.statSync(path.join(tempDir, "notes.txt")).size, 10_000);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("flushes buffered events when the least recently used writer is evicted", () =>
    Effect.gen(function* () {
      const tempDir = makeTempDir("synara-provider-log-evict-");
      try {
        const logger = yield* makeEventNdjsonLogger(path.join(tempDir, "events.log"), {
          stream: "native",
          maxOpenWriters: 2,
        });
        assert.isDefined(logger);
        if (!logger) return;

        yield* logger.write({ id: "a-1" }, ThreadId.makeUnsafe("thread-a"));
        yield* logger.write({ id: "b-1" }, ThreadId.makeUnsafe("thread-b"));
        yield* logger.write({ id: "c-1" }, ThreadId.makeUnsafe("thread-c"));

        yield* Effect.promise(() => waitForLines(path.join(tempDir, "thread-a.log"), 1));
        assert.equal(readLines(path.join(tempDir, "thread-a.log")).length, 1);

        yield* logger.write({ id: "a-2" }, ThreadId.makeUnsafe("thread-a"));
        yield* logger.close();

        assert.equal(readLines(path.join(tempDir, "thread-a.log")).length, 2);
        assert.equal(readLines(path.join(tempDir, "thread-b.log")).length, 1);
        assert.equal(readLines(path.join(tempDir, "thread-c.log")).length, 1);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});
