// FILE: useSmoothStreamedText.ts
// Purpose: Reveal streamed assistant text at a steady, adaptive cadence so tokens appear
//          fluidly instead of in the ~100ms network clumps that land in the store.
// Layer: Web UI streaming primitive
// Why: The transport coalesces deltas into one store update per ~100ms
//      (apps/web/src/routes/__root.tsx Throttler), so rendering each clump verbatim looks
//      choppy. This hook drains the already-delivered buffer on requestAnimationFrame at a
//      velocity that adapts to the backlog, low-pass-smooths that velocity so there are
//      no jarring speed jumps, and sleeps between bursts once it catches up. It feeds the
//      same text ChatMarkdown already defers, so the markdown re-parse stays coalesced by
//      useDeferredValue: this hook governs *cadence*, not parse cost.

import { useEffect, useRef, useState } from "react";
import { isBlockMarkerOnlyLine } from "../lib/markdownStreamingRepair";
import { useMediaQuery } from "./useMediaQuery";

// Drain the current backlog over this window. Kept above the ~100ms network flush so a
// small backlog cushion always remains and the reveal tracks inflow without running dry.
const DRAIN_WINDOW_SECONDS = 0.5;
// Hard ceiling so a single huge flush (e.g. a pasted code block) reveals fast but bounded
// rather than snapping in all at once.
const MAX_CHARS_PER_SECOND = 2000;
const MIN_BURST_CHARS_PER_SECOND = 600;
const ARRIVAL_RATE_HEADROOM = 1.5;
const ARRIVAL_RATE_TIME_CONSTANT_SECONDS = 0.8;
const MIN_ARRIVAL_INTERVAL_SECONDS = 0.016;
// Low-pass factor: how aggressively the live velocity chases the target velocity each
// frame. Smaller is smoother but laggier; ~0.15 ≈ a ~110ms time constant at 60fps.
const VELOCITY_LERP = 0.15;
// Clamp per-frame delta so returning from a backgrounded tab (rAF paused) does not dump
// the whole backlog in a single frame.
const MAX_FRAME_SECONDS = 0.05;
const VELOCITY_LERP_REFERENCE_HZ = 60;
// Minimum spacing between React commits. The reveal float still advances every frame at
// the smoothed velocity; this only batches how often the grown prefix is pushed to state.
export const MIN_EMIT_INTERVAL_MS = 16;
export const END_OF_STREAM_DRAIN_MS = 250;
export const MAX_REVEAL_CHARS_PER_COMMIT = 140;
export const CATCH_UP_SECONDS = 0.6;
export const MAX_CATCH_UP_CHARS_PER_SECOND = 6000;
export const FRESH_MOUNT_REVEAL_MAX_CHARS = 2000;
export const ARRIVAL_REVEAL_DEADLINE_MS = 550;
const REVEALED_LENGTH_REGISTRY_LIMIT = 200;
export const WORD_STEP_CHARS = 22;
const WHITESPACE_PATTERN = /\s/;
const DAMPED_TAIL_SNAP_THRESHOLD_CHARS = 0.001;
const END_OF_STREAM_DRAIN_FALLBACK_MS = END_OF_STREAM_DRAIN_MS + 100;

/**
 * Mutable per-message reveal state. Owned by the hook via refs; the pure stepper below
 * mutates it in place so the rAF loop allocates nothing per frame.
 */
export interface SmoothRevealState {
  /** Revealed character count, accumulated as a float across frames. */
  shown: number;
  /** Smoothed reveal velocity in chars/second. */
  velocity: number;
  /** Timestamp (ms) of the previous frame; 0 marks the start of a fresh burst. */
  lastFrameAt: number;
  /** Timestamp (ms) of the last emitted commit; 0 forces the next emit immediately. */
  lastEmitAt: number;
  drainDeadlineMs: number;
  arrivalRate: number;
  lastArrivalAt: number;
  arrivedLength: number;
  arrivalDeadlines: Array<{ readonly dueAt: number; readonly length: number }>;
}

export function createSmoothRevealState(shown: number): SmoothRevealState {
  return {
    shown,
    velocity: 0,
    lastFrameAt: 0,
    lastEmitAt: 0,
    drainDeadlineMs: 0,
    arrivalRate: 0,
    lastArrivalAt: 0,
    arrivedLength: shown,
    arrivalDeadlines: [],
  };
}

export function recordSmoothRevealArrival(
  state: SmoothRevealState,
  nowMs: number,
  addedChars: number,
): void {
  if (state.lastArrivalAt > 0) {
    const intervalSeconds = Math.max(
      MIN_ARRIVAL_INTERVAL_SECONDS,
      (nowMs - state.lastArrivalAt) / 1000,
    );
    const weight = 1 - Math.exp(-intervalSeconds / ARRIVAL_RATE_TIME_CONSTANT_SECONDS);
    state.arrivalRate += (addedChars / intervalSeconds - state.arrivalRate) * weight;
  }
  state.lastArrivalAt = nowMs;
  if (addedChars <= 0) return;
  state.arrivedLength += addedChars;
  state.arrivalDeadlines.push({
    dueAt: nowMs + ARRIVAL_REVEAL_DEADLINE_MS,
    length: state.arrivedLength,
  });
}

export function revealVelocityCeiling(state: SmoothRevealState, backlog = 0): number {
  const steadyCeiling = Math.min(
    MAX_CHARS_PER_SECOND,
    Math.max(MIN_BURST_CHARS_PER_SECOND, state.arrivalRate * ARRIVAL_RATE_HEADROOM),
  );
  const catchUpCeiling = Math.min(MAX_CATCH_UP_CHARS_PER_SECOND, backlog / CATCH_UP_SECONDS);
  return Math.max(steadyCeiling, catchUpCeiling);
}

export interface SmoothRevealStep {
  /** Floored character count to commit this frame, or null when no commit is due. */
  emitCount: number | null;
  /** True when the backlog is drained and the loop should sleep until the next flush. */
  done: boolean;
}

const VELOCITY_DECAY_PER_SECOND = -Math.log(1 - VELOCITY_LERP) * VELOCITY_LERP_REFERENCE_HZ;
const BACKLOG_GAIN_PER_SECOND_SQUARED = VELOCITY_DECAY_PER_SECOND / DRAIN_WINDOW_SECONDS;
const OSCILLATION_EPSILON = 1e-9;

function advanceTowardCappedVelocity(
  state: SmoothRevealState,
  ceiling: number,
  dtSeconds: number,
): number {
  const decay = Math.exp(-VELOCITY_DECAY_PER_SECOND * dtSeconds);
  const initialGap = state.velocity - ceiling;
  state.velocity = ceiling + initialGap * decay;
  return ceiling * dtSeconds + (initialGap * (1 - decay)) / VELOCITY_DECAY_PER_SECOND;
}

function advanceTowardBacklogVelocity(
  state: SmoothRevealState,
  backlog: number,
  dtSeconds: number,
): number {
  const halfDecay = VELOCITY_DECAY_PER_SECOND / 2;
  const omegaSquared = BACKLOG_GAIN_PER_SECOND_SQUARED - halfDecay * halfDecay;
  let cosine = 1;
  let sineOverOmega = dtSeconds;
  if (omegaSquared > OSCILLATION_EPSILON) {
    const omega = Math.sqrt(omegaSquared);
    cosine = Math.cos(omega * dtSeconds);
    sineOverOmega = Math.sin(omega * dtSeconds) / omega;
  } else if (omegaSquared < -OSCILLATION_EPSILON) {
    const omega = Math.sqrt(-omegaSquared);
    cosine = Math.cosh(omega * dtSeconds);
    sineOverOmega = Math.sinh(omega * dtSeconds) / omega;
  }
  const envelope = Math.exp(-halfDecay * dtSeconds);
  const velocity = state.velocity;
  const nextBacklog =
    envelope * (cosine * backlog + sineOverOmega * (halfDecay * backlog - velocity));
  const nextVelocity =
    envelope *
    (cosine * velocity +
      sineOverOmega * (BACKLOG_GAIN_PER_SECOND_SQUARED * backlog - halfDecay * velocity));
  state.velocity = Math.max(0, nextVelocity);
  return Math.max(0, backlog - nextBacklog);
}

function advanceSmoothedReveal(
  state: SmoothRevealState,
  backlog: number,
  dtSeconds: number,
): number {
  if (dtSeconds <= 0) return 0;
  const ceiling = revealVelocityCeiling(state, backlog);
  return backlog / DRAIN_WINDOW_SECONDS >= ceiling
    ? advanceTowardCappedVelocity(state, ceiling, dtSeconds)
    : advanceTowardBacklogVelocity(state, backlog, dtSeconds);
}

function endOfStreamDrainAdvance(
  state: SmoothRevealState,
  nowMs: number,
  backlog: number,
  dtSeconds: number,
  smoothedAdvance: number,
): number {
  const remainingSeconds = (state.drainDeadlineMs - nowMs) / 1000;
  if (remainingSeconds <= dtSeconds) return backlog;
  return Math.max(smoothedAdvance, (backlog * dtSeconds) / remainingSeconds);
}

function arrivalDeadlineAdvance(
  state: SmoothRevealState,
  nowMs: number,
  dtSeconds: number,
  smoothedAdvance: number,
): number {
  const deadlines = state.arrivalDeadlines;
  while (deadlines.length > 0 && deadlines[0]!.length <= state.shown) deadlines.shift();
  const due = deadlines[0];
  if (due === undefined) return smoothedAdvance;
  const dueBacklog = due.length - state.shown;
  const remainingSeconds = (due.dueAt - nowMs) / 1000;
  const required =
    remainingSeconds <= dtSeconds ? dueBacklog : (dueBacklog * dtSeconds) / remainingSeconds;
  if (required <= smoothedAdvance) return smoothedAdvance;
  if (dtSeconds > 0) state.velocity = required / dtSeconds;
  return required;
}

function integrateSmoothReveal(
  state: SmoothRevealState,
  nowMs: number,
  targetLength: number,
): void {
  const previousFrameAt = state.lastFrameAt;
  const dt = previousFrameAt
    ? Math.min(Math.max(0, nowMs - previousFrameAt) / 1000, MAX_FRAME_SECONDS)
    : 0;
  state.lastFrameAt = nowMs;

  const backlog = targetLength - state.shown;
  if (backlog <= 0) return;

  const smoothedAdvance = advanceSmoothedReveal(state, backlog, dt);
  const advance =
    state.drainDeadlineMs > 0
      ? endOfStreamDrainAdvance(state, nowMs, backlog, dt, smoothedAdvance)
      : arrivalDeadlineAdvance(state, nowMs, dt, smoothedAdvance);
  state.shown = Math.min(targetLength, state.shown + advance);
  if (targetLength - state.shown < DAMPED_TAIL_SNAP_THRESHOLD_CHARS) {
    state.shown = targetLength;
  }
}

export function advanceSmoothRevealToArrival(
  state: SmoothRevealState,
  nowMs: number,
  previousTargetLength: number,
): void {
  if (state.lastFrameAt === 0) {
    state.lastFrameAt = nowMs;
    return;
  }
  integrateSmoothReveal(state, nowMs, previousTargetLength);
  if (state.shown >= previousTargetLength) state.velocity = 0;
}

/**
 * Advance the reveal by one animation frame. Mutates `state` in place and reports
 * whether this frame should commit a longer prefix and whether the loop can sleep.
 *
 * Emission is quantized: a commit is due only when the floored count advanced AND
 * either MIN_EMIT_INTERVAL_MS elapsed since the last commit, the reveal just caught
 * up with the target (never hold back the final characters of a burst), or no commit
 * has happened yet in this burst.
 */
export function stepSmoothReveal(
  state: SmoothRevealState,
  nowMs: number,
  targetLength: number,
  emittedCount: number,
): SmoothRevealStep {
  if (state.shown > targetLength) state.shown = targetLength;
  if (targetLength - state.shown <= 0) {
    state.velocity = 0;
    state.lastFrameAt = 0;
    return { emitCount: null, done: true };
  }

  integrateSmoothReveal(state, nowMs, targetLength);
  if (state.drainDeadlineMs === 0) {
    state.shown = Math.min(state.shown, emittedCount + MAX_REVEAL_CHARS_PER_COMMIT);
  }

  const nextCount = Math.floor(state.shown);
  const caughtUp = nextCount >= targetLength;
  const emitDue =
    nextCount !== emittedCount &&
    (caughtUp || state.lastEmitAt === 0 || nowMs - state.lastEmitAt >= MIN_EMIT_INTERVAL_MS);
  if (emitDue) {
    state.lastEmitAt = nowMs;
  }

  const done = targetLength - state.shown <= 0;
  if (done) {
    state.velocity = 0;
    state.lastFrameAt = 0;
  }
  return { emitCount: emitDue ? nextCount : null, done };
}

export function alignRevealCount(
  text: string,
  previousCount: number,
  candidateCount: number,
): number {
  if (candidateCount <= previousCount) return previousCount;
  const withinLastWord = !WHITESPACE_PATTERN.test(text.slice(candidateCount));
  let aligned = withinLastWord ? text.length : candidateCount;
  if (aligned < text.length && !WHITESPACE_PATTERN.test(text[aligned - 1] ?? "")) {
    let boundary = candidateCount;
    while (boundary > previousCount && !WHITESPACE_PATTERN.test(text[boundary - 1]!)) boundary -= 1;
    if (boundary > previousCount) aligned = boundary;
    else if (candidateCount - previousCount < WORD_STEP_CHARS) return previousCount;
  }
  const lineStart = text.lastIndexOf("\n", aligned - 1) + 1;
  if (isBlockMarkerOnlyLine(text.slice(lineStart, aligned))) {
    return Math.max(previousCount, lineStart);
  }
  return aligned;
}

const revealedLengthByKey = new Map<string, number>();

export function rememberRevealedLength(revealKey: string, length: number): void {
  revealedLengthByKey.delete(revealKey);
  revealedLengthByKey.set(revealKey, length);
  if (revealedLengthByKey.size > REVEALED_LENGTH_REGISTRY_LIMIT) {
    const oldestKey = revealedLengthByKey.keys().next().value;
    if (oldestKey !== undefined) revealedLengthByKey.delete(oldestKey);
  }
}

export function initialRevealCount(
  text: string,
  animatedStream: boolean,
  revealKey: string | undefined,
): number {
  if (!animatedStream || revealKey === undefined) return text.length;
  const remembered = revealedLengthByKey.get(revealKey);
  if (remembered !== undefined) return Math.min(remembered, text.length);
  if (text.length <= MAX_REVEAL_CHARS_PER_COMMIT || text.length > FRESH_MOUNT_REVEAL_MAX_CHARS) {
    return text.length;
  }
  return alignRevealCount(text, 0, MAX_REVEAL_CHARS_PER_COMMIT);
}

export interface SmoothStreamedText {
  readonly text: string;
  readonly isRevealing: boolean;
}

/**
 * Smoothly reveal `text` while `isStreaming` is true.
 *
 * - Returns `text` unchanged when not streaming or under prefers-reduced-motion, so
 *   completed messages and reduced-motion users see the exact text with zero animation.
 * - When streaming ends with a backlog, reveals the rest within END_OF_STREAM_DRAIN_MS
 *   instead of in one frame; `isRevealing` stays true until the drain finishes.
 * - Text already present on mount is shown immediately, unless `revealKey` names a fresh
 *   streaming message: then it animates from the length last revealed for that key, or
 *   from its first commit-sized, word-aligned chunk for a new key.
 */
export function useSmoothStreamedText(
  text: string,
  isStreaming: boolean,
  revealKey?: string,
): SmoothStreamedText {
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  // Testable env (jsdom/vitest) has no rAF or has mocked timers – smooth reveal would
  // jank and never settle. Fall back to immediate text so streaming tests stay
  // deterministic and the main thread isn't blocked by rAF loops.
  const isTestableEnv =
    typeof window === "undefined" ||
    typeof (window as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame !==
      "function" ||
    (typeof process !== "undefined" &&
      (process.env.VITEST === "true" || process.env.NODE_ENV === "test"));
  const canAnimate = !reduceMotion && !isTestableEnv;

  const [mountRevealCount] = useState(() =>
    initialRevealCount(text, canAnimate && isStreaming, revealKey),
  );
  const [revealed, setRevealed] = useState(() => text.slice(0, mountRevealCount));
  const [previousIsStreaming, setPreviousIsStreaming] = useState(isStreaming);
  const [drainRequested, setDrainRequested] = useState(false);
  if (previousIsStreaming !== isStreaming) {
    setPreviousIsStreaming(isStreaming);
    setDrainRequested(previousIsStreaming && !isStreaming);
  }

  const revealPending = revealed.length < text.length && text.startsWith(revealed);
  const isRevealing = canAnimate && (isStreaming || (drainRequested && revealPending));
  const live = canAnimate && (isStreaming || drainRequested);

  // Latest full text, mirrored post-commit so the rAF loop always reads the current value
  // without re-subscribing the animation effect on every ~100ms delta.
  const targetRef = useRef(text.slice(0, mountRevealCount));
  const stateRef = useRef<SmoothRevealState>(createSmoothRevealState(mountRevealCount));
  // Character count last pushed to React state — guards against redundant setState when the
  // floored count has not advanced.
  const emittedRef = useRef(mountRevealCount);
  const rafRef = useRef<number | null>(null);
  const drainTimerRef = useRef<number | null>(null);
  const tickRef = useRef<(now: number) => void>(() => undefined);

  const cancelFrame = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const clearDrainTimer = () => {
    if (drainTimerRef.current != null) {
      window.clearTimeout(drainTimerRef.current);
      drainTimerRef.current = null;
    }
  };

  const scheduleFrame = () => {
    if (rafRef.current != null) {
      return;
    }
    rafRef.current = requestAnimationFrame((now) => {
      rafRef.current = null;
      tickRef.current(now);
    });
  };

  const snapToTarget = () => {
    cancelFrame();
    const target = targetRef.current;
    const { arrivalRate, lastArrivalAt, drainDeadlineMs } = stateRef.current;
    stateRef.current = {
      ...createSmoothRevealState(target.length),
      arrivalRate,
      lastArrivalAt,
      drainDeadlineMs,
    };
    emittedRef.current = target.length;
    setRevealed(target);
  };

  const finishDrain = () => {
    cancelFrame();
    clearDrainTimer();
    const target = targetRef.current;
    stateRef.current = createSmoothRevealState(target.length);
    emittedRef.current = target.length;
    setRevealed(target);
    setDrainRequested(false);
  };

  // Installed in an effect (not during render — that write would make the
  // whole hook ineligible for React Compiler). The tick reads everything
  // through refs, so a mount-time install stays permanently fresh.
  useEffect(() => {
    tickRef.current = (now: number) => {
      const target = targetRef.current;
      const step = stepSmoothReveal(stateRef.current, now, target.length, emittedRef.current);
      const emitCount =
        step.emitCount === null || stateRef.current.drainDeadlineMs !== 0
          ? step.emitCount
          : alignRevealCount(target, emittedRef.current, step.emitCount);
      if (emitCount !== null && emitCount !== emittedRef.current) {
        emittedRef.current = emitCount;
        setRevealed(emitCount >= target.length ? target : target.slice(0, emitCount));
      }
      if (!step.done) {
        scheduleFrame();
      } else if (stateRef.current.drainDeadlineMs !== 0) {
        finishDrain();
      }
    };
  }, [finishDrain, scheduleFrame]);

  useEffect(() => {
    const previousTarget = targetRef.current;
    const isAppendOnly = text.length >= previousTarget.length && text.startsWith(previousTarget);
    targetRef.current = text;

    if (!live || !isAppendOnly) {
      cancelFrame();
      clearDrainTimer();
      stateRef.current = createSmoothRevealState(text.length);
      emittedRef.current = text.length;
      setRevealed(text);
      return;
    }

    if (isStreaming) {
      stateRef.current.drainDeadlineMs = 0;
      clearDrainTimer();
    } else {
      if (emittedRef.current >= text.length) {
        finishDrain();
        return;
      }
      if (stateRef.current.drainDeadlineMs === 0) {
        stateRef.current.drainDeadlineMs = performance.now() + END_OF_STREAM_DRAIN_MS;
        clearDrainTimer();
        drainTimerRef.current = window.setTimeout(finishDrain, END_OF_STREAM_DRAIN_FALLBACK_MS);
      }
    }

    if (isStreaming) {
      recordSmoothRevealArrival(
        stateRef.current,
        performance.now(),
        text.length - previousTarget.length,
      );
    }
    if (text.length > stateRef.current.shown) {
      advanceSmoothRevealToArrival(stateRef.current, performance.now(), previousTarget.length);
      scheduleFrame();
    }
  }, [cancelFrame, clearDrainTimer, finishDrain, isStreaming, live, scheduleFrame, text]);

  useEffect(() => {
    if (!live) return;
    const snapWhenVisible = () => {
      if (document.visibilityState === "visible") snapToTarget();
    };
    document.addEventListener("visibilitychange", snapWhenVisible);
    return () => document.removeEventListener("visibilitychange", snapWhenVisible);
  }, [live, snapToTarget]);

  useEffect(
    () => () => {
      cancelFrame();
      clearDrainTimer();
    },
    [cancelFrame, clearDrainTimer],
  );

  const visibleText = isRevealing ? revealed : text;
  useEffect(() => {
    if (revealKey !== undefined) rememberRevealedLength(revealKey, visibleText.length);
  }, [revealKey, visibleText.length]);

  return { text: visibleText, isRevealing };
}
