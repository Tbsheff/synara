import {
  RuntimeItemId,
  ThreadId,
  type ThreadLiveUpdate,
  TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS,
  TurnId,
} from "@synara/contracts";
import { Effect, Fiber, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  appendOutputTail,
  coalescedLiveToolOutputStream,
  makeLiveToolOutputHub,
  OUTPUT_TRUNCATION_PREFIX,
  renderOutputTail,
} from "./liveToolOutput.ts";

const threadId = ThreadId.makeUnsafe("thread-live");
const turnId = TurnId.makeUnsafe("turn-live");
const itemId = RuntimeItemId.makeUnsafe("item-live");

function collect(hub: ReturnType<typeof makeLiveToolOutputHub>) {
  const updates: ThreadLiveUpdate[] = [];
  const unsubscribe = hub.subscribe(threadId, (update) => updates.push(update));
  return { updates, unsubscribe };
}

describe("output tail", () => {
  it("keeps exactly the last characters and counts every character", () => {
    let tail = appendOutputTail(undefined, "a".repeat(15_000));
    tail = appendOutputTail(tail, "b".repeat(15_000));
    expect(tail.text.length).toBe(TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS);
    expect(tail.text).toBe(`${"a".repeat(5_000)}${"b".repeat(15_000)}`);
    expect(tail.truncated).toBe(true);
    expect(tail.totalChars).toBe(30_000);
    expect(renderOutputTail(tail)).toBe(`${OUTPUT_TRUNCATION_PREFIX}${tail.text}`);
  });

  it("keeps whitespace-only output intact", () => {
    const tail = appendOutputTail(undefined, "  \n\t ");
    expect(renderOutputTail(tail)).toBe("  \n\t ");
    expect(tail.truncated).toBe(false);
  });
});

describe("makeLiveToolOutputHub", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes at most every 250 ms per item, including the trailing chunk", () => {
    const hub = makeLiveToolOutputHub();
    const { updates } = collect(hub);
    for (let index = 0; index < 1_000; index += 1) {
      hub.append({
        threadId,
        turnId,
        itemId,
        streamKind: "command_output",
        delta: `line ${index}\n`,
      });
      vi.advanceTimersByTime(1);
    }
    vi.advanceTimersByTime(250);
    const outputs = updates.filter((update) => update.kind === "tool-output");
    expect(outputs.length).toBeGreaterThan(1);
    expect(outputs.length).toBeLessThanOrEqual(5);
    const last = outputs.at(-1);
    expect(last?.kind === "tool-output" && last.tail.endsWith("line 999\n")).toBe(true);
  });

  it("keeps a 20k tail with the truncation prefix", () => {
    const hub = makeLiveToolOutputHub();
    const { updates } = collect(hub);
    const body = Array.from({ length: 5_000 }, (_, index) => `${index}`.padStart(8, "0")).join("");
    hub.append({ threadId, turnId, itemId, streamKind: "command_output", delta: body });
    const update = updates.at(-1);
    expect(update?.kind).toBe("tool-output");
    if (update?.kind !== "tool-output") return;
    expect(update.tail).toBe(
      `${OUTPUT_TRUNCATION_PREFIX}${body.slice(body.length - TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS)}`,
    );
    expect(update.truncated).toBe(true);
    expect(update.totalChars).toBe(body.length);
  });

  it("clears an item on completion and stops its pending publish", () => {
    const hub = makeLiveToolOutputHub();
    const { updates } = collect(hub);
    hub.append({ threadId, turnId, itemId, streamKind: "command_output", delta: "one\n" });
    hub.append({ threadId, turnId, itemId, streamKind: "command_output", delta: "two\n" });
    hub.clearItem(threadId, itemId);
    vi.advanceTimersByTime(1_000);
    expect(updates.map((update) => update.kind)).toEqual(["tool-output", "tool-output-cleared"]);
    expect(hub.current(threadId)).toEqual([]);
  });

  it("clears every item of a finished turn and of an exited session", () => {
    const hub = makeLiveToolOutputHub();
    const otherTurn = TurnId.makeUnsafe("turn-other");
    hub.append({ threadId, turnId, itemId, streamKind: "command_output", delta: "a" });
    hub.append({
      threadId,
      turnId: otherTurn,
      itemId: RuntimeItemId.makeUnsafe("item-other"),
      streamKind: "file_change_output",
      delta: "b",
    });
    hub.clearTurn(threadId, turnId);
    expect(hub.current(threadId).map((update) => update.itemId)).toEqual(["item-other"]);
    hub.clearThread(threadId);
    expect(hub.current(threadId)).toEqual([]);
  });

  it("keeps running background items across turn end until the item or thread clears", () => {
    const hub = makeLiveToolOutputHub();
    const backgroundId = RuntimeItemId.makeUnsafe("item-background");
    const turnlessBackgroundId = RuntimeItemId.makeUnsafe("item-background-turnless");
    hub.markBackground(threadId, backgroundId);
    hub.markBackground(threadId, turnlessBackgroundId);
    hub.append({ threadId, turnId, itemId, streamKind: "command_output", delta: "fg" });
    hub.append({
      threadId,
      turnId,
      itemId: backgroundId,
      streamKind: "command_output",
      delta: "bg",
    });
    hub.append({
      threadId,
      turnId: null,
      itemId: turnlessBackgroundId,
      streamKind: "command_output",
      delta: "bg",
    });
    hub.clearTurn(threadId, turnId);
    expect(hub.current(threadId).map((update) => update.itemId)).toEqual([
      backgroundId,
      turnlessBackgroundId,
    ]);

    hub.clearItem(threadId, backgroundId);
    hub.append({
      threadId,
      turnId,
      itemId: backgroundId,
      streamKind: "command_output",
      delta: "x",
    });
    hub.clearTurn(threadId, turnId);
    expect(hub.current(threadId).map((update) => update.itemId)).toEqual([turnlessBackgroundId]);

    hub.clearThread(threadId);
    hub.append({
      threadId,
      turnId: null,
      itemId: turnlessBackgroundId,
      streamKind: "command_output",
      delta: "y",
    });
    hub.clearTurn(threadId, turnId);
    expect(hub.current(threadId)).toEqual([]);
  });
});

describe("coalescedLiveToolOutputStream", () => {
  it("sends current tails first and keeps only the newest update per item", async () => {
    const hub = makeLiveToolOutputHub({ minIntervalMs: 0 });
    hub.append({ threadId, turnId, itemId, streamKind: "command_output", delta: "boot\n" });
    const received = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* coalescedLiveToolOutputStream(hub, threadId).pipe(
            Stream.take(2),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* Effect.yieldNow;
          for (let index = 0; index < 50; index += 1) {
            hub.append({
              threadId,
              turnId,
              itemId,
              streamKind: "command_output",
              delta: `${index}\n`,
            });
          }
          return yield* Fiber.join(fiber);
        }),
      ),
    );
    const updates = Array.from(received);
    expect(updates[0]?.kind === "tool-output" && updates[0].tail).toBe("boot\n");
    const latest = updates[1];
    expect(latest?.kind === "tool-output" && latest.tail.endsWith("49\n")).toBe(true);
  });
});
