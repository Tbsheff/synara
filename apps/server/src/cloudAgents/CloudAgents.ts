import { mkdir } from "node:fs/promises";

import {
  CloudCliUnavailableError,
  CloudInvalidInputError,
  CloudSubmitInput,
  type CloudAgentError,
  type CloudApplyResult,
  type CloudCapabilities,
  type CloudEnvironment,
  type CloudFollowUpReceipt,
  type CloudProvider,
  type CloudSubmitReceipt,
  type CloudTask,
  type CloudTaskPage,
  type CloudTaskStatusChange,
} from "@synara/contracts";
import { resolveExecutable } from "@synara/shared/executable";
import { Clock, Effect, Layer, Option, Schema, ServiceMap, Stream } from "effect";

import {
  DEFAULT_CLOUD_AGENTS_TIMEOUTS,
  unsupportedOperation,
  type CloudAgentDriver,
  type CloudAgentsTimeouts,
  type CloudApplyInput,
  type CloudCapabilityFlag,
  type CloudDiffInput,
  type CloudDriverContext,
  type CloudFollowUpInput,
  type CloudListAllTasksInput,
  type CloudListTasksInput,
  type CloudTaskLookupInput,
} from "./cloudAgentDriver.ts";
import { CloudCliRunner } from "./CloudCliRunner.ts";
import { buildCloudCliEnvironment } from "./cloudProcessEnv.ts";
import { makeCloudSubmitGuard } from "./cloudSubmitGuard.ts";
import { pollCloudTaskStatus, type CloudTaskPollOptions } from "./cloudTaskPolling.ts";
import { makeClaudeCloudDriver } from "./claudeCloudDriver.ts";
import { makeCodexCloudDriver, type CodexConfiguredEnvironment } from "./codexCloudDriver.ts";

export interface CloudAgentsConfig {
  readonly scratchDir: string;
  readonly codex: {
    readonly binaryPath: string;
    readonly environments?: ReadonlyArray<CodexConfiguredEnvironment> | undefined;
  };
  readonly claude: {
    readonly binaryPath: string;
  };
  readonly baseEnv?: NodeJS.ProcessEnv | undefined;
  readonly timeouts?: Partial<CloudAgentsTimeouts> | undefined;
  readonly submitGuardCapacity?: number | undefined;
  readonly resolveExecutable?:
    | ((command: string, env: NodeJS.ProcessEnv) => string | null)
    | undefined;
}

export interface CloudProviderInput {
  readonly provider: CloudProvider;
}

export interface CloudAgentsShape {
  readonly capabilities: (provider: CloudProvider) => Effect.Effect<CloudCapabilities>;
  readonly refreshCapabilities: (provider: CloudProvider) => Effect.Effect<CloudCapabilities>;
  readonly listEnvironments: (
    provider: CloudProvider,
  ) => Effect.Effect<ReadonlyArray<CloudEnvironment>, CloudAgentError>;
  readonly submit: (input: CloudSubmitInput) => Effect.Effect<CloudSubmitReceipt, CloudAgentError>;
  readonly listTasks: (
    input: CloudProviderInput & CloudListTasksInput,
  ) => Effect.Effect<CloudTaskPage, CloudAgentError>;
  readonly listAllTasks: (
    input: CloudProviderInput & CloudListAllTasksInput,
  ) => Effect.Effect<ReadonlyArray<CloudTask>, CloudAgentError>;
  readonly getTask: (
    input: CloudProviderInput & CloudTaskLookupInput,
  ) => Effect.Effect<CloudTask, CloudAgentError>;
  readonly status: (
    input: CloudProviderInput & CloudTaskLookupInput,
  ) => Effect.Effect<CloudTask, CloudAgentError>;
  readonly diff: (
    input: CloudProviderInput & CloudDiffInput,
  ) => Effect.Effect<string, CloudAgentError>;
  readonly apply: (
    input: CloudProviderInput & CloudApplyInput,
  ) => Effect.Effect<CloudApplyResult, CloudAgentError>;
  readonly sendFollowUp: (
    input: CloudProviderInput & CloudFollowUpInput,
  ) => Effect.Effect<CloudFollowUpReceipt, CloudAgentError>;
  readonly watchTask: (
    input: CloudProviderInput & CloudTaskLookupInput & CloudTaskPollOptions,
  ) => Stream.Stream<CloudTaskStatusChange, CloudAgentError>;
}

export class CloudAgents extends ServiceMap.Service<CloudAgents, CloudAgentsShape>()(
  "synara/cloudAgents/CloudAgents",
) {}

const decodeSubmitInput = Schema.decodeUnknownOption(CloudSubmitInput);

function requireFlag(
  capabilities: CloudCapabilities,
  flag: CloudCapabilityFlag,
  operation: string,
): Effect.Effect<string, CloudAgentError> {
  if (!capabilities.available || capabilities.executablePath === null) {
    return Effect.fail(
      new CloudCliUnavailableError({
        provider: capabilities.provider,
        detail: capabilities.unavailableReason ?? "the CLI is not available",
      }),
    );
  }
  if (!capabilities[flag]) {
    return Effect.fail(
      unsupportedOperation(
        capabilities.provider,
        operation,
        "capability-missing",
        `${capabilities.provider} CLI ${capabilities.cliVersion ?? ""} does not support ${operation}.`.replace(
          /\s+/g,
          " ",
        ),
      ),
    );
  }
  return Effect.succeed(capabilities.executablePath);
}

export const makeCloudAgents = (config: CloudAgentsConfig) =>
  Effect.gen(function* () {
    const runner = yield* CloudCliRunner;
    yield* Effect.tryPromise(() => mkdir(config.scratchDir, { recursive: true })).pipe(
      Effect.orDie,
    );
    const baseEnv = config.baseEnv ?? process.env;
    const timeouts: CloudAgentsTimeouts = { ...DEFAULT_CLOUD_AGENTS_TIMEOUTS, ...config.timeouts };
    const lookupExecutable =
      config.resolveExecutable ??
      ((command: string, env: NodeJS.ProcessEnv) => resolveExecutable(command, { env }));
    const submitGuard = makeCloudSubmitGuard(config.submitGuardCapacity);
    const capabilityCache = new Map<CloudProvider, CloudCapabilities>();
    const nowIso = Clock.currentTimeMillis.pipe(
      Effect.map((millis) => new Date(millis).toISOString()),
    );

    const driverFor = (provider: CloudProvider): CloudAgentDriver => drivers[provider];

    const refreshCapabilities = (provider: CloudProvider) =>
      driverFor(provider).detectCapabilities.pipe(
        Effect.tap((capabilities) =>
          Effect.sync(() => capabilityCache.set(provider, capabilities)),
        ),
      );

    const capabilities = (provider: CloudProvider) =>
      Effect.suspend(() => {
        const cached = capabilityCache.get(provider);
        return cached ? Effect.succeed(cached) : refreshCapabilities(provider);
      });

    const makeContext = (provider: CloudProvider): CloudDriverContext => {
      const env = buildCloudCliEnvironment(provider, baseEnv);
      return {
        provider,
        scratchDir: config.scratchDir,
        timeouts,
        runCli: (call) =>
          runner.run({
            executable: call.executable,
            args: call.args,
            cwd: call.cwd ?? config.scratchDir,
            env,
            timeoutMs: call.timeoutMs,
            stdin: call.stdin,
          }),
        capabilities: capabilities(provider),
        requireCli: (flag, operation) =>
          capabilities(provider).pipe(
            Effect.flatMap((current) => requireFlag(current, flag, operation)),
          ),
        resolveExecutable: (command) => lookupExecutable(command, env),
        nowIso,
      };
    };

    const drivers: Record<CloudProvider, CloudAgentDriver> = {
      codex: makeCodexCloudDriver(makeContext("codex"), {
        binaryPath: config.codex.binaryPath,
        configuredEnvironments: config.codex.environments ?? [],
      }),
      claude: makeClaudeCloudDriver(makeContext("claude"), {
        binaryPath: config.claude.binaryPath,
      }),
    };

    const submit = (input: CloudSubmitInput) =>
      Effect.suspend(() => {
        const decoded = decodeSubmitInput(input);
        if (Option.isNone(decoded)) {
          return Effect.fail(
            new CloudInvalidInputError({
              provider: input.provider,
              operation: "submit",
              detail: "submit input is not valid",
            }),
          );
        }
        const valid = decoded.value;
        return submitGuard.run(
          valid.provider,
          valid.requestId,
          driverFor(valid.provider).submit(valid),
        );
      });

    const getTask = (input: CloudProviderInput & CloudTaskLookupInput) =>
      driverFor(input.provider).getTask(input);

    return {
      capabilities,
      refreshCapabilities,
      listEnvironments: (provider) => driverFor(provider).listEnvironments,
      submit,
      listTasks: (input) => driverFor(input.provider).listTasks(input),
      listAllTasks: (input) => driverFor(input.provider).listAllTasks(input),
      getTask,
      status: (input) => driverFor(input.provider).status(input),
      diff: (input) => driverFor(input.provider).diff(input),
      apply: (input) => driverFor(input.provider).apply(input),
      sendFollowUp: (input) => driverFor(input.provider).sendFollowUp(input),
      watchTask: (input) => pollCloudTaskStatus(getTask(input), input),
    } satisfies CloudAgentsShape;
  });

export const makeCloudAgentsLayer = (config: CloudAgentsConfig) =>
  Layer.effect(CloudAgents, makeCloudAgents(config));
