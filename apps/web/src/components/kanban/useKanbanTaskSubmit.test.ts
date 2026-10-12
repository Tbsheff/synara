import { ProjectId, ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ send: vi.fn(), close: vi.fn(), navigate: vi.fn() }));
vi.mock("react", async (load) => ({
  ...(await load<typeof import("react")>()),
  useRef: <T>(current: T) => ({ current }),
  useState: <T>(value: T) => [value, vi.fn()],
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => harness.navigate }));
vi.mock("~/hooks/useProviderStatusRefresh", () => ({
  useRefreshProviderStatusesNow: () => vi.fn(),
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("~/lib/providerAvailability", () => ({
  resolveProviderSendAvailabilityWithRefresh: async () => ({ usable: true }),
}));
vi.mock("~/lib/kanbanTaskCreate", () => ({
  createAndSendKanbanTask: harness.send,
  createKanbanDraftTask: vi.fn(),
}));
import { useKanbanTaskSubmit } from "./useKanbanTaskSubmit";

beforeEach(() => {
  harness.send.mockReset();
  harness.close.mockReset();
});
describe("Kanban new-task retry", () => {
  it.each(["returned error", "thrown error"])(
    "reuses the created task after a %s",
    async (failure) => {
      const createdId = ThreadId.makeUnsafe("created-kanban-task");
      harness.send
        .mockImplementationOnce(async (input) => {
          input.onThreadCreated?.(createdId);
          if (failure === "thrown error") throw new Error("send failed");
          return { threadId: createdId, result: { kind: "error", message: "send failed" } };
        })
        .mockResolvedValueOnce({ threadId: createdId, result: { kind: "dispatched" } });
      const submit = useKanbanTaskSubmit({
        selectedProjectId: ProjectId.makeUnsafe("project-task"),
        hasSendableContent: true,
        selectedProvider: "codex",
        selectedProviderInstanceId: "codex",
        selectedModel: "gpt-5.4",
        selectedModelSupportsAutoMode: undefined,
        taskPreview: "Fix task",
        trimmedPrompt: "Fix task",
        scratchThreadId: ThreadId.makeUnsafe("scratch-task"),
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
        waitForPendingImages: async () => undefined,
        onOpenChange: harness.close,
      });
      await submit.handleCreate();
      await vi.waitFor(() => expect(harness.send).toHaveBeenCalledTimes(1));
      await Promise.resolve();
      await Promise.resolve();
      expect(harness.close).not.toHaveBeenCalled();
      await submit.handleCreate();
      await vi.waitFor(() => expect(harness.send).toHaveBeenCalledTimes(2));
      expect(harness.send.mock.calls[1]?.[0].existingThreadId).toBe(createdId);
    },
  );
});
