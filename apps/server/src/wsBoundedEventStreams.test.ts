import { ORCHESTRATION_STREAM_OVERFLOW_CODE, type TerminalEvent } from "@synara/contracts";
import { Cause, Effect, Exit, Fiber, PubSub, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { boundedSnapshotEventStream, boundedTerminalEventStream } from "./wsBoundedEventStreams";

const outputEvent = (index: number): TerminalEvent => ({
  type: "output",
  threadId: "thread-1",
  terminalId: "default",
  createdAt: "2026-10-11T00:00:00.000Z",
  data: `chunk-${index}-${"x".repeat(64)}`,
});

const failureCode = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const error = Cause.squash(exit.cause) as { readonly code?: string };
  return error.code;
};

const settle = Effect.gen(function* () {
  for (let index = 0; index < 20; index++) yield* Effect.yieldNow;
});

describe("bounded websocket event streams", () => {
  it("fails a terminal subscriber that stops pulling instead of retaining its output", async () => {
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let listener: ((event: TerminalEvent) => void) | undefined;
          const stream = boundedTerminalEventStream(
            (next) =>
              Effect.sync(() => {
                listener = next;
                return () => {
                  listener = undefined;
                };
              }),
            { capacity: 4 },
          );
          const pull = yield* Stream.toPull(stream);
          const first = yield* Effect.forkScoped(pull);
          while (listener === undefined) yield* Effect.yieldNow;
          listener(outputEvent(0));
          expect(yield* Fiber.join(first)).toHaveLength(1);

          for (let index = 1; index <= 32; index++) listener?.(outputEvent(index));
          yield* settle;
          return yield* Effect.exit(pull);
        }),
      ),
    );

    expect(failureCode(exit)).toBe(ORCHESTRATION_STREAM_OVERFLOW_CODE);
  });

  it("keeps terminal history snapshots outside the output byte budget", async () => {
    const history = "\u001b[0m".repeat(16_384);
    const received = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let listener: ((event: TerminalEvent) => void) | undefined;
          const stream = boundedTerminalEventStream(
            (next) =>
              Effect.sync(() => {
                listener = next;
                return () => {
                  listener = undefined;
                };
              }),
            { capacity: 8, maxSerializedBytes: 4_096 },
          );
          const pull = yield* Stream.toPull(stream);
          const first = yield* Effect.forkScoped(pull);
          while (listener === undefined) yield* Effect.yieldNow;
          for (const terminalId of ["one", "two"]) {
            listener({
              type: "started",
              threadId: "thread-1",
              terminalId,
              createdAt: "2026-10-11T00:00:00.000Z",
              snapshot: {
                threadId: "thread-1",
                terminalId,
                cwd: "/tmp",
                status: "running",
                pid: 1,
                history,
                exitCode: null,
                exitSignal: null,
                updatedAt: "2026-10-11T00:00:00.000Z",
              },
            });
          }
          yield* settle;
          const batch = yield* Fiber.join(first);
          const rest = batch.length < 2 ? yield* pull : [];
          return [...batch, ...rest];
        }),
      ),
    );

    expect(received.map((event) => event.type)).toEqual(["started", "started"]);
  });

  it("fails a Task subscriber that stops pulling and keeps snapshots outside the budget", async () => {
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* PubSub.unbounded<{ readonly type: string; readonly id: number }>();
          const subscription = yield* PubSub.subscribe(events);
          const stream = boundedSnapshotEventStream(
            Stream.concat(
              Stream.make({ type: "snapshot", id: 0, body: "s".repeat(4_096) }),
              Stream.fromSubscription(subscription),
            ),
            { label: "todo.events", capacity: 64, maxSerializedBytes: 1_024 },
          );
          const pull = yield* Stream.toPull(stream);
          const [snapshot] = yield* pull;
          expect(snapshot?.type).toBe("snapshot");

          for (let index = 1; index <= 64; index++) {
            yield* PubSub.publish(events, { type: "todo-upserted", id: index });
          }
          yield* settle;
          return yield* Effect.exit(pull);
        }),
      ),
    );

    expect(failureCode(exit)).toBe(ORCHESTRATION_STREAM_OVERFLOW_CODE);
  });

  it("delivers every event to a subscriber that keeps pulling", async () => {
    const received = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* PubSub.unbounded<{ readonly type: string; readonly id: number }>();
          const subscription = yield* PubSub.subscribe(events);
          const stream = boundedSnapshotEventStream(
            Stream.concat(
              Stream.make({ type: "snapshot", id: 0 }),
              Stream.fromSubscription(subscription),
            ),
            { label: "todo.events", capacity: 4 },
          );
          const collected = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 11)));
          for (let index = 1; index <= 10; index++) {
            yield* PubSub.publish(events, { type: "todo-upserted", id: index });
            yield* settle;
          }
          return yield* Fiber.join(collected);
        }),
      ),
    );

    expect(Array.from(received, (event) => event.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
