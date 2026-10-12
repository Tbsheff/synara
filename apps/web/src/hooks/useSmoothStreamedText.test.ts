// FILE: useSmoothStreamedText.test.ts
// Purpose: Pins the pure reveal stepper — velocity-driven drain plus quantized commits.
//          The hook itself is thin wiring (refs + rAF scheduling) around this function.

import { describe, expect, it } from "vitest";

import {
  alignRevealCount,
  createSmoothRevealState,
  advanceSmoothRevealToArrival,
  CATCH_UP_SECONDS,
  END_OF_STREAM_DRAIN_MS,
  MAX_CATCH_UP_CHARS_PER_SECOND,
  MAX_REVEAL_CHARS_PER_COMMIT,
  MIN_EMIT_INTERVAL_MS,
  recordSmoothRevealArrival,
  revealVelocityCeiling,
  stepSmoothReveal,
  type SmoothRevealState,
} from "./useSmoothStreamedText";

const FRAME_MS = 8; // ~120Hz display

interface DrainRun {
  emits: { at: number; count: number }[];
  frames: number;
  state: SmoothRevealState;
}

/** Drive the stepper frame-by-frame until the backlog drains (or maxFrames). */
function drain(
  state: SmoothRevealState,
  targetLength: number,
  startMs: number,
  maxFrames = 10_000,
): DrainRun {
  const emits: { at: number; count: number }[] = [];
  let emitted = Math.floor(state.shown);
  let now = startMs;
  let frames = 0;
  for (; frames < maxFrames; frames += 1) {
    const step = stepSmoothReveal(state, now, targetLength, emitted);
    if (step.emitCount !== null) {
      emits.push({ at: now, count: step.emitCount });
      emitted = step.emitCount;
    }
    if (step.done) {
      break;
    }
    now += FRAME_MS;
  }
  return { emits, frames, state };
}

describe("stepSmoothReveal", () => {
  it("spaces commits at least MIN_EMIT_INTERVAL_MS apart while draining", () => {
    const run = drain(createSmoothRevealState(0), 400, 1_000);

    expect(run.emits.length).toBeGreaterThan(1);
    for (let index = 1; index < run.emits.length - 1; index += 1) {
      expect(run.emits[index]!.at - run.emits[index - 1]!.at).toBeGreaterThanOrEqual(
        MIN_EMIT_INTERVAL_MS,
      );
    }
    expect(run.emits.length).toBeLessThanOrEqual(Math.ceil(run.frames / 2) + 1);
  });

  it("emits the catch-up commit even when the interval has not elapsed", () => {
    // Mid-burst, one frame from catching up, with a commit only 4ms ago: the
    // final characters must not be held hostage to the quantization gate.
    const state: SmoothRevealState = {
      shown: 101.5,
      velocity: 500,
      lastFrameAt: 992,
      lastEmitAt: 996,
      drainDeadlineMs: 0,
      arrivalRate: 0,
      lastArrivalAt: 0,
      arrivedLength: 103,
      arrivalDeadlines: [],
    };
    const step = stepSmoothReveal(state, 1_000, 103, 101);

    expect(step.emitCount).toBe(103);
    expect(step.done).toBe(true);
  });

  it("clamps the frame delta after a background-tab resume", () => {
    const state = createSmoothRevealState(0);
    // Prime one frame so velocity builds, then jump far ahead as if rAF was paused.
    stepSmoothReveal(state, 1_000, 500, 0);
    stepSmoothReveal(state, 1_008, 500, 0);
    const shownBefore = state.shown;
    const velocityBefore = state.velocity;
    stepSmoothReveal(state, 61_000, 500, Math.floor(shownBefore));

    // At most MAX_FRAME_SECONDS (0.05s) of reveal, not 60s of backlog dump.
    expect(state.shown - shownBefore).toBeLessThanOrEqual(
      Math.max(state.velocity, velocityBefore) * 0.05 + 1,
    );
    expect(state.shown).toBeLessThan(500);
  });

  it("clamps and sleeps when the target shrank below the revealed count", () => {
    const state = createSmoothRevealState(200);
    const step = stepSmoothReveal(state, 1_000, 50, 200);

    expect(state.shown).toBe(50);
    expect(step.done).toBe(true);
    expect(step.emitCount).toBeNull();
  });

  it("reports done and resets burst tracking once caught up", () => {
    const run = drain(createSmoothRevealState(0), 60, 2_000);

    expect(run.state.velocity).toBe(0);
    expect(run.state.lastFrameAt).toBe(0);
    // A later burst starting fresh emits its first advanced frame promptly.
    const next = drain(run.state, 120, 2_000 + run.frames * FRAME_MS + 100);
    expect(next.emits.length).toBeGreaterThan(0);
  });

  it("drains a large paste at the bounded catch-up ceiling instead of snapping", () => {
    const state = createSmoothRevealState(0);
    recordSmoothRevealArrival(state, 0, 10_000);
    const run = drain(state, 10_000, 0);

    expect(run.frames * FRAME_MS).toBeGreaterThanOrEqual(
      (10_000 / MAX_REVEAL_CHARS_PER_COMMIT) * MIN_EMIT_INTERVAL_MS,
    );
    expect(run.frames * FRAME_MS).toBeLessThan(4_000);
    expect(run.emits.at(-1)?.count).toBe(10_000);
    expect(maxCommitGrowth(run.emits, 0)).toBeLessThanOrEqual(MAX_REVEAL_CHARS_PER_COMMIT);
  });

  it("spreads a large first chunk over several hundred milliseconds", () => {
    const run = drain(createSmoothRevealState(0), 243, 1_000);
    const firstEmit = run.emits[0]!;
    const lastEmit = run.emits.at(-1)!;

    expect(lastEmit.count).toBe(243);
    expect(lastEmit.at - firstEmit.at).toBeGreaterThanOrEqual(300);
    const largestStep = Math.max(
      ...run.emits.map((emit, index) => emit.count - (run.emits[index - 1]?.count ?? 0)),
    );
    expect(largestStep).toBeLessThanOrEqual(12);
  });

  it("raises the ceiling to keep up with a fast sustained stream", () => {
    const state = createSmoothRevealState(0);
    for (let flush = 0; flush <= 30; flush += 1) {
      recordSmoothRevealArrival(state, 1_000 + flush * 100, 120);
    }

    expect(state.arrivalRate).toBeGreaterThan(1_000);
    expect(revealVelocityCeiling(state)).toBeGreaterThan(1_500);
  });
});

describe("alignRevealCount", () => {
  it.each([
    ["backs off to the last word boundary", "foo bar baz qux", 0, 9, 8],
    ["holds a partial word", "foo bar baz qux", 0, 10, 8],
    ["shows the caught-up tail even mid-word", "foo bar ba", 0, 10, 10],
    ["completes the last arrived word early", "foo bar baz", 0, 9, 11],
    ["holds a short first word", "abcdefgh ij", 0, 4, 0],
    ["shows a long token after one word step", `${"a".repeat(30)} b`, 0, 25, 25],
    ["keeps a count that ends on whitespace", "foo ", 0, 4, 4],
    ["never ends on a bare list marker", "text\n- item more", 0, 7, 5],
    ["never ends on a bare heading marker", "text\n## Title here", 0, 8, 5],
    ["never moves backwards", "foo bar baz qux", 8, 9, 8],
  ])("%s", (_label, text, previous, candidate, expected) => {
    expect(alignRevealCount(text, previous, candidate)).toBe(expected);
  });
});

interface Arrival {
  readonly at: number;
  readonly text: string;
}

interface StreamRun {
  readonly commits: ReadonlyArray<{ readonly at: number; readonly count: number }>;
  readonly arrivedAt: (count: number) => number;
}

function maxCommitGrowth(
  commits: ReadonlyArray<{ readonly count: number }>,
  startCount: number,
): number {
  return Math.max(
    0,
    ...commits.map((commit, index) => commit.count - (commits[index - 1]?.count ?? startCount)),
  );
}

function simulateStream(
  arrivals: readonly Arrival[],
  hz: number,
  untilMs: number,
  options: { readonly endAt?: number } = {},
): StreamRun {
  const frameMs = 1_000 / hz;
  const state = createSmoothRevealState(0);
  const commits: Array<{ at: number; count: number }> = [];
  let target = "";
  let emitted = 0;
  let awake = false;
  let nextArrival = 0;
  for (let now = 0; now <= untilMs; now += frameMs) {
    while (nextArrival < arrivals.length && arrivals[nextArrival]!.at <= now) {
      const previousLength = target.length;
      target = arrivals[nextArrival]!.text;
      recordSmoothRevealArrival(state, now, target.length - previousLength);
      advanceSmoothRevealToArrival(state, now, previousLength);
      awake = true;
      nextArrival += 1;
    }
    if (options.endAt !== undefined && now >= options.endAt && state.drainDeadlineMs === 0) {
      state.drainDeadlineMs = now + END_OF_STREAM_DRAIN_MS;
      awake = true;
    }
    if (!awake) continue;
    const step = stepSmoothReveal(state, now, target.length, emitted);
    const count =
      step.emitCount === null || state.drainDeadlineMs !== 0
        ? step.emitCount
        : alignRevealCount(target, emitted, step.emitCount);
    if (count !== null && count !== emitted) {
      emitted = count;
      commits.push({ at: now, count });
    }
    if (step.done) awake = false;
  }
  const arrivedAt = (count: number) =>
    arrivals.find((arrival) => arrival.text.length >= count)?.at ?? Number.POSITIVE_INFINITY;
  return { commits, arrivedAt };
}

function proseOfLength(length: number): string {
  let text = "";
  while (text.length < length) text += "the reader sees words arrive at a steady pace ";
  return text.slice(0, length);
}

describe("bounded catch-up (no arrival snap)", () => {
  it.each([60, 30])("spreads a +1172-char mid-message burst over frames at %d Hz", (hz) => {
    const prefix = proseOfLength(300);
    const burst = `${prefix}${proseOfLength(1172)}`;
    const run = simulateStream(
      [
        { at: 0, text: prefix },
        { at: 1_000, text: burst },
      ],
      hz,
      4_000,
    );
    const burstCommits = run.commits.filter((commit) => commit.at >= 1_000);

    expect(run.commits.at(-1)?.count).toBe(burst.length);
    expect(maxCommitGrowth(burstCommits, prefix.length)).toBeLessThanOrEqual(
      MAX_REVEAL_CHARS_PER_COMMIT,
    );
    expect(burstCommits.length).toBeGreaterThanOrEqual(10);
  });

  it("animates a 785-char first update from empty instead of showing it at once", () => {
    const answer = proseOfLength(785);
    const run = simulateStream([{ at: 0, text: answer }], 60, 3_000);

    expect(run.commits.at(-1)?.count).toBe(785);
    expect(run.commits.length).toBeGreaterThanOrEqual(8);
    expect(maxCommitGrowth(run.commits, 0)).toBeLessThanOrEqual(MAX_REVEAL_CHARS_PER_COMMIT);
  });

  it("raises the velocity ceiling with the backlog, up to the catch-up cap", () => {
    const state = createSmoothRevealState(0);
    expect(revealVelocityCeiling(state, 3_000)).toBeCloseTo(3_000 / CATCH_UP_SECONDS);
    expect(revealVelocityCeiling(state, 100_000)).toBe(MAX_CATCH_UP_CHARS_PER_SECOND);
    expect(revealVelocityCeiling(state, 0)).toBe(revealVelocityCeiling(state));
  });

  it("keeps the backlog bounded under a fast sustained stream", () => {
    const arrivals: Arrival[] = [];
    const full = proseOfLength(40 * 300);
    for (let flush = 1; flush <= 40; flush += 1) {
      arrivals.push({ at: flush * 100, text: full.slice(0, flush * 300) });
    }
    const run = simulateStream(arrivals, 60, 6_000);
    const lags = arrivals.map((arrival) => {
      const shownAt = run.commits.findLast((commit) => commit.at <= arrival.at)?.count ?? 0;
      return arrival.text.length - shownAt;
    });

    expect(Math.max(...lags.slice(10))).toBeLessThan(3_000 * CATCH_UP_SECONDS + 600);
    expect(maxCommitGrowth(run.commits, 0)).toBeLessThanOrEqual(MAX_REVEAL_CHARS_PER_COMMIT);
  });

  it.each([60, 30])("still finishes the end-of-stream drain within the window at %d Hz", (hz) => {
    const answer = proseOfLength(1_500);
    const run = simulateStream([{ at: 0, text: answer }], hz, 2_000, { endAt: 100 });

    const finished = run.commits.find((commit) => commit.count === answer.length);
    expect(finished).toBeDefined();
    expect(finished!.at - 100).toBeLessThanOrEqual(END_OF_STREAM_DRAIN_MS + 1_000 / hz);
  });
});

function longestCommitGap(run: StreamRun, until: number): number {
  const times = [0, ...run.commits.map((commit) => commit.at).filter((at) => at <= until)];
  return Math.max(...times.slice(1).map((at, index) => at - times[index]!));
}

describe("pacer never stalls with backlog", () => {
  it.each([60, 30])("emits a fixed 300-char prose backlog promptly at %d Hz", (hz) => {
    const text = proseOfLength(300);
    const run = simulateStream([{ at: 0, text }], hz, 2_000);
    const last = run.commits.at(-1)!;

    expect(last.count).toBe(300);
    expect(last.at).toBeLessThanOrEqual(600);
    expect(longestCommitGap(run, last.at)).toBeLessThanOrEqual(250);
  });

  it.each([60, 30])(
    "holds a trailing heading marker, emits the rest promptly, and releases it on the next arrival at %d Hz",
    (hz) => {
      const head = `${proseOfLength(280)}\n\n`;
      const held = `${head}### `;
      const completed = `${held}Resume latency\n\nNext paragraph.`;
      const run = simulateStream(
        [
          { at: 0, text: held },
          { at: 1_000, text: completed },
        ],
        hz,
        3_000,
      );
      const beforeArrival = run.commits.filter((commit) => commit.at < 1_000);
      const lastBefore = beforeArrival.at(-1)!;

      expect(lastBefore.count).toBe(head.length);
      expect(lastBefore.at).toBeLessThanOrEqual(600);
      expect(longestCommitGap(run, lastBefore.at)).toBeLessThanOrEqual(250);
      const released = run.commits.find((commit) => commit.count > head.length)!;
      expect(released.at).toBeGreaterThanOrEqual(1_000);
      expect(released.at - 1_000).toBeLessThanOrEqual(250);
      expect(run.commits.at(-1)!.count).toBe(completed.length);
    },
  );
});
