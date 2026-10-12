import { describe, expect, it } from "vitest";

import {
  commonPrefixLength,
  emptyRevealSchedule,
  MAX_REVEAL_DELAY_MS,
  nextRevealSchedule,
  REVEAL_CHUNK_CHARS,
  REVEAL_DELAY_PER_CHAR_MS,
} from "./useStreamingTextReveal";

describe("commonPrefixLength", () => {
  it("measures the shared prefix", () => {
    expect(commonPrefixLength("hello world", "hello there")).toBe(6);
    expect(commonPrefixLength("", "abc")).toBe(0);
  });
});

describe("nextRevealSchedule", () => {
  it("splits fresh text into staggered chunks", () => {
    const schedule = nextRevealSchedule(
      emptyRevealSchedule(),
      "Hello ",
      `Hello ${"x".repeat(40)}`,
      1_000,
    );

    expect(schedule.fragments.map(({ start, end }) => [start, end])).toEqual([
      [6, 6 + REVEAL_CHUNK_CHARS],
      [6 + REVEAL_CHUNK_CHARS, 6 + 2 * REVEAL_CHUNK_CHARS],
      [6 + 2 * REVEAL_CHUNK_CHARS, 46],
    ]);
    expect(schedule.fragments.map((fragment) => fragment.startedAt)).toEqual([
      1_000 + REVEAL_CHUNK_CHARS * REVEAL_DELAY_PER_CHAR_MS,
      1_000 + 2 * REVEAL_CHUNK_CHARS * REVEAL_DELAY_PER_CHAR_MS,
      1_000 + 40 * REVEAL_DELAY_PER_CHAR_MS,
    ]);
  });

  it("caps the stagger delay within one commit", () => {
    const text = "word ".repeat(30);
    const schedule = nextRevealSchedule(emptyRevealSchedule(), "", text, 1_000);
    expect(schedule.fragments.at(-1)!.startedAt).toBeLessThanOrEqual(1_000 + MAX_REVEAL_DELAY_MS);
  });

  it("anchors each commit's stagger to the commit time", () => {
    let schedule = emptyRevealSchedule();
    let text = "";
    for (let step = 0; step < 40; step += 1) {
      const next = `${text}word `;
      schedule = nextRevealSchedule(schedule, text, next, 1_000 + step * 16);
      text = next;
    }
    const last = schedule.fragments.at(-1)!;
    expect(last.startedAt).toBe(1_000 + 39 * 16 + 5 * REVEAL_DELAY_PER_CHAR_MS);
  });

  it("skips the fade when input is faster than the fast-input limit", () => {
    const schedule = nextRevealSchedule(emptyRevealSchedule(), "", "x".repeat(200), 1_000);
    expect(schedule.fragments).toEqual([]);
  });

  it("drops fragments whose text changed", () => {
    const first = nextRevealSchedule(emptyRevealSchedule(), "ab", "abcdef", 1_000);
    const second = nextRevealSchedule(first, "abcdef", "abcXYZ", 1_050);
    expect(second.fragments.map(({ start, end }) => [start, end])).toEqual([
      [2, 3],
      [3, 6],
    ]);
  });
});
