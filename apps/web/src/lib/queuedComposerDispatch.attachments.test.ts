import { ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QueuedComposerChatTurn } from "../composerDraftStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { makeFile, makeImage, resetComposerDraftStore } from "../composerDraftStoreTestFixtures";
import { useStore } from "../store";
import { initialState } from "../storeState";
import { makeState, makeThread } from "../storeTestFixtures";
import { toastManager } from "../components/ui/toast";
import * as composerSend from "./composerSend";
import {
  dispatchQueuedComposerTurnHeadless,
  persistQueuedComposerAttachments,
  restoreQueuedComposerChatTurnAttachments,
} from "./queuedComposerDispatch";
import {
  claimQueuedComposerAutoDispatch,
  resetQueuedComposerDrainForTests,
  startQueuedComposerDrainWatcher,
} from "./queuedComposerDrain";

const blobStore = vi.hoisted(() => ({
  files: new Map<string, File>(),
  failWrites: false,
}));

vi.mock("./composerImageBlobStore", () => ({
  composerImageBlobKey: (threadId: string, imageId: string) => `${threadId}:${imageId}`,
  persistComposerImageBlob: vi.fn(
    async (input: { threadId: string; imageId: string; file: File }) => {
      if (blobStore.failWrites) throw new Error("IndexedDB unavailable");
      const key = `${input.threadId}:${input.imageId}`;
      blobStore.files.set(key, input.file);
      return key;
    },
  ),
  readComposerImageBlob: vi.fn(async (key: string) => blobStore.files.get(key) ?? null),
  deleteComposerImageBlob: vi.fn(async () => undefined),
}));

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

function makeChatTurn(overrides: Partial<QueuedComposerChatTurn>): QueuedComposerChatTurn {
  return {
    id: "queued-chat-1",
    kind: "chat",
    createdAt: "2026-03-13T12:00:00.000Z",
    previewText: "review these",
    prompt: "review these",
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
    ...overrides,
  };
}

describe("queued composer attachments", () => {
  beforeEach(() => {
    blobStore.files.clear();
    blobStore.failWrites = false;
    resetComposerDraftStore();
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
  });

  it("stores queued image and file bytes as blobs, in input order", async () => {
    const first = makeImage({ id: "img-a", previewUrl: "data:image/png;base64,AAAA" });
    const second = makeImage({ id: "img-b", previewUrl: "data:image/png;base64,BBBB" });
    const file = makeFile({ id: "file-a", name: "spec.pdf", mimeType: "application/pdf" });

    const refs = await persistQueuedComposerAttachments({
      threadId: THREAD_ID,
      queuedTurnId: "queued-chat-1",
      images: [first, second],
      files: [file],
    });

    expect(refs.persistedImages.map((image) => image.id)).toEqual(["img-a", "img-b"]);
    expect(refs.persistedImages.every((image) => image.blobKey && !image.dataUrl)).toBe(true);
    expect(refs.persistedFiles).toEqual([
      {
        id: "file-a",
        name: "spec.pdf",
        mimeType: "application/pdf",
        sizeBytes: file.sizeBytes,
        blobKey: `${THREAD_ID}:queued:queued-chat-1:file-a`,
      },
    ]);
  });

  it("falls back to inline image data and a missing file marker when blob storage fails", async () => {
    blobStore.failWrites = true;
    const image = makeImage({ id: "img-a", previewUrl: "data:image/png;base64,AAAA" });
    const file = makeFile({ id: "file-a" });

    const refs = await persistQueuedComposerAttachments({
      threadId: THREAD_ID,
      queuedTurnId: "queued-chat-1",
      images: [image],
      files: [file],
    });

    expect(refs.persistedImages).toEqual([
      expect.objectContaining({ id: "img-a", dataUrl: "data:image/png;base64,AAAA" }),
    ]);
    expect(refs.persistedFiles).toEqual([expect.objectContaining({ id: "file-a" })]);
    expect(refs.persistedFiles[0]?.blobKey).toBeUndefined();
  });

  it("restores reloaded queued attachments from blobs in their original order", async () => {
    const image = makeImage({ id: "img-a", previewUrl: "data:image/png;base64,AAAA" });
    const file = makeFile({ id: "file-a", name: "spec.pdf" });
    const refs = await persistQueuedComposerAttachments({
      threadId: THREAD_ID,
      queuedTurnId: "queued-chat-1",
      images: [image],
      files: [file],
    });

    const restored = await restoreQueuedComposerChatTurnAttachments(
      makeChatTurn({ ...refs, images: [], files: [] }),
    );

    expect(restored.missingAttachmentNames).toEqual([]);
    expect(restored.turn.images.map((entry) => entry.id)).toEqual(["img-a"]);
    expect(restored.turn.files.map((entry) => [entry.id, entry.name])).toEqual([
      ["file-a", "spec.pdf"],
    ]);
  });

  it("sends a reloaded queued file in the background after restoring it", async () => {
    const file = makeFile({ id: "file-a", name: "spec.pdf" });
    const refs = await persistQueuedComposerAttachments({
      threadId: THREAD_ID,
      queuedTurnId: "queued-chat-1",
      images: [],
      files: [file],
    });
    const stageUpload = vi.spyOn(composerSend, "stageUploadComposerAttachments").mockResolvedValue({
      attachments: [],
      commit: () => undefined,
      cleanup: async () => undefined,
      runWithDispatch: async (run) => run([]),
    });

    const succeeded = await dispatchQueuedComposerTurnHeadless({
      threadId: THREAD_ID,
      queuedTurn: makeChatTurn({ ...refs, files: [] }),
      dispatchMode: "queue",
      assistantDeliveryMode: "streaming",
    });

    expect(succeeded).toBe(true);
    expect(stageUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [expect.objectContaining({ id: "file-a", name: "spec.pdf" })],
      }),
    );
  });

  it("holds a reloaded queued turn whose file is gone and tells the user", async () => {
    const toast = vi.spyOn(toastManager, "add");
    const stageUpload = vi.spyOn(composerSend, "stageUploadComposerAttachments");

    const succeeded = await dispatchQueuedComposerTurnHeadless({
      threadId: THREAD_ID,
      queuedTurn: makeChatTurn({
        persistedFiles: [{ id: "file-a", name: "spec.pdf", mimeType: "text/plain", sizeBytes: 4 }],
      }),
      dispatchMode: "queue",
      assistantDeliveryMode: "streaming",
    });

    expect(succeeded).toBe(false);
    expect(stageUpload).not.toHaveBeenCalled();
    expect(nativeApiMocks.dispatchCommand).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining("spec.pdf") }),
    );
  });

  it("restores a reloaded queued file into the queue so editing it keeps the file", async () => {
    const file = makeFile({ id: "file-a", name: "spec.pdf" });
    const refs = await persistQueuedComposerAttachments({
      threadId: THREAD_ID,
      queuedTurnId: "queued-chat-1",
      images: [],
      files: [file],
    });
    resetQueuedComposerDrainForTests();
    claimQueuedComposerAutoDispatch(THREAD_ID);
    useComposerDraftStore
      .getState()
      .enqueueQueuedTurn(THREAD_ID, makeChatTurn({ ...refs, files: [] }));
    const stop = startQueuedComposerDrainWatcher({ dispatch: async () => false });

    try {
      await vi.waitFor(() => {
        const queued = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]
          ?.queuedTurns[0] as QueuedComposerChatTurn | undefined;
        expect(queued?.files.map((entry) => entry.id)).toEqual(["file-a"]);
        expect(queued?.persistedFiles).toEqual(refs.persistedFiles);
      });
    } finally {
      stop();
      resetQueuedComposerDrainForTests();
    }
  });
});
