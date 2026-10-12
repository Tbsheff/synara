import { ProjectId, ThreadId, ProviderInstanceId } from "@synara/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { reactHookHarness } from "../../test/reactHookHarness";
import { KanbanTaskProjectPicker } from "./KanbanTaskProjectPicker";
import { KanbanTaskExtrasMenu } from "./KanbanTaskExtrasMenu";
import { useKanbanTaskSubmit } from "./useKanbanTaskSubmit";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  create: vi.fn(),
  toast: vi.fn(),
  wait: vi.fn(),
  close: vi.fn(),
}));
vi.mock("react", async () => (await import("../../test/reactHookHarness")).reactHookHarnessMock);
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("~/hooks/useProviderStatusRefresh", () => ({
  useRefreshProviderStatusesNow: () => vi.fn(),
}));
vi.mock("~/lib/providerAvailability", () => ({
  resolveProviderSendAvailabilityWithRefresh: async () => ({ usable: true }),
}));
vi.mock("~/composerDraftStore", () => ({
  providerInstanceModelSelectionKey: () => "codex",
  useComposerDraftStore: { getState: () => ({ draftsByThreadId: {} }) },
}));
vi.mock("~/lib/kanbanTaskCreate", () => ({
  createAndSendKanbanTask: mocks.send,
  createKanbanDraftTask: mocks.create,
}));
const input = {
  selectedProjectId: ProjectId.makeUnsafe("project"),
  hasSendableContent: true,
  selectedProvider: "codex",
  selectedProviderInstanceId: ProviderInstanceId.makeUnsafe("codex"),
  selectedModel: "gpt-5.4",
  selectedModelSupportsAutoMode: undefined,
  taskPreview: "Task",
  trimmedPrompt: "Task",
  scratchThreadId: ThreadId.makeUnsafe("scratch"),
  runtimeMode: "approval-required",
  interactionMode: "default",
  envMode: "local",
  sendAsDraft: false,
  defaultProvider: "codex",
  assistantDeliveryMode: "buffered",
  providerOptionsForDispatch: undefined,
  providerInstances: [],
  providerStatuses: [],
  isPreparingImages: false,
  waitForPendingImages: mocks.wait,
  onOpenChange: mocks.close,
} as const;
const render = (overrides: Partial<Parameters<typeof useKanbanTaskSubmit>[0]> = {}) => {
  reactHookHarness.beginRender();
  return useKanbanTaskSubmit({ ...input, ...overrides });
};
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
beforeEach(() => {
  reactHookHarness.reset();
  vi.clearAllMocks();
  mocks.wait.mockResolvedValue(undefined);
});
it("retries the saved task instead of creating a second task", async () => {
  const threadId = ThreadId.makeUnsafe("saved-task");
  mocks.send.mockResolvedValueOnce({ threadId, result: { kind: "error", message: "send failed" } });
  await render().handleCreate();
  await flush();
  mocks.send.mockResolvedValueOnce({ threadId, result: { kind: "dispatched" } });
  await render().handleCreate();
  await flush();
  expect(mocks.send.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ threadId }));
});
it("releases the submit guard when image preparation fails", async () => {
  mocks.wait.mockRejectedValueOnce(new Error("Image preparation failed"));
  await render().handleCreate();
  await flush();
  mocks.send.mockResolvedValueOnce({
    threadId: ThreadId.makeUnsafe("saved-task"),
    result: { kind: "dispatched" },
  });
  await render().handleCreate();
  await flush();
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({ description: "Image preparation failed" }),
  );
});

it("updates the saved task from scratch before saving edited content as a draft", async () => {
  const threadId = ThreadId.makeUnsafe("saved-edited-draft");
  mocks.send.mockResolvedValueOnce({ threadId, result: { kind: "error", message: "Refused" } });
  await render().handleCreate();
  await flush();
  mocks.create.mockReturnValueOnce(threadId);
  await render({ sendAsDraft: true, trimmedPrompt: "Edited prompt" }).handleCreate();
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({
      threadId,
      prompt: "Edited prompt",
      sourceComposerThreadId: input.scratchThreadId,
    }),
  );
  expect(mocks.close).toHaveBeenCalledWith(false);
});
it("withholds save as draft while the send outcome is unknown", async () => {
  mocks.send.mockResolvedValueOnce({
    threadId: ThreadId.makeUnsafe("unknown-task"),
    result: { kind: "error", message: "Reply lost", outcomeUnknown: true },
  });
  await render().handleCreate();
  await flush();
  const retry = render({ sendAsDraft: true, trimmedPrompt: "Edited prompt" });
  expect(retry.canCreate).toBe(false);
  await retry.handleCreate();
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalledWith(
    expect.objectContaining({ title: "Task added to Drafts" }),
  );
});

it.each([
  { selectedProjectId: ProjectId.makeUnsafe("different-project") },
  { envMode: "worktree" as const },
])("keeps the saved task target fixed after failure: %s", async (change) => {
  const threadId = ThreadId.makeUnsafe("fixed-target-task");
  mocks.send.mockImplementationOnce(async (request) => {
    request.onCreated(threadId);
    return { threadId, result: { kind: "error", message: "Refused" } };
  });
  await render().handleCreate();
  await flush();
  const changed = render(change);
  expect(changed.canCreate).toBe(false);
  await changed.handleCreate();
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(render().savedTaskTarget).toEqual({
    projectId: input.selectedProjectId,
    envMode: input.envMode,
  });
});
it("locks the target when creation succeeds even if dispatch later throws", async () => {
  mocks.send.mockImplementationOnce(async (request) => {
    request.onCreated(ThreadId.makeUnsafe("fixed-target-thrown"));
    throw new Error("Dispatch failed");
  });
  await render().handleCreate();
  await flush();
  expect(render().savedTaskTarget).toEqual({
    projectId: input.selectedProjectId,
    envMode: input.envMode,
  });
});

vi.mock("~/components/ProjectMenuPicker", () => ({ ProjectMenuPicker: () => null }));
vi.mock("~/components/ui/button", () => ({ Button: () => null }));
vi.mock("~/components/chat/ComposerPickerMenuPopup", () => ({
  ComposerPickerMenuPopup: () => null,
  ComposerPickerMenuSubPopup: () => null,
}));
vi.mock("~/components/ui/menu", () => ({
  Menu: () => null,
  MenuRadioGroup: () => null,
  MenuRadioItem: () => null,
  MenuSeparator: () => null,
  MenuSub: () => null,
  MenuSubTrigger: () => null,
  MenuTrigger: () => null,
}));
vi.mock("~/lib/icons", () => ({
  ChevronDownIcon: () => null,
  BugIcon: () => null,
  ListTodoIcon: () => null,
  MessageCircleIcon: () => null,
  PlusIcon: () => null,
  WorktreeIcon: () => null,
}));
vi.mock("~/lib/central-icons", () => ({ CentralIcon: () => null }));

it("disables the project picker and ignores a stale project choice after saving", () => {
  const change = vi.fn();
  const picker = KanbanTaskProjectPicker({
    projectOptions: [{ id: input.selectedProjectId, name: "Project" }],
    selectedProjectId: input.selectedProjectId,
    onProjectIdChange: change,
    disabled: true,
  });
  expect(picker.props.trigger.props.disabled).toBe(true);
  picker.props.onProjectIdChange(ProjectId.makeUnsafe("different-project"));
  expect(change).not.toHaveBeenCalled();
});
it("disables both environment choices and ignores a stale worktree choice after saving", () => {
  const change = vi.fn();
  const menu = KanbanTaskExtrasMenu({
    provider: "codex",
    interactionMode: "default",
    onInteractionModeChange: vi.fn(),
    envMode: "local",
    onEnvModeChange: change,
    environmentDisabled: true,
  });
  const group = menu.props.children[1].props.children[2];
  expect(
    group.props.children.every((item: { props: { disabled: boolean } }) => item.props.disabled),
  ).toBe(true);
  group.props.onValueChange("worktree");
  expect(change).not.toHaveBeenCalled();
});
