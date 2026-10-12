import { Deferred, Duration, Effect, Exit, Scope } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  evaluateAcpTurnIdleTick,
  forkAcpTurnIdleWatchdog,
  isAcpTurnProgressEventTag,
  isAcpWatchdogTickAfterSuspend,
  resolveAcpTurnIdleTimeoutMs,
} from "./AcpTurnIdleWatchdog.ts";

describe("isAcpTurnProgressEventTag", () => {
  it("classifies genuine turn-progress events as progress", () => {
    expect(isAcpTurnProgressEventTag("ContentDelta")).toBe(true);
    expect(isAcpTurnProgressEventTag("ToolCallUpdated")).toBe(true);
    expect(isAcpTurnProgressEventTag("PlanUpdated")).toBe(true);
    expect(isAcpTurnProgressEventTag("AssistantItemStarted")).toBe(true);
    expect(isAcpTurnProgressEventTag("AssistantItemCompleted")).toBe(true);
  });
  it("does not treat heartbeats or unknown tags as progress", () => {
    expect(isAcpTurnProgressEventTag("ModeChanged")).toBe(false);
    expect(isAcpTurnProgressEventTag("UsageUpdated")).toBe(false);
    expect(isAcpTurnProgressEventTag("unknown")).toBe(false);
  });
});

describe("evaluateAcpTurnIdleTick", () => {
  it("stops once the turn is no longer active, regardless of idle state", () => {
    expect(
      evaluateAcpTurnIdleTick({
        isTurnActive: false,
        isAwaitingHuman: false,
        idleMs: 10_000_000,
        idleTimeoutMs: 1,
      }),
    ).toBe("stop");
  });

  it("refreshes the clock while the turn is legitimately blocked on a human", () => {
    expect(
      evaluateAcpTurnIdleTick({
        isTurnActive: true,
        isAwaitingHuman: true,
        idleMs: 10_000_000,
        idleTimeoutMs: 1,
      }),
    ).toBe("touch");
  });

  it("keeps watching while the turn is still within the idle budget", () => {
    expect(
      evaluateAcpTurnIdleTick({
        isTurnActive: true,
        isAwaitingHuman: false,
        idleMs: 5_000,
        idleTimeoutMs: 600_000,
      }),
    ).toBe("continue");
  });

  it("times out at or past the threshold", () => {
    expect(
      evaluateAcpTurnIdleTick({
        isTurnActive: true,
        isAwaitingHuman: false,
        idleMs: 600_000,
        idleTimeoutMs: 600_000,
      }),
    ).toBe("timeout");
    expect(
      evaluateAcpTurnIdleTick({
        isTurnActive: true,
        isAwaitingHuman: false,
        idleMs: 600_001,
        idleTimeoutMs: 600_000,
      }),
    ).toBe("timeout");
  });
});

describe("resolveAcpTurnIdleTimeoutMs", () => {
  const envVar = "SYNARA_TEST_TURN_IDLE_TIMEOUT_MS";
  const defaultMs = 600_000;

  it("falls back to the default when unset, blank, or non-numeric", () => {
    expect(resolveAcpTurnIdleTimeoutMs({ envVar, defaultMs, env: {} })).toBe(defaultMs);
    expect(resolveAcpTurnIdleTimeoutMs({ envVar, defaultMs, env: { [envVar]: "   " } })).toBe(
      defaultMs,
    );
    expect(resolveAcpTurnIdleTimeoutMs({ envVar, defaultMs, env: { [envVar]: "soon" } })).toBe(
      defaultMs,
    );
  });

  it("rejects non-positive overrides so a typo cannot disable the backstop", () => {
    expect(resolveAcpTurnIdleTimeoutMs({ envVar, defaultMs, env: { [envVar]: "0" } })).toBe(
      defaultMs,
    );
    expect(resolveAcpTurnIdleTimeoutMs({ envVar, defaultMs, env: { [envVar]: "-5000" } })).toBe(
      defaultMs,
    );
  });

  it("accepts a positive numeric override (trimmed)", () => {
    expect(resolveAcpTurnIdleTimeoutMs({ envVar, defaultMs, env: { [envVar]: "30000" } })).toBe(
      30_000,
    );
    expect(resolveAcpTurnIdleTimeoutMs({ envVar, defaultMs, env: { [envVar]: "  45000  " } })).toBe(
      45_000,
    );
  });
});

describe("forkAcpTurnIdleWatchdog", () => {
  it("force-fails a turn that has been idle past the threshold", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fired = yield* Deferred.make<number>();
      let active = true;

      yield* forkAcpTurnIdleWatchdog({
        idleTimeoutMs: 1,
        checkIntervalMs: 1,
        scope,
        isTurnActive: () => active,
        isAwaitingHuman: () => false,
        // Epoch baseline → the turn reads as effectively infinitely idle.
        lastActivityAt: () => 0,
        touchActivity: () => {},
        onIdleTimeout: (idleMs) =>
          Effect.gen(function* () {
            active = false;
            yield* Deferred.succeed(fired, idleMs);
          }),
      });

      const idleMs = yield* Deferred.await(fired);
      yield* Scope.close(scope, Exit.void);
      return idleMs;
    });

    const idleMs = await Effect.runPromise(program);
    expect(idleMs).toBeGreaterThan(0);
  });

  it("does not fire while the turn keeps reporting fresh activity", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      let fired = false;

      yield* forkAcpTurnIdleWatchdog({
        idleTimeoutMs: 60_000,
        checkIntervalMs: 1,
        scope,
        isTurnActive: () => true,
        isAwaitingHuman: () => false,
        // Always "just now" → never crosses the 60s threshold.
        lastActivityAt: () => Date.now(),
        touchActivity: () => {},
        onIdleTimeout: () =>
          Effect.sync(() => {
            fired = true;
          }),
      });

      yield* Effect.sleep(25);
      yield* Scope.close(scope, Exit.void);
      return fired;
    });

    const fired = await Effect.runPromise(program);
    expect(fired).toBe(false);
  });

  it("uses the live timeout override for provider work hidden from the parent stream", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      let fired = false;
      let nestedWorkActive = true;

      yield* forkAcpTurnIdleWatchdog({
        idleTimeoutMs: 1,
        currentIdleTimeoutMs: () => (nestedWorkActive ? 60_000 : 1),
        checkIntervalMs: 1,
        scope,
        isTurnActive: () => true,
        isAwaitingHuman: () => false,
        lastActivityAt: () => Date.now() - 100,
        touchActivity: () => {},
        onIdleTimeout: () =>
          Effect.sync(() => {
            fired = true;
          }),
      });

      yield* Effect.sleep(10);
      const stayedAliveDuringNestedWork = !fired;
      nestedWorkActive = false;
      yield* Effect.sleep(10);
      yield* Scope.close(scope, Exit.void);
      return { fired, stayedAliveDuringNestedWork };
    });

    await expect(Effect.runPromise(program)).resolves.toEqual({
      fired: true,
      stayedAliveDuringNestedWork: true,
    });
  });
});

describe("isAcpWatchdogTickAfterSuspend", () => {
  it("treats a tick gap far beyond the check interval as a suspend and resume", () => {
    expect(
      isAcpWatchdogTickAfterSuspend({ tickGapMs: 2 * 60 * 60_000, checkIntervalMs: 15_000 }),
    ).toBe(true);
  });

  it("treats on-time and modestly late ticks as regular ticks", () => {
    expect(isAcpWatchdogTickAfterSuspend({ tickGapMs: 15_000, checkIntervalMs: 15_000 })).toBe(
      false,
    );
    expect(isAcpWatchdogTickAfterSuspend({ tickGapMs: 40_000, checkIntervalMs: 15_000 })).toBe(
      false,
    );
  });

  it("does not read timer jitter on very short intervals as a suspend", () => {
    expect(isAcpWatchdogTickAfterSuspend({ tickGapMs: 50, checkIntervalMs: 1 })).toBe(false);
  });
});

describe("evaluateAcpTurnIdleTick after a suspend", () => {
  it("refreshes the clock instead of timing out on the first tick after resume", () => {
    expect(
      evaluateAcpTurnIdleTick({
        isTurnActive: true,
        isAwaitingHuman: false,
        idleMs: 2 * 60 * 60_000,
        idleTimeoutMs: 600_000,
        resumedFromSuspend: true,
      }),
    ).toBe("touch");
  });

  it("still stops a turn that ended during the suspend", () => {
    expect(
      evaluateAcpTurnIdleTick({
        isTurnActive: false,
        isAwaitingHuman: false,
        idleMs: 2 * 60 * 60_000,
        idleTimeoutMs: 600_000,
        resumedFromSuspend: true,
      }),
    ).toBe("stop");
  });
});

describe("forkAcpTurnIdleWatchdog across wall-clock jumps", () => {
  const checkIntervalMs = 15_000;
  const idleTimeoutMs = 600_000;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const runWatchdog = (
    drive: (input: {
      readonly tick: (wallClockAdvanceMs: number) => Effect.Effect<void>;
      readonly fired: () => number | null;
    }) => Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      let wallNow = Date.UTC(2026, 9, 11, 9, 0, 0);
      vi.spyOn(Date, "now").mockImplementation(() => wallNow);
      let lastActivityAt = wallNow;
      let firedIdleMs: number | null = null;
      const scope = yield* Scope.make();
      yield* forkAcpTurnIdleWatchdog({
        idleTimeoutMs,
        checkIntervalMs,
        scope,
        isTurnActive: () => firedIdleMs === null,
        isAwaitingHuman: () => false,
        lastActivityAt: () => lastActivityAt,
        touchActivity: () => {
          lastActivityAt = wallNow;
        },
        onIdleTimeout: (idleMs) =>
          Effect.sync(() => {
            firedIdleMs = idleMs;
          }),
      });
      yield* Effect.yieldNow;
      yield* drive({
        tick: (wallClockAdvanceMs) =>
          Effect.gen(function* () {
            wallNow += wallClockAdvanceMs;
            yield* TestClock.adjust(Duration.millis(checkIntervalMs));
            yield* Effect.yieldNow;
          }),
        fired: () => firedIdleMs,
      });
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(TestClock.layer()), Effect.scoped);

  it("does not fail a healthy turn on the first tick after laptop sleep", async () => {
    let firedAfterResume: number | null = null;
    let firedAfterGrace: number | null = null;
    await Effect.runPromise(
      runWatchdog(({ tick, fired }) =>
        Effect.gen(function* () {
          yield* tick(checkIntervalMs);
          yield* tick(2 * 60 * 60_000);
          firedAfterResume = fired();
          for (let index = 0; index < 5; index += 1) yield* tick(checkIntervalMs);
          firedAfterGrace = fired();
        }),
      ),
    );
    expect(firedAfterResume).toBeNull();
    expect(firedAfterGrace).toBeNull();
  });

  it("still fails a turn that stalls after a resume once the idle limit passes again", async () => {
    let firedIdleMs: number | null = null;
    await Effect.runPromise(
      runWatchdog(({ tick, fired }) =>
        Effect.gen(function* () {
          yield* tick(2 * 60 * 60_000);
          for (let index = 0; index < idleTimeoutMs / checkIntervalMs; index += 1) {
            yield* tick(checkIntervalMs);
          }
          firedIdleMs = fired();
        }),
      ),
    );
    expect(firedIdleMs).toBe(idleTimeoutMs);
  });

  it("fails a real stall that ticks regularly with no activity", async () => {
    let firedBeforeLimit: number | null = null;
    let firedIdleMs: number | null = null;
    await Effect.runPromise(
      runWatchdog(({ tick, fired }) =>
        Effect.gen(function* () {
          const ticksToLimit = idleTimeoutMs / checkIntervalMs;
          for (let index = 0; index < ticksToLimit - 1; index += 1) yield* tick(checkIntervalMs);
          firedBeforeLimit = fired();
          yield* tick(checkIntervalMs);
          firedIdleMs = fired();
        }),
      ),
    );
    expect(firedBeforeLimit).toBeNull();
    expect(firedIdleMs).toBe(idleTimeoutMs);
  });
});
