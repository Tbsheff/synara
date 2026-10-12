import { assert, it } from "@effect/vitest";
import {
  CloudCliFailedError,
  CloudTaskNotFoundError,
  type CloudAgentError,
  type CloudTask,
  type CloudTaskStatus,
} from "@synara/contracts";
import { Duration, Effect, Exit, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe } from "vitest";

import { decodeCloudTaskId } from "./codexCloudCli.ts";
import { pollCloudTaskStatus } from "./cloudTaskPolling.ts";
import { CODEX_TASK_ID } from "./testing/fakeCloudCli.ts";

const TASK_ID = decodeCloudTaskId(CODEX_TASK_ID);

function task(status: CloudTaskStatus): CloudTask {
  if (!TASK_ID) throw new Error("invalid test task id");
  return {
    provider: "codex",
    id: TASK_ID,
    url: null,
    title: "Say hello",
    status,
    rawStatus: status,
    updatedAt: null,
    environmentId: null,
    environmentLabel: null,
    diffSummary: null,
    attemptTotal: null,
    isReview: false,
  };
}

const transientError = () =>
  new CloudCliFailedError({ provider: "codex", operation: "list", exitCode: 1, detail: "503" });

function scriptedFetch(steps: ReadonlyArray<CloudTaskStatus | CloudAgentError>) {
  let index = 0;
  const fetch = Effect.suspend(() => {
    const step = steps[Math.min(index, steps.length - 1)]!;
    index += 1;
    return typeof step === "string" ? Effect.succeed(task(step)) : Effect.fail(step);
  });
  return { fetch, calls: () => index };
}

const advance = (millis: number) =>
  Effect.gen(function* () {
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(millis));
    yield* Effect.yieldNow;
  });

const testClock = Effect.provide(TestClock.layer());

describe("pollCloudTaskStatus", () => {
  it.effect("emits only status changes and stops at a terminal status", () =>
    Effect.gen(function* () {
      const script = scriptedFetch(["pending", "pending", "pending", "ready"]);
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(
          pollCloudTaskStatus(script.fetch, { intervalMs: 20_000, jitterRatio: 0 }),
        ),
      );
      for (let poll = 0; poll < 3; poll += 1) yield* advance(20_000);
      const changes = yield* Fiber.join(fiber);
      assert.deepStrictEqual(
        changes.map((change) => [change.previousStatus, change.task.status]),
        [
          [null, "pending"],
          ["pending", "ready"],
        ],
      );
      assert.strictEqual(script.calls(), 4);
    }).pipe(testClock),
  );

  it.effect("waits the full interval between polls", () =>
    Effect.gen(function* () {
      const script = scriptedFetch(["pending", "ready"]);
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(
          pollCloudTaskStatus(script.fetch, { intervalMs: 20_000, jitterRatio: 0 }),
        ),
      );
      yield* advance(19_999);
      assert.strictEqual(script.calls(), 1);
      yield* advance(1);
      yield* Fiber.join(fiber);
      assert.strictEqual(script.calls(), 2);
    }).pipe(testClock),
  );

  it.effect("backs off after transient errors and recovers", () =>
    Effect.gen(function* () {
      const script = scriptedFetch(["pending", transientError(), transientError(), "ready"]);
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(
          pollCloudTaskStatus(script.fetch, {
            intervalMs: 20_000,
            maxIntervalMs: 60_000,
            jitterRatio: 0,
          }),
        ),
      );
      yield* advance(20_000);
      assert.strictEqual(script.calls(), 2);
      yield* advance(39_999);
      assert.strictEqual(script.calls(), 2);
      yield* advance(1);
      assert.strictEqual(script.calls(), 3);
      yield* advance(60_000);
      const changes = yield* Fiber.join(fiber);
      assert.deepStrictEqual(
        changes.map((change) => change.task.status),
        ["pending", "ready"],
      );
    }).pipe(testClock),
  );

  it.effect("fails at once for a task that does not exist", () =>
    Effect.gen(function* () {
      const notFound = new CloudTaskNotFoundError({ provider: "codex", taskId: CODEX_TASK_ID });
      const script = scriptedFetch([notFound]);
      const exit = yield* Effect.exit(Stream.runCollect(pollCloudTaskStatus(script.fetch)));
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(script.calls(), 1);
    }).pipe(testClock),
  );

  it.effect("fails after the configured number of consecutive errors", () =>
    Effect.gen(function* () {
      const script = scriptedFetch([transientError()]);
      const fiber = yield* Effect.forkChild(
        Effect.exit(
          Stream.runCollect(
            pollCloudTaskStatus(script.fetch, {
              intervalMs: 1_000,
              maxIntervalMs: 1_000,
              maxConsecutiveErrors: 3,
              jitterRatio: 0,
            }),
          ),
        ),
      );
      yield* advance(1_000);
      yield* advance(1_000);
      const exit = yield* Fiber.join(fiber);
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(script.calls(), 3);
    }).pipe(testClock),
  );

  it.effect("keeps polling after a terminal status when asked to", () =>
    Effect.gen(function* () {
      const script = scriptedFetch(["ready", "ready", "error"]);
      const changes = yield* Effect.forkChild(
        Stream.runCollect(
          pollCloudTaskStatus(script.fetch, {
            intervalMs: 1_000,
            stopOnTerminal: false,
            jitterRatio: 0,
          }).pipe(Stream.take(2)),
        ),
      );
      yield* advance(1_000);
      yield* advance(1_000);
      const collected = yield* Fiber.join(changes);
      assert.deepStrictEqual(
        collected.map((change) => change.task.status),
        ["ready", "error"],
      );
    }).pipe(testClock),
  );
});
