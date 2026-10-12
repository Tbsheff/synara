import nodePath from "node:path";

import {
  CloudInvalidInputError,
  CloudNoDiffError,
  CloudOutputParseError,
  CloudSubmitUncertainError,
  CloudTaskNotFoundError,
  type CloudAgentError,
  type CloudApplyResult,
  type CloudCapabilities,
  type CloudEnvironment,
  type CloudSubmitInput,
  type CloudSubmitReceipt,
  type CloudTask,
  type CloudTaskId,
  type CloudTaskPage,
} from "@synara/contracts";
import { Effect, Result } from "effect";

import { compareSemverVersions } from "../provider/providerMaintenance.ts";
import {
  exitFailure,
  spawnFailure,
  unavailableCapabilities,
  unsupportedOperation,
  type CloudAgentDriver,
  type CloudApplyInput,
  type CloudDiffInput,
  type CloudDriverContext,
  type CloudListTasksInput,
  type CloudTaskLookupInput,
} from "./cloudAgentDriver.ts";
import type { CloudCliOutput } from "./CloudCliRunner.ts";
import {
  CODEX_CLOUD_LIST_PAGE_LIMIT,
  CODEX_CLOUD_MAX_ATTEMPTS,
  capCliDetail,
  classifyCodexApplyOutput,
  decodeCloudEnvironmentId,
  codexStatusSnapshotToTask,
  firstOutputLines,
  helpListsFlag,
  isCodexNoDiffStderr,
  isCodexNotFoundStderr,
  parseCodexCloudSubcommands,
  parseCodexExecOutput,
  parseCodexListJson,
  parseCodexStatusText,
  parseCodexVersion,
} from "./codexCloudCli.ts";

export const MINIMUM_TESTED_CODEX_CLOUD_VERSION = "0.162.0";
export const CODEX_TASK_LOOKUP_MAX_PAGES = 3;
export const CODEX_LIST_ALL_DEFAULT_MAX_PAGES = 5;

const PROVIDER = "codex" as const;
const SAFE_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/+-]*$/;

export interface CodexConfiguredEnvironment {
  readonly id: string;
  readonly label?: string | undefined;
}

export interface CodexCloudDriverOptions {
  readonly configuredEnvironments: ReadonlyArray<CodexConfiguredEnvironment>;
  readonly binaryPath: string;
}

function invalidInput(operation: string, detail: string): CloudInvalidInputError {
  return new CloudInvalidInputError({ provider: PROVIDER, operation, detail });
}

const FIRST_PRINTABLE_CHAR_CODE = 0x20;
const DELETE_CHAR_CODE = 0x7f;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < FIRST_PRINTABLE_CHAR_CODE || code === DELETE_CHAR_CODE) return true;
  }
  return false;
}

function isSafeEnvironmentArgument(value: string): boolean {
  return !value.startsWith("-") && !hasControlCharacter(value);
}

function validatedAttempt(
  operation: string,
  attempt: number | undefined,
): Effect.Effect<number | undefined, CloudInvalidInputError> {
  if (attempt === undefined) return Effect.succeed(undefined);
  const isValidAttempt =
    Number.isInteger(attempt) && attempt >= 1 && attempt <= CODEX_CLOUD_MAX_ATTEMPTS;
  return isValidAttempt
    ? Effect.succeed(attempt)
    : Effect.fail(invalidInput(operation, `attempt must be 1-${CODEX_CLOUD_MAX_ATTEMPTS}`));
}

function attemptArgs(attempt: number | undefined): ReadonlyArray<string> {
  return attempt === undefined ? [] : ["--attempt", String(attempt)];
}

function taskLookupFailure(
  taskId: CloudTaskId,
  operation: string,
  timeoutMs: number,
  output: CloudCliOutput,
): CloudAgentError {
  return isCodexNotFoundStderr(output.stderr)
    ? new CloudTaskNotFoundError({ provider: PROVIDER, taskId })
    : exitFailure(PROVIDER, operation, timeoutMs, output);
}

function noDiffReasonFor(task: CloudTask): CloudNoDiffError["reason"] | null {
  if (task.status === "pending" || task.status === "unknown") return "not-ready";
  if (task.status === "error" || task.status === "cancelled") return "unavailable";
  if (task.diffSummary && task.diffSummary.filesChanged === 0) return "no-changes";
  return null;
}

export function mergeCodexEnvironments(
  configured: ReadonlyArray<CodexConfiguredEnvironment>,
  tasks: ReadonlyArray<CloudTask>,
): ReadonlyArray<CloudEnvironment> {
  const environments: CloudEnvironment[] = [];
  const knownLabels = new Set<string>();
  for (const entry of configured) {
    const label = entry.label?.trim() || null;
    environments.push({
      provider: PROVIDER,
      id: decodeCloudEnvironmentId(entry.id),
      label,
      source: "configured",
    });
    if (label) knownLabels.add(label.toLowerCase());
  }
  for (const task of tasks) {
    const label = task.environmentLabel?.trim();
    if (!label || knownLabels.has(label.toLowerCase())) continue;
    knownLabels.add(label.toLowerCase());
    environments.push({ provider: PROVIDER, id: null, label, source: "observed" });
  }
  return environments;
}

export function makeCodexCloudDriver(
  ctx: CloudDriverContext,
  options: CodexCloudDriverOptions,
): CloudAgentDriver {
  const probe = (executable: string, args: ReadonlyArray<string>) =>
    ctx.runCli({ executable, args, timeoutMs: ctx.timeouts.probeMs }).pipe(
      Effect.result,
      Effect.map((result) => (Result.isSuccess(result) ? result.success : null)),
    );

  const detectCapabilities: Effect.Effect<CloudCapabilities> = Effect.gen(function* () {
    const executable = ctx.resolveExecutable(options.binaryPath);
    if (!executable) {
      return unavailableCapabilities(
        PROVIDER,
        null,
        null,
        `Codex CLI was not found (${options.binaryPath}).`,
      );
    }
    const versionOutput = yield* probe(executable, ["--version"]);
    const version = versionOutput?.exitCode === 0 ? parseCodexVersion(versionOutput.stdout) : null;
    if (!version) {
      return unavailableCapabilities(
        PROVIDER,
        executable,
        null,
        "Codex CLI version is unreadable.",
      );
    }
    if (compareSemverVersions(version, MINIMUM_TESTED_CODEX_CLOUD_VERSION) < 0) {
      return unavailableCapabilities(
        PROVIDER,
        executable,
        version,
        `Codex CLI ${version} is older than the tested ${MINIMUM_TESTED_CODEX_CLOUD_VERSION}.`,
      );
    }
    const [cloudHelp, listHelp, execHelp] = yield* Effect.all(
      [
        probe(executable, ["cloud", "--help"]),
        probe(executable, ["cloud", "list", "--help"]),
        probe(executable, ["cloud", "exec", "--help"]),
      ],
      { concurrency: "unbounded" },
    );
    const subcommands = parseCodexCloudSubcommands(cloudHelp?.stdout ?? "");
    if (subcommands.size === 0) {
      return unavailableCapabilities(
        PROVIDER,
        executable,
        version,
        "Codex CLI has no `cloud` command.",
      );
    }
    const execText = execHelp?.stdout ?? "";
    const canSubmit = subcommands.has("exec") && helpListsFlag(execText, "--branch");
    return {
      provider: PROVIDER,
      executablePath: executable,
      cliVersion: version,
      available: true,
      unavailableReason: null,
      canSubmit,
      canList: subcommands.has("list") && helpListsFlag(listHelp?.stdout ?? "", "--json"),
      canStatus: subcommands.has("status"),
      canDiff: subcommands.has("diff"),
      canApply: subcommands.has("apply"),
      canFollowUp: false,
      canCancel: false,
      canListEnvironments: false,
      maxAttempts: canSubmit
        ? helpListsFlag(execText, "--attempts")
          ? CODEX_CLOUD_MAX_ATTEMPTS
          : 1
        : 0,
    } satisfies CloudCapabilities;
  });

  const runRead = (operation: string, executable: string, args: ReadonlyArray<string>) =>
    ctx
      .runCli({ executable, args, timeoutMs: ctx.timeouts.readMs })
      .pipe(Effect.mapError((error) => spawnFailure(PROVIDER, operation, error)));

  const listTasks = (input: CloudListTasksInput): Effect.Effect<CloudTaskPage, CloudAgentError> =>
    Effect.gen(function* () {
      const operation = "list";
      const limit = input.limit ?? CODEX_CLOUD_LIST_PAGE_LIMIT;
      if (!Number.isInteger(limit) || limit < 1 || limit > CODEX_CLOUD_LIST_PAGE_LIMIT) {
        return yield* invalidInput(operation, `limit must be 1-${CODEX_CLOUD_LIST_PAGE_LIMIT}`);
      }
      if (input.cursor !== undefined && input.cursor.startsWith("-")) {
        return yield* invalidInput(operation, "cursor is not valid");
      }
      if (input.environment !== undefined && !isSafeEnvironmentArgument(input.environment)) {
        return yield* invalidInput(operation, "environment is not valid");
      }
      const executable = yield* ctx.requireCli("canList", operation);
      const args = [
        "cloud",
        "list",
        "--json",
        "--limit",
        String(limit),
        ...(input.cursor !== undefined ? ["--cursor", input.cursor] : []),
        ...(input.environment !== undefined ? ["--env", input.environment] : []),
      ];
      const output = yield* runRead(operation, executable, args);
      if (output.exitCode !== 0) {
        return yield* exitFailure(PROVIDER, operation, ctx.timeouts.readMs, output);
      }
      const parsed = parseCodexListJson(output.stdout);
      if (!parsed.ok) {
        return yield* new CloudOutputParseError({
          provider: PROVIDER,
          operation,
          detail: parsed.detail,
        });
      }
      return parsed.page;
    });

  const listAllTasks = (input: {
    readonly environment?: string | undefined;
    readonly maxPages: number;
    readonly until?: ((task: CloudTask) => boolean) | undefined;
  }): Effect.Effect<ReadonlyArray<CloudTask>, CloudAgentError> =>
    Effect.gen(function* () {
      const tasks: CloudTask[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < input.maxPages; page += 1) {
        const result = yield* listTasks({ environment: input.environment, cursor });
        tasks.push(...result.tasks);
        if (input.until && result.tasks.some(input.until)) break;
        if (result.cursor === null) break;
        if (seenCursors.has(result.cursor)) {
          return yield* new CloudOutputParseError({
            provider: PROVIDER,
            operation: "list",
            detail: "list --json repeated a pagination cursor",
          });
        }
        seenCursors.add(result.cursor);
        cursor = result.cursor;
      }
      return tasks;
    });

  const status = (input: CloudTaskLookupInput): Effect.Effect<CloudTask, CloudAgentError> =>
    Effect.gen(function* () {
      const operation = "status";
      const executable = yield* ctx.requireCli("canStatus", operation);
      const output = yield* runRead(operation, executable, ["cloud", "status", input.taskId]);
      const snapshot = parseCodexStatusText(output.stdout);
      if (snapshot) return codexStatusSnapshotToTask(input.taskId, snapshot);
      return yield* taskLookupFailure(input.taskId, operation, ctx.timeouts.readMs, output);
    });

  const getTask = (input: CloudTaskLookupInput): Effect.Effect<CloudTask, CloudAgentError> =>
    Effect.gen(function* () {
      const isTarget = (task: CloudTask) => task.id === input.taskId;
      const listed = yield* listAllTasks({
        maxPages: CODEX_TASK_LOOKUP_MAX_PAGES,
        until: isTarget,
      });
      return listed.find(isTarget) ?? (yield* status(input));
    });

  const requireDiffAvailable = (taskId: CloudTaskId) =>
    Effect.gen(function* () {
      const task = yield* getTask({ taskId });
      const reason = noDiffReasonFor(task);
      if (reason) {
        return yield* new CloudNoDiffError({ provider: PROVIDER, taskId, reason });
      }
      return task;
    });

  const diff = (input: CloudDiffInput): Effect.Effect<string, CloudAgentError> =>
    Effect.gen(function* () {
      const operation = "diff";
      const attempt = yield* validatedAttempt(operation, input.attempt);
      const executable = yield* ctx.requireCli("canDiff", operation);
      yield* requireDiffAvailable(input.taskId);
      const output = yield* runRead(operation, executable, [
        "cloud",
        "diff",
        input.taskId,
        ...attemptArgs(attempt),
      ]);
      if (output.exitCode === 0) return output.stdout;
      if (isCodexNoDiffStderr(output.stderr)) {
        return yield* new CloudNoDiffError({
          provider: PROVIDER,
          taskId: input.taskId,
          reason: "unavailable",
        });
      }
      return yield* taskLookupFailure(input.taskId, operation, ctx.timeouts.readMs, output);
    });

  const requireCleanWorktreeRoot = (worktreePath: string) =>
    Effect.gen(function* () {
      const operation = "apply";
      if (!nodePath.isAbsolute(worktreePath)) {
        return yield* invalidInput(operation, "worktreePath must be an absolute path");
      }
      const git = ctx.resolveExecutable("git") ?? "git";
      const runGit = (args: ReadonlyArray<string>) =>
        ctx
          .runCli({
            executable: git,
            args: ["-C", worktreePath, ...args],
            timeoutMs: ctx.timeouts.readMs,
          })
          .pipe(Effect.mapError((error) => spawnFailure(PROVIDER, operation, error)));
      const topLevel = yield* runGit(["rev-parse", "--is-inside-work-tree", "--show-prefix"]);
      const [insideWorkTree, prefix = ""] = topLevel.stdout.split("\n");
      const isWorktreeRoot =
        topLevel.exitCode === 0 && insideWorkTree?.trim() === "true" && prefix.trim() === "";
      if (!isWorktreeRoot) {
        return yield* invalidInput(operation, "worktreePath must be the root of a git worktree");
      }
      const status = yield* runGit(["status", "--porcelain=v1", "--untracked-files=all"]);
      if (status.exitCode !== 0) {
        return yield* exitFailure(PROVIDER, operation, ctx.timeouts.readMs, status);
      }
      if (status.stdout.trim().length > 0) {
        return yield* invalidInput(operation, "worktreePath has uncommitted or untracked changes");
      }
    });

  const apply = (input: CloudApplyInput): Effect.Effect<CloudApplyResult, CloudAgentError> =>
    Effect.gen(function* () {
      const operation = "apply";
      const attempt = yield* validatedAttempt(operation, input.attempt);
      const executable = yield* ctx.requireCli("canApply", operation);
      yield* requireCleanWorktreeRoot(input.worktreePath);
      yield* requireDiffAvailable(input.taskId);
      const output = yield* ctx
        .runCli({
          executable,
          args: ["cloud", "apply", input.taskId, ...attemptArgs(attempt)],
          cwd: input.worktreePath,
          timeoutMs: ctx.timeouts.applyMs,
        })
        .pipe(Effect.mapError((error) => spawnFailure(PROVIDER, operation, error)));
      if (output.timedOut) {
        return yield* exitFailure(PROVIDER, operation, ctx.timeouts.applyMs, output);
      }
      if (output.exitCode !== 0 && isCodexNotFoundStderr(output.stderr)) {
        return yield* new CloudTaskNotFoundError({ provider: PROVIDER, taskId: input.taskId });
      }
      if (output.exitCode !== 0 && isCodexNoDiffStderr(output.stderr)) {
        return yield* new CloudNoDiffError({
          provider: PROVIDER,
          taskId: input.taskId,
          reason: "unavailable",
        });
      }
      return {
        provider: PROVIDER,
        taskId: input.taskId,
        attempt: attempt ?? null,
        worktreePath: input.worktreePath,
        outcome: classifyCodexApplyOutput(output),
        detail: firstOutputLines(`${output.stdout}\n${output.stderr}`),
      } satisfies CloudApplyResult;
    });

  const submit = (input: CloudSubmitInput): Effect.Effect<CloudSubmitReceipt, CloudAgentError> =>
    Effect.gen(function* () {
      const operation = "submit";
      if (!isSafeEnvironmentArgument(input.environment)) {
        return yield* invalidInput(operation, "environment is not valid");
      }
      if (!SAFE_BRANCH_PATTERN.test(input.branch)) {
        return yield* invalidInput(operation, "branch is not a valid branch name");
      }
      const attempts = input.attempts ?? 1;
      const executable = yield* ctx.requireCli("canSubmit", operation);
      const capabilities = yield* ctx.capabilities;
      if (!Number.isInteger(attempts) || attempts < 1 || attempts > capabilities.maxAttempts) {
        return yield* invalidInput(operation, `attempts must be 1-${capabilities.maxAttempts}`);
      }
      const uncertain = (detail: string) =>
        new CloudSubmitUncertainError({ provider: PROVIDER, requestId: input.requestId, detail });
      const output = yield* ctx
        .runCli({
          executable,
          args: [
            "cloud",
            "exec",
            "--env",
            input.environment,
            "--branch",
            input.branch,
            "--attempts",
            String(attempts),
            "--",
            input.prompt,
          ],
          timeoutMs: ctx.timeouts.submitMs,
        })
        .pipe(
          Effect.mapError((error) =>
            error.executableMissing
              ? spawnFailure(PROVIDER, operation, error)
              : uncertain(capCliDetail(error.detail)),
          ),
        );
      if (output.timedOut) {
        return yield* uncertain(`exec timed out after ${ctx.timeouts.submitMs} ms`);
      }
      if (output.exitCode !== 0) {
        return yield* exitFailure(PROVIDER, operation, ctx.timeouts.submitMs, output);
      }
      const parsed = parseCodexExecOutput(output.stdout);
      if (!parsed) {
        return yield* uncertain("exec succeeded but printed no task URL");
      }
      return {
        provider: PROVIDER,
        requestId: input.requestId,
        taskId: parsed.taskId,
        url: parsed.url,
        submittedAt: yield* ctx.nowIso,
      } satisfies CloudSubmitReceipt;
    });

  const listEnvironments = Effect.gen(function* () {
    const capabilities = yield* ctx.capabilities;
    if (!capabilities.canList) {
      return mergeCodexEnvironments(options.configuredEnvironments, []);
    }
    const tasks = yield* listAllTasks({ maxPages: 1 });
    return mergeCodexEnvironments(options.configuredEnvironments, tasks);
  });

  return {
    provider: PROVIDER,
    detectCapabilities,
    listEnvironments,
    submit,
    listTasks,
    listAllTasks: (input) =>
      listAllTasks({
        environment: input.environment,
        maxPages: input.maxPages ?? CODEX_LIST_ALL_DEFAULT_MAX_PAGES,
      }),
    getTask,
    status,
    diff,
    apply,
    sendFollowUp: () =>
      Effect.fail(
        unsupportedOperation(
          PROVIDER,
          "follow-up",
          "no-cli-command",
          "The Codex CLI cannot send a follow-up to a cloud task. Continue in ChatGPT.",
        ),
      ),
  };
}
