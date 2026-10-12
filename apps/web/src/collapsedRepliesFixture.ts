import { MessageId, TurnId, type OrchestrationThreadActivity } from "@synara/contracts";

import { makeActivity } from "./storeTestFixtures";
import type { ChatMessage } from "./types";

const USER_TURN = "9ba9393b";
const FIRST_WAKE_TURN = "1f6b1375";
const SECOND_WAKE_TURN = "15bf09a1";

function message(
  id: string,
  role: ChatMessage["role"],
  createdAt: string,
  turnId: string,
  textLength: number,
): ChatMessage {
  return {
    id: MessageId.makeUnsafe(id),
    role,
    text: "x".repeat(textLength),
    turnId: TurnId.makeUnsafe(turnId),
    createdAt,
    completedAt: createdAt,
    streaming: false,
  };
}

export const collapsedRepliesMessages: ChatMessage[] = [
  message("u1", "user", "2026-10-09T20:04:14.174Z", USER_TURN, 40),
  message("a132", "assistant", "2026-10-09T20:04:18.000Z", USER_TURN, 132),
  message("a894", "assistant", "2026-10-09T20:06:40.000Z", USER_TURN, 894),
  message("a971", "assistant", "2026-10-09T20:08:10.000Z", FIRST_WAKE_TURN, 971),
  message("a231", "assistant", "2026-10-09T20:10:34.600Z", SECOND_WAKE_TURN, 231),
];

const backgroundTasksPayload = {
  message: "2 tasks: Map runtime events, Trace web rendering",
  detail: "2 tasks: Map runtime events, Trace web rendering",
  nativeEventType: "background_tasks_changed",
  data: {
    subtype: "background_tasks_changed",
    tasks: [
      { task_id: "add708e", task_type: "local_agent", description: "Map runtime events" },
      { task_id: "a8ab72", task_type: "local_agent", description: "Trace web rendering" },
    ],
  },
};

function baselineSkipped(id: string, createdAt: string, turnId: string, sequence: number) {
  return makeActivity({
    id,
    createdAt,
    kind: "checkpoint.baseline.skipped",
    summary: "Checkpoint baseline unavailable for this turn",
    tone: "info",
    turnId,
    sequence,
  });
}

export const collapsedRepliesActivities: OrchestrationThreadActivity[] = [
  makeActivity({
    id: "agent-started",
    createdAt: "2026-10-09T20:04:19.000Z",
    kind: "tool.started",
    summary: "Agent",
    turnId: USER_TURN,
    sequence: 872_001,
    payload: { itemType: "collab_agent_tool_call", data: { toolUseId: "toolu_1" } },
  }),
  makeActivity({
    id: "moved-to-background",
    createdAt: "2026-10-09T20:04:20.000Z",
    kind: "runtime.warning",
    summary: "Moved to background",
    tone: "info",
    turnId: USER_TURN,
    sequence: 872_002,
    payload: backgroundTasksPayload,
  }),
  baselineSkipped("skip-child-1", "2026-10-09T20:05:00.000Z", "070747fd", 664_015),
  makeActivity({
    id: "completion-add708e",
    createdAt: "2026-10-09T20:07:04.589Z",
    kind: "task.completed",
    summary: "Task completed",
    tone: "info",
    sequence: 872_100,
    payload: { taskId: "add708e", status: "completed" },
  }),
  baselineSkipped("skip-wake-1", "2026-10-09T20:07:10.000Z", FIRST_WAKE_TURN, 664_100),
  makeActivity({
    id: "wake-1-read",
    createdAt: "2026-10-09T20:07:30.000Z",
    kind: "tool.completed",
    summary: "Read",
    turnId: FIRST_WAKE_TURN,
    sequence: 872_110,
    payload: { itemType: "dynamic_tool_call", toolName: "Read", data: { toolUseId: "toolu_2" } },
  }),
  baselineSkipped("skip-child-2", "2026-10-09T20:09:00.000Z", "17f3b195", 664_200),
  makeActivity({
    id: "completion-a8ab72",
    createdAt: "2026-10-09T20:10:32.257Z",
    kind: "task.completed",
    summary: "Task completed",
    tone: "info",
    sequence: 872_200,
    payload: { taskId: "a8ab72", status: "completed" },
  }),
  baselineSkipped("skip-wake-2", "2026-10-09T20:10:40.000Z", SECOND_WAKE_TURN, 664_300),
];

export const collapsedRepliesVisibleTurnIds = new Set(
  [USER_TURN, FIRST_WAKE_TURN, SECOND_WAKE_TURN].map((turnId) => TurnId.makeUnsafe(turnId)),
);
