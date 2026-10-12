import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import nodePath from "node:path";

import {
  CLOUD_DIFF_MAX_BYTES,
  CLOUD_PROMPT_SUMMARY_MAX_LENGTH,
  CloudInvalidInputError,
  CloudSubmitUncertainError,
  type CloudAgentError,
  type CloudApplyResult,
  type CloudApplyToWorktreeInput,
  type CloudCapabilities,
  type CloudFollowUpReceipt,
  type CloudGetCapabilitiesInput,
  type CloudGetDiffInput,
  type CloudGetDiffResult,
  type CloudListEnvironmentsResult,
  type CloudListSubmissionsInput,
  type CloudListSubmissionsResult,
  type CloudListTasksRpcInput,
  type CloudProvider,
  type CloudProviderInput,
  type CloudSendFollowUpInput,
  type CloudSubmission,
  type CloudSubmitReceipt,
  type CloudSubmitRpcInput,
  type CloudTask,
  type CloudTaskPage,
  type CloudTaskRefInput,
  type CloudTaskStatus,
  type CloudWatchTaskEvent,
} from "@synara/contracts";
import { resolveExecutable } from "@synara/shared/executable";
import {
  Cause,
  Clock,
  Effect,
  Exit,
  Deferred,
  Layer,
  Option,
  Scope,
  ServiceMap,
  Stream,
} from "effect";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";
import { CloudSubmissionRepository } from "../persistence/Services/CloudSubmissionRepository.ts";
import type { CloudSubmissionRepositoryError } from "../persistence/Services/CloudSubmissionRepository.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeCloudAgents, type CloudAgentsShape } from "./CloudAgents.ts";
import { CloudCliRunner } from "./CloudCliRunner.ts";
import {
  claudeCloudBinaryPath,
  codexBinaryUnresolvedFallback,
  codexCloudBinaryCandidates,
  selectCodexCloudBinary,
  type CloudBinaryCandidateInput,
} from "./cloudBinaryResolution.ts";
import { parseCodexVersion } from "./codexCloudCli.ts";
import { buildCloudCliEnvironment } from "./cloudProcessEnv.ts";

export type CloudGatewayError = CloudAgentError | CloudSubmissionRepositoryError;

export interface CloudAgentsGatewayShape {
  readonly getCapabilities: (
    input: CloudGetCapabilitiesInput,
  ) => Effect.Effect<CloudCapabilities, CloudGatewayError>;
  readonly listEnvironments: (
    input: CloudProviderInput,
  ) => Effect.Effect<CloudListEnvironmentsResult, CloudGatewayError>;
  readonly listTasks: (
    input: CloudListTasksRpcInput,
  ) => Effect.Effect<CloudTaskPage, CloudGatewayError>;
  readonly getTask: (input: CloudTaskRefInput) => Effect.Effect<CloudTask, CloudGatewayError>;
  readonly submit: (
    input: CloudSubmitRpcInput,
  ) => Effect.Effect<CloudSubmission, CloudGatewayError>;
  readonly listSubmissions: (
    input: CloudListSubmissionsInput,
  ) => Effect.Effect<CloudListSubmissionsResult, CloudGatewayError>;
  readonly getDiff: (
    input: CloudGetDiffInput,
  ) => Effect.Effect<CloudGetDiffResult, CloudGatewayError>;
  readonly applyToWorktree: (
    input: CloudApplyToWorktreeInput,
  ) => Effect.Effect<CloudApplyResult, CloudGatewayError>;
  readonly sendFollowUp: (
    input: CloudSendFollowUpInput,
  ) => Effect.Effect<CloudFollowUpReceipt, CloudGatewayError>;
  readonly watchTask: (input: CloudTaskRefInput) => Stream.Stream<CloudWatchTaskEvent>;
}

export class CloudAgentsGateway extends ServiceMap.Service<
  CloudAgentsGateway,
  CloudAgentsGatewayShape
>()("synara/cloudAgents/CloudAgentsGateway") {}

export const CLOUD_SUBMIT_RESTART_DETAIL =
  "Synara stopped while this submit was running. Check the task list before you submit again.";
export const CLOUD_SUBMIT_INTERRUPTED_DETAIL =
  "The submit stopped before the CLI returned a task. Check the task list before you submit again.";

const DEFAULT_SUBMISSION_LIST_LIMIT = 100;
const CLOUD_SCRATCH_DIRECTORY = "cloud-agents";

const RETRYABLE_PREFLIGHT_ERROR_TAGS: ReadonlySet<string> = new Set([
  "CloudInvalidInputError",
  "CloudCliUnavailableError",
  "CloudOperationUnsupportedError",
]);

const UNCERTAIN_ERROR_TAGS: ReadonlySet<string> = new Set([
  "CloudSubmitUncertainError",
  "CloudCliTimeoutError",
]);

export interface CloudAgentsGatewayOptions {
  readonly baseEnv?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly homeDir?: string | undefined;
  readonly resolveExecutable?:
    | ((command: string, env: NodeJS.ProcessEnv) => string | null)
    | undefined;
  readonly buildCloudAgents?:
    | ((config: {
        readonly scratchDir: string;
        readonly codexBinaryPath: string;
        readonly claudeBinaryPath: string;
      }) => Effect.Effect<CloudAgentsShape>)
    | undefined;
}

export function summarizeCloudPrompt(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, " ").trim();
  return collapsed.length <= CLOUD_PROMPT_SUMMARY_MAX_LENGTH
    ? collapsed
    : `${collapsed.slice(0, CLOUD_PROMPT_SUMMARY_MAX_LENGTH - 1)}…`;
}

export function capCloudPatch(patch: string, maxBytes: number = CLOUD_DIFF_MAX_BYTES) {
  const bytes = Buffer.from(patch, "utf8");
  if (bytes.byteLength <= maxBytes) {
    return { patch, truncated: false };
  }
  const head = bytes.subarray(0, maxBytes).toString("utf8");
  const lastNewline = head.lastIndexOf("\n");
  return { patch: lastNewline > 0 ? head.slice(0, lastNewline + 1) : head, truncated: true };
}

export function isPathInsideDirectory(directory: string, candidate: string): boolean {
  const relative = nodePath.relative(directory, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !nodePath.isAbsolute(relative);
}

const realpathOrNull = (path: string) =>
  Effect.promise(() => realpath(path).catch(() => null as string | null));

function errorTag(error: unknown): string | null {
  return typeof error === "object" && error !== null && "_tag" in error
    ? String((error as { _tag: unknown })._tag)
    : null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

export const makeCloudAgentsGateway = (options: CloudAgentsGatewayOptions = {}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const settingsService = yield* ServerSettingsService;
    const repository = yield* CloudSubmissionRepository;
    const runner = yield* CloudCliRunner;
    const baseEnv = options.baseEnv ?? process.env;
    const platform = options.platform ?? process.platform;
    const homeDir = options.homeDir ?? homedir();
    const lookupExecutable =
      options.resolveExecutable ??
      ((command: string, env: NodeJS.ProcessEnv) => resolveExecutable(command, { env }));
    const scratchDir = nodePath.join(config.stateDir, CLOUD_SCRATCH_DIRECTORY);
    const codexEnv = buildCloudCliEnvironment("codex", baseEnv);

    const nowIso = Clock.currentTimeMillis.pipe(
      Effect.map((millis) => new Date(millis).toISOString()),
    );

    yield* nowIso.pipe(
      Effect.flatMap((updatedAt) =>
        repository.markInterruptedSubmitsUncertain({
          updatedAt,
          errorDetail: CLOUD_SUBMIT_RESTART_DETAIL,
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("cloud submit restart sweep failed", { cause: Cause.pretty(cause) }),
      ),
    );

    const submitScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(submitScope, Exit.void));

    const buildLock = yield* Semaphore.make(1);
    let current: { readonly fingerprint: string; readonly service: CloudAgentsShape } | null = null;

    const probeCodexVersion = (path: string) =>
      runner
        .run({
          executable: path,
          args: ["--version"],
          cwd: config.stateDir,
          env: codexEnv,
          timeoutMs: 15_000,
        })
        .pipe(
          Effect.map((output) => (output.exitCode === 0 ? parseCodexVersion(output.stdout) : null)),
          Effect.orElseSucceed(() => null),
        );

    const defaultBuild = (built: {
      readonly scratchDir: string;
      readonly codexBinaryPath: string;
      readonly claudeBinaryPath: string;
    }) =>
      makeCloudAgents({
        scratchDir: built.scratchDir,
        codex: { binaryPath: built.codexBinaryPath },
        claude: { binaryPath: built.claudeBinaryPath },
        baseEnv,
        resolveExecutable: lookupExecutable,
      }).pipe(Effect.provideService(CloudCliRunner, runner));

    const build = options.buildCloudAgents ?? defaultBuild;

    const resolveBinaries = Effect.gen(function* () {
      const settings = yield* settingsService.getSettings.pipe(Effect.option);
      const codexSettingsPath = Option.match(settings, {
        onNone: () => "codex",
        onSome: (value) => value.providers.codex.binaryPath,
      });
      const claudeSettingsPath = Option.match(settings, {
        onNone: () => "claude",
        onSome: (value) => value.providers.claudeAgent.binaryPath,
      });
      const candidateInput: CloudBinaryCandidateInput = {
        env: baseEnv,
        settingsBinaryPath: codexSettingsPath,
        platform,
        homeDir,
        resolve: (command) => lookupExecutable(command, codexEnv),
      };
      return {
        candidateInput,
        claudeBinaryPath: claudeCloudBinaryPath({
          env: baseEnv,
          settingsBinaryPath: claudeSettingsPath,
        }),
      };
    });

    const cloudAgents = (forceRebuild: boolean) =>
      buildLock.withPermits(1)(
        Effect.gen(function* () {
          const { candidateInput, claudeBinaryPath } = yield* resolveBinaries;
          const candidates = codexCloudBinaryCandidates(candidateInput);
          const fingerprint = JSON.stringify([candidates, claudeBinaryPath]);
          if (current !== null && !forceRebuild && current.fingerprint === fingerprint) {
            return current.service;
          }
          const selected = yield* selectCodexCloudBinary(candidates, probeCodexVersion);
          const service = yield* build({
            scratchDir,
            codexBinaryPath: selected ?? codexBinaryUnresolvedFallback(candidateInput),
            claudeBinaryPath,
          });
          current = { fingerprint, service };
          return service;
        }),
      );

    const withCloud = <A, E>(use: (cloud: CloudAgentsShape) => Effect.Effect<A, E>) =>
      cloudAgents(false).pipe(Effect.flatMap(use));

    const recordStatus = (provider: CloudProvider, task: CloudTask) =>
      nowIso.pipe(
        Effect.flatMap((updatedAt) =>
          repository.recordTaskStatus({
            provider,
            taskId: task.id,
            lastStatus: task.status satisfies CloudTaskStatus,
            updatedAt,
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("cloud task status record failed", { cause: Cause.pretty(cause) }),
        ),
      );

    const inFlightSubmits = new Map<
      string,
      Deferred.Deferred<CloudSubmission, CloudGatewayError>
    >();
    const submitLock = yield* Semaphore.make(1);

    const settleSubmission = (
      pending: CloudSubmission,
      exit: Exit.Exit<CloudSubmitReceipt, CloudAgentError>,
    ): Effect.Effect<CloudSubmission, CloudGatewayError> =>
      Effect.gen(function* () {
        const updatedAt = yield* nowIso;
        if (Exit.isSuccess(exit)) {
          const settled: CloudSubmission = {
            ...pending,
            state: "submitted",
            taskId: exit.value.taskId,
            taskUrl: exit.value.url,
            lastStatus: "pending",
            errorDetail: null,
            updatedAt,
          };
          yield* repository.update(settled);
          return settled;
        }
        const failure = Exit.findErrorOption(exit);
        const tag = Option.isSome(failure) ? failure.value._tag : null;
        if (Option.isSome(failure) && RETRYABLE_PREFLIGHT_ERROR_TAGS.has(failure.value._tag)) {
          yield* repository.delete({ provider: pending.provider, requestId: pending.requestId });
          return yield* Effect.fail(failure.value);
        }
        const uncertain = Exit.hasInterrupts(exit) || tag === null || UNCERTAIN_ERROR_TAGS.has(tag);
        const settled: CloudSubmission = {
          ...pending,
          state: uncertain ? "uncertain" : "failed",
          errorDetail: Option.isSome(failure)
            ? failure.value.message
            : CLOUD_SUBMIT_INTERRUPTED_DETAIL,
          updatedAt,
        };
        yield* repository.update(settled);
        return settled;
      });

    const runSubmit = (input: CloudSubmitRpcInput, key: string) =>
      Effect.gen(function* () {
        const createdAt = yield* nowIso;
        const pending: CloudSubmission = {
          provider: input.provider,
          requestId: input.requestId,
          projectId: input.projectId ?? null,
          environment: input.environment,
          branch: input.branch,
          promptSummary: summarizeCloudPrompt(input.prompt),
          state: "submitting",
          taskId: null,
          taskUrl: null,
          lastStatus: null,
          errorDetail: null,
          createdAt,
          updatedAt: createdAt,
        };
        yield* repository.insert(pending);
        const cloud = yield* cloudAgents(false);
        const exit = yield* cloud
          .submit({
            provider: input.provider,
            requestId: input.requestId,
            environment: input.environment,
            prompt: input.prompt,
            branch: input.branch,
            ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
          })
          .pipe(Effect.exit);
        return yield* settleSubmission(pending, exit);
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            const row = yield* repository.get({
              provider: input.provider,
              requestId: input.requestId,
            });
            if (Option.isSome(row) && row.value.state === "submitting") {
              yield* repository.update({
                ...row.value,
                state: "uncertain",
                errorDetail: CLOUD_SUBMIT_INTERRUPTED_DETAIL,
                updatedAt: yield* nowIso,
              });
            }
          }).pipe(Effect.ignore),
        ),
        Effect.ensuring(Effect.sync(() => inFlightSubmits.delete(key))),
      );

    const submit: CloudAgentsGatewayShape["submit"] = (input) =>
      Effect.gen(function* () {
        const key = `${input.provider}\u0000${input.requestId}`;
        const decision = yield* submitLock.withPermits(1)(
          Effect.gen(function* () {
            const running = inFlightSubmits.get(key);
            if (running) return { kind: "join", outcome: running } as const;
            const existing = yield* repository.get({
              provider: input.provider,
              requestId: input.requestId,
            });
            if (Option.isSome(existing)) {
              return { kind: "stored", submission: existing.value } as const;
            }
            const outcome = yield* Deferred.make<CloudSubmission, CloudGatewayError>();
            inFlightSubmits.set(key, outcome);
            yield* runSubmit(input, key).pipe(
              Effect.exit,
              Effect.flatMap((exit) => Deferred.done(outcome, exit)),
              Effect.forkIn(submitScope),
            );
            return { kind: "join", outcome } as const;
          }),
        );
        if (decision.kind === "join") {
          return yield* Deferred.await(decision.outcome);
        }
        if (decision.submission.state === "submitting") {
          return yield* new CloudSubmitUncertainError({
            provider: input.provider,
            requestId: input.requestId,
            detail: CLOUD_SUBMIT_RESTART_DETAIL,
          });
        }
        return decision.submission;
      });

    const getDiff: CloudAgentsGatewayShape["getDiff"] = (input) =>
      withCloud((cloud) =>
        cloud
          .diff({
            provider: input.provider,
            taskId: input.taskId,
            ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
          })
          .pipe(
            Effect.map((patch) => ({
              provider: input.provider,
              taskId: input.taskId,
              attempt: input.attempt ?? null,
              ...capCloudPatch(patch),
            })),
          ),
      );

    const applyToWorktree: CloudAgentsGatewayShape["applyToWorktree"] = (input) =>
      Effect.gen(function* () {
        const worktreesRoot = yield* realpathOrNull(config.worktreesDir);
        const target = nodePath.isAbsolute(input.worktreePath)
          ? yield* realpathOrNull(input.worktreePath)
          : null;
        if (
          worktreesRoot === null ||
          target === null ||
          !isPathInsideDirectory(worktreesRoot, target)
        ) {
          return yield* new CloudInvalidInputError({
            provider: input.provider,
            operation: "apply",
            detail: "Apply needs a Synara-managed worktree. Choose or create one first.",
          });
        }
        return yield* withCloud((cloud) =>
          cloud.apply({
            provider: input.provider,
            taskId: input.taskId,
            worktreePath: target,
            ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
          }),
        );
      });

    const watchTask: CloudAgentsGatewayShape["watchTask"] = (input) =>
      Stream.unwrap(
        cloudAgents(false).pipe(
          Effect.map((cloud) =>
            cloud.watchTask({ provider: input.provider, taskId: input.taskId }).pipe(
              Stream.tap((change) => recordStatus(input.provider, change.task)),
              Stream.map((change): CloudWatchTaskEvent => ({ type: "status", change })),
            ),
          ),
        ),
      ).pipe(
        Stream.catchCause((cause) => {
          const failure = Cause.findErrorOption(cause);
          const error = Option.isSome(failure) ? failure.value : Cause.squash(cause);
          const event: CloudWatchTaskEvent = {
            type: "error",
            code: errorTag(error) ?? "CloudWatchFailed",
            message: errorMessage(error, "Synara could not read the cloud task status."),
          };
          return Stream.succeed(event);
        }),
        Stream.concat(Stream.never),
      );

    return {
      getCapabilities: (input) =>
        cloudAgents(input.refresh === true).pipe(
          Effect.flatMap((cloud) =>
            input.refresh === true
              ? cloud.refreshCapabilities(input.provider)
              : cloud.capabilities(input.provider),
          ),
        ),
      listEnvironments: (input) =>
        withCloud((cloud) =>
          cloud
            .listEnvironments(input.provider)
            .pipe(Effect.map((environments) => ({ environments }))),
        ),
      listTasks: (input) =>
        withCloud((cloud) =>
          cloud.listTasks({
            provider: input.provider,
            ...(input.environment !== undefined ? { environment: input.environment } : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
            ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
          }),
        ),
      getTask: (input) =>
        withCloud((cloud) =>
          cloud
            .getTask({ provider: input.provider, taskId: input.taskId })
            .pipe(Effect.tap((task) => recordStatus(input.provider, task))),
        ),
      submit,
      listSubmissions: (input) =>
        repository
          .list({
            projectId: input.projectId ?? null,
            limit: input.limit ?? DEFAULT_SUBMISSION_LIST_LIMIT,
          })
          .pipe(Effect.map((submissions) => ({ submissions }))),
      getDiff,
      applyToWorktree,
      sendFollowUp: (input) =>
        withCloud((cloud) =>
          cloud.sendFollowUp({
            provider: input.provider,
            sessionReference: input.sessionReference,
            message: input.message,
          }),
        ),
      watchTask,
    } satisfies CloudAgentsGatewayShape;
  });

export const makeCloudAgentsGatewayLayer = (options: CloudAgentsGatewayOptions = {}) =>
  Layer.effect(CloudAgentsGateway, makeCloudAgentsGateway(options));
