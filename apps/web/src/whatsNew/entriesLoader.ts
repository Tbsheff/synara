import { useEffect, useState } from "react";

import type { WhatsNewEntry } from "./logic";

let loadedEntries: readonly WhatsNewEntry[] | null = null;
let entriesLoad: Promise<readonly WhatsNewEntry[]> | null = null;

export function loadWhatsNewEntries(): Promise<readonly WhatsNewEntry[]> {
  entriesLoad ??= import("./entries").then(
    (module) => {
      loadedEntries = module.WHATS_NEW_ENTRIES;
      return loadedEntries;
    },
    (error: unknown) => {
      entriesLoad = null;
      throw error;
    },
  );
  return entriesLoad;
}

export function useWhatsNewEntries(enabled: boolean): readonly WhatsNewEntry[] | null {
  const [entries, setEntries] = useState(loadedEntries);
  useEffect(() => {
    if (!enabled || entries !== null) {
      return;
    }
    let active = true;
    loadWhatsNewEntries().then(
      (next) => {
        if (active) setEntries(next);
      },
      (error: unknown) => {
        console.warn("Could not load the release notes.", error);
      },
    );
    return () => {
      active = false;
    };
  }, [enabled, entries]);
  return entries;
}
