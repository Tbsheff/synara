// FILE: kanbanTaskCreate.sendAsGoal.test.ts
// Purpose: Verifies create-and-send routes through the goal dispatch variant only
//          when the dialog's "send as goal" toggle is on (default off).
// Layer: Web Kanban lib tests

import { ProjectId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  dispatch: vi.fn(),
  register: vi.fn(),
  setPrompt: vi.fn(),
  uncertain: vi.fn(),
  dispatchAsGoal: vi.fn(),
}));

vi.mock("./kanbanDispatch", () => ({
  hasUncertainDraftThreadDispatch: harness.uncertain,
  dispatchKanbanDraftThread: harness.dispatch,
  dispatchKanbanDraftThreadAsGoal: harness.dispatchAsGoal,
}));

vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      registerDraftThread: harness.register,
      copyTransferableComposerState: vi.fn(),
      setPrompt: harness.setPrompt,
      setModelSelection: vi.fn(),
      setRuntimeMode: vi.fn(),
      setInteractionMode: vi.fn(),
    }),
  },
}));

import { createAndSendKanbanTask } from "./kanbanTaskCreate";

const BASE_INPUT = {
  projectId: ProjectId.makeUnsafe("project-kanban-goal"),
  prompt: "Ship the kanban v2 goal flow",
  modelSelection: { provider: "codex", model: "gpt-5.4" },
  runtimeMode: "approval-required",
  interactionMode: "debug",
  envMode: "local",
  defaultProvider: "codex",
  assistantDeliveryMode: "buffered",
} as const;

beforeEach(() => {
  harness.register.mockClear();
  harness.setPrompt.mockClear();
  harness.uncertain.mockReset();
  harness.uncertain.mockReturnValue(false);
  harness.dispatch.mockReset();
  harness.dispatchAsGoal.mockReset();
  harness.dispatch.mockResolvedValue({ kind: "dispatched" });
  harness.dispatchAsGoal.mockResolvedValue({ kind: "dispatched" });
});

describe("createAndSendKanbanTask send-as-goal routing", () => {
  it("uses plain dispatch by default", async () => {
    const { result } = await createAndSendKanbanTask({ ...BASE_INPUT });

    expect(result).toEqual({ kind: "dispatched" });
    expect(harness.dispatch).toHaveBeenCalledTimes(1);
    expect(harness.dispatchAsGoal).not.toHaveBeenCalled();
    expect(harness.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: BASE_INPUT.projectId,
        thread: null,
        defaultProvider: "codex",
        assistantDeliveryMode: "buffered",
      }),
    );
  });

  it("routes through the goal dispatch variant when sendAsGoal is true", async () => {
    const { threadId, result } = await createAndSendKanbanTask({
      ...BASE_INPUT,
      sendAsGoal: true,
    });

    expect(result).toEqual({ kind: "dispatched" });
    expect(harness.dispatchAsGoal).toHaveBeenCalledTimes(1);
    expect(harness.dispatch).not.toHaveBeenCalled();
    expect(harness.dispatchAsGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId,
        projectId: BASE_INPUT.projectId,
        thread: null,
      }),
    );
  });
});

it("reuses the saved thread after dispatch fails and applies the edited prompt", async () => {
  harness.dispatch.mockResolvedValueOnce({ kind: "error", message: "Refused" });
  const first = await createAndSendKanbanTask(BASE_INPUT);
  const retried = await createAndSendKanbanTask({
    ...BASE_INPUT,
    threadId: first.threadId,
    prompt: "Edited task",
  });
  expect(retried.threadId).toBe(first.threadId);
  expect(harness.register).toHaveBeenCalledTimes(1);
  expect(harness.setPrompt).toHaveBeenLastCalledWith(first.threadId, "Edited task");
  expect(harness.dispatch.mock.calls[1]?.[0]).toEqual(
    expect.objectContaining({ threadId: first.threadId }),
  );
});

it("does not replace the saved composer while an exact send is unresolved", async () => {
  harness.dispatch.mockResolvedValueOnce({
    kind: "error",
    message: "Reply lost",
    outcomeUnknown: true,
  });
  const first = await createAndSendKanbanTask(BASE_INPUT);
  harness.setPrompt.mockClear();
  harness.uncertain.mockReturnValue(true);
  await createAndSendKanbanTask({
    ...BASE_INPUT,
    threadId: first.threadId,
    prompt: "Edited while pending",
  });
  expect(harness.setPrompt).not.toHaveBeenCalled();
});
