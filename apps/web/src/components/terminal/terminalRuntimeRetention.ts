import type { TerminalRuntimeStatus } from "./terminalRuntimeTypes";

export interface TerminalRuntimeRetentionLimits {
  maxIdleMs: number;
  maxDetachedRuntimes: number;
  maxDetachedScrollbackLines: number;
}

export const TERMINAL_RUNTIME_RETENTION_LIMITS: TerminalRuntimeRetentionLimits = {
  maxIdleMs: 10 * 60_000,
  maxDetachedRuntimes: 6,
  maxDetachedScrollbackLines: 20_000,
};

export interface DetachedTerminalRuntime {
  runtimeKey: string;
  detachedAt: number;
  scrollbackLines: number;
  evictable: boolean;
}

export interface TerminalRuntimeEvictionPlan {
  evict: string[];
  nextSweepAt: number | null;
}

export function isEvictableTerminalRuntime(runtime: {
  runtimeStatus: TerminalRuntimeStatus;
  pendingWriteBytes: number;
  providerAuthInstanceId?: string;
}): boolean {
  return (
    (runtime.runtimeStatus === "ready" ||
      runtime.runtimeStatus === "exited" ||
      runtime.runtimeStatus === "error") &&
    runtime.pendingWriteBytes === 0 &&
    !runtime.providerAuthInstanceId
  );
}

export function planTerminalRuntimeEviction(
  detached: readonly DetachedTerminalRuntime[],
  now: number,
  limits: TerminalRuntimeRetentionLimits,
): TerminalRuntimeEvictionPlan {
  const oldestFirst = detached.toSorted((left, right) => left.detachedAt - right.detachedAt);
  const newest = oldestFirst.at(-1);
  const evicted = new Set<DetachedTerminalRuntime>();

  for (const runtime of oldestFirst) {
    if (runtime.evictable && now - runtime.detachedAt >= limits.maxIdleMs) {
      evicted.add(runtime);
    }
  }

  let retainedCount = detached.length - evicted.size;
  let retainedLines = 0;
  for (const runtime of oldestFirst) {
    if (!evicted.has(runtime)) retainedLines += runtime.scrollbackLines;
  }

  for (const runtime of oldestFirst) {
    const overBudget =
      retainedCount > limits.maxDetachedRuntimes ||
      retainedLines > limits.maxDetachedScrollbackLines;
    if (!overBudget) break;
    if (!runtime.evictable || runtime === newest || evicted.has(runtime)) continue;
    evicted.add(runtime);
    retainedCount -= 1;
    retainedLines -= runtime.scrollbackLines;
  }

  let nextSweepAt: number | null = null;
  for (const runtime of oldestFirst) {
    if (evicted.has(runtime)) continue;
    const expiresAt = runtime.evictable
      ? runtime.detachedAt + limits.maxIdleMs
      : now + Math.min(1_000, limits.maxIdleMs);
    nextSweepAt = nextSweepAt === null ? expiresAt : Math.min(nextSweepAt, expiresAt);
  }

  return {
    evict: oldestFirst
      .filter((runtime) => evicted.has(runtime))
      .map((runtime) => runtime.runtimeKey),
    nextSweepAt,
  };
}
