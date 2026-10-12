import { assert, it } from "@effect/vitest";
import type { CloudRequestId, CloudSubmission, CloudTaskId } from "@synara/contracts";
import { Effect, Layer, Option } from "effect";

import { CloudSubmissionRepository } from "../Services/CloudSubmissionRepository";
import { CloudSubmissionRepositoryLive } from "./CloudSubmissionRepository";
import { SqlitePersistenceMemory } from "./Sqlite";

const layer = it.layer(
  CloudSubmissionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const TASK_ID = "task_e_0123456789abcdef0123456789abcdef" as CloudTaskId;

function submission(requestId: string, overrides: Partial<CloudSubmission> = {}): CloudSubmission {
  return {
    provider: "codex",
    requestId: requestId as CloudRequestId,
    projectId: "project-a",
    environment: "synara-sandbox",
    branch: "main",
    promptSummary: "Say hello",
    state: "submitting",
    taskId: null,
    taskUrl: null,
    lastStatus: null,
    errorDetail: null,
    createdAt: "2026-10-11T10:00:00.000Z",
    updatedAt: "2026-10-11T10:00:00.000Z",
    ...overrides,
  };
}

layer("CloudSubmissionRepository", (it) => {
  it.effect("stores a submit before the CLI runs and settles it in place", () =>
    Effect.gen(function* () {
      const repository = yield* CloudSubmissionRepository;
      const key = { provider: "codex" as const, requestId: "req-1" as CloudRequestId };
      yield* repository.insert(submission("req-1"));
      const pending = yield* repository.get(key);
      assert.strictEqual(Option.getOrThrow(pending).state, "submitting");

      yield* repository.update(
        submission("req-1", {
          state: "submitted",
          taskId: TASK_ID,
          taskUrl: `https://chatgpt.com/codex/tasks/${TASK_ID}`,
          lastStatus: "pending",
          updatedAt: "2026-10-11T10:00:04.000Z",
        }),
      );
      const settled = Option.getOrThrow(yield* repository.get(key));
      assert.strictEqual(settled.state, "submitted");
      assert.strictEqual(settled.taskId, TASK_ID);
      assert.strictEqual(settled.createdAt, "2026-10-11T10:00:00.000Z");

      yield* repository.recordTaskStatus({
        provider: "codex",
        taskId: TASK_ID,
        lastStatus: "ready",
        updatedAt: "2026-10-11T10:08:00.000Z",
      });
      assert.strictEqual(Option.getOrThrow(yield* repository.get(key)).lastStatus, "ready");

      yield* repository.delete(key);
      assert.isTrue(Option.isNone(yield* repository.get(key)));
    }),
  );

  it.effect("rejects a second row for the same request id", () =>
    Effect.gen(function* () {
      const repository = yield* CloudSubmissionRepository;
      yield* repository.insert(submission("req-dup"));
      const second = yield* Effect.result(repository.insert(submission("req-dup")));
      assert.strictEqual(second._tag, "Failure");
    }),
  );

  it.effect("turns leftover submitting rows into uncertain ones after a restart", () =>
    Effect.gen(function* () {
      const repository = yield* CloudSubmissionRepository;
      yield* repository.insert(submission("req-left"));
      yield* repository.insert(
        submission("req-done", { state: "submitted", taskId: TASK_ID, lastStatus: "pending" }),
      );
      yield* repository.markInterruptedSubmitsUncertain({
        updatedAt: "2026-10-11T11:00:00.000Z",
        errorDetail: "Synara restarted while the submit was running.",
      });
      const left = Option.getOrThrow(
        yield* repository.get({ provider: "codex", requestId: "req-left" as CloudRequestId }),
      );
      assert.strictEqual(left.state, "uncertain");
      assert.strictEqual(left.errorDetail, "Synara restarted while the submit was running.");
      const done = Option.getOrThrow(
        yield* repository.get({ provider: "codex", requestId: "req-done" as CloudRequestId }),
      );
      assert.strictEqual(done.state, "submitted");
    }),
  );

  it.effect("lists newest first and filters by project", () =>
    Effect.gen(function* () {
      const repository = yield* CloudSubmissionRepository;
      yield* repository.insert(
        submission("req-old", { projectId: "project-list", createdAt: "2026-10-01T00:00:00.000Z" }),
      );
      yield* repository.insert(
        submission("req-new", { projectId: "project-list", createdAt: "2026-10-02T00:00:00.000Z" }),
      );
      yield* repository.insert(
        submission("req-other", {
          projectId: "project-other",
          createdAt: "2026-10-03T00:00:00.000Z",
        }),
      );
      const listed = yield* repository.list({ projectId: "project-list", limit: 10 });
      assert.deepStrictEqual(
        listed.map((row) => row.requestId),
        ["req-new", "req-old"],
      );
      const limited = yield* repository.list({ projectId: null, limit: 1 });
      assert.strictEqual(limited.length, 1);
    }),
  );
});
