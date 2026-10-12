import { WorkerPoolManager } from "@pierre/diffs/worker";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import type { DiffThemeName } from "./diffRendering";

export function diffWorkerPoolSize(fileCount: number, cores: number): number {
  if (fileCount <= 0) return 0;
  const cap = Math.max(2, Math.min(6, Math.floor((cores || 4) / 2)));
  return Math.min(cap, Math.ceil(fileCount / 2));
}

const workloads = new Map<symbol, number>();
const listeners = new Set<() => void>();
let snapshot: { pool: WorkerPoolManager | undefined; size: number; generation: number } = {
  pool: undefined,
  size: 0,
  generation: 0,
};

export function subscribeDiffWorkerPool(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDiffWorkerPool() {
  return snapshot;
}

export function setDiffWorkerWorkload(owner: symbol, files: number, theme: DiffThemeName): void {
  if (files > 0) workloads.set(owner, files);
  else workloads.delete(owner);
  const totalFiles = Array.from(workloads.values()).reduce((total, count) => total + count, 0);
  const cores = typeof navigator === "undefined" ? 4 : navigator.hardwareConcurrency;
  const size = diffWorkerPoolSize(totalFiles, cores);
  if (size === snapshot.size) return;

  snapshot.pool?.terminate();
  snapshot = {
    pool:
      size > 0
        ? new WorkerPoolManager(
            { workerFactory: () => new DiffsWorker(), poolSize: size, totalASTLRUCacheSize: 240 },
            { theme, tokenizeMaxLineLength: 1_000 },
          )
        : undefined,
    size,
    generation: snapshot.generation + 1,
  };
  for (const listener of listeners) listener();
}
