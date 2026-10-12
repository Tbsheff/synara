import { ThreadId } from "@synara/contracts";
import { useEffect } from "react";
import {
  type ComposerImageAttachment,
  type PersistedComposerImageAttachment,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { composerImageBlobKey, persistComposerImageBlob } from "../../lib/composerImageBlobStore";
import { readFileAsDataUrl } from "../../lib/composerSend";

export async function stagePersistedComposerImageAttachments(input: {
  threadId: ThreadId;
  images: ReadonlyArray<ComposerImageAttachment>;
  getPersistedAttachments: () => PersistedComposerImageAttachment[];
}): Promise<PersistedComposerImageAttachment[]> {
  try {
    const existingPersistedById = new Map(
      input.getPersistedAttachments().map((attachment) => [attachment.id, attachment]),
    );
    const staged = await Promise.all(
      input.images.map(async (image): Promise<PersistedComposerImageAttachment | null> => {
        const existingPersisted = existingPersistedById.get(image.id);
        const metadata = {
          id: image.id,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          ...(image.source ? { source: image.source } : {}),
        };
        const expectedBlobKey = composerImageBlobKey(input.threadId, image.id);
        if (existingPersisted?.blobKey === expectedBlobKey) {
          return { ...metadata, blobKey: expectedBlobKey };
        }
        try {
          const blobKey = await persistComposerImageBlob({
            threadId: input.threadId,
            imageId: image.id,
            file: image.file,
          });
          return { ...metadata, blobKey };
        } catch {
          try {
            return { ...metadata, dataUrl: await readFileAsDataUrl(image.file) };
          } catch {
            return existingPersisted ?? null;
          }
        }
      }),
    );
    return staged.filter(
      (attachment): attachment is PersistedComposerImageAttachment => attachment !== null,
    );
  } catch {
    const currentImageIds = new Set(input.images.map((image) => image.id));
    return input
      .getPersistedAttachments()
      .filter((attachment) => currentImageIds.has(attachment.id));
  }
}
interface ComposerAttachmentPersistenceInput {
  threadId: ThreadId;
  composerImages: readonly ComposerImageAttachment[];
  composerPromptHistorySavedDraftImages: readonly ComposerImageAttachment[] | null;
}

export function useComposerAttachmentPersistence({
  threadId,
  composerImages,
  composerPromptHistorySavedDraftImages,
}: ComposerAttachmentPersistenceInput) {
  const clearComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  );
  const syncComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  );
  const syncComposerDraftPromptHistorySavedDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPromptHistorySavedDraftPersistedAttachments,
  );
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (composerImages.length === 0) {
        const hasDeferredBlobAttachment =
          useComposerDraftStore
            .getState()
            .draftsByThreadId[threadId]?.persistedAttachments.some(
              (attachment) => attachment.blobKey,
            ) ?? false;
        if (hasDeferredBlobAttachment) {
          return;
        }
        clearComposerDraftPersistedAttachments(threadId);
        return;
      }
      const staged = await stagePersistedComposerImageAttachments({
        threadId,
        images: composerImages,
        getPersistedAttachments: () =>
          useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedAttachments ?? [],
      });
      if (cancelled) {
        return;
      }
      // Stage attachments in persisted draft state first so persist middleware can write them.
      void syncComposerDraftPersistedAttachments(threadId, staged);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    clearComposerDraftPersistedAttachments,
    composerImages,
    syncComposerDraftPersistedAttachments,
    threadId,
  ]);

  useEffect(() => {
    if (
      !composerPromptHistorySavedDraftImages ||
      composerPromptHistorySavedDraftImages.length === 0
    ) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const staged = await stagePersistedComposerImageAttachments({
        threadId,
        images: composerPromptHistorySavedDraftImages,
        getPersistedAttachments: () =>
          useComposerDraftStore.getState().draftsByThreadId[threadId]?.promptHistorySavedDraft
            ?.persistedAttachments ?? [],
      });
      if (cancelled) {
        return;
      }
      void syncComposerDraftPromptHistorySavedDraftPersistedAttachments(threadId, staged);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    composerPromptHistorySavedDraftImages,
    syncComposerDraftPromptHistorySavedDraftPersistedAttachments,
    threadId,
  ]);
}
