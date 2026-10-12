import { tmpdir } from "node:os";
import nodePath from "node:path";

import { assert, it } from "@effect/vitest";
import type { CloudAgentError, CloudSubmitInput, CloudTaskId } from "@synara/contracts";
import { Effect, Fiber, Result } from "effect";
import { describe } from "vitest";

import { makeCloudAgents, type CloudAgentsConfig } from "./CloudAgents.ts";
import { CloudCliRunner } from "./CloudCliRunner.ts";
import { decodeCloudEnvironmentId, decodeCloudTaskId } from "./codexCloudCli.ts";
import {
  CLAUDE_PRINT_CLOUD_DISABLED_STDERR,
  CLAUDE_PROBE_ROUTES,
  CLAUDE_SESSION_ID,
  CODEX_ENV_ID,
  CODEX_ENV_LABEL,
  CODEX_EXEC_STDOUT,
  CODEX_NO_DIFF_STDERR,
  CODEX_NOT_FOUND_STDERR,
  CODEX_OTHER_TASK_ID,
  CODEX_PROBE_ROUTES,
  CODEX_SAMPLE_PATCH,
  CODEX_TASK_ID,
  argsEqual,
  argsStartWith,
  claudeFollowUpReceipt,
  codexListJson,
  codexStatusStdout,
  makeFakeCloudCli,
  route,
  type FakeCloudCli,
  type FakeCloudCliRoute,
} from "./testing/fakeCloudCli.ts";

const SCRATCH_DIR = nodePath.join(tmpdir(), "synara-cloud-agents-test");
const WORKTREE = nodePath.join(tmpdir(), "synara-cloud-agents-worktree");

function taskId(value: string): CloudTaskId {
  const decoded = decodeCloudTaskId(value);
  if (!decoded) throw new Error(`invalid test task id ${value}`);
  return decoded;
}

const TASK = taskId(CODEX_TASK_ID);

function forProvider(provider: string, routes: ReadonlyArray<FakeCloudCliRoute>) {
  return routes.map((entry) => ({
    ...entry,
    match: (invocation: Parameters<FakeCloudCliRoute["match"]>[0]) =>
      invocation.executable === `/fake/bin/${provider}` && entry.match(invocation),
  }));
}

function makeTestService(
  routes: ReadonlyArray<FakeCloudCliRoute>,
  overrides: Partial<CloudAgentsConfig> = {},
) {
  const fake = makeFakeCloudCli([
    ...forProvider("codex", CODEX_PROBE_ROUTES),
    ...forProvider("claude", CLAUDE_PROBE_ROUTES),
    ...routes,
  ]);
  const config: CloudAgentsConfig = {
    scratchDir: SCRATCH_DIR,
    codex: {
      binaryPath: "codex",
      environments: [{ id: CODEX_ENV_ID, label: CODEX_ENV_LABEL }],
    },
    claude: { binaryPath: "claude" },
    baseEnv: {
      PATH: "/usr/bin",
      HOME: "/home/test",
      CODEX_STARTING_DIFF: "stale",
      ANTHROPIC_API_KEY: "test-key",
      CLAUDE_CODE_OAUTH_TOKEN: "test-token",
    },
    resolveExecutable: (command) => `/fake/bin/${command}`,
    ...overrides,
  };
  return makeCloudAgents(config).pipe(
    Effect.provideService(CloudCliRunner, fake.runner),
    Effect.map((service) => ({ service, fake })),
  );
}

const codexRoute = (
  match: FakeCloudCliRoute["match"],
  ...responses: Parameters<typeof route>[1][]
) => forProvider("codex", [route(match, ...responses)])[0]!;

const claudeRoute = (
  match: FakeCloudCliRoute["match"],
  ...responses: Parameters<typeof route>[1][]
) => forProvider("claude", [route(match, ...responses)])[0]!;

const submitInput = (overrides: Partial<CloudSubmitInput> = {}): CloudSubmitInput =>
  ({
    provider: "codex",
    requestId: "req-1",
    environment: CODEX_ENV_ID,
    prompt: "Add a hello world script",
    branch: "main",
    ...overrides,
  }) as CloudSubmitInput;

function expectFailureTag<A>(result: Result.Result<A, CloudAgentError>, tag: string) {
  assert.isTrue(Result.isFailure(result), `expected ${tag}`);
  if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, tag);
}

const isHelpProbe = (args: ReadonlyArray<string>) => args.at(-1) === "--help";

const commandCalls = (fake: FakeCloudCli, ...prefix: string[]) =>
  fake.callsMatching(argsStartWith(...prefix)).filter((call) => !isHelpProbe(call.args));

describe("CloudAgents capabilities", () => {
  it.effect("detects the Codex cloud command surface from version and help", () =>
    Effect.gen(function* () {
      const { service } = yield* makeTestService([]);
      const capabilities = yield* service.capabilities("codex");
      assert.deepStrictEqual(capabilities, {
        provider: "codex",
        executablePath: "/fake/bin/codex",
        cliVersion: "0.162.1",
        available: true,
        unavailableKind: null,
        unavailableReason: null,
        canSubmit: true,
        canList: true,
        canStatus: true,
        canDiff: true,
        canApply: true,
        canFollowUp: false,
        canCancel: false,
        canListEnvironments: false,
        maxAttempts: 4,
      });
    }),
  );

  it.effect("caches capabilities until a refresh", () =>
    Effect.gen(function* () {
      const { service, fake } = yield* makeTestService([]);
      yield* service.capabilities("codex");
      yield* service.capabilities("codex");
      assert.strictEqual(fake.callsMatching(argsEqual("--version")).length, 1);
      yield* service.refreshCapabilities("codex");
      assert.strictEqual(fake.callsMatching(argsEqual("--version")).length, 2);
    }),
  );

  it.effect("marks a Codex CLI older than the tested version unavailable", () =>
    Effect.gen(function* () {
      const fake = makeFakeCloudCli([
        route(argsEqual("--version"), { stdout: "codex-cli 0.150.0\n" }),
      ]);
      const service = yield* makeCloudAgents({
        scratchDir: SCRATCH_DIR,
        codex: { binaryPath: "codex" },
        claude: { binaryPath: "claude" },
        resolveExecutable: (command) => `/fake/bin/${command}`,
      }).pipe(Effect.provideService(CloudCliRunner, fake.runner));
      const capabilities = yield* service.capabilities("codex");
      assert.isFalse(capabilities.available);
      assert.strictEqual(capabilities.unavailableKind, "too-old");
      assert.include(capabilities.unavailableReason ?? "", "0.150.0");
      const listed = yield* Effect.result(service.listTasks({ provider: "codex" }));
      expectFailureTag(listed, "CloudCliUnavailableError");
    }),
  );

  it.effect("reports a missing executable without spawning", () =>
    Effect.gen(function* () {
      const { service, fake } = yield* makeTestService([], { resolveExecutable: () => null });
      const capabilities = yield* service.capabilities("codex");
      assert.isFalse(capabilities.available);
      assert.isNull(capabilities.executablePath);
      assert.strictEqual(fake.calls.length, 0);
    }),
  );

  it.effect("reports Claude as follow-up only: start is interactive-only", () =>
    Effect.gen(function* () {
      const { service } = yield* makeTestService([]);
      const capabilities = yield* service.capabilities("claude");
      assert.isTrue(capabilities.available);
      assert.isFalse(capabilities.canSubmit);
      assert.isTrue(capabilities.canFollowUp);
      assert.isFalse(capabilities.canList);
      assert.isFalse(capabilities.canStatus);
    }),
  );
});

describe("CloudAgents Codex submit", () => {
  it.effect("passes the branch, environment and attempts explicitly and parses the URL", () =>
    Effect.gen(function* () {
      const { service, fake } = yield* makeTestService([
        codexRoute(argsStartWith("cloud", "exec"), { stdout: CODEX_EXEC_STDOUT }),
      ]);
      const receipt = yield* service.submit(submitInput({ attempts: 2, prompt: "--help me" }));
      assert.strictEqual(receipt.taskId, CODEX_TASK_ID);
      assert.strictEqual(receipt.url, `https://chatgpt.com/codex/tasks/${CODEX_TASK_ID}`);
      const [call] = commandCalls(fake, "cloud", "exec");
      assert.deepStrictEqual(call?.args, [
        "cloud",
        "exec",
        "--env",
        CODEX_ENV_ID,
        "--branch",
        "main",
        "--attempts",
        "2",
        "--",
        "--help me",
      ]);
      assert.strictEqual(call?.cwd, SCRATCH_DIR);
      assert.strictEqual(call?.env.NO_COLOR, "1");
      assert.isUndefined(call?.env.CODEX_STARTING_DIFF);
    }),
  );

  it.effect("returns the stored receipt for a repeated request id without a second exec", () =>
    Effect.gen(function* () {
      const { service, fake } = yield* makeTestService([
        codexRoute(argsStartWith("cloud", "exec"), { stdout: CODEX_EXEC_STDOUT }),
      ]);
      const first = yield* service.submit(submitInput());
      const second = yield* service.submit(submitInput());
      assert.deepStrictEqual(second, first);
      assert.strictEqual(commandCalls(fake, "cloud", "exec").length, 1);
    }),
  );

  it.effect("marks a timed-out submit uncertain and never runs it again", () =>
    Effect.gen(function* () {
      const { service, fake } = yield* makeTestService([
        codexRoute(argsStartWith("cloud", "exec"), { timedOut: true, exitCode: null }),
      ]);
      expectFailureTag(
        yield* Effect.result(service.submit(submitInput())),
        "CloudSubmitUncertainError",
      );
      expectFailureTag(
        yield* Effect.result(service.submit(submitInput())),
        "CloudSubmitUncertainError",
      );
      assert.strictEqual(commandCalls(fake, "cloud", "exec").length, 1);
    }),
  );

  it.effect("marks exit 0 without a task URL uncertain", () =>
    Effect.gen(function* () {
      const { service } = yield* makeTestService([
        codexRoute(argsStartWith("cloud", "exec"), { stdout: "Submitted.\n" }),
      ]);
      expectFailureTag(
        yield* Effect.result(service.submit(submitInput())),
        "CloudSubmitUncertainError",
      );
    }),
  );

  it.effect("refuses a second submit while the first one runs", () =>
    Effect.gen(function* () {
      const { service, fake } = yield* makeTestService([
        codexRoute(argsStartWith("cloud", "exec"), "hang"),
      ]);
      yield* service.capabilities("codex");
      const first = yield* Effect.forkChild(service.submit(submitInput()));
      yield* Effect.yieldNow;
      expectFailureTag(
        yield* Effect.result(service.submit(submitInput())),
        "CloudSubmitInFlightError",
      );
      yield* Fiber.interrupt(first);
      expectFailureTag(
        yield* Effect.result(service.submit(submitInput())),
        "CloudSubmitUncertainError",
      );
      assert.strictEqual(commandCalls(fake, "cloud", "exec").length, 1);
    }),
  );

  it.effect("rejects unsafe input before any spawn and allows a corrected retry", () =>
    Effect.gen(function* () {
      const { service, fake } = yield* makeTestService([
        codexRoute(argsStartWith("cloud", "exec"), { stdout: CODEX_EXEC_STDOUT }),
      ]);
      expectFailureTag(
        yield* Effect.result(service.submit(submitInput({ branch: "--upload-pack=x" }))),
        "CloudInvalidInputError",
      );
      expectFailureTag(
        yield* Effect.result(service.submit(submitInput({ environment: "-x" }))),
        "CloudInvalidInputError",
      );
      expectFailureTag(
        yield* Effect.result(service.submit(submitInput({ attempts: 5 }))),
        "CloudInvalidInputError",
      );
      expectFailureTag(
        yield* Effect.result(service.submit(submitInput({ branch: "" }))),
        "CloudInvalidInputError",
      );
      assert.strictEqual(commandCalls(fake, "cloud", "exec").length, 0);
      const receipt = yield* service.submit(submitInput());
      assert.strictEqual(receipt.taskId, CODEX_TASK_ID);
    }),
  );

  it.effect("replays a definite CLI failure for the same request id", () =>
    Effect.gen(function* () {
      const { service, fake } = yield* makeTestService([
        codexRoute(argsStartWith("cloud", "exec"), {
          exitCode: 1,
          stderr: "Error: environment not found",
        }),
      ]);
      expectFailureTag(yield* Effect.result(service.submit(submitInput())), "CloudCliFailedError");
      expectFailureTag(yield* Effect.result(service.submit(submitInput())), "CloudCliFailedError");
      assert.strictEqual(commandCalls(fake, "cloud", "exec").length, 1);
    }),
  );
});

describe("CloudAgents Codex reads", () => {
  it.effect("treats status exit 1 with [PENDING] as a pending task, not a failure", () =>
    Effect.gen(function* () {
      const { service } = yield* makeTestService([
        codexRoute(argsStartWith("cloud", "status"), {
          stdout: codexStatusStdout("PENDING"),
          exitCode: 1,
        }),
      ]);
      const task = yield* service.status({ provider: "codex", taskId: TASK });
      assert.strictEqual(task.status, "pending");
      assert.strictEqual(task.rawStatus, "PENDING");
      assert.strictEqual(task.environmentLabel, CODEX_ENV_LABEL);
    }),
  );

  it.effect("maps the 404 stderr for a bad id to CloudTaskNotFoundError", () =>
    Effect.gen(function* () {
      const { service } = yield* makeTestService([
        codexRoute(argsStartWith("cloud", "status"), {
          stderr: CODEX_NOT_FOUND_STDERR,
          exitCode: 1,
        }),
      ]);
      const result = yield* Effect.result(
        service.status({ provider: "codex", taskId: taskId("task_e_bogus") }),
      );
      expectFailureTag(result, "CloudTaskNotFoundError");
    }),
  );

  it.effect("maps an unrecognized status failure to CloudCliFailedError", () =>
    Effect.gen(function* () {
      const { service } = yield* makeTestService([
        codexRoute(argsStartWith("cloud", "status"), {
          stderr: "Error: not logged in",
          exitCode: 1,
        }),
      ]);
      const result = yield* Effect.result(service.status({ provider: "codex", taskId: TASK }));
      expectFailureTag(result, "CloudCliFailedError");
    }),
  );

  it.effect("prefers list --json over a lagging status read", () =>
    Effect.gen(function* () {
      const { service, fake } = yield* makeTestService([
        codexRoute(argsStartWith("cloud", "list"), {
          stdout: codexListJson([{ status: "ready", filesChanged: 1 }]),
        }),
        codexRoute(argsStartWith("cloud", "status"), {
          stdout: codexStatusStdout("PENDING"),
          exitCode: 1,
        }),
      ]);
      const task = yield* service.getTask({ provider: "codex", taskId: TASK });
      assert.strictEqual(task.status, "ready");
      assert.deepStrictEqual(task.diffSummary, { filesChanged: 1, linesAdded: 3, linesRemoved: 1 });
      assert.strictEqual(commandCalls(fake, "cloud", "status").length, 0);
    }),
  );

  it.effect("falls back to status for a task that is not on the listed pages", () =>
    Effect.gen(function* () {
      const { service } = yield* makeTestService([
        codexRoute(argsStartWith("cloud", "list"), {
          stdout: codexListJson([{ id: CODEX_OTHER_TASK_ID, status: "ready" }]),
        }),
        codexRoute(argsStartWith("cloud", "status"), { stdout: codexStatusStdout("READY") }),
      ]);
      const task = yield* service.getTask({ provider: "codex", taskId: TASK });
      assert.strictEqual(task.status, "ready");
      assert.strictEqual(task.id, CODEX_TASK_ID);
    }),
  );

  it.effect("follows cursors and rejects a repeated cursor", () =>
    Effect.gen(function* () {
      const { service, fake } = yield* makeTestService([
        codexRoute(
          argsStartWith("cloud", "list"),
          { stdout: codexListJson([{ id: CODEX_OTHER_TASK_ID, status: "ready" }], "c1") },
          { stdout: codexListJson([{ status: "pending" }], "c1") },
        ),
      ]);
      const result = yield* Effect.result(service.listAllTasks({ provider: "codex" }));
      expectFailureTag(result, "CloudOutputParseError");
      const listCalls = commandCalls(fake, "cloud", "list");
      assert.strictEqual(listCalls.length, 2);
      assert.deepStrictEqual(listCalls[1]?.args.slice(-2), ["--cursor", "c1"]);
    }),
  );

  it.effect("derives environments from configuration and list labels", () =>
    Effect.gen(function* () {
      const { service } = yield* makeTestService([
        codexRoute(argsStartWith("cloud", "list"), {
          stdout: codexListJson([
            { status: "ready", environmentLabel: "SYNARA-SANDBOX" },
            { id: CODEX_OTHER_TASK_ID, status: "ready", environmentLabel: "web-app" },
          ]),
        }),
      ]);
      const environments = yield* service.listEnvironments("codex");
      assert.deepStrictEqual(environments, [
        {
          provider: "codex",
          id: decodeCloudEnvironmentId(CODEX_ENV_ID),
          label: CODEX_ENV_LABEL,
          source: "configured",
        },
        { provider: "codex", id: null, label: "web-app", source: "observed" },
      ]);
    }),
  );
});

describe("CloudAgents Codex diff and apply", () => {
  it.effect("does not call diff for a ready task with no changed files", () =>
    Effect.gen(function* () {
      const { service, fake } = yield* makeTestService([
        codexRoute(argsStartWith("cloud", "list"), {
          stdout: codexListJson([{ status: "ready", filesChanged: 0 }]),
        }),
      ]);
      const result = yield* Effect.result(service.diff({ provider: "codex", taskId: TASK }));
      expectFailureTag(result, "CloudNoDiffError");
      if (Result.isFailure(result) && result.failure._tag === "CloudNoDiffError") {
        assert.strictEqual(result.failure.reason, "no-changes");
      }
      assert.strictEqual(commandCalls(fake, "cloud", "diff").length, 0);
    }),
  );

  it.effect("does not call diff while the task is pending", () =>
    Effect.gen(function* () {
      const { service, fake } = yield* makeTestService([
        codexRoute(argsStartWith("cloud", "list"), {
          stdout: codexListJson([{ status: "pending", filesChanged: 0 }]),
        }),
      ]);
      const result = yield* Effect.result(service.diff({ provider: "codex", taskId: TASK }));
      expectFailureTag(result, "CloudNoDiffError");
      if (Result.isFailure(result) && result.failure._tag === "CloudNoDiffError") {
        assert.strictEqual(result.failure.reason, "not-ready");
      }
      assert.strictEqual(commandCalls(fake, "cloud", "diff").length, 0);
    }),
  );

  it.effect("returns the patch for a ready task with changes", () =>
    Effect.gen(function* () {
      const { service, fake } = yield* makeTestService([
        codexRoute(argsStartWith("cloud", "list"), {
          stdout: codexListJson([{ status: "ready", filesChanged: 1 }]),
        }),
        codexRoute(argsStartWith("cloud", "diff"), { stdout: CODEX_SAMPLE_PATCH }),
      ]);
      const patch = yield* service.diff({ provider: "codex", taskId: TASK, attempt: 2 });
      assert.strictEqual(patch, CODEX_SAMPLE_PATCH);
      assert.deepStrictEqual(commandCalls(fake, "cloud", "diff")[0]?.args, [
        "cloud",
        "diff",
        CODEX_TASK_ID,
        "--attempt",
        "2",
      ]);
    }),
  );

  it.effect("maps the CLI no-diff stderr to CloudNoDiffError", () =>
    Effect.gen(function* () {
      const { service } = yield* makeTestService([
        codexRoute(argsStartWith("cloud", "list"), {
          stdout: codexListJson([{ status: "ready", filesChanged: 1 }]),
        }),
        codexRoute(argsStartWith("cloud", "diff"), { stderr: CODEX_NO_DIFF_STDERR, exitCode: 1 }),
      ]);
      const result = yield* Effect.result(
        service.diff({ provider: "codex", taskId: TASK, attempt: 4 }),
      );
      expectFailureTag(result, "CloudNoDiffError");
    }),
  );

  it.effect("applies only into an explicit, clean worktree root", () =>
    Effect.gen(function* () {
      const gitRoutes = forProvider("git", [
        route(argsEqual("-C", WORKTREE, "rev-parse", "--is-inside-work-tree", "--show-prefix"), {
          stdout: "true\n\n",
        }),
        route(argsEqual("-C", WORKTREE, "status", "--porcelain=v1", "--untracked-files=all"), {
          stdout: "",
        }),
      ]);
      const { service, fake } = yield* makeTestService([
        ...gitRoutes,
        codexRoute(argsStartWith("cloud", "list"), {
          stdout: codexListJson([{ status: "ready", filesChanged: 1 }]),
        }),
        codexRoute(argsStartWith("cloud", "apply"), { stdout: "Applied patch cleanly.\n" }),
      ]);
      const relative = yield* Effect.result(
        service.apply({ provider: "codex", taskId: TASK, worktreePath: "relative/path" }),
      );
      expectFailureTag(relative, "CloudInvalidInputError");
      assert.strictEqual(commandCalls(fake, "cloud", "apply").length, 0);

      const applied = yield* service.apply({
        provider: "codex",
        taskId: TASK,
        worktreePath: WORKTREE,
      });
      assert.strictEqual(applied.outcome, "applied");
      const [applyCall] = commandCalls(fake, "cloud", "apply");
      assert.strictEqual(applyCall?.cwd, WORKTREE);
    }),
  );

  it.effect("refuses to apply into a dirty worktree", () =>
    Effect.gen(function* () {
      const { service, fake } = yield* makeTestService([
        ...forProvider("git", [
          route(argsStartWith("-C", WORKTREE, "rev-parse"), { stdout: "true\n\n" }),
          route(argsStartWith("-C", WORKTREE, "status"), { stdout: "?? notes.txt\n" }),
        ]),
      ]);
      const result = yield* Effect.result(
        service.apply({ provider: "codex", taskId: TASK, worktreePath: WORKTREE }),
      );
      expectFailureTag(result, "CloudInvalidInputError");
      assert.strictEqual(commandCalls(fake, "cloud", "apply").length, 0);
    }),
  );

  it.effect("refuses a path inside a worktree that is not its root", () =>
    Effect.gen(function* () {
      const { service } = yield* makeTestService([
        ...forProvider("git", [
          route(argsStartWith("-C", WORKTREE, "rev-parse"), { stdout: "true\nsrc/\n" }),
        ]),
      ]);
      const result = yield* Effect.result(
        service.apply({ provider: "codex", taskId: TASK, worktreePath: WORKTREE }),
      );
      expectFailureTag(result, "CloudInvalidInputError");
    }),
  );

  it.effect("reports a partial apply as a result, not an error", () =>
    Effect.gen(function* () {
      const { service } = yield* makeTestService([
        ...forProvider("git", [
          route(argsStartWith("-C", WORKTREE, "rev-parse"), { stdout: "true\n\n" }),
          route(argsStartWith("-C", WORKTREE, "status"), { stdout: "" }),
        ]),
        codexRoute(argsStartWith("cloud", "list"), {
          stdout: codexListJson([{ status: "ready", filesChanged: 2 }]),
        }),
        codexRoute(argsStartWith("cloud", "apply"), {
          stderr: "Partial apply: 1 file conflicted\n",
          exitCode: 1,
        }),
      ]);
      const applied = yield* service.apply({
        provider: "codex",
        taskId: TASK,
        worktreePath: WORKTREE,
      });
      assert.strictEqual(applied.outcome, "partial");
    }),
  );
});

describe("CloudAgents Claude", () => {
  it.effect("refuses submit as interactive-only without spawning the CLI", () =>
    Effect.gen(function* () {
      const { service, fake } = yield* makeTestService([]);
      const result = yield* Effect.result(service.submit(submitInput({ provider: "claude" })));
      expectFailureTag(result, "CloudOperationUnsupportedError");
      if (Result.isFailure(result) && result.failure._tag === "CloudOperationUnsupportedError") {
        assert.strictEqual(result.failure.reason, "interactive-only");
      }
      assert.strictEqual(fake.calls.length, 0);
    }),
  );

  it.effect("sends a follow-up with -p --cloud and reads the JSON receipt", () =>
    Effect.gen(function* () {
      const { service, fake } = yield* makeTestService([
        claudeRoute(argsStartWith("--print", "--cloud"), { stdout: claudeFollowUpReceipt() }),
      ]);
      const receipt = yield* service.sendFollowUp({
        provider: "claude",
        sessionReference: `https://claude.ai/code/${CLAUDE_SESSION_ID}`,
        message: "-also add tests",
      });
      assert.deepStrictEqual(receipt, {
        provider: "claude",
        sessionId: taskId(CLAUDE_SESSION_ID),
        url: `https://claude.ai/code/${CLAUDE_SESSION_ID}`,
      });
      const [call] = commandCalls(fake, "--print", "--cloud");
      assert.deepStrictEqual(call?.args, [
        "--print",
        "--cloud",
        CLAUDE_SESSION_ID,
        "--output-format",
        "json",
        "--",
        "-also add tests",
      ]);
      assert.isUndefined(call?.env.ANTHROPIC_API_KEY);
      assert.isUndefined(call?.env.CLAUDE_CODE_OAUTH_TOKEN);
      assert.strictEqual(call?.env.NO_COLOR, "1");
    }),
  );

  it.effect("maps the recorded --cloud/--print refusal to an interactive-only error", () =>
    Effect.gen(function* () {
      const { service } = yield* makeTestService([
        claudeRoute(argsStartWith("--print", "--cloud"), {
          stderr: CLAUDE_PRINT_CLOUD_DISABLED_STDERR,
          exitCode: 1,
        }),
      ]);
      const result = yield* Effect.result(
        service.sendFollowUp({
          provider: "claude",
          sessionReference: CLAUDE_SESSION_ID,
          message: "continue",
        }),
      );
      expectFailureTag(result, "CloudOperationUnsupportedError");
      if (Result.isFailure(result) && result.failure._tag === "CloudOperationUnsupportedError") {
        assert.strictEqual(result.failure.reason, "interactive-only");
        assert.include(result.failure.detail, "interactive only");
      }
    }),
  );

  it.effect("rejects a session reference that is not a Claude session", () =>
    Effect.gen(function* () {
      const { service, fake } = yield* makeTestService([]);
      const result = yield* Effect.result(
        service.sendFollowUp({
          provider: "claude",
          sessionReference: "--dangerously-skip-permissions",
          message: "hi",
        }),
      );
      expectFailureTag(result, "CloudInvalidInputError");
      assert.strictEqual(fake.calls.length, 0);
    }),
  );

  it.effect("has no list, status, diff or apply command", () =>
    Effect.gen(function* () {
      const { service } = yield* makeTestService([]);
      expectFailureTag(
        yield* Effect.result(service.listTasks({ provider: "claude" })),
        "CloudOperationUnsupportedError",
      );
      expectFailureTag(
        yield* Effect.result(
          service.status({ provider: "claude", taskId: taskId(CLAUDE_SESSION_ID) }),
        ),
        "CloudOperationUnsupportedError",
      );
    }),
  );
});
