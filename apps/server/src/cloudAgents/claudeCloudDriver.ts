import {
  CLOUD_FOLLOW_UP_MESSAGE_MAX_LENGTH,
  CloudInvalidInputError,
  CloudOutputParseError,
  CloudTaskNotFoundError,
  type CloudAgentError,
  type CloudCapabilities,
  type CloudFollowUpReceipt,
} from "@synara/contracts";
import { Effect, Result } from "effect";

import {
  exitFailure,
  spawnFailure,
  unavailableCapabilities,
  unsupportedOperation,
  type CloudAgentDriver,
  type CloudDriverContext,
  type CloudFollowUpInput,
} from "./cloudAgentDriver.ts";
import {
  classifyClaudeCloudStderr,
  parseClaudeFollowUpReceipt,
  parseClaudeSessionReference,
  parseClaudeVersion,
} from "./claudeCloudCli.ts";
import { capCliDetail, helpListsFlag } from "./codexCloudCli.ts";

const PROVIDER = "claude" as const;

export const CLAUDE_CLOUD_START_INTERACTIVE_ONLY_DETAIL =
  "Claude Code starts a cloud session only in an interactive terminal. Start it at claude.ai/code or with `claude --cloud` in a terminal, then attach to it by session ID.";

const CLAUDE_NO_CLI_COMMAND_DETAIL =
  "Claude Code has no supported command for this cloud operation. Open the session at claude.ai/code.";

export interface ClaudeCloudDriverOptions {
  readonly binaryPath: string;
}

export function makeClaudeCloudDriver(
  ctx: CloudDriverContext,
  options: ClaudeCloudDriverOptions,
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
        `Claude Code CLI was not found (${options.binaryPath}).`,
      );
    }
    const [versionOutput, helpOutput] = yield* Effect.all(
      [probe(executable, ["--version"]), probe(executable, ["--help"])],
      { concurrency: "unbounded" },
    );
    const version = versionOutput?.exitCode === 0 ? parseClaudeVersion(versionOutput.stdout) : null;
    if (!version) {
      return unavailableCapabilities(
        PROVIDER,
        executable,
        null,
        "Claude Code CLI version is unreadable.",
      );
    }
    const helpText = helpOutput?.stdout ?? "";
    const hasCloudFlag = helpListsFlag(helpText, "--cloud");
    if (!hasCloudFlag) {
      return unavailableCapabilities(
        PROVIDER,
        executable,
        version,
        `Claude Code ${version} has no --cloud option.`,
      );
    }
    return {
      provider: PROVIDER,
      executablePath: executable,
      cliVersion: version,
      available: true,
      unavailableReason: null,
      canSubmit: false,
      canList: false,
      canStatus: false,
      canDiff: false,
      canApply: false,
      canFollowUp: helpListsFlag(helpText, "--output-format"),
      canCancel: false,
      canListEnvironments: false,
      maxAttempts: 0,
    } satisfies CloudCapabilities;
  });

  const sendFollowUp = (
    input: CloudFollowUpInput,
  ): Effect.Effect<CloudFollowUpReceipt, CloudAgentError> =>
    Effect.gen(function* () {
      const operation = "follow-up";
      const sessionId = parseClaudeSessionReference(input.sessionReference);
      if (!sessionId) {
        return yield* new CloudInvalidInputError({
          provider: PROVIDER,
          operation,
          detail: "session reference must be a Claude cloud session ID or claude.ai/code URL",
        });
      }
      const message = input.message.trim();
      if (message.length === 0 || message.length > CLOUD_FOLLOW_UP_MESSAGE_MAX_LENGTH) {
        return yield* new CloudInvalidInputError({
          provider: PROVIDER,
          operation,
          detail: `message must be 1-${CLOUD_FOLLOW_UP_MESSAGE_MAX_LENGTH} characters`,
        });
      }
      const executable = yield* ctx.requireCli("canFollowUp", operation);
      const output = yield* ctx
        .runCli({
          executable,
          args: ["--print", "--cloud", sessionId, "--output-format", "json", "--", message],
          timeoutMs: ctx.timeouts.followUpMs,
        })
        .pipe(Effect.mapError((error) => spawnFailure(PROVIDER, operation, error)));
      if (output.timedOut || output.exitCode !== 0) {
        const failureKind = output.timedOut ? "other" : classifyClaudeCloudStderr(output.stderr);
        if (failureKind === "interactive-only") {
          return yield* unsupportedOperation(
            PROVIDER,
            operation,
            "interactive-only",
            capCliDetail(output.stderr),
          );
        }
        if (failureKind === "not-found") {
          return yield* new CloudTaskNotFoundError({ provider: PROVIDER, taskId: sessionId });
        }
        return yield* exitFailure(PROVIDER, operation, ctx.timeouts.followUpMs, output);
      }
      const receipt = parseClaudeFollowUpReceipt(output.stdout, sessionId);
      if (!receipt.ok) {
        return yield* new CloudOutputParseError({
          provider: PROVIDER,
          operation,
          detail: capCliDetail(receipt.detail),
        });
      }
      return { provider: PROVIDER, sessionId: receipt.sessionId, url: receipt.url };
    });

  const noCliCommand = (operation: string) =>
    Effect.fail(
      unsupportedOperation(PROVIDER, operation, "no-cli-command", CLAUDE_NO_CLI_COMMAND_DETAIL),
    );

  return {
    provider: PROVIDER,
    detectCapabilities,
    listEnvironments: noCliCommand("list-environments"),
    submit: () =>
      Effect.fail(
        unsupportedOperation(
          PROVIDER,
          "submit",
          "interactive-only",
          CLAUDE_CLOUD_START_INTERACTIVE_ONLY_DETAIL,
        ),
      ),
    listTasks: () => noCliCommand("list"),
    listAllTasks: () => noCliCommand("list"),
    getTask: () => noCliCommand("status"),
    status: () => noCliCommand("status"),
    diff: () => noCliCommand("diff"),
    apply: () => noCliCommand("apply"),
    sendFollowUp,
  };
}
