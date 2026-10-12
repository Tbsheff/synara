import { ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { partializeComposerDraftStoreState, useComposerDraftStore } from "./composerDraftStore";
import { isComposerImageBlobReferenced } from "./composerDraftAttachments";
import {
  normalizeCurrentPersistedComposerDraftStoreState,
  toHydratedThreadDraft,
} from "./composerDraftPersistence";
import type { QueuedComposerChatTurn } from "./composerDraftDomain";
import {
  makeFile,
  makeImage,
  makeQueuedChatTurn,
  resetComposerDraftStore,
} from "./composerDraftStoreTestFixtures";

const THREAD_ID = ThreadId.makeUnsafe("thread-queued-attachments");

function reloadQueuedTurns() {
  const serialized = JSON.stringify(
    partializeComposerDraftStoreState(useComposerDraftStore.getState()),
  );
  const restored = normalizeCurrentPersistedComposerDraftStoreState(JSON.parse(serialized));
  const persistedDraft = restored.draftsByThreadId[THREAD_ID];
  return {
    serialized,
    queuedTurns: persistedDraft ? toHydratedThreadDraft(THREAD_ID, persistedDraft).queuedTurns : [],
  };
}

function queuedChatTurn(overrides: Partial<QueuedComposerChatTurn>): QueuedComposerChatTurn {
  return { ...(makeQueuedChatTurn("queued-with-files") as QueuedComposerChatTurn), ...overrides };
}

describe("queued composer turns with attachments across reload", () => {
  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("keeps a queued turn with a file and its stored file reference", () => {
    const file = makeFile({ id: "file-1", name: "spec.pdf", mimeType: "application/pdf" });
    useComposerDraftStore.getState().enqueueQueuedTurn(
      THREAD_ID,
      queuedChatTurn({
        prompt: "review the attached spec",
        files: [file],
        persistedFiles: [
          {
            id: "file-1",
            name: "spec.pdf",
            mimeType: "application/pdf",
            sizeBytes: file.sizeBytes,
            blobKey: "thread-queued-attachments:queued:queued-with-files:file-1",
          },
        ],
      }),
    );

    const { queuedTurns } = reloadQueuedTurns();

    expect(queuedTurns).toHaveLength(1);
    const restored = queuedTurns[0] as QueuedComposerChatTurn;
    expect(restored.prompt).toBe("review the attached spec");
    expect(restored.persistedFiles).toEqual([
      {
        id: "file-1",
        name: "spec.pdf",
        mimeType: "application/pdf",
        sizeBytes: file.sizeBytes,
        blobKey: "thread-queued-attachments:queued:queued-with-files:file-1",
      },
    ]);
  });

  it("keeps the text of a queued turn whose file bytes could not be stored and marks the file missing", () => {
    const file = makeFile({ id: "file-unsaved", name: "notes.txt" });
    useComposerDraftStore
      .getState()
      .enqueueQueuedTurn(THREAD_ID, queuedChatTurn({ prompt: "use these notes", files: [file] }));

    const { queuedTurns } = reloadQueuedTurns();

    expect(queuedTurns).toHaveLength(1);
    const restored = queuedTurns[0] as QueuedComposerChatTurn;
    expect(restored.prompt).toBe("use these notes");
    expect(restored.files).toEqual([]);
    expect(restored.persistedFiles).toEqual([
      { id: "file-unsaved", name: "notes.txt", mimeType: "text/plain", sizeBytes: file.sizeBytes },
    ]);
  });

  it("stores queued images by blob reference instead of base64", () => {
    const image = makeImage({ id: "snap-1", previewUrl: "data:image/png;base64,AAAA" });
    useComposerDraftStore.getState().enqueueQueuedTurn(
      THREAD_ID,
      queuedChatTurn({
        images: [image],
        persistedImages: [
          {
            id: "snap-1",
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
            blobKey: "thread-queued-attachments:queued:queued-with-files:snap-1",
          },
        ],
      }),
    );

    const { serialized, queuedTurns } = reloadQueuedTurns();

    expect(serialized).not.toContain("data:image/png;base64");
    expect((queuedTurns[0] as QueuedComposerChatTurn).persistedImages).toEqual([
      expect.objectContaining({
        id: "snap-1",
        blobKey: "thread-queued-attachments:queued:queued-with-files:snap-1",
      }),
    ]);
  });

  it("still hydrates a legacy queued image saved as a data URL", () => {
    const image = makeImage({ id: "legacy-1", previewUrl: "data:image/png;base64,AQEBAQ==" });
    useComposerDraftStore
      .getState()
      .enqueueQueuedTurn(THREAD_ID, queuedChatTurn({ images: [image] }));

    const { queuedTurns } = reloadQueuedTurns();

    const restored = queuedTurns[0] as QueuedComposerChatTurn;
    expect(restored.images.map((entry) => entry.id)).toEqual(["legacy-1"]);
    expect(restored.images[0]?.previewUrl).toBe("data:image/png;base64,AQEBAQ==");
  });

  it("protects queued blob references from orphaned-blob cleanup", () => {
    useComposerDraftStore.getState().enqueueQueuedTurn(
      THREAD_ID,
      queuedChatTurn({
        persistedFiles: [
          {
            id: "file-1",
            name: "spec.pdf",
            mimeType: "application/pdf",
            sizeBytes: 4,
            blobKey: "queued-file-blob",
          },
        ],
        persistedImages: [
          {
            id: "snap-1",
            name: "snap.png",
            mimeType: "image/png",
            sizeBytes: 4,
            blobKey: "queued-image-blob",
          },
        ],
      }),
    );
    const drafts = useComposerDraftStore.getState().draftsByThreadId;

    expect(isComposerImageBlobReferenced(drafts, "queued-file-blob")).toBe(true);
    expect(isComposerImageBlobReferenced(drafts, "queued-image-blob")).toBe(true);
    expect(isComposerImageBlobReferenced(drafts, "unrelated-blob")).toBe(false);
  });
});
