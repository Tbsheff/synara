import {
  CLOUD_TASK_TERMINAL_STATUSES,
  type CloudAgentError,
  type CloudTask,
  type CloudTaskStatus,
  type CloudTaskStatusChange,
} from "@synara/contracts";
import { Clock, Duration, Effect, Option, Result, Stream } from "effect";

export const DEFAULT_CLOUD_POLL_INTERVAL_MS = 20_000;
export const DEFAULT_CLOUD_POLL_MAX_INTERVAL_MS = 300_000;
export const DEFAULT_CLOUD_POLL_MAX_CONSECUTIVE_ERRORS = 5;
export const DEFAULT_CLOUD_POLL_JITTER_RATIO = 0.1;

const NON_RETRYABLE_POLL_ERROR_TAGS: ReadonlySet<string> = new Set([
  "CloudTaskNotFoundError",
  "CloudInvalidInputError",
  "CloudCliUnavailableError",
  "CloudOperationUnsupportedError",
]);

export interface CloudTaskPollOptions {
  readonly intervalMs?: number | undefined;
  readonly maxIntervalMs?: number | undefined;
  readonly maxConsecutiveErrors?: number | undefined;
  readonly stopOnTerminal?: boolean | undefined;
  readonly jitterRatio?: number | undefined;
  readonly random?: (() => number) | undefined;
}

interface PollState {
  readonly isFirstPoll: boolean;
  readonly delayMs: number;
  readonly consecutiveErrors: number;
  readonly lastStatus: CloudTaskStatus | null;
}

function withJitter(delayMs: number, ratio: number, random: () => number): number {
  if (ratio <= 0) return delayMs;
  const spread = delayMs * ratio;
  return Math.max(0, Math.round(delayMs - spread + random() * spread * 2));
}

export function pollCloudTaskStatus(
  fetchTask: Effect.Effect<CloudTask, CloudAgentError>,
  options: CloudTaskPollOptions = {},
): Stream.Stream<CloudTaskStatusChange, CloudAgentError> {
  const baseDelayMs = Math.max(1, options.intervalMs ?? DEFAULT_CLOUD_POLL_INTERVAL_MS);
  const maxDelayMs = Math.max(
    baseDelayMs,
    options.maxIntervalMs ?? DEFAULT_CLOUD_POLL_MAX_INTERVAL_MS,
  );
  const maxConsecutiveErrors = Math.max(
    1,
    options.maxConsecutiveErrors ?? DEFAULT_CLOUD_POLL_MAX_CONSECUTIVE_ERRORS,
  );
  const stopOnTerminal = options.stopOnTerminal ?? true;
  const jitterRatio = options.jitterRatio ?? DEFAULT_CLOUD_POLL_JITTER_RATIO;
  const random = options.random ?? Math.random;

  const initialState: PollState = {
    isFirstPoll: true,
    delayMs: baseDelayMs,
    consecutiveErrors: 0,
    lastStatus: null,
  };

  return Stream.paginate(initialState, (state) =>
    Effect.gen(function* () {
      if (!state.isFirstPoll) {
        yield* Effect.sleep(Duration.millis(withJitter(state.delayMs, jitterRatio, random)));
      }
      const fetched = yield* Effect.result(fetchTask);
      if (Result.isFailure(fetched)) {
        const error = fetched.failure;
        const consecutiveErrors = state.consecutiveErrors + 1;
        if (
          NON_RETRYABLE_POLL_ERROR_TAGS.has(error._tag) ||
          consecutiveErrors >= maxConsecutiveErrors
        ) {
          return yield* Effect.fail(error);
        }
        const nextState: PollState = {
          ...state,
          isFirstPoll: false,
          consecutiveErrors,
          delayMs: Math.min(maxDelayMs, state.delayMs * 2),
        };
        return [[], Option.some(nextState)] as const;
      }
      const task = fetched.success;
      const statusChanged = task.status !== state.lastStatus;
      const observedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      const changes: ReadonlyArray<CloudTaskStatusChange> = statusChanged
        ? [{ task, previousStatus: state.lastStatus, observedAt }]
        : [];
      const reachedTerminal = stopOnTerminal && CLOUD_TASK_TERMINAL_STATUSES.has(task.status);
      const nextState: PollState = {
        isFirstPoll: false,
        delayMs: baseDelayMs,
        consecutiveErrors: 0,
        lastStatus: task.status,
      };
      return [changes, reachedTerminal ? Option.none() : Option.some(nextState)] as const;
    }),
  );
}
