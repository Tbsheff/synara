import {
  CloudSubmitInFlightError,
  CloudSubmitUncertainError,
  type CloudAgentError,
  type CloudProvider,
  type CloudSubmitReceipt,
} from "@synara/contracts";
import { Effect, Exit, Option } from "effect";

export const DEFAULT_CLOUD_SUBMIT_GUARD_CAPACITY = 500;

const RETRYABLE_PREFLIGHT_ERROR_TAGS: ReadonlySet<string> = new Set([
  "CloudInvalidInputError",
  "CloudCliUnavailableError",
  "CloudOperationUnsupportedError",
]);

type SubmitExit = Exit.Exit<CloudSubmitReceipt, CloudAgentError>;

type GuardEntry =
  | { readonly kind: "pending" }
  | { readonly kind: "settled"; readonly exit: SubmitExit };

export interface CloudSubmitGuard {
  readonly run: (
    provider: CloudProvider,
    requestId: string,
    submit: Effect.Effect<CloudSubmitReceipt, CloudAgentError>,
  ) => Effect.Effect<CloudSubmitReceipt, CloudAgentError>;
}

function isRetryablePreflightFailure(exit: SubmitExit): boolean {
  if (Exit.isSuccess(exit)) return false;
  const failure = Exit.findErrorOption(exit);
  return Option.isSome(failure) && RETRYABLE_PREFLIGHT_ERROR_TAGS.has(failure.value._tag);
}

function replay(exit: SubmitExit): Effect.Effect<CloudSubmitReceipt, CloudAgentError> {
  return Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause);
}

export function makeCloudSubmitGuard(
  capacity: number = DEFAULT_CLOUD_SUBMIT_GUARD_CAPACITY,
): CloudSubmitGuard {
  const entries = new Map<string, GuardEntry>();

  const evictOldestSettled = () => {
    for (const [key, entry] of entries) {
      if (entries.size <= capacity) return;
      if (entry.kind === "settled") entries.delete(key);
    }
  };

  const settle = (
    key: string,
    provider: CloudProvider,
    requestId: string,
    exit: SubmitExit,
  ): void => {
    if (isRetryablePreflightFailure(exit)) {
      entries.delete(key);
      return;
    }
    const recorded: SubmitExit = Exit.hasInterrupts(exit)
      ? Exit.fail(
          new CloudSubmitUncertainError({
            provider,
            requestId,
            detail: "submit was cancelled while the CLI was running",
          }),
        )
      : exit;
    entries.delete(key);
    entries.set(key, { kind: "settled", exit: recorded });
    evictOldestSettled();
  };

  return {
    run: (provider, requestId, submit) =>
      Effect.suspend(() => {
        const key = `${provider}\u0000${requestId}`;
        const existing = entries.get(key);
        if (existing?.kind === "pending") {
          return Effect.fail(new CloudSubmitInFlightError({ provider, requestId }));
        }
        if (existing?.kind === "settled") {
          return replay(existing.exit);
        }
        entries.set(key, { kind: "pending" });
        return submit.pipe(
          Effect.onExit((exit) => Effect.sync(() => settle(key, provider, requestId, exit))),
        );
      }),
  };
}
