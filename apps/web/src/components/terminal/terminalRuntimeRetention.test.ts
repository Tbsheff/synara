import { describe, expect, it } from "vitest";

import {
  isEvictableTerminalRuntime,
  planTerminalRuntimeEviction,
  type DetachedTerminalRuntime,
  type TerminalRuntimeRetentionLimits,
} from "./terminalRuntimeRetention";

const limits: TerminalRuntimeRetentionLimits = {
  maxIdleMs: 1_000,
  maxDetachedRuntimes: 3,
  maxDetachedScrollbackLines: 10_000,
};

function detached(
  runtimeKey: string,
  detachedAt: number,
  overrides: Partial<DetachedTerminalRuntime> = {},
): DetachedTerminalRuntime {
  return { runtimeKey, detachedAt, scrollbackLines: 100, evictable: true, ...overrides };
}

describe("planTerminalRuntimeEviction", () => {
  it("keeps everything inside the budget and schedules the earliest idle expiry", () => {
    const plan = planTerminalRuntimeEviction([detached("b", 200), detached("a", 100)], 500, limits);
    expect(plan).toEqual({ evict: [], nextSweepAt: 1_100 });
  });

  it("evicts runtimes detached for longer than the idle age", () => {
    const plan = planTerminalRuntimeEviction(
      [detached("old", 0), detached("fresh", 900)],
      1_000,
      limits,
    );
    expect(plan).toEqual({ evict: ["old"], nextSweepAt: 1_900 });
  });

  it("evicts least recently detached runtimes beyond the count budget", () => {
    const runtimes = [5, 1, 4, 2, 3].map((at) => detached(`t${at}`, at));
    expect(planTerminalRuntimeEviction(runtimes, 10, limits).evict).toEqual(["t1", "t2"]);
  });

  it("evicts least recently detached runtimes beyond the scrollback budget", () => {
    const runtimes = [
      detached("a", 1, { scrollbackLines: 5_000 }),
      detached("b", 2, { scrollbackLines: 5_000 }),
      detached("c", 3, { scrollbackLines: 4_000 }),
    ];
    expect(planTerminalRuntimeEviction(runtimes, 10, limits).evict).toEqual(["a"]);
  });

  it("counts ineligible runtimes toward the budget without choosing them", () => {
    const runtimes = [
      detached("busy-1", 1, { evictable: false }),
      detached("busy-2", 2, { evictable: false }),
      detached("busy-3", 3, { evictable: false }),
      detached("idle", 4),
      detached("newest", 5),
    ];
    expect(planTerminalRuntimeEviction(runtimes, 10, limits)).toEqual({
      evict: ["idle"],
      nextSweepAt: 1_005,
    });
  });

  it("never lets the budget evict the most recently detached runtime", () => {
    const runtimes = [
      detached("busy", 1, { evictable: false, scrollbackLines: 50_000 }),
      detached("newest", 2, { scrollbackLines: 50_000 }),
    ];
    expect(planTerminalRuntimeEviction(runtimes, 10, limits).evict).toEqual([]);
  });

  it("rechecks runtimes whose output or replay has not settled", () => {
    const plan = planTerminalRuntimeEviction(
      [detached("busy", 0, { evictable: false })],
      5_000,
      limits,
    );
    expect(plan).toEqual({ evict: [], nextSweepAt: 6_000 });
  });
});

describe("isEvictableTerminalRuntime", () => {
  it("only allows settled chat terminals whose output is fully written", () => {
    const settled = { runtimeStatus: "ready" as const, pendingWriteBytes: 0 };
    expect(isEvictableTerminalRuntime(settled)).toBe(true);
    expect(isEvictableTerminalRuntime({ ...settled, runtimeStatus: "exited" })).toBe(true);
    expect(isEvictableTerminalRuntime({ ...settled, runtimeStatus: "error" })).toBe(true);
    expect(isEvictableTerminalRuntime({ ...settled, providerAuthInstanceId: "codex_work" })).toBe(
      false,
    );
    expect(isEvictableTerminalRuntime({ ...settled, pendingWriteBytes: 12 })).toBe(false);
    for (const runtimeStatus of ["connecting", "replaying"] as const) {
      expect(isEvictableTerminalRuntime({ ...settled, runtimeStatus })).toBe(false);
    }
  });
});
