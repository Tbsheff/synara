import type { ThreadId } from "@synara/contracts";
import { composerDraftThreadStorageKey, type ComposerDraftStoreState } from "./composerDraftDomain";
import {
  partializeComposerDraftStoreState,
  type PersistedComposerDraftStoreState,
} from "./composerDraftPersistence";
import { createDeferredPersistStorage, type StateStorage } from "./lib/storage";

type RecordIndex = PersistedComposerDraftStoreState & { draftRecordIds?: string[] };

export function createComposerDraftPersistStorage(storage: StateStorage) {
  let storageName = "";
  let savedDrafts: ComposerDraftStoreState["draftsByThreadId"] = {};
  let pendingDrafts = savedDrafts;
  const read = (name: string, raw: string | null): string | null | Promise<string | null> => {
    if (!raw) return raw;
    const value = JSON.parse(raw) as { state: RecordIndex; version?: number };
    if (!Array.isArray(value.state.draftRecordIds)) return raw;
    const ids = value.state.draftRecordIds.filter((id) => typeof id === "string");
    const records = ids.map((id) => storage.getItem(composerDraftThreadStorageKey(name, id)));
    const merge = (values: (string | null)[]) => {
      const drafts: Record<
        ThreadId,
        PersistedComposerDraftStoreState["draftsByThreadId"][ThreadId]
      > = {};
      values.forEach((record, index) => {
        if (record) drafts[ids[index] as ThreadId] = JSON.parse(record);
      });
      return JSON.stringify({ ...value, state: { ...value.state, draftsByThreadId: drafts } });
    };
    return records.every(
      (record): record is string | null => record === null || typeof record === "string",
    )
      ? merge(records)
      : Promise.all(records).then(merge);
  };
  const indexedStorage: StateStorage = {
    getItem: (name) => {
      const raw = storage.getItem(name);
      return raw === null || typeof raw === "string"
        ? read(name, raw)
        : raw.then((value) => read(name, value));
    },
    setItem: (name, raw) => {
      storage.setItem(name, raw);
      for (const threadId of Object.keys(savedDrafts)) {
        if (!(threadId in pendingDrafts))
          storage.removeItem(composerDraftThreadStorageKey(name, threadId));
      }
      savedDrafts = pendingDrafts;
    },
    removeItem: async (name) => {
      const raw = await storage.getItem(name);
      if (raw) {
        const value = JSON.parse(raw) as { state: RecordIndex };
        for (const threadId of value.state.draftRecordIds ?? []) {
          storage.removeItem(composerDraftThreadStorageKey(name, threadId));
        }
      }
      storage.removeItem(name);
      savedDrafts = {};
    },
  };
  const deferred = createDeferredPersistStorage<
    ComposerDraftStoreState,
    PersistedComposerDraftStoreState
  >({
    getStorage: () => indexedStorage,
    partialize: (state) => {
      const changedDrafts = Object.fromEntries(
        Object.entries(state.draftsByThreadId).filter(
          ([id, draft]) => savedDrafts[id as ThreadId] !== draft,
        ),
      );
      const persisted = partializeComposerDraftStoreState({
        ...state,
        draftsByThreadId: changedDrafts,
      });
      for (const [id, draft] of Object.entries(changedDrafts)) {
        const record = persisted.draftsByThreadId[id as ThreadId];
        storage.setItem(
          composerDraftThreadStorageKey(storageName, id),
          JSON.stringify(record ?? { prompt: draft.prompt, attachments: [] }),
        );
      }
      pendingDrafts = state.draftsByThreadId;
      return {
        ...persisted,
        draftsByThreadId: {},
        draftRecordIds: Object.keys(state.draftsByThreadId),
      } as RecordIndex;
    },
  });
  return {
    ...deferred,
    setItem: (name: string, value: Parameters<typeof deferred.setItem>[1]) => {
      storageName = name;
      deferred.setItem(name, value);
    },
  };
}
