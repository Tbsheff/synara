import {
  type OrchestrationThreadStreamItem,
  RuntimeItemId,
  ThreadId,
  TurnId,
  WS_THREAD_LIVE_ITEMS_MIN_REVISION,
} from "@synara/contracts";
import { Effect, Fiber, Option, Queue, Stream } from "effect";
import { Headers } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { makeLiveToolOutputHub } from "./orchestration/liveToolOutput";
import {
  negotiatedRevisionFromHeaders,
  makeThreadDetailStream,
  WS_NEGOTIATED_REVISION_HEADER,
  type ThreadStreamOutput,
  withLiveToolOutputItems,
  withoutResumedMarker,
} from "./wsRpc";

const threadId = ThreadId.makeUnsafe("thread-ws-live");
const turnId = TurnId.makeUnsafe("turn-ws-live");
const itemId = RuntimeItemId.makeUnsafe("item-ws-live");

const replayItem = {
  kind: "replay",
  events: [],
} as unknown as OrchestrationThreadStreamItem;
const snapshotItem = {
  kind: "snapshot",
  snapshot: { snapshotSequence: 41 },
} as unknown as OrchestrationThreadStreamItem;

describe("negotiatedRevisionFromHeaders", () => {
  it("reads the server-set revision and treats a missing value as legacy", () => {
    expect(
      negotiatedRevisionFromHeaders(
        Headers.fromInput({
          [WS_NEGOTIATED_REVISION_HEADER]: String(WS_THREAD_LIVE_ITEMS_MIN_REVISION),
        }),
      ),
    ).toBe(WS_THREAD_LIVE_ITEMS_MIN_REVISION);
    expect(negotiatedRevisionFromHeaders(Headers.fromInput({}))).toBe(0);
    expect(
      negotiatedRevisionFromHeaders(Headers.fromInput({ [WS_NEGOTIATED_REVISION_HEADER]: "x" })),
    ).toBe(0);
  });
});

describe("withLiveToolOutputItems", () => {
  it("sends live tails only after the snapshot or replay and leaves those items untouched", async () => {
    const hub = makeLiveToolOutputHub({ minIntervalMs: 0 });
    hub.append({ threadId, turnId, itemId, streamKind: "command_output", delta: "before\n" });
    const received = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const threadItems = yield* Queue.unbounded<OrchestrationThreadStreamItem>();
          const fiber = yield* withLiveToolOutputItems(
            Stream.fromQueue(threadItems),
            hub,
            threadId,
          ).pipe(Stream.take(4), Stream.runCollect, Effect.forkScoped);
          yield* Effect.sleep("20 millis");
          yield* Queue.offer(threadItems, snapshotItem);
          yield* Effect.sleep("20 millis");
          hub.append({ threadId, turnId, itemId, streamKind: "command_output", delta: "after\n" });
          yield* Effect.sleep("20 millis");
          yield* Queue.offer(threadItems, replayItem);
          return Array.from(yield* Fiber.join(fiber));
        }),
      ),
    );
    expect(received[0]).toBe(snapshotItem);
    const live = received.filter((item) => item.kind === "live");
    expect(live.map((item) => item.kind === "live" && item.live.kind)).toEqual([
      "tool-output",
      "tool-output",
    ]);
    const lastLive = live.at(-1);
    expect(
      lastLive?.kind === "live" && lastLive.live.kind === "tool-output" && lastLive.live.tail,
    ).toBe("before\nafter\n");
    expect(received.filter((item) => item.kind !== "live")).toEqual([snapshotItem, replayItem]);
    for (const item of live) {
      expect(item).not.toHaveProperty("event");
      expect(item).not.toHaveProperty("events");
      expect(item).not.toHaveProperty("snapshot");
    }
  });

  it("releases held live tails on a resume with an empty gap and never sends the marker", async () => {
    const hub = makeLiveToolOutputHub({ minIntervalMs: 0 });
    hub.append({ threadId, turnId, itemId, streamKind: "command_output", delta: "tick1\n" });
    const received = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const threadItems = yield* Queue.unbounded<ThreadStreamOutput>();
          const fiber = yield* withLiveToolOutputItems(
            Stream.fromQueue(threadItems),
            hub,
            threadId,
          ).pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped);
          yield* Effect.sleep("20 millis");
          yield* Queue.offer(threadItems, { kind: "resumed" });
          yield* Effect.sleep("20 millis");
          hub.append({ threadId, turnId, itemId, streamKind: "command_output", delta: "tick2\n" });
          return Array.from(yield* Fiber.join(fiber).pipe(Effect.timeout("1 second")));
        }),
      ),
    );
    expect(received.map((item) => item.kind)).toEqual(["live", "live"]);
    expect(
      received.map(
        (item) => item.kind === "live" && item.live.kind === "tool-output" && item.live.tail,
      ),
    ).toEqual(["tick1\n", "tick1\ntick2\n"]);
  });

  it("keeps the first output line when it arrives before the first thread item", async () => {
    const hub = makeLiveToolOutputHub({ minIntervalMs: 0 });
    const received = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const threadItems = yield* Queue.unbounded<OrchestrationThreadStreamItem>();
          const fiber = yield* withLiveToolOutputItems(
            Stream.fromQueue(threadItems),
            hub,
            threadId,
          ).pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped);
          yield* Effect.sleep("20 millis");
          hub.append({ threadId, turnId, itemId, streamKind: "command_output", delta: "tick1\n" });
          yield* Effect.sleep("20 millis");
          hub.append({ threadId, turnId, itemId, streamKind: "command_output", delta: "tick2\n" });
          yield* Effect.sleep("20 millis");
          yield* Queue.offer(threadItems, snapshotItem);
          return Array.from(yield* Fiber.join(fiber).pipe(Effect.timeout("1 second")));
        }),
      ),
    );
    expect(received[0]).toBe(snapshotItem);
    const live = received[1];
    expect(live?.kind === "live" && live.live.kind === "tool-output" && live.live.tail).toBe(
      "tick1\ntick2\n",
    );
  });
});

describe("withoutResumedMarker", () => {
  it("drops the server-only resume marker for clients without live items", async () => {
    const items = await Effect.runPromise(
      withoutResumedMarker(
        Stream.make<ReadonlyArray<ThreadStreamOutput>>({ kind: "resumed" }, replayItem),
      ).pipe(Stream.runCollect),
    );
    expect(Array.from(items)).toEqual([replayItem]);
  });
});

describe("makeThreadDetailStream", () => {
  it.each([true, false])(
    "delivers live tails after a cursor resume with an empty gap (batch %s)",
    async (batchReplay) => {
      const hub = makeLiveToolOutputHub({ minIntervalMs: 0 });
      hub.append({ threadId, turnId, itemId, streamKind: "command_output", delta: "tick1\n" });
      const received = await Effect.runPromise(
        withLiveToolOutputItems(
          makeThreadDetailStream(threadId, {
            subscribeLive: Effect.succeed(Stream.never),
            snapshot: Effect.die(new Error("cursor resume must not load the snapshot")),
            snapshotSequence: () => 0,
            getHighWaterSequence: Effect.succeed(5),
            resumeFromSequence: 5,
            batchReplay,
            replay: () => Stream.empty,
          }),
          hub,
          threadId,
        ).pipe(Stream.take(1), Stream.runCollect, Effect.timeout("1 second")),
      );
      const live = Array.from(received)[0];
      expect(live?.kind === "live" && live.live.kind === "tool-output" && live.live.tail).toBe(
        "tick1\n",
      );
    },
  );

  it("fails identifiably when the snapshot has no thread detail", async () => {
    const exit = await Effect.runPromiseExit(
      makeThreadDetailStream(threadId, {
        subscribeLive: Effect.succeed(Stream.empty),
        snapshot: Effect.succeed({ detail: Option.none(), snapshotSequence: 5 }),
        snapshotSequence: (snapshot) => snapshot.snapshotSequence,
        getHighWaterSequence: Effect.succeed(5),
        replay: () => Stream.empty,
      }).pipe(Stream.runCollect),
    );
    expect(JSON.stringify(exit)).toContain("THREAD_SNAPSHOT_NOT_FOUND");
  });
});
