// FILE: terminalRuntimeRegistry.ts
// Purpose: Keep a stable runtime map and delegate terminal lifecycle work to terminalRuntime.ts.
// Layer: Terminal runtime infrastructure
// Depends on: terminalRuntime.ts for lifecycle, terminalRuntimeTypes.ts for stable ids and contracts.

import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import { registerTerminalRuntimeCleanup } from "../../lib/terminalStateCleanup";
import { readNativeApi } from "~/nativeApi";

import { terminalEventDispatcher } from "./terminalEventDispatcher";

import {
  attachRuntimeToContainer,
  createRuntimeEntry,
  detachRuntimeFromContainer,
  disposeRuntimeEntry,
  syncRuntimeConfig,
  updateRuntimeViewState,
} from "./terminalRuntime";
import type {
  TerminalRuntimeConfig,
  TerminalRuntimeEntry,
  TerminalRuntimeStatus,
  TerminalRuntimeViewState,
} from "./terminalRuntimeTypes";
import { buildTerminalRuntimeKey } from "./terminalRuntimeTypes";
import {
  isEvictableTerminalRuntime,
  planTerminalRuntimeEviction,
  TERMINAL_RUNTIME_RETENTION_LIMITS,
  type DetachedTerminalRuntime,
  type TerminalRuntimeRetentionLimits,
} from "./terminalRuntimeRetention";

export { buildTerminalRuntimeKey, type TerminalRuntimeCallbacks } from "./terminalRuntimeTypes";

// --- Registry orchestration -------------------------------------------------

const OUTPUT_BYTE_ENCODER = new TextEncoder();

interface EvictedTerminalSession {
  threadId: string;
  unsubscribe: () => void;
}

function acknowledgeEvictedOutput(threadId: string, terminalId: string, bytes: number): void {
  const ackOutput = readNativeApi()?.terminal.ackOutput;
  if (bytes <= 0 || typeof ackOutput !== "function") return;
  void ackOutput({ threadId, terminalId, bytes }).catch(() => undefined);
}

function scrollbackLineCount(entry: TerminalRuntimeEntry): number {
  return entry.terminal.buffer?.normal.length ?? 0;
}

class TerminalRuntimeRegistry {
  private entries = new Map<string, TerminalRuntimeEntry>();
  private detachedAtByKey = new Map<string, number>();
  private evictedSessions = new Map<string, EvictedTerminalSession>();
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepAt = Number.POSITIVE_INFINITY;

  constructor(private readonly retentionLimits: TerminalRuntimeRetentionLimits) {}

  attach(
    config: TerminalRuntimeConfig,
    viewState: TerminalRuntimeViewState,
    container: HTMLDivElement,
  ): { terminal: Terminal; searchAddon: SearchAddon; runtimeStatus: TerminalRuntimeStatus } {
    this.detachedAtByKey.delete(config.runtimeKey);
    this.releaseEvictedSession(config.runtimeKey);
    let entry = this.entries.get(config.runtimeKey);
    if (!entry) {
      entry = createRuntimeEntry(config);
      this.entries.set(config.runtimeKey, entry);
    } else {
      syncRuntimeConfig(entry, config);
    }

    attachRuntimeToContainer(entry, viewState, container);
    return {
      terminal: entry.terminal,
      searchAddon: entry.searchAddon,
      runtimeStatus: entry.runtimeStatus,
    };
  }

  syncConfig(runtimeKey: string, config: TerminalRuntimeConfig): void {
    const entry = this.entries.get(runtimeKey);
    if (!entry) return;
    syncRuntimeConfig(entry, config);
  }

  setViewState(runtimeKey: string, viewState: TerminalRuntimeViewState): void {
    const entry = this.entries.get(runtimeKey);
    if (!entry) return;
    updateRuntimeViewState(entry, viewState);
  }

  detach(runtimeKey: string): void {
    const entry = this.entries.get(runtimeKey);
    if (!entry) return;
    detachRuntimeFromContainer(entry);
    this.detachedAtByKey.set(runtimeKey, Date.now());
    this.scheduleSweep(Date.now());
  }

  dispose(runtimeKey: string): void {
    this.releaseEvictedSession(runtimeKey);
    this.detachedAtByKey.delete(runtimeKey);
    const entry = this.entries.get(runtimeKey);
    if (!entry) return;
    disposeRuntimeEntry(entry);
    this.entries.delete(runtimeKey);
  }

  disposeTerminal(threadId: string, terminalId: string): void {
    this.dispose(buildTerminalRuntimeKey(threadId, terminalId));
  }

  disposeThread(threadId: string): void {
    for (const [runtimeKey, entry] of this.entries) {
      if (entry.threadId === threadId) {
        this.dispose(runtimeKey);
      }
    }
    for (const [runtimeKey, session] of this.evictedSessions) {
      if (session.threadId === threadId) this.releaseEvictedSession(runtimeKey);
    }
  }

  disposeOrphanedThreads(activeThreadIds: ReadonlySet<string>): void {
    for (const [runtimeKey, entry] of this.entries) {
      if (!entry.providerAuthInstanceId && !activeThreadIds.has(entry.threadId)) {
        this.dispose(runtimeKey);
      }
    }
    for (const [runtimeKey, session] of this.evictedSessions) {
      if (!activeThreadIds.has(session.threadId)) this.releaseEvictedSession(runtimeKey);
    }
  }

  focus(runtimeKey: string): void {
    this.entries.get(runtimeKey)?.terminal.focus();
  }

  private scheduleSweep(at: number): void {
    if (this.sweepTimer !== null && this.sweepAt <= at) return;
    if (this.sweepTimer !== null) clearTimeout(this.sweepTimer);
    this.sweepAt = at;
    this.sweepTimer = setTimeout(
      () => {
        this.sweepTimer = null;
        this.sweepAt = Number.POSITIVE_INFINITY;
        this.evictDetachedRuntimes();
      },
      Math.max(0, at - Date.now()),
    );
  }

  private evictDetachedRuntimes(): void {
    const detached: DetachedTerminalRuntime[] = [];
    for (const [runtimeKey, detachedAt] of this.detachedAtByKey) {
      const entry = this.entries.get(runtimeKey);
      if (!entry) continue;
      detached.push({
        runtimeKey,
        detachedAt,
        scrollbackLines: scrollbackLineCount(entry),
        evictable: isEvictableTerminalRuntime(entry),
      });
    }
    const plan = planTerminalRuntimeEviction(detached, Date.now(), this.retentionLimits);
    for (const runtimeKey of plan.evict) {
      const entry = this.entries.get(runtimeKey);
      if (!entry) continue;
      this.retainEvictedSession(entry);
      this.detachedAtByKey.delete(runtimeKey);
      disposeRuntimeEntry(entry);
      this.entries.delete(runtimeKey);
    }
    if (plan.nextSweepAt !== null) this.scheduleSweep(plan.nextSweepAt);
  }

  private retainEvictedSession(entry: TerminalRuntimeEntry): void {
    const { runtimeKey, threadId, terminalId, callbacks } = entry;
    const unsubscribe = terminalEventDispatcher.subscribe(threadId, terminalId, (event) => {
      if (event.type === "output") {
        acknowledgeEvictedOutput(
          threadId,
          terminalId,
          event.byteLength ?? OUTPUT_BYTE_ENCODER.encode(event.data).byteLength,
        );
      } else if (event.type === "exited") {
        this.releaseEvictedSession(runtimeKey);
        callbacks.onSessionExited();
      }
    });
    this.evictedSessions.set(runtimeKey, { threadId, unsubscribe });
  }

  private releaseEvictedSession(runtimeKey: string): void {
    const session = this.evictedSessions.get(runtimeKey);
    if (!session) return;
    this.evictedSessions.delete(runtimeKey);
    session.unsubscribe();
  }
}

export const terminalRuntimeRegistry = new TerminalRuntimeRegistry(
  TERMINAL_RUNTIME_RETENTION_LIMITS,
);
registerTerminalRuntimeCleanup((activeThreadIds) =>
  terminalRuntimeRegistry.disposeOrphanedThreads(activeThreadIds),
);
