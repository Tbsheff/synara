import { ThreadId, type ThreadComputerState } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QueuedComposerTurn } from "../composerDraftStore";
import { resetComposerDraftStore } from "../composerDraftStoreTestFixtures";
import { useComputerStateStore } from "../computerStateStore";
import { useStore } from "../store";
import { initialState } from "../storeState";
import { makeState, makeThread } from "../storeTestFixtures";
import * as computerProvisioning from "./computerProvisioning";
import { dispatchQueuedComposerTurnHeadless } from "./queuedComposerDispatch";

const nativeApiMocks = vi.hoisted(() => ({
  dispatchCommand: vi.fn(async (_command: Record<string, unknown>) => undefined),
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: {
      dispatchCommand: nativeApiMocks.dispatchCommand,
    },
  }),
}));

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

const BASE_FIELDS = {
  selectedProvider: "codex",
  selectedModel: "gpt-5",
  selectedPromptEffort: null,
  modelSelection: { provider: "codex", model: "gpt-5" },
  runtimeMode: "full-access",
} as const;

function makeQueuedTurn(
  kind: "chat" | "plan-follow-up",
  computer: {
    computerControlMode: "off" | "request" | "chat";
    computerControlGeneration: number;
  },
): QueuedComposerTurn {
  const enableComputerControl = computer.computerControlMode !== "off";
  if (kind === "plan-follow-up") {
    return {
      id: "queued-plan-1",
      kind: "plan-follow-up",
      createdAt: "2026-03-13T12:00:00.000Z",
      previewText: "use the computer to implement the plan",
      text: "use the computer to implement the plan",
      interactionMode: "default",
      ...BASE_FIELDS,
      ...computer,
      enableComputerControl,
    };
  }
  return {
    id: "queued-chat-1",
    kind: "chat",
    createdAt: "2026-03-13T12:00:00.000Z",
    previewText: "open the settings window",
    prompt: "open the settings window",
    images: [],
    files: [],
    assistantSelections: [],
    browserAnnotations: [],
    terminalContexts: [],
    fileComments: [],
    pastedTexts: [],
    pullRequestContexts: [],
    skills: [],
    mentions: [],
    ...BASE_FIELDS,
    ...computer,
    enableComputerControl,
    interactionMode: "default",
    envMode: "local",
  };
}

function setLiveControlGeneration(generation: number): void {
  useComputerStateStore.setState({
    threadStatesByThreadId: {
      [THREAD_ID]: { threadId: THREAD_ID, controlGeneration: generation } as ThreadComputerState,
    },
  });
}

function turnStartCommand(): Record<string, unknown> | undefined {
  return nativeApiMocks.dispatchCommand.mock.calls
    .map(([command]) => command)
    .find((command) => command.type === "thread.turn.start");
}

describe("dispatchQueuedComposerTurnHeadless computer control", () => {
  beforeEach(() => {
    resetComposerDraftStore();
    useStore.setState(initialState);
    useComputerStateStore.getState().clear();
    nativeApiMocks.dispatchCommand.mockClear();
    useStore.setState(
      makeState(
        makeThread({
          id: THREAD_ID,
          modelSelection: { provider: "codex", model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
        }),
      ),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetComposerDraftStore();
    useStore.setState(initialState);
    useComputerStateStore.getState().clear();
  });

  it.each(["chat", "plan-follow-up"] as const)(
    "sends the frozen request mode and generation of a queued %s",
    async (kind) => {
      setLiveControlGeneration(4);
      const succeeded = await dispatchQueuedComposerTurnHeadless({
        threadId: THREAD_ID,
        queuedTurn: makeQueuedTurn(kind, {
          computerControlMode: "request",
          computerControlGeneration: 4,
        }),
        dispatchMode: "queue",
        assistantDeliveryMode: "streaming",
      });

      expect(succeeded).toBe(true);
      expect(turnStartCommand()).toMatchObject({
        enableComputerControl: true,
        computerControlMode: "request",
        computerControlGeneration: 4,
      });
    },
  );

  it.each(["chat", "plan-follow-up"] as const)(
    "turns computer control off for a queued %s whose generation was revoked",
    async (kind) => {
      setLiveControlGeneration(5);
      const succeeded = await dispatchQueuedComposerTurnHeadless({
        threadId: THREAD_ID,
        queuedTurn: makeQueuedTurn(kind, {
          computerControlMode: "request",
          computerControlGeneration: 4,
        }),
        dispatchMode: "queue",
        assistantDeliveryMode: "streaming",
      });

      expect(succeeded).toBe(true);
      expect(turnStartCommand()).toMatchObject({
        enableComputerControl: false,
        computerControlMode: "off",
      });
    },
  );

  it.each(["chat", "plan-follow-up"] as const)(
    "keeps chat mode for a queued %s only while the Settings default still allows it",
    async (kind) => {
      setLiveControlGeneration(2);
      const queuedTurn = makeQueuedTurn(kind, {
        computerControlMode: "chat",
        computerControlGeneration: 2,
      });

      await dispatchQueuedComposerTurnHeadless({
        threadId: THREAD_ID,
        queuedTurn,
        dispatchMode: "queue",
        assistantDeliveryMode: "streaming",
        computerControlEnabled: true,
      });
      expect(turnStartCommand()).toMatchObject({
        enableComputerControl: true,
        computerControlMode: "chat",
        computerControlGeneration: 2,
      });

      nativeApiMocks.dispatchCommand.mockClear();
      await dispatchQueuedComposerTurnHeadless({
        threadId: THREAD_ID,
        queuedTurn,
        dispatchMode: "queue",
        assistantDeliveryMode: "streaming",
        computerControlEnabled: false,
      });
      expect(turnStartCommand()).toMatchObject({
        enableComputerControl: false,
        computerControlMode: "off",
      });
    },
  );

  it.each(["chat", "plan-follow-up"] as const)(
    "holds a queued request-mode %s while computer permissions are not ready",
    async (kind) => {
      setLiveControlGeneration(1);
      const guide = vi
        .spyOn(computerProvisioning, "prepareComputerPermissionGuide")
        .mockResolvedValue(false);
      const succeeded = await dispatchQueuedComposerTurnHeadless({
        threadId: THREAD_ID,
        queuedTurn: makeQueuedTurn(kind, {
          computerControlMode: "request",
          computerControlGeneration: 1,
        }),
        dispatchMode: "queue",
        assistantDeliveryMode: "streaming",
      });

      expect(succeeded).toBe(false);
      expect(guide).toHaveBeenCalledOnce();
      expect(nativeApiMocks.dispatchCommand).not.toHaveBeenCalled();
    },
  );

  it.each(["chat", "plan-follow-up"] as const)(
    "keeps the frozen request of a queued %s when this thread's computer state is not loaded yet",
    async (kind) => {
      const succeeded = await dispatchQueuedComposerTurnHeadless({
        threadId: THREAD_ID,
        queuedTurn: makeQueuedTurn(kind, {
          computerControlMode: "request",
          computerControlGeneration: 4,
        }),
        dispatchMode: "queue",
        assistantDeliveryMode: "streaming",
      });

      expect(succeeded).toBe(true);
      expect(turnStartCommand()).toMatchObject({
        enableComputerControl: true,
        computerControlMode: "request",
        computerControlGeneration: 4,
      });
    },
  );
});
