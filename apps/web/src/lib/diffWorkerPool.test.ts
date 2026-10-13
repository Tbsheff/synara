import { describe, expect, it, vi } from "vitest";
vi.mock("@pierre/diffs/worker/worker.js?worker", () => ({ default: vi.fn() }));
import { diffWorkerPoolSize } from "./diffWorkerPool";

describe("diff worker workload sizing", () => {
  it.each([
    [0, 0],
    [1, 1],
    [2, 1],
    [3, 2],
    [6, 3],
    [10, 5],
    [64, 6],
  ])("uses %i files to select %i workers on a 14-core machine", (files, workers) => {
    expect(diffWorkerPoolSize(files, 14)).toBe(workers);
  });
  it("keeps the existing CPU cap and fallback for large workloads", () => {
    expect(diffWorkerPoolSize(64, 4)).toBe(2);
    expect(diffWorkerPoolSize(64, 0)).toBe(2);
    expect(diffWorkerPoolSize(64, 1)).toBe(2);
  });
});
