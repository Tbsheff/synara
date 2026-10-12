import { ProjectId, ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useComposerDraftStore } from "../composerDraftStore";
import { resetComposerDraftStore } from "../composerDraftStoreTestFixtures";
import type { SidebarThreadSummary } from "../types";
import { dispatchKanbanDraftThread } from "./kanbanDispatch";
import { createKanbanDraftTask } from "./kanbanTaskCreate";

const nativeApiMocks = vi.hoisted(() => ({
  dispatchCommand: vi.fn(async () => undefined),
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: {
      dispatchCommand: nativeApiMocks.dispatchCommand,
    },
  }),
}));

vi.mock("../kanbanUiStore", () => ({
  useKanbanUiStore: {
    getState: () => ({
      markOptimisticDispatch: () => undefined,
      clearOptimisticDispatch: () => undefined,
    }),
  },
}));

describe("Kanban task Debug mode", () => {
  beforeEach(() => {
    resetComposerDraftStore();
    nativeApiMocks.dispatchCommand.mockClear();
  });

  it("preserves Debug in the draft and dispatched turn", async () => {
    const projectId = ProjectId.makeUnsafe("project-kanban-debug");
    const threadId = createKanbanDraftTask({
      projectId,
      prompt: "Investigate the failing task",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "approval-required",
      interactionMode: "debug",
      envMode: "local",
    });

    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.interactionMode).toBe(
      "debug",
    );
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.interactionMode).toBe(
      "debug",
    );

    const result = await dispatchKanbanDraftThread({
      threadId,
      projectId,
      thread: { id: threadId, projectId } as unknown as SidebarThreadSummary,
      defaultProvider: "codex",
      assistantDeliveryMode: "buffered",
    });

    expect(result).toEqual({ kind: "dispatched" });
    expect(nativeApiMocks.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.turn.start",
        interactionMode: "debug",
      }),
    );
  });
});

it("updates the same saved draft with edited prompt and attachments", () => {
  resetComposerDraftStore();
  const projectId = ProjectId.makeUnsafe("edited-draft-project");
  const scratchThreadId = ThreadId.makeUnsafe("edited-draft-scratch");
  const input = {
    projectId,
    prompt: "Original",
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    envMode: "local",
  } as const;
  const threadId = createKanbanDraftTask(input);
  const store = useComposerDraftStore.getState();
  store.setPrompt(scratchThreadId, "Edited prompt");
  const file = {
    type: "file" as const,
    id: "edited-file",
    name: "note.txt",
    mimeType: "text/plain",
    sizeBytes: 4,
    file: new File(["note"], "note.txt", { type: "text/plain" }),
  };
  store.addFiles(scratchThreadId, [file]);
  expect(
    createKanbanDraftTask({
      ...input,
      threadId,
      sourceComposerThreadId: scratchThreadId,
      prompt: "Edited prompt",
    }),
  ).toBe(threadId);
  const saved = useComposerDraftStore.getState().draftsByThreadId[threadId];
  expect(saved?.prompt).toBe("Edited prompt");
  expect(saved?.files).toEqual([file]);
});
