import { ThreadId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";
import { createComposerDraftPersistStorage } from "./composerDraftStorage";
import { useComposerDraftStore } from "./composerDraftStore";
import * as Schema from "effect/Schema";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  composerDraftThreadStorageKey,
} from "./composerDraftDomain";
import { DRAFT_ATTACHMENT_SLOT, syncPersistedAttachmentsForSlot } from "./composerDraftAttachments";
import { setLocalStorageItem } from "./hooks/useLocalStorage";
import { makeImage, resetComposerDraftStore } from "./composerDraftStoreTestFixtures";
import { createMemoryStorage } from "./lib/storage";

const A = ThreadId.makeUnsafe("draft-a");
const B = ThreadId.makeUnsafe("draft-b");

describe("composer draft record storage", () => {
  it("verifies native capture persistence from the per-thread record", async () => {
    resetComposerDraftStore();
    const image = makeImage({ id: "native-capture", previewUrl: "blob:native-capture" });
    useComposerDraftStore.getState().addImage(A, image);
    const attachment = {
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      blobKey: "capture-blob",
    };
    const result = await syncPersistedAttachmentsForSlot(
      A,
      [attachment],
      useComposerDraftStore.getState,
      useComposerDraftStore.setState,
      DRAFT_ATTACHMENT_SLOT,
      () => {
        setLocalStorageItem(
          COMPOSER_DRAFT_STORAGE_KEY,
          {
            version: COMPOSER_DRAFT_STORAGE_VERSION,
            state: { draftsByThreadId: {}, draftRecordIds: [A] },
          },
          Schema.Unknown,
        );
        setLocalStorageItem(
          composerDraftThreadStorageKey(COMPOSER_DRAFT_STORAGE_KEY, A),
          { prompt: "", attachments: [attachment] },
          Schema.Unknown,
        );
      },
    );
    expect(result).toBe("persisted");
  });

  it("loads synchronous draft storage before the first edit", () => {
    const base = createMemoryStorage();
    base.setItem(
      "drafts",
      JSON.stringify({ version: 1, state: { draftsByThreadId: {}, draftRecordIds: [A] } }),
    );
    base.setItem(
      composerDraftThreadStorageKey("drafts", A),
      JSON.stringify({ prompt: "saved first", attachments: [] }),
    );
    const loaded = createComposerDraftPersistStorage(base).getItem("drafts");
    expect(loaded).not.toBeInstanceOf(Promise);
    expect(loaded).toMatchObject({
      state: { draftsByThreadId: { [A]: { prompt: "saved first" } } },
    });
  });

  it("writes only the changed thread and reloads both drafts", async () => {
    resetComposerDraftStore();
    const base = createMemoryStorage();
    const setItem = vi.spyOn(base, "setItem");
    const storage = createComposerDraftPersistStorage(base);
    useComposerDraftStore.getState().setPrompt(A, "first thread");
    useComposerDraftStore.getState().setPrompt(B, "second thread");
    storage.setItem("drafts", { state: useComposerDraftStore.getState() as never, version: 1 });
    storage.flush();
    setItem.mockClear();

    useComposerDraftStore.getState().setPrompt(A, "edited first thread");
    storage.setItem("drafts", { state: useComposerDraftStore.getState() as never, version: 1 });
    storage.flush();

    expect(setItem.mock.calls.map(([, raw]) => raw).join("\n")).not.toContain("second thread");
    const reloaded = await createComposerDraftPersistStorage(base).getItem("drafts");
    expect(reloaded?.state.draftsByThreadId[A]?.prompt).toBe("edited first thread");
    expect(reloaded?.state.draftsByThreadId[B]?.prompt).toBe("second thread");
  });

  it("loads legacy single-record storage before writing separate thread records", async () => {
    const base = createMemoryStorage();
    base.setItem(
      "drafts",
      JSON.stringify({
        version: 1,
        state: { draftsByThreadId: { [A]: { prompt: "legacy", attachments: [] } } },
      }),
    );
    const value = await createComposerDraftPersistStorage(base).getItem("drafts");
    expect(value?.state.draftsByThreadId[A]?.prompt).toBe("legacy");
  });

  it("removes deleted thread records without losing the other draft", async () => {
    resetComposerDraftStore();
    const base = createMemoryStorage();
    const storage = createComposerDraftPersistStorage(base);
    useComposerDraftStore.getState().setPrompt(A, "first");
    useComposerDraftStore.getState().setPrompt(B, "second");
    storage.setItem("drafts", { state: useComposerDraftStore.getState() as never, version: 1 });
    storage.flush();
    useComposerDraftStore.setState({
      draftsByThreadId: { [B]: useComposerDraftStore.getState().draftsByThreadId[B]! },
    });
    storage.setItem("drafts", { state: useComposerDraftStore.getState() as never, version: 1 });
    storage.flush();
    const value = await createComposerDraftPersistStorage(base).getItem("drafts");
    expect(value?.state.draftsByThreadId[A]).toBeUndefined();
    expect(value?.state.draftsByThreadId[B]?.prompt).toBe("second");
  });
});
