// FILE: SessionTeardownGate.ts
// Purpose: Prevents a replacement ACP runtime from starting before its predecessor exits.
// Layer: Provider ACP lifecycle coordination

import type { ThreadId } from "@synara/contracts";
import { Deferred, Effect, Exit } from "effect";

import type { teardownProviderProcessTree } from "../supervisedProcessTeardown.ts";

export interface SessionTeardownGate<E> {
  readonly track: (threadId: ThreadId, completion: Deferred.Deferred<void, E>) => void;
  readonly isPending: (threadId: ThreadId) => boolean;
  readonly pendingThreadIds: () => ReadonlyArray<ThreadId>;
  readonly awaitPending: (threadId: ThreadId) => Effect.Effect<void, E>;
  readonly complete: (
    threadId: ThreadId,
    completion: Deferred.Deferred<void, E>,
    exit: Exit.Exit<void, E>,
    retry: Effect.Effect<void, E>,
  ) => Effect.Effect<void>;
}

interface PendingTeardown<E> {
  readonly completion: Deferred.Deferred<void, E>;
  retry: Effect.Effect<void, E> | undefined;
}

export function makeSessionTeardownGate<E>(): SessionTeardownGate<E> {
  const pendingByThreadId = new Map<ThreadId, PendingTeardown<E>>();

  const complete: SessionTeardownGate<E>["complete"] = (threadId, completion, exit, retry) =>
    Effect.suspend(() => {
      const pending = pendingByThreadId.get(threadId);
      if (pending?.completion === completion) {
        if (Exit.isSuccess(exit)) {
          pendingByThreadId.delete(threadId);
        } else {
          pending.retry = retry;
        }
      }
      return Deferred.done(completion, exit).pipe(Effect.asVoid);
    });

  const retryFailedTeardown = (threadId: ThreadId, retry: Effect.Effect<void, E>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const completion = yield* Deferred.make<void, E>();
        pendingByThreadId.set(threadId, { completion, retry: undefined });
        const exit = yield* Effect.exit(restore(retry));
        yield* complete(threadId, completion, exit, retry);
        return yield* exit;
      }),
    );

  const awaitPending = (threadId: ThreadId): Effect.Effect<void, E> =>
    Effect.suspend(() => {
      const pending = pendingByThreadId.get(threadId);
      if (pending === undefined) {
        return Effect.void;
      }
      return Deferred.await(pending.completion).pipe(
        Effect.catchCause((cause) => {
          if (pendingByThreadId.get(threadId) !== pending) {
            return awaitPending(threadId);
          }
          return pending.retry === undefined
            ? Effect.failCause(cause)
            : retryFailedTeardown(threadId, pending.retry);
        }),
      );
    });

  return {
    track: (threadId, completion) => {
      pendingByThreadId.set(threadId, { completion, retry: undefined });
    },
    isPending: (threadId) => pendingByThreadId.has(threadId),
    pendingThreadIds: () => Array.from(pendingByThreadId.keys()),
    awaitPending,
    complete,
  };
}

type ProcessTreeTeardown = typeof teardownProviderProcessTree;

export interface RetriableProcessTreeTeardown {
  readonly teardownProcessTree: ProcessTreeTeardown;
  readonly retry: () => Promise<void>;
}

export function makeRetriableProcessTreeTeardown(
  teardownProcessTree: ProcessTreeTeardown,
): RetriableProcessTreeTeardown {
  let lastInput: Parameters<ProcessTreeTeardown>[0] | undefined;
  let exitProven = false;
  const recordedTeardown: ProcessTreeTeardown = async (input, dependencies) => {
    lastInput = input;
    const result = await teardownProcessTree(input, dependencies);
    exitProven = true;
    return result;
  };
  return {
    teardownProcessTree: recordedTeardown,
    retry: async () => {
      if (exitProven || lastInput === undefined) {
        return;
      }
      await recordedTeardown(lastInput);
    },
  };
}
