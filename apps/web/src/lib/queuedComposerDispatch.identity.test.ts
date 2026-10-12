import { CommandId, MessageId, ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QueuedComposerTurn } from "../composerDraftStore";
import { resetComposerDraftStore } from "../composerDraftStoreTestFixtures";
import { useStore } from "../store";
import { initialState } from "../storeState";
import { makeState, makeThread } from "../storeTestFixtures";
import * as composerSend from "./composerSend";
import {
  dispatchQueuedComposerTurnHeadless,
  releaseQueuedComposerDispatchAttempt,
} from "./queuedComposerDispatch";

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
const COMMAND_ID = CommandId.makeUnsafe("queued-command-1");
const MESSAGE_ID = MessageId.makeUnsafe("queued-message-1");
const CREATED_AT = "2026-03-13T12:05:00.000Z";

const UNKNOWN_OUTCOME = {
  _tag: "WsTransportRequestInterruptedError",
  code: "WS_REQUEST_TIMEOUT",
  message: "timed out",
};

function makeQueuedChatTurn(): QueuedComposerTurn {
  return {
    id: "queued-chat-1",
    kind: "chat",
    createdAt: "2026-03-13T12:00:00.000Z",
    previewText: "follow up with the screenshot",
    prompt: "follow up with the screenshot",
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
    selectedProvider: "codex",
    selectedModel: "gpt-5",
    selectedPromptEffort: null,
    modelSelection: { provider: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    envMode: "local",
  };
}

function turnStarts(): Record<string, unknown>[] {
  return nativeApiMocks.dispatchCommand.mock.calls
    .map(([command]) => command)
    .filter((command) => command.type === "thread.turn.start");
}

describe("dispatchQueuedComposerTurnHeadless attempt identity", () => {
  const cleanup = vi.fn(async () => undefined);
  const commit = vi.fn();
  let stageUpload: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetComposerDraftStore();
    nativeApiMocks.dispatchCommand.mockReset();
    nativeApiMocks.dispatchCommand.mockResolvedValue(undefined);
    cleanup.mockClear();
    commit.mockClear();
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
    let uploadCount = 0;
    stageUpload = vi
      .spyOn(composerSend, "stageUploadComposerAttachments")
      .mockImplementation(async () => {
        uploadCount += 1;
        const attachments = [
          { type: "image" as const, id: `managed-upload-${uploadCount}` },
        ] as unknown as composerSend.StagedComposerAttachments["attachments"];
        return {
          attachments,
          cleanup,
          commit,
          runWithDispatch: async (run) => {
            try {
              const result = await run(attachments);
              commit();
              return result;
            } catch (error) {
              await cleanup();
              throw error;
            }
          },
        };
      });
  });

  afterEach(() => {
    releaseQueuedComposerDispatchAttempt(COMMAND_ID);
    vi.restoreAllMocks();
    resetComposerDraftStore();
    useStore.setState(initialState);
  });

  it("keeps uploads and resends the identical command after an unknown outcome", async () => {
    nativeApiMocks.dispatchCommand.mockImplementation(async (command) => {
      if (command.type === "thread.turn.start" && turnStarts().length === 1) {
        throw UNKNOWN_OUTCOME;
      }
      return undefined;
    });
    const onOutcomeUnknown = vi.fn();
    const input = {
      threadId: THREAD_ID,
      queuedTurn: makeQueuedChatTurn(),
      dispatchMode: "queue" as const,
      assistantDeliveryMode: "streaming" as const,
      messageId: MESSAGE_ID,
      commandId: COMMAND_ID,
      createdAt: CREATED_AT,
      onOutcomeUnknown,
    };

    expect(await dispatchQueuedComposerTurnHeadless(input)).toBe(false);
    expect(onOutcomeUnknown).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();

    expect(await dispatchQueuedComposerTurnHeadless(input)).toBe(true);
    expect(stageUpload).toHaveBeenCalledOnce();
    const [first, second] = turnStarts();
    expect(first).toMatchObject({ commandId: COMMAND_ID, createdAt: CREATED_AT });
    expect(second).toEqual(first);
    expect(commit).toHaveBeenCalled();
  });

  it("cleans up uploads and reports no unknown outcome after a definitive failure", async () => {
    nativeApiMocks.dispatchCommand.mockImplementation(async (command) => {
      if (command.type === "thread.turn.start") throw new Error("Thread is busy.");
      return undefined;
    });
    const onOutcomeUnknown = vi.fn();

    const succeeded = await dispatchQueuedComposerTurnHeadless({
      threadId: THREAD_ID,
      queuedTurn: makeQueuedChatTurn(),
      dispatchMode: "queue",
      assistantDeliveryMode: "streaming",
      messageId: MESSAGE_ID,
      commandId: COMMAND_ID,
      createdAt: CREATED_AT,
      onOutcomeUnknown,
    });

    expect(succeeded).toBe(false);
    expect(onOutcomeUnknown).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it.each(["chat", "plan-follow-up"] as const)(
    "resends the frozen %s command even when live settings changed after an unknown outcome",
    async (kind) => {
      nativeApiMocks.dispatchCommand.mockImplementation(async (command) => {
        if (command.type === "thread.turn.start" && turnStarts().length === 1) {
          throw UNKNOWN_OUTCOME;
        }
        return undefined;
      });
      const queuedTurn: QueuedComposerTurn =
        kind === "chat"
          ? makeQueuedChatTurn()
          : {
              id: "queued-plan-1",
              kind: "plan-follow-up",
              createdAt: "2026-03-13T12:00:00.000Z",
              previewText: "implement the plan",
              text: "implement the plan",
              interactionMode: "default",
              selectedProvider: "codex",
              selectedModel: "gpt-5",
              selectedPromptEffort: null,
              modelSelection: { provider: "codex", model: "gpt-5" },
              runtimeMode: "full-access",
            };
      const base = {
        threadId: THREAD_ID,
        queuedTurn,
        dispatchMode: "queue" as const,
        messageId: MESSAGE_ID,
        commandId: COMMAND_ID,
        createdAt: CREATED_AT,
      };

      expect(
        await dispatchQueuedComposerTurnHeadless({ ...base, assistantDeliveryMode: "streaming" }),
      ).toBe(false);
      expect(
        await dispatchQueuedComposerTurnHeadless({ ...base, assistantDeliveryMode: "buffered" }),
      ).toBe(true);

      const [first, second] = turnStarts();
      expect(first).toMatchObject({ assistantDeliveryMode: "streaming" });
      expect(second).toEqual(first);
    },
  );
});
