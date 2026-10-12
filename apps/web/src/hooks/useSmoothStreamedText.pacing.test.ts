import { describe, expect, it } from "vitest";

import {
  createSmoothRevealState,
  END_OF_STREAM_DRAIN_MS,
  stepSmoothReveal,
  type SmoothRevealState,
  advanceSmoothRevealToArrival,
} from "./useSmoothStreamedText";

const FLUSH_INTERVAL_MS = 100;
const CHARS_PER_FLUSH = 50;
const FLUSH_OFFSET_MS = 7;
const CLOCK_ORIGIN_MS = 1_000;

interface PacedReveal {
  readonly positionAt: (elapsedMs: number) => number;
  readonly commits: ReadonlyArray<{ readonly at: number; readonly count: number }>;
  readonly lastFlushAt: number;
  readonly finalLength: number;
  readonly finishedAt: number | null;
}

function runPacedReveal(hz: number, flushes: number): PacedReveal {
  const frameMs = 1_000 / hz;
  const state: SmoothRevealState = createSmoothRevealState(0);
  const samples: Array<{ at: number; shown: number }> = [];
  const commits: Array<{ at: number; count: number }> = [];
  const flushTimes = Array.from(
    { length: flushes },
    (_, flush) => flush * FLUSH_INTERVAL_MS + FLUSH_OFFSET_MS,
  );
  const lastFlushAt = flushTimes.at(-1)!;
  const finalLength = flushes * CHARS_PER_FLUSH;
  const clock = (elapsedMs: number) => CLOCK_ORIGIN_MS + elapsedMs;
  let target = 0;
  let emitted = 0;
  let finishedAt: number | null = null;
  let awake = false;
  let nextFlush = 0;

  for (let frame = 1; frame * frameMs <= lastFlushAt + 2_000; frame += 1) {
    const frameAt = frame * frameMs;
    while (nextFlush < flushTimes.length && flushTimes[nextFlush]! <= frameAt) {
      const flushAt = flushTimes[nextFlush]!;
      advanceSmoothRevealToArrival(state, clock(flushAt), target);
      target += CHARS_PER_FLUSH;
      if (nextFlush === flushes - 1) {
        state.drainDeadlineMs = clock(flushAt) + END_OF_STREAM_DRAIN_MS;
      }
      awake = true;
      nextFlush += 1;
    }
    if (!awake) continue;
    const step = stepSmoothReveal(state, clock(frameAt), target, emitted);
    if (step.emitCount !== null) {
      emitted = step.emitCount;
      commits.push({ at: frameAt, count: emitted });
    }
    samples.push({ at: frameAt, shown: state.shown });
    if (step.done) {
      awake = false;
      if (state.drainDeadlineMs !== 0 && finishedAt === null) finishedAt = frameAt;
    }
  }

  return {
    positionAt: (elapsedMs) =>
      samples.find((sample) => Math.abs(sample.at - elapsedMs) < 1e-6)?.shown ?? Number.NaN,
    commits,
    lastFlushAt,
    finalLength,
    finishedAt,
  };
}

describe("smooth reveal pacing", () => {
  it("reveals at the same pace on 60 Hz and 120 Hz displays", () => {
    const at60 = runPacedReveal(60, 20);
    const at120 = runPacedReveal(120, 20);

    for (const elapsedMs of [300, 600, 1_200]) {
      const position60 = at60.positionAt(elapsedMs);
      const position120 = at120.positionAt(elapsedMs);
      expect(position60).toBeGreaterThan(0);
      expect(Math.abs(position60 - position120) / position60).toBeLessThanOrEqual(0.02);
    }
  });

  it.each([60, 120])(
    "finishes the end-of-stream backlog within the drain window at %i Hz",
    (hz) => {
      const run = runPacedReveal(hz, 20);

      expect(run.commits.at(-1)?.count).toBe(run.finalLength);
      expect(run.finishedAt).not.toBeNull();
      expect(run.finishedAt! - run.lastFlushAt).toBeLessThanOrEqual(
        END_OF_STREAM_DRAIN_MS + 1_000 / hz,
      );

      const steadyJumps = run.commits
        .filter((commit) => commit.at > 300 && commit.at < run.lastFlushAt)
        .map((commit, index, all) => (index === 0 ? 0 : commit.count - all[index - 1]!.count))
        .filter((jump) => jump > 0)
        .toSorted((left, right) => left - right);
      const steadyP95 = steadyJumps[Math.floor(steadyJumps.length * 0.95)]!;
      const drainCommits = run.commits.filter((commit) => commit.at >= run.lastFlushAt);
      expect(drainCommits.length).toBeGreaterThan(1);
      const commitsBeforeDrain = run.commits.filter((commit) => commit.at < run.lastFlushAt);
      let previousCount = commitsBeforeDrain.at(-1)?.count ?? 0;
      for (const commit of drainCommits) {
        expect(commit.count - previousCount).toBeLessThanOrEqual(steadyP95 * 2.5);
        previousCount = commit.count;
      }
    },
  );

  it("drains a large final backlog by the deadline instead of in one frame", () => {
    const state = createSmoothRevealState(0);
    state.drainDeadlineMs = 1_000 + END_OF_STREAM_DRAIN_MS;
    let emitted = 0;
    const counts: number[] = [];
    let now = 1_000;
    for (let frame = 0; frame < 60; frame += 1) {
      const step = stepSmoothReveal(state, now, 400, emitted);
      if (step.emitCount !== null) {
        emitted = step.emitCount;
        counts.push(emitted);
      }
      if (step.done) break;
      now += 1_000 / 60;
    }

    expect(emitted).toBe(400);
    expect(now).toBeLessThanOrEqual(1_000 + END_OF_STREAM_DRAIN_MS + 1_000 / 60);
    expect(counts.length).toBeGreaterThan(2);
    expect(counts[0]).toBeLessThan(400);
  });
});
