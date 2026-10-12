import { ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QueuedComposerTurn } from "../composerDraftStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { resetComposerDraftStore } from "../composerDraftStoreTestFixtures";
import { useStore } from "../store";
import { initialState } from "../storeState";
import { makeState, makeThread } from "../storeTestFixtures";
import {
  resetQueuedComposerDrainForTests,
  setQueuedComposerDrainComputerControlEnabled,
  startQueuedComposerDrainWatcher,
} from "./queuedComposerDrain";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

interface DispatchInput {
  messageId?: string;
  commandId?: string;
  createdAt?: string;
  computerControlEnabled?: boolean;
  onOutcomeUnknown?: () => void;
}

function makeQueuedChatTurn(id: string): QueuedComposerTurn {
  return {
    id,
    kind: "chat",
    createdAt: "2026-03-13T12:00:00.000Z",
    previewText: `queued ${id}`,
    prompt: `queued ${id}`,
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

async function flushDrain(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("queued composer drain attempt identity", () => {
  const dispatch = vi.fn<(input: DispatchInput) => Promise<boolean>>();

  beforeEach(() => {
    vi.useFakeTimers();
    resetQueuedComposerDrainForTests();
    resetComposerDraftStore();
    useStore.setState(
      makeState(
        makeThread({
          id: THREAD_ID,
          session: {
            provider: "codex",
            status: "ready",
            orchestrationStatus: "ready",
            createdAt: "2026-02-13T00:00:00.000Z",
            updatedAt: "2026-02-13T00:00:00.000Z",
          },
        }),
      ),
    );
    dispatch.mockReset();
    startQueuedComposerDrainWatcher({ dispatch: dispatch as never });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetQueuedComposerDrainForTests();
    resetComposerDraftStore();
    useStore.setState(initialState);
  });

  it("retries an unknown-outcome send with the same message, command, and timestamp", async () => {
    dispatch.mockImplementationOnce(async (input) => {
      input.onOutcomeUnknown?.();
      return false;
    });
    dispatch.mockResolvedValueOnce(true);
    useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, makeQueuedChatTurn("uncertain"));

    await flushDrain();
    expect(dispatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(dispatch).toHaveBeenCalledTimes(2);

    const [first, second] = dispatch.mock.calls.map(([input]) => input);
    expect(first?.commandId).toBeDefined();
    expect(first?.createdAt).toBeDefined();
    expect(second?.messageId).toBe(first?.messageId);
    expect(second?.commandId).toBe(first?.commandId);
    expect(second?.createdAt).toBe(first?.createdAt);
  });

  it("mints a new identity after a definitive failure", async () => {
    dispatch.mockResolvedValueOnce(false);
    dispatch.mockResolvedValueOnce(true);
    useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, makeQueuedChatTurn("refused"));

    await flushDrain();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(dispatch).toHaveBeenCalledTimes(2);

    const [first, second] = dispatch.mock.calls.map(([input]) => input);
    expect(second?.messageId).not.toBe(first?.messageId);
    expect(second?.commandId).not.toBe(first?.commandId);
  });

  it("passes the Settings computer-control default to background sends", async () => {
    dispatch.mockResolvedValue(true);
    setQueuedComposerDrainComputerControlEnabled(true);
    useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, makeQueuedChatTurn("computer"));

    await flushDrain();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ computerControlEnabled: true }),
    );
  });
});
