import { Effect, Option, Queue, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { loadThreadSnapshotWithBootstrapWait } from "./threadSnapshotBootstrap";

describe("thread snapshot bootstrap", () => {
  it("loads a committed snapshot from a ready signal without a polling delay", async () => {
    let ready = false;
    const read = vi.fn(() => (ready ? Option.some("detail") : Option.none<string>()));
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<unknown>();
          yield* Effect.gen(function* () {
            yield* Effect.sleep(10);
            ready = true;
            yield* Queue.offer(queue, {});
          }).pipe(Effect.forkScoped);
          return yield* loadThreadSnapshotWithBootstrapWait({
            readSnapshot: Effect.sync(read),
            subscribeReady: Effect.succeed(Stream.fromQueue(queue)),
            timeoutMs: 500,
          }).pipe(Effect.timeoutOption(60));
        }),
      ),
    );
    expect(result).toEqual(Option.some(Option.some("detail")));
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("does not repeatedly query a missing thread before the deadline", async () => {
    const read = vi.fn(() => Option.none<string>());
    const result = await Effect.runPromise(
      loadThreadSnapshotWithBootstrapWait({
        readSnapshot: Effect.sync(read),
        subscribeReady: Effect.succeed(Stream.never),
        timeoutMs: 220,
      }),
    );
    expect(result).toEqual(Option.none());
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("attaches the readiness listener before the first snapshot read", async () => {
    let attached = false;
    const result = await Effect.runPromise(
      loadThreadSnapshotWithBootstrapWait({
        readSnapshot: Effect.sync(() => Option.some(attached)),
        subscribeReady: Effect.sync(() => {
          attached = true;
          return Stream.never;
        }),
        timeoutMs: 10,
      }),
    );
    expect(result).toEqual(Option.some(true));
  });
});
