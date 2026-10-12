import { ThreadId } from "@synara/contracts";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { makeSessionTeardownGate } from "./SessionTeardownGate.ts";

describe("SessionTeardownGate", () => {
  it("blocks replacement work until the tracked teardown completes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const gate = makeSessionTeardownGate<string>();
        const threadId = ThreadId.makeUnsafe("thread-1");
        const completion = yield* Deferred.make<void, string>();
        let replacementStarted = false;
        gate.track(threadId, completion);
        expect(gate.isPending(threadId)).toBe(true);

        const replacement = yield* gate.awaitPending(threadId).pipe(
          Effect.andThen(
            Effect.sync(() => {
              replacementStarted = true;
            }),
          ),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        expect(replacementStarted).toBe(false);

        yield* gate.complete(threadId, completion, Exit.void, Effect.void);
        yield* Fiber.join(replacement);
        expect(replacementStarted).toBe(true);
        expect(gate.isPending(threadId)).toBe(false);
      }),
    );
  });

  it("does not let stale cleanup clear a newer teardown gate", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const gate = makeSessionTeardownGate<string>();
        const threadId = ThreadId.makeUnsafe("thread-1");
        const oldCompletion = yield* Deferred.make<void, string>();
        const newCompletion = yield* Deferred.make<void, string>();
        let replacementStarted = false;
        gate.track(threadId, oldCompletion);
        gate.track(threadId, newCompletion);

        yield* gate.complete(threadId, oldCompletion, Exit.void, Effect.void);
        expect(gate.isPending(threadId)).toBe(true);
        const replacement = yield* gate.awaitPending(threadId).pipe(
          Effect.andThen(
            Effect.sync(() => {
              replacementStarted = true;
            }),
          ),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        expect(replacementStarted).toBe(false);

        yield* gate.complete(threadId, newCompletion, Exit.void, Effect.void);
        yield* Fiber.join(replacement);
        expect(replacementStarted).toBe(true);
      }),
    );
  });

  it("keeps a failed teardown pending until a retry proves exit", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const gate = makeSessionTeardownGate<string>();
        const threadId = ThreadId.makeUnsafe("thread-1");
        const completion = yield* Deferred.make<void, string>();
        const retryOutcomes: Array<Exit.Exit<void, string>> = [Exit.fail("still running")];
        let retries = 0;
        const retry = Effect.suspend(() => {
          retries += 1;
          return retryOutcomes.shift() ?? Exit.void;
        });
        gate.track(threadId, completion);

        yield* gate.complete(threadId, completion, Exit.fail("exit unproven"), retry);
        expect(Exit.isFailure(yield* Effect.exit(Deferred.await(completion)))).toBe(true);
        expect(gate.isPending(threadId)).toBe(true);

        const firstReplacement = yield* Effect.exit(gate.awaitPending(threadId));
        expect(firstReplacement).toEqual(Exit.fail("still running"));
        expect(gate.isPending(threadId)).toBe(true);

        yield* gate.awaitPending(threadId);
        expect(retries).toBe(2);
        expect(gate.isPending(threadId)).toBe(false);
      }),
    );
  });
});
