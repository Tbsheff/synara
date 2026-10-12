import type { ClientOrchestrationCommand } from "@synara/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";
import { makeThread } from "../../storeTestFixtures";
import { emitWsTransportState } from "../../wsTransportEvents";
import { useWarmProviderSession } from "./useWarmProviderSession";

const api = vi.hoisted(() => ({
  orchestration: {
    dispatchCommand: vi.fn<(command: ClientOrchestrationCommand) => Promise<void>>(async () => {}),
  },
}));
vi.mock("~/nativeApi", () => ({ readNativeApi: () => api }));
afterEach(() => vi.clearAllMocks());

it("warms on open, focus and reconnect without a turn, and re-warms changed settings", async () => {
  const thread = makeThread();
  const persistSettings = vi.fn(async () => {});
  const input = {
    thread,
    enabled: true,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    persistSettings,
  };
  const screen = await renderHook((props = input) => useWarmProviderSession(props), {
    initialProps: input,
  });
  try {
    await expect.poll(() => api.orchestration.dispatchCommand.mock.calls.length).toBe(1);
    screen.result.current();
    expect(api.orchestration.dispatchCommand.mock.calls.length).toBe(1);
    await screen.rerender({
      ...input,
      modelSelection: { ...thread.modelSelection, model: "other" },
      runtimeMode: "full-access",
    });
    await expect.poll(() => api.orchestration.dispatchCommand.mock.calls.length).toBe(2);
    emitWsTransportState("open");
    await expect.poll(() => api.orchestration.dispatchCommand.mock.calls.length).toBe(3);
    for (const [command] of api.orchestration.dispatchCommand.mock.calls) {
      expect(command.type).toBe("thread.session.warm");
      expect(command).not.toHaveProperty("message");
      expect(command).not.toHaveProperty("input");
    }
  } finally {
    await screen.unmount();
  }
});

it.each([
  { archivedAt: new Date().toISOString() },
  { parentThreadId: "parent" },
  { accountMismatch: true },
])("does not warm an ineligible thread: %j", async (change) => {
  const thread = makeThread(change as Parameters<typeof makeThread>[0]);
  const persistSettings = vi.fn(async () => {});
  const screen = await renderHook(() =>
    useWarmProviderSession({
      thread,
      enabled: true,
      modelSelection:
        "accountMismatch" in change
          ? { ...thread.modelSelection, instanceId: "other-account" }
          : thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      persistSettings,
    }),
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 350));
    screen.result.current();
    expect(api.orchestration.dispatchCommand).not.toHaveBeenCalled();
    expect(persistSettings).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});

it("re-warms an allowed saved account change without touching another account", async () => {
  const thread = makeThread();
  const modelSelection = { ...thread.modelSelection, instanceId: "codex-work" };
  const input = {
    thread,
    enabled: true,
    modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    persistSettings: vi.fn(async () => {}),
  };
  const screen = await renderHook((props = input) => useWarmProviderSession(props), {
    initialProps: input,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(api.orchestration.dispatchCommand).not.toHaveBeenCalled();
    await screen.rerender({ ...input, thread: { ...thread, modelSelection } });
    await expect.poll(() => api.orchestration.dispatchCommand.mock.calls.length).toBe(1);
    expect(api.orchestration.dispatchCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.session.warm",
      modelSelection,
    });
  } finally {
    await screen.unmount();
  }
});
