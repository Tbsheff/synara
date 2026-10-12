import {
  CLOUD_AGENTS_BETA_ONLY_MESSAGE,
  CLOUD_AGENTS_UNAVAILABLE_ERROR_CODE,
  CLOUD_AGENTS_WS_METHODS,
  WsRpcError,
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
  type CloudProviderInput,
  type CloudSendFollowUpInput,
  type CloudSubmission,
  type CloudSubmitRpcInput,
  type CloudTask,
  type CloudTaskPage,
  type CloudTaskRefInput,
  type CloudWatchTaskEvent,
} from "@synara/contracts";
import { Effect, Stream } from "effect";

import type { CloudAgentsGatewayShape } from "./CloudAgentsGateway.ts";

const CLOUD_ERROR_TAG_PREFIX = "Cloud";

export interface WsCloudHandlers {
  readonly [CLOUD_AGENTS_WS_METHODS.getCapabilities]: (
    input: CloudGetCapabilitiesInput,
  ) => Effect.Effect<CloudCapabilities, WsRpcError>;
  readonly [CLOUD_AGENTS_WS_METHODS.listEnvironments]: (
    input: CloudProviderInput,
  ) => Effect.Effect<CloudListEnvironmentsResult, WsRpcError>;
  readonly [CLOUD_AGENTS_WS_METHODS.listTasks]: (
    input: CloudListTasksRpcInput,
  ) => Effect.Effect<CloudTaskPage, WsRpcError>;
  readonly [CLOUD_AGENTS_WS_METHODS.getTask]: (
    input: CloudTaskRefInput,
  ) => Effect.Effect<CloudTask, WsRpcError>;
  readonly [CLOUD_AGENTS_WS_METHODS.submit]: (
    input: CloudSubmitRpcInput,
  ) => Effect.Effect<CloudSubmission, WsRpcError>;
  readonly [CLOUD_AGENTS_WS_METHODS.listSubmissions]: (
    input: CloudListSubmissionsInput,
  ) => Effect.Effect<CloudListSubmissionsResult, WsRpcError>;
  readonly [CLOUD_AGENTS_WS_METHODS.getDiff]: (
    input: CloudGetDiffInput,
  ) => Effect.Effect<CloudGetDiffResult, WsRpcError>;
  readonly [CLOUD_AGENTS_WS_METHODS.applyToWorktree]: (
    input: CloudApplyToWorktreeInput,
  ) => Effect.Effect<CloudApplyResult, WsRpcError>;
  readonly [CLOUD_AGENTS_WS_METHODS.sendFollowUp]: (
    input: CloudSendFollowUpInput,
  ) => Effect.Effect<CloudFollowUpReceipt, WsRpcError>;
}

export interface WsCloudHandlerDependencies {
  readonly enabled: boolean;
  readonly gateway: CloudAgentsGatewayShape | undefined;
}

export function cloudAgentsUnavailableError(): WsRpcError {
  return new WsRpcError({
    message: CLOUD_AGENTS_BETA_ONLY_MESSAGE,
    code: CLOUD_AGENTS_UNAVAILABLE_ERROR_CODE,
    retryable: false,
  });
}

function cloudErrorCode(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null || !("_tag" in cause)) return undefined;
  const tag = String((cause as { readonly _tag: unknown })._tag);
  return tag.startsWith(CLOUD_ERROR_TAG_PREFIX) ? tag : undefined;
}

export function toCloudWsRpcError(cause: unknown, fallbackMessage: string): WsRpcError {
  if (cause instanceof WsRpcError) return cause;
  const code = cloudErrorCode(cause);
  return new WsRpcError({
    message: cause instanceof Error && cause.message.length > 0 ? cause.message : fallbackMessage,
    ...(code !== undefined ? { code } : {}),
    retryable: false,
  });
}

const refuse = () => Effect.fail(cloudAgentsUnavailableError());

function activeGateway(
  dependencies: WsCloudHandlerDependencies,
): CloudAgentsGatewayShape | undefined {
  return dependencies.enabled ? dependencies.gateway : undefined;
}

export function makeWsCloudHandlers(dependencies: WsCloudHandlerDependencies): WsCloudHandlers {
  const gateway = activeGateway(dependencies);
  if (gateway === undefined) {
    return {
      [CLOUD_AGENTS_WS_METHODS.getCapabilities]: refuse,
      [CLOUD_AGENTS_WS_METHODS.listEnvironments]: refuse,
      [CLOUD_AGENTS_WS_METHODS.listTasks]: refuse,
      [CLOUD_AGENTS_WS_METHODS.getTask]: refuse,
      [CLOUD_AGENTS_WS_METHODS.submit]: refuse,
      [CLOUD_AGENTS_WS_METHODS.listSubmissions]: refuse,
      [CLOUD_AGENTS_WS_METHODS.getDiff]: refuse,
      [CLOUD_AGENTS_WS_METHODS.applyToWorktree]: refuse,
      [CLOUD_AGENTS_WS_METHODS.sendFollowUp]: refuse,
    };
  }
  const run = <A, E>(effect: Effect.Effect<A, E>, fallbackMessage: string) =>
    effect.pipe(Effect.mapError((cause) => toCloudWsRpcError(cause, fallbackMessage)));
  return {
    [CLOUD_AGENTS_WS_METHODS.getCapabilities]: (input) =>
      run(gateway.getCapabilities(input), "Failed to check the cloud CLI"),
    [CLOUD_AGENTS_WS_METHODS.listEnvironments]: (input) =>
      run(gateway.listEnvironments(input), "Failed to list cloud environments"),
    [CLOUD_AGENTS_WS_METHODS.listTasks]: (input) =>
      run(gateway.listTasks(input), "Failed to list cloud tasks"),
    [CLOUD_AGENTS_WS_METHODS.getTask]: (input) =>
      run(gateway.getTask(input), "Failed to read the cloud task"),
    [CLOUD_AGENTS_WS_METHODS.submit]: (input) =>
      run(gateway.submit(input), "Failed to submit the cloud task"),
    [CLOUD_AGENTS_WS_METHODS.listSubmissions]: (input) =>
      run(gateway.listSubmissions(input), "Failed to list submitted cloud tasks"),
    [CLOUD_AGENTS_WS_METHODS.getDiff]: (input) =>
      run(gateway.getDiff(input), "Failed to read the cloud diff"),
    [CLOUD_AGENTS_WS_METHODS.applyToWorktree]: (input) =>
      run(gateway.applyToWorktree(input), "Failed to apply the cloud diff"),
    [CLOUD_AGENTS_WS_METHODS.sendFollowUp]: (input) =>
      run(gateway.sendFollowUp(input), "Failed to send the cloud follow-up"),
  };
}

export function makeCloudWatchTaskStream(
  dependencies: WsCloudHandlerDependencies,
  input: CloudTaskRefInput,
): Stream.Stream<CloudWatchTaskEvent, WsRpcError> {
  const gateway = activeGateway(dependencies);
  return gateway === undefined
    ? Stream.fail(cloudAgentsUnavailableError())
    : gateway.watchTask(input);
}
