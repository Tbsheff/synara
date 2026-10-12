import {
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
  type ThreadLiveUpdate,
} from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { makeActivity } from "./storeTestFixtures";
import {
  applyLiveToolOutputUpdate,
  clearAllLiveToolOutput,
  clearLiveToolOutputForCompletedTools,
  clearLiveToolOutputForEvents,
  clearLiveToolOutputItem,
  clearLiveToolOutputThread,
  liveToolOutputKey,
  useLiveToolOutputStore,
} from "./liveToolOutputStore";

const ITEM_ID = "call-1";

function outputUpdate(threadId: string, tail: string, updatedAt: string): ThreadLiveUpdate {
  return {
    kind: "tool-output",
    threadId: ThreadId.makeUnsafe(threadId),
    turnId: TurnId.makeUnsafe(`${threadId}-turn`),
    itemId: ITEM_ID,
    activityId: `${threadId}-activity`,
    streamKind: "command_output",
    tail,
    truncated: false,
    totalChars: tail.length,
    updatedAt,
  } as ThreadLiveUpdate;
}

function tailOf(threadId: string): string | undefined {
  return useLiveToolOutputStore.getState().byThreadItemKey[liveToolOutputKey(threadId, ITEM_ID)]
    ?.tail;
}

describe("liveToolOutputStore", () => {
  afterEach(() => {
    clearAllLiveToolOutput();
  });

  it("keeps the same provider item id apart across threads", () => {
    applyLiveToolOutputUpdate(outputUpdate("thread-a", "a1", "2026-10-10T00:00:01.000Z"));
    applyLiveToolOutputUpdate(outputUpdate("thread-b", "b1", "2026-10-10T00:00:00.000Z"));

    expect(tailOf("thread-a")).toBe("a1");
    expect(tailOf("thread-b")).toBe("b1");

    clearLiveToolOutputItem("thread-a", ITEM_ID);
    expect(tailOf("thread-a")).toBeUndefined();
    expect(tailOf("thread-b")).toBe("b1");

    clearLiveToolOutputThread("thread-b");
    expect(tailOf("thread-b")).toBeUndefined();
  });

  it("drops a frame older than the stored one for the same thread item", () => {
    applyLiveToolOutputUpdate(outputUpdate("thread-a", "newer", "2026-10-10T00:00:02.000Z"));
    applyLiveToolOutputUpdate(outputUpdate("thread-a", "older", "2026-10-10T00:00:01.000Z"));
    expect(tailOf("thread-a")).toBe("newer");
  });

  const toolActivity = (kind: string): OrchestrationThreadActivity =>
    makeActivity({
      id: `${kind}-activity`,
      kind,
      summary: "Bash",
      turnId: "thread-a-turn",
      payload: { itemType: "command_execution", data: { toolUseId: ITEM_ID } },
    });
  const activityAppended = (
    threadId: string,
    activity: OrchestrationThreadActivity,
  ): OrchestrationEvent =>
    ({
      type: "thread.activity-appended",
      aggregateId: threadId,
      payload: { threadId: ThreadId.makeUnsafe(threadId), activity },
    }) as unknown as OrchestrationEvent;

  it("clears a tail when a replayed batch completes its tool", () => {
    applyLiveToolOutputUpdate(outputUpdate("thread-a", "a1", "2026-10-10T00:00:01.000Z"));
    applyLiveToolOutputUpdate(outputUpdate("thread-b", "b1", "2026-10-10T00:00:01.000Z"));

    clearLiveToolOutputForEvents([
      activityAppended("thread-a", toolActivity("tool.updated")),
      activityAppended("thread-a", toolActivity("tool.completed")),
    ]);

    expect(tailOf("thread-a")).toBeUndefined();
    expect(tailOf("thread-b")).toBe("b1");
  });

  it("keeps a tail that arrived before the snapshot while its tool is still running", () => {
    applyLiveToolOutputUpdate(outputUpdate("thread-a", "a1", "2026-10-10T00:00:01.000Z"));

    clearLiveToolOutputForCompletedTools("thread-a", [toolActivity("tool.started")]);
    expect(tailOf("thread-a")).toBe("a1");

    clearLiveToolOutputForCompletedTools("thread-a", [toolActivity("tool.completed")]);
    expect(tailOf("thread-a")).toBeUndefined();
  });
});
