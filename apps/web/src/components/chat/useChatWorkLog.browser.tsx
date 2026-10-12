import { MessageId, TurnId } from "@synara/contracts";
import { expect, it } from "vitest";
import { renderHook } from "vitest-browser-react";

import { makeActivity, makeThread } from "../../storeTestFixtures";
import type { ChatMessage, Thread } from "../../types";
import { useChatWorkLog } from "./useChatWorkLog";

const turnId = TurnId.makeUnsafe("turn-1");

function assistantMessage(text: string): ChatMessage {
  return {
    id: MessageId.makeUnsafe("assistant-1"),
    role: "assistant",
    text,
    turnId,
    createdAt: "2026-01-01T00:00:02.000Z",
    streaming: true,
  } as ChatMessage;
}

function streamingThread(): Thread {
  return makeThread({
    messages: [
      {
        id: MessageId.makeUnsafe("user-1"),
        role: "user",
        text: "Run it",
        createdAt: "2026-01-01T00:00:00.000Z",
        streaming: false,
      } as ChatMessage,
      assistantMessage("Working"),
    ],
    activities: [
      makeActivity({
        id: "tool-started",
        kind: "tool.started",
        turnId: "turn-1",
        createdAt: "2026-01-01T00:00:01.000Z",
        payload: { itemType: "command_execution", data: { item: { id: "tool-1" } } },
      }),
      makeActivity({
        id: "tool-completed",
        kind: "tool.completed",
        turnId: "turn-1",
        createdAt: "2026-01-01T00:00:01.500Z",
        payload: { itemType: "command_execution", data: { item: { id: "tool-1" } } },
      }),
    ],
    latestTurn: {
      turnId,
      state: "running",
      requestedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: null,
      assistantMessageId: MessageId.makeUnsafe("assistant-1"),
    },
  });
}

it("keeps work-log entries stable across text-only streaming deltas", async () => {
  let thread = streamingThread();
  const { result, rerender } = await renderHook(
    (props?: { activeThread: Thread }) =>
      useChatWorkLog({
        activeThread: props?.activeThread ?? thread,
        latestTurnSettled: false,
        latestTurnLive: true,
      }),
    { initialProps: { activeThread: thread } },
  );
  const initialEntries = result.current.workLogEntries;
  expect(initialEntries).toHaveLength(1);

  let identityChanges = 0;
  for (let delta = 0; delta < 100; delta += 1) {
    const previous = result.current.workLogEntries;
    thread = {
      ...thread,
      messages: thread.messages.with(1, assistantMessage(`Working ${delta}`)),
    };
    await rerender({ activeThread: thread });
    if (result.current.workLogEntries !== previous) identityChanges += 1;
  }

  expect(identityChanges).toBe(0);
  expect(result.current.workLogEntries).toBe(initialEntries);
});
