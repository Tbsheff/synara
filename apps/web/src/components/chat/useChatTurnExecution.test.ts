import { MessageId, ProjectId, ThreadId } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeThread } from "../../storeTestFixtures";
import { resetComposerDraftStore } from "../../composerDraftStoreTestFixtures";
import { useChatTurnExecution } from "./useChatTurnExecution";

vi.mock("react", async (load) => ({
  ...(await load<typeof import("react")>()),
  useCallback: <T>(callback: T) => callback,
}));
vi.mock("~/lib/threadCreatePromotion", () => ({ promoteThreadCreate: async () => "created" }));
vi.mock("~/projectInstructionsStore", () => ({
  useProjectInstructionsStore: { getState: () => ({ instructionsByProjectId: {} }) },
  mergeProjectInstructionsIntoThreadNotes: () => "",
}));

afterEach(() => {
  vi.restoreAllMocks();
  resetComposerDraftStore();
});
describe("first-turn project rename", () => {
  it("sends the turn before a failed cosmetic rename and still reports success", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const threadId = ThreadId.makeUnsafe("rename-failure-thread");
    const dispatchCommand = vi.fn(async (command: { type: string }) => {
      if (command.type === "project.meta.update") throw new Error("rename failed");
    });
    type Input = Parameters<typeof useChatTurnExecution>[0];
    const noop = vi.fn();
    const input = Object.fromEntries(
      [
        "setStoreThreadWorkspace",
        "clearLocalDispatchWorktreeSetup",
        "beginLocalDispatch",
        "runProjectScript",
        "persistThreadSettingsForNextTurn",
        "rememberCustomBinaryPathForDispatch",
        "setComposerDraftComputerControlMode",
        "setSettledThreadBranchWarningDismissedThreadId",
        "armLocalDispatchAckFallback",
        "setQueuedSteerGate",
        "setPlanSidebarOpen",
        "setRestoredQueuedSourceProposedPlan",
        "failLocalDispatchWorktreeSetup",
        "setOptimisticUserMessages",
        "setPrompt",
        "setComposerCursor",
        "addComposerImagesToDraft",
        "addComposerFilesToDraft",
        "addComposerAssistantSelectionToDraft",
        "addComposerDraftBrowserAnnotations",
        "addComposerFileCommentToDraft",
        "addComposerTerminalContextsToDraft",
        "addComposerPastedTextsToDraft",
        "addComposerPullRequestContextsToDraft",
        "updateSelectedComposerSkills",
        "updateSelectedComposerMentions",
        "setComposerTrigger",
        "setThreadError",
        "scheduleFailedWorktreeSetupDispatchReset",
        "resetLocalDispatch",
      ].map((key) => [key, noop]),
    );
    const execute = useChatTurnExecution({
      ...input,
      isServerThread: false,
      isLocalDraftThread: true,
      threadNotes: "",
      threadId,
      activeThreadIdRef: { current: threadId },
      promptRef: { current: "Prompt" },
      sendInFlightRef: { current: true },
      worktreeSetupResolutionRef: { current: null },
      planSidebarDismissedForTurnRef: { current: null },
    } as unknown as Input);
    type Prepared = Parameters<typeof execute>[0];
    const modelSelection = { provider: "codex" as const, model: "gpt-5.4" };
    const prepared = {
      api: { orchestration: { dispatchCommand } },
      threadIdForSend: threadId,
      targetProjectIdForSend: ProjectId.makeUnsafe("rename-project"),
      nextThreadEnvMode: "local",
      nextThreadBranch: null,
      nextThreadWorktreePath: null,
      nextThreadWorkingDirectory: null,
      nextAssociatedWorktreePath: null,
      nextAssociatedWorktreeBranch: null,
      nextAssociatedWorktreeRef: null,
      targetProjectCwdForSend: "/workspace",
      worktreeSetupResolution: null,
      baseBranchForWorktree: null,
      selectedModelSelectionForSend: modelSelection,
      selectedModelForSend: modelSelection.model,
      targetProjectDefaultModelSelectionForSend: null,
      title: "Prompt",
      nextRuntimeModeForSend: "approval-required",
      interactionModeForSend: "default",
      activeThread: makeThread({ id: threadId }),
      targetProjectKindForSend: "chat",
      setupScriptForWorktree: null,
      messageCreatedAt: "2026-01-01T00:00:00.000Z",
      messageIdForSend: MessageId.makeUnsafe("rename-message"),
      turnAttachmentsPromise: Promise.resolve({
        attachments: [],
        cleanup: noop,
        commit: noop,
        runWithDispatch: async (run: (attachments: []) => Promise<void>) => run([]),
      }),
      outgoingMessageText: "Prompt",
      mentionedSkillsForSend: [],
      mentionedPluginMentionsForSend: [],
      dispatchMode: "queue",
      queuedChatTurn: null,
      sourceProposedPlanForSend: null,
      shouldResumeSettledLocalThread: false,
      currentActiveGitBranchForSend: null,
      turnDispatchSettings: {
        modelSelection,
        providerOptions: undefined,
        enableComputerControl: false,
        assistantDeliveryMode: "buffered",
        runtimeMode: "approval-required",
        interactionMode: "default",
        envMode: "local",
      },
      promptForSend: "Prompt",
      composerImagesSnapshot: [],
      composerFilesSnapshot: [],
      composerAssistantSelectionsSnapshot: [],
      composerBrowserAnnotationsSnapshot: [],
      composerFileCommentsSnapshot: [],
      composerTerminalContextsSnapshot: [],
      composerPastedTextsSnapshot: [],
      composerPullRequestContextsSnapshot: [],
      composerSkillsSnapshot: [],
      composerMentionsSnapshot: [],
    } as unknown as Prepared;
    expect(await execute(prepared)).toBe(true);
    expect(dispatchCommand.mock.calls.map(([command]) => command.type)).toEqual([
      "thread.turn.start",
      "project.meta.update",
    ]);
  });
});
