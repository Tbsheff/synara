import {
  EventId,
  ProviderRuntimeEvent as ProviderRuntimeEventSchema,
  ProviderItemId,
  ThreadId,
  TurnId,
  type ProviderEvent,
} from "@synara/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { makeCodexRuntimeEventMapper } from "./CodexAdapter.ts";

const threadId = ThreadId.makeUnsafe("thread-lifecycle-payload");
const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEventSchema);
const OUTPUT_MARKER = "lifecycle-output-marker";

function commandCompleted(): ProviderEvent {
  return {
    id: EventId.makeUnsafe("evt-command-completed"),
    kind: "notification",
    provider: "codex",
    threadId,
    createdAt: "2026-10-11T00:00:00.000Z",
    method: "item/completed",
    turnId: TurnId.makeUnsafe("turn-1"),
    itemId: ProviderItemId.makeUnsafe("cmd-1"),
    payload: {
      threadId: "provider-thread",
      turnId: "turn-1",
      item: {
        type: "commandExecution",
        id: "cmd-1",
        command: "ls",
        status: "completed",
        aggregatedOutput: OUTPUT_MARKER,
        exitCode: 0,
      },
    },
  };
}

describe("Codex item lifecycle payload storage", () => {
  it("stores lifecycle data once and keeps raw provenance as metadata", () => {
    const events = makeCodexRuntimeEventMapper()(commandCompleted(), threadId);
    const completed = events.find((event) => event.type === "item.completed");
    if (!completed) return expect.fail("expected item.completed");
    decodeRuntimeEvent(completed);

    expect(completed.raw).toEqual({
      source: "codex.app-server.notification",
      method: "item/completed",
      payload: {},
    });
    const serialized = JSON.stringify(completed);
    expect(serialized.split(OUTPUT_MARKER).length - 1).toBe(1);
  });
});
