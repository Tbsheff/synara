import { mkdir } from "node:fs/promises";
import nodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  CloudRequestId,
  CloudSubmission,
  CloudSubmitRpcInput,
  CloudTaskId,
  CloudWatchTaskEvent,
} from "@synara/contracts";
import { Effect, Layer, Option, Result, Stream } from "effect";
import { describe } from "vitest";

import { ServerConfig } from "../config.ts";
import { CloudSubmissionRepositoryLive } from "../persistence/Layers/CloudSubmissionRepository.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CloudSubmissionRepository } from "../persistence/Services/CloudSubmissionRepository.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  CLOUD_SUBMIT_RESTART_DETAIL,
  CloudAgentsGateway,
  capCloudPatch,
  isPathInsideDirectory,
  makeCloudAgentsGatewayLayer,
  summarizeCloudPrompt,
} from "./CloudAgentsGateway.ts";
import { CloudCliRunner } from "./CloudCliRunner.ts";
import {
  CLAUDE_PROBE_ROUTES,
  CODEX_ENV_ID,
  CODEX_EXEC_STDOUT,
  CODEX_NOT_FOUND_STDERR,
  CODEX_PROBE_ROUTES,
  CODEX_SAMPLE_PATCH,
  CODEX_TASK_ID,
  argsStartWith,
  codexListJson,
  makeFakeCloudCli,
  route,
  type FakeCloudCli,
  type FakeCloudCliRoute,
} from "./testing/fakeCloudCli.ts";

const TASK = CODEX_TASK_ID as CloudTaskId;

function forExecutable(executable: string, routes: ReadonlyArray<FakeCloudCliRoute>) {
  return routes.map((entry) => ({
    ...entry,
    match: (invocation: Parameters<FakeCloudCliRoute["match"]>[0]) =>
      invocation.executable === executable && entry.match(invocation),
  }));
}

const codex = (match: FakeCloudCliRoute["match"], ...responses: Parameters<typeof route>[1][]) =>
  forExecutable("/fake/bin/codex", [route(match, ...responses)])[0]!;

const git = (match: FakeCloudCliRoute["match"], ...responses: Parameters<typeof route>[1][]) =>
  forExecutable("/fake/bin/git", [route(match, ...responses)])[0]!;

function fakeResolve(command: string): string | null {
  if (command.startsWith("/fake/")) return command;
  return command.includes("/") ? null : `/fake/bin/${command}`;
}

const gatewayOptions = {
  baseEnv: { PATH: "/usr/bin", HOME: "/home/test" },
  platform: "linux" as const,
  homeDir: "/home/test",
  resolveExecutable: fakeResolve,
};

function makeHarness(
  routes: ReadonlyArray<FakeCloudCliRoute>,
  beforeGateway: (
    repository: typeof CloudSubmissionRepository.Service,
  ) => Effect.Effect<void> = () => Effect.void,
) {
  const fake = makeFakeCloudCli([
    ...forExecutable("/fake/bin/codex", CODEX_PROBE_ROUTES),
    ...forExecutable("/fake/bin/claude", CLAUDE_PROBE_ROUTES),
    ...routes,
  ]);
  const dependencies = CloudSubmissionRepositoryLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(Layer.succeed(CloudCliRunner, fake.runner)),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "synara-cloud-gateway-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  const seeded = Layer.effectDiscard(
    Effect.gen(function* () {
      const repository = yield* CloudSubmissionRepository;
      yield* beforeGateway(repository);
    }),
  ).pipe(Layer.provideMerge(dependencies));
  const layer = makeCloudAgentsGatewayLayer(gatewayOptions).pipe(Layer.provideMerge(seeded));
  return { fake, layer };
}

const submitInput = (overrides: Partial<CloudSubmitRpcInput> = {}): CloudSubmitRpcInput =>
  ({
    provider: "codex",
    requestId: "req-1",
    environment: CODEX_ENV_ID,
    prompt: "Add a hello world script\n\nKeep it short.",
    branch: "main",
    projectId: "project-a",
    ...overrides,
  }) as CloudSubmitRpcInput;

const execCalls = (fake: FakeCloudCli) =>
  fake.callsMatching(
    (invocation) =>
      invocation.args[0] === "cloud" &&
      invocation.args[1] === "exec" &&
      !invocation.args.includes("--help"),
  );

describe("CloudAgentsGateway", () => {
  it.effect(
    "persists a submit and replays it for the same request id without a second exec",
    () => {
      const { fake, layer } = makeHarness([
        codex(argsStartWith("cloud", "exec"), { stdout: CODEX_EXEC_STDOUT }),
      ]);
      return Effect.gen(function* () {
        const gateway = yield* CloudAgentsGateway;
        const first = yield* gateway.submit(submitInput());
        assert.strictEqual(first.state, "submitted");
        assert.strictEqual(first.taskId, TASK);
        assert.strictEqual(first.promptSummary, "Add a hello world script Keep it short.");
        assert.strictEqual(first.projectId, "project-a");

        const replay = yield* gateway.submit(submitInput());
        assert.deepStrictEqual(replay, first);
        assert.strictEqual(execCalls(fake).length, 1);

        const listed = yield* gateway.listSubmissions({});
        assert.deepStrictEqual(
          listed.submissions.map((row) => row.requestId),
          ["req-1"],
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("joins concurrent submits with the same request id into one exec", () => {
    const { fake, layer } = makeHarness([
      codex(argsStartWith("cloud", "exec"), { stdout: CODEX_EXEC_STDOUT }),
    ]);
    return Effect.gen(function* () {
      const gateway = yield* CloudAgentsGateway;
      const input = submitInput({ requestId: "req-race" as CloudRequestId });
      const [left, right] = yield* Effect.all([gateway.submit(input), gateway.submit(input)], {
        concurrency: "unbounded",
      });
      assert.deepStrictEqual(left, right);
      assert.strictEqual(execCalls(fake).length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("records a CLI failure as failed and never runs exec again for that id", () => {
    const { fake, layer } = makeHarness([
      codex(argsStartWith("cloud", "exec"), {
        stderr: "Error: environment not found",
        exitCode: 1,
      }),
    ]);
    return Effect.gen(function* () {
      const gateway = yield* CloudAgentsGateway;
      const first = yield* gateway.submit(submitInput({ requestId: "req-fail" as CloudRequestId }));
      assert.strictEqual(first.state, "failed");
      assert.include(first.errorDetail ?? "", "environment not found");
      const again = yield* gateway.submit(submitInput({ requestId: "req-fail" as CloudRequestId }));
      assert.strictEqual(again.state, "failed");
      assert.strictEqual(execCalls(fake).length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("drops the row on a preflight refusal so the same id can be retried", () => {
    const { layer } = makeHarness([]);
    return Effect.gen(function* () {
      const gateway = yield* CloudAgentsGateway;
      const repository = yield* CloudSubmissionRepository;
      const result = yield* Effect.result(
        gateway.submit(
          submitInput({ provider: "claude", requestId: "req-claude" as CloudRequestId }),
        ),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "CloudOperationUnsupportedError");
      }
      const row = yield* repository.get({
        provider: "claude",
        requestId: "req-claude" as CloudRequestId,
      });
      assert.isTrue(Option.isNone(row));
    }).pipe(Effect.provide(layer));
  });

  it.effect("turns a submit left running by a restart into uncertain and does not rerun it", () => {
    const leftover: CloudSubmission = {
      provider: "codex",
      requestId: "req-left" as CloudRequestId,
      projectId: null,
      environment: CODEX_ENV_ID,
      branch: "main",
      promptSummary: "Say hello",
      state: "submitting",
      taskId: null,
      taskUrl: null,
      lastStatus: null,
      errorDetail: null,
      createdAt: "2026-10-11T10:00:00.000Z",
      updatedAt: "2026-10-11T10:00:00.000Z",
    };
    const { fake, layer } = makeHarness(
      [codex(argsStartWith("cloud", "exec"), { stdout: CODEX_EXEC_STDOUT })],
      (repository) => repository.insert(leftover).pipe(Effect.orDie),
    );
    return Effect.gen(function* () {
      const gateway = yield* CloudAgentsGateway;
      const replay = yield* gateway.submit(
        submitInput({ requestId: "req-left" as CloudRequestId }),
      );
      assert.strictEqual(replay.state, "uncertain");
      assert.strictEqual(replay.errorDetail, CLOUD_SUBMIT_RESTART_DETAIL);
      assert.strictEqual(execCalls(fake).length, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to apply outside the Synara worktrees directory before any CLI call", () => {
    const { fake, layer } = makeHarness([]);
    return Effect.gen(function* () {
      const gateway = yield* CloudAgentsGateway;
      const result = yield* Effect.result(
        gateway.applyToWorktree({ provider: "codex", taskId: TASK, worktreePath: process.cwd() }),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result))
        assert.strictEqual(result.failure._tag, "CloudInvalidInputError");
      assert.strictEqual(
        fake.callsMatching((invocation) => invocation.args.includes("apply")).length,
        0,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("applies inside a managed worktree through the CLI", () => {
    const { fake, layer } = makeHarness([
      git(argsStartWith("-C"), { stdout: "true\n\n" }, { stdout: "" }),
      codex(argsStartWith("cloud", "list"), {
        stdout: codexListJson([{ status: "ready", filesChanged: 1 }]),
      }),
      codex(argsStartWith("cloud", "apply"), { stdout: "Successfully applied patch\n" }),
    ]);
    return Effect.gen(function* () {
      const config = yield* ServerConfig;
      const worktree = nodePath.join(config.worktreesDir, "repo", "synara-abc");
      yield* Effect.promise(() => mkdir(worktree, { recursive: true }));
      const gateway = yield* CloudAgentsGateway;
      const result = yield* gateway.applyToWorktree({
        provider: "codex",
        taskId: TASK,
        worktreePath: worktree,
      });
      assert.strictEqual(result.outcome, "applied");
      const applyCall = fake.callsMatching((invocation) => invocation.args[1] === "apply")[0];
      assert.isDefined(applyCall);
      assert.strictEqual(nodePath.basename(applyCall!.cwd), "synara-abc");
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a watch failure as one error item instead of failing the stream", () => {
    const { layer } = makeHarness([
      codex(argsStartWith("cloud", "list"), { stdout: codexListJson([]) }),
      codex(argsStartWith("cloud", "status"), { stderr: CODEX_NOT_FOUND_STDERR, exitCode: 1 }),
    ]);
    return Effect.gen(function* () {
      const gateway = yield* CloudAgentsGateway;
      const events = yield* gateway
        .watchTask({ provider: "codex", taskId: TASK })
        .pipe(Stream.take(1), Stream.runCollect);
      const [event] = Array.from(events) as Array<CloudWatchTaskEvent>;
      assert.strictEqual(event?.type, "error");
      if (event?.type === "error") assert.strictEqual(event.code, "CloudTaskNotFoundError");
    }).pipe(Effect.provide(layer));
  });

  it.effect("returns the diff with a truncation flag", () => {
    const { layer } = makeHarness([
      codex(argsStartWith("cloud", "list"), {
        stdout: codexListJson([{ status: "ready", filesChanged: 1 }]),
      }),
      codex(argsStartWith("cloud", "diff"), { stdout: CODEX_SAMPLE_PATCH }),
    ]);
    return Effect.gen(function* () {
      const gateway = yield* CloudAgentsGateway;
      const diff = yield* gateway.getDiff({ provider: "codex", taskId: TASK });
      assert.strictEqual(diff.patch, CODEX_SAMPLE_PATCH);
      assert.isFalse(diff.truncated);
    }).pipe(Effect.provide(layer));
  });
});

describe("cloud gateway helpers", () => {
  it("caps a patch at a line boundary", () => {
    const capped = capCloudPatch("line one\nline two\nline three\n", 12);
    assert.deepStrictEqual(capped, { patch: "line one\n", truncated: true });
    assert.deepStrictEqual(capCloudPatch("short\n", 100), { patch: "short\n", truncated: false });
  });

  it("accepts only paths strictly inside the worktrees directory", () => {
    assert.isTrue(isPathInsideDirectory("/state/worktrees", "/state/worktrees/repo/wt"));
    assert.isFalse(isPathInsideDirectory("/state/worktrees", "/state/worktrees"));
    assert.isFalse(isPathInsideDirectory("/state/worktrees", "/state/worktrees-other/wt"));
    assert.isFalse(isPathInsideDirectory("/state/worktrees", "/repo"));
  });

  it("collapses whitespace in the stored prompt summary", () => {
    assert.strictEqual(summarizeCloudPrompt("  a\n\nb\tc "), "a b c");
    assert.strictEqual(summarizeCloudPrompt("x".repeat(400)).length, 280);
  });
});
