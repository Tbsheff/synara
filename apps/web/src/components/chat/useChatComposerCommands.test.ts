import { ThreadId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: <T>(callback: T) => callback,
  };
});

import { useChatComposerCommands } from "./useChatComposerCommands";

type CommandsInput = Parameters<typeof useChatComposerCommands>[0];

const THREAD_ID = ThreadId.makeUnsafe("thread-prompt-history");

function createHarness(sendResult: boolean) {
  const navigationState = { index: 0, draft: "my unsent draft" };
  const promptHistoryNavigationRef = { current: navigationState as unknown };
  const setComposerDraftPromptHistorySavedDraft = vi.fn();
  const restoreComposerDraftPromptHistorySavedDraft = vi.fn();
  const pendingSend: { resolve: ((sent: boolean) => void) | null } = { resolve: null };
  const onSend = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        pendingSend.resolve = resolve;
      }),
  );
  const input = {
    threadId: THREAD_ID,
    composerMenuOpenRef: { current: false },
    resolveActiveComposerTrigger: () => ({
      snapshot: {
        value: "recalled prompt",
        cursor: 15,
        expandedCursor: 15,
        selectionCollapsed: true,
      },
      trigger: null,
    }),
    promptHistoryNavigationRef,
    expectedPromptHistoryPromptRef: { current: null },
    setComposerDraftPromptHistorySavedDraft,
    restoreComposerDraftPromptHistorySavedDraft,
    onSend,
    settings: { followUpBehavior: "queue" },
    hasLiveTurn: false,
    isLocalFolderBrowserOpen: false,
    activePendingProgress: null,
    isComposerApprovalState: false,
    pendingUserInputs: [],
    promptHistory: ["recalled prompt"],
  } as unknown as CommandsInput;
  const commands = useChatComposerCommands(input);
  const pressEnter = () =>
    commands.onComposerCommandKey("Enter", {
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
    } as KeyboardEvent);
  return {
    navigationState,
    promptHistoryNavigationRef,
    setComposerDraftPromptHistorySavedDraft,
    restoreComposerDraftPromptHistorySavedDraft,
    onSend,
    pressEnter,
    settleSend: async () => {
      pendingSend.resolve?.(sendResult);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("useChatComposerCommands Enter while browsing prompt history", () => {
  it("keeps the saved draft and browse state when the send is rejected", async () => {
    const harness = createHarness(false);

    expect(harness.pressEnter()).toBe(true);
    expect(harness.onSend).toHaveBeenCalledTimes(1);
    expect(harness.setComposerDraftPromptHistorySavedDraft).not.toHaveBeenCalled();
    expect(harness.promptHistoryNavigationRef.current).toBe(harness.navigationState);

    await harness.settleSend();

    expect(harness.setComposerDraftPromptHistorySavedDraft).not.toHaveBeenCalled();
    expect(harness.restoreComposerDraftPromptHistorySavedDraft).not.toHaveBeenCalled();
    expect(harness.promptHistoryNavigationRef.current).toBe(harness.navigationState);
  });

  it("keeps the saved draft when send throws", async () => {
    const harness = createHarness(false);
    harness.onSend.mockRejectedValueOnce(new Error("send unavailable"));
    harness.pressEnter();
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.setComposerDraftPromptHistorySavedDraft).not.toHaveBeenCalled();
    expect(harness.promptHistoryNavigationRef.current).toBe(harness.navigationState);
  });

  it("drops the saved draft once the send succeeds", async () => {
    const harness = createHarness(true);

    harness.pressEnter();
    await harness.settleSend();

    expect(harness.setComposerDraftPromptHistorySavedDraft).toHaveBeenCalledWith(THREAD_ID, null);
    expect(harness.promptHistoryNavigationRef.current).toBeNull();
    expect(harness.restoreComposerDraftPromptHistorySavedDraft).not.toHaveBeenCalled();
  });
});
