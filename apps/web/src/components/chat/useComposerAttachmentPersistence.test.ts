import { ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeImage } from "../../composerDraftStoreTestFixtures";
import { stagePersistedComposerImageAttachments } from "./useComposerAttachmentPersistence";

const blobStore = vi.hoisted(() => ({
  writes: [] as string[],
  delayMsByImageId: new Map<string, number>(),
  failWrites: false,
}));

vi.mock("../../lib/composerImageBlobStore", () => ({
  composerImageBlobKey: (threadId: string, imageId: string) => `${threadId}:${imageId}`,
  persistComposerImageBlob: vi.fn(async (input: { threadId: string; imageId: string }) => {
    await new Promise((resolve) =>
      setTimeout(resolve, blobStore.delayMsByImageId.get(input.imageId) ?? 0),
    );
    if (blobStore.failWrites) throw new Error("IndexedDB unavailable");
    blobStore.writes.push(input.imageId);
    return `${input.threadId}:${input.imageId}`;
  }),
}));

vi.mock("../../lib/composerSend", () => ({
  readFileAsDataUrl: vi.fn(async (file: File) => `data:${file.type};base64,AQEBAQ==`),
}));

const THREAD_ID = ThreadId.makeUnsafe("thread-draft-images");

function appSnapImage(id: string) {
  return {
    ...makeImage({ id, previewUrl: `blob:${id}` }),
    source: {
      kind: "appsnap" as const,
      captureId: `capture-${id}`,
      capturedAt: "2026-10-11T10:00:00.000Z",
      appName: "Finder",
      windowTitle: null,
    },
  };
}

describe("stagePersistedComposerImageAttachments", () => {
  beforeEach(() => {
    blobStore.writes = [];
    blobStore.delayMsByImageId.clear();
    blobStore.failWrites = false;
  });

  it("stores a pasted image as a blob reference instead of base64", async () => {
    const image = makeImage({ id: "pasted-1", previewUrl: "blob:pasted-1" });

    const staged = await stagePersistedComposerImageAttachments({
      threadId: THREAD_ID,
      images: [image],
      getPersistedAttachments: () => [],
    });

    expect(staged).toEqual([
      {
        id: "pasted-1",
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        blobKey: `${THREAD_ID}:pasted-1`,
      },
    ]);
  });

  it("reuses the stored blob of an unchanged image without writing it again", async () => {
    const image = makeImage({ id: "pasted-1", previewUrl: "blob:pasted-1" });
    const existing = {
      id: "pasted-1",
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      blobKey: `${THREAD_ID}:pasted-1`,
    };

    const staged = await stagePersistedComposerImageAttachments({
      threadId: THREAD_ID,
      images: [image],
      getPersistedAttachments: () => [existing],
    });

    expect(staged).toEqual([existing]);
    expect(blobStore.writes).toEqual([]);
  });

  it("keeps the composer order when an earlier image finishes storing last", async () => {
    blobStore.delayMsByImageId.set("first", 20);
    const images = [appSnapImage("first"), appSnapImage("second")];

    const staged = await stagePersistedComposerImageAttachments({
      threadId: THREAD_ID,
      images,
      getPersistedAttachments: () => [],
    });

    expect(staged.map((attachment) => attachment.id)).toEqual(["first", "second"]);
  });

  it("falls back to inline data when blob storage is unavailable", async () => {
    blobStore.failWrites = true;
    const image = makeImage({ id: "pasted-1", previewUrl: "blob:pasted-1" });

    const staged = await stagePersistedComposerImageAttachments({
      threadId: THREAD_ID,
      images: [image],
      getPersistedAttachments: () => [],
    });

    expect(staged).toHaveLength(1);
    expect(staged[0]?.blobKey).toBeUndefined();
    expect(staged[0]?.dataUrl).toBe("data:image/png;base64,AQEBAQ==");
  });
});
