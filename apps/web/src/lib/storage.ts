import { Debouncer } from "@tanstack/react-pacer";
import type { PersistStorage, StorageValue } from "zustand/middleware";

export interface StateStorage<R = unknown> {
  getItem: (name: string) => string | null | Promise<string | null>;
  setItem: (name: string, value: string) => R;
  removeItem: (name: string) => R;
}

export interface DebouncedStorage<R = unknown> extends StateStorage<R> {
  flush: () => void;
}

export interface DeferredPersistStorage<S> extends PersistStorage<S> {
  flush: () => void;
}

export function createMemoryStorage(): StateStorage {
  const store = new Map<string, string>();
  return {
    getItem: (name) => store.get(name) ?? null,
    setItem: (name, value) => {
      store.set(name, value);
    },
    removeItem: (name) => {
      store.delete(name);
    },
  };
}

function isStateStorage(value: unknown): value is StateStorage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<StateStorage>;
  return (
    typeof candidate.getItem === "function" &&
    typeof candidate.setItem === "function" &&
    typeof candidate.removeItem === "function"
  );
}

export function createBrowserStateStorage(): StateStorage {
  return isStateStorage(globalThis.localStorage) ? globalThis.localStorage : createMemoryStorage();
}

export function createDebouncedStorage(
  baseStorage: StateStorage,
  debounceMs: number = 300,
): DebouncedStorage {
  const debouncedSetItem = new Debouncer(
    (name: string, value: string) => {
      baseStorage.setItem(name, value);
    },
    { wait: debounceMs },
  );

  return {
    getItem: (name) => baseStorage.getItem(name),
    setItem: (name, value) => {
      debouncedSetItem.maybeExecute(name, value);
    },
    removeItem: (name) => {
      debouncedSetItem.cancel();
      baseStorage.removeItem(name);
    },
    flush: () => {
      debouncedSetItem.flush();
    },
  };
}

interface PageHideEventTarget {
  readonly addEventListener: (type: string, listener: () => void) => void;
}

interface PageVisibilityTarget extends PageHideEventTarget {
  readonly visibilityState: string;
}

export interface FlushBeforePageHideEnv {
  readonly window?: PageHideEventTarget | undefined;
  readonly document?: PageVisibilityTarget | undefined;
}

export function flushStorageBeforePageHide(
  flush: () => void,
  env: FlushBeforePageHideEnv = {
    window: typeof window !== "undefined" ? window : undefined,
    document: typeof document !== "undefined" ? document : undefined,
  },
): void {
  env.window?.addEventListener("beforeunload", flush);
  env.window?.addEventListener("pagehide", flush);
  const doc = env.document;
  doc?.addEventListener("visibilitychange", () => {
    if (doc.visibilityState === "hidden") flush();
  });
}

export function createDeferredPersistStorage<State, Persisted = State>(options: {
  readonly getStorage: () => StateStorage;
  readonly partialize: (state: State) => Persisted;
  readonly debounceMs?: number;
}): DeferredPersistStorage<Persisted> {
  const { getStorage, partialize, debounceMs = 300 } = options;
  let pending: { readonly name: string; readonly value: StorageValue<Persisted> } | null = null;

  const writePending = (): void => {
    if (pending === null) return;
    const { name, value } = pending;
    pending = null;
    getStorage().setItem(
      name,
      JSON.stringify({
        state: partialize(value.state as unknown as State),
        version: value.version,
      }),
    );
  };

  const debouncedWrite = new Debouncer(() => writePending(), { wait: debounceMs });
  const parse = (value: string | null): StorageValue<Persisted> | null =>
    value === null ? null : (JSON.parse(value) as StorageValue<Persisted>);

  return {
    getItem: (name) => {
      const raw = getStorage().getItem(name);
      return raw instanceof Promise ? raw.then(parse) : parse(raw);
    },
    setItem: (name, value) => {
      pending = { name, value };
      debouncedWrite.maybeExecute();
    },
    removeItem: (name) => {
      pending = null;
      debouncedWrite.cancel();
      getStorage().removeItem(name);
    },
    flush: () => {
      debouncedWrite.cancel();
      writePending();
    },
  };
}
