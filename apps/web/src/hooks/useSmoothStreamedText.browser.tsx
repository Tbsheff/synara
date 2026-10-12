// FILE: useSmoothStreamedText.browser.tsx
// Layer: Web browser tests
// Depends on: useSmoothStreamedText and a real React/browser rAF loop. The pure
//             stepper math is pinned separately in useSmoothStreamedText.test.ts;
//             these tests cover the wiring the stepper tests cannot see.

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import {
  END_OF_STREAM_DRAIN_MS,
  MAX_REVEAL_CHARS_PER_COMMIT,
  useSmoothStreamedText,
} from "~/hooks/useSmoothStreamedText";

interface SmoothTextProps {
  readonly text: string;
  readonly isStreaming: boolean;
}

const MULTI_COMMIT_DELTA = "word ".repeat(100);
const BURST_DELTA = "word ".repeat(150);

function renderSmoothText(initialProps: SmoothTextProps) {
  return renderHook(
    (props?: SmoothTextProps) =>
      useSmoothStreamedText(
        props?.text ?? initialProps.text,
        props?.isStreaming ?? initialProps.isStreaming,
      ).text,
    { initialProps },
  );
}

describe("useSmoothStreamedText", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows mount text immediately and reveals appended deltas gradually", async () => {
    const mountText = "Hello ";
    const hook = await renderSmoothText({ text: mountText, isStreaming: true });
    expect(hook.result.current).toBe(mountText);

    const full = mountText + MULTI_COMMIT_DELTA;
    await hook.rerender({ text: full, isStreaming: true });
    // The append only wakes the rAF loop — the backlog must not snap in at once.
    expect(hook.result.current.length).toBeLessThan(full.length);
    expect(full.startsWith(hook.result.current)).toBe(true);

    // The reveal passes through intermediate prefixes on its way to the target.
    let intermediate = "";
    await expect
      .poll(
        () => {
          const value = hook.result.current;
          if (value.length > mountText.length && value.length < full.length) {
            intermediate = value;
          }
          return intermediate.length > 0;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    expect(full.startsWith(intermediate)).toBe(true);

    await expect.poll(() => hook.result.current, { timeout: 10_000 }).toBe(full);

    await hook.unmount();
  });

  it("shows a mid-word tail once the reveal catches up during a pause", async () => {
    const hook = await renderSmoothText({ text: "Hello ", isStreaming: true });
    await hook.rerender({ text: "Hello world", isStreaming: true });
    await expect.poll(() => hook.result.current, { timeout: 2_000 }).toBe("Hello world");
    await hook.unmount();
  });

  it("reveals a large burst in bounded commits instead of snapping", async () => {
    const mountText = "Hello ";
    const hook = await renderSmoothText({ text: mountText, isStreaming: true });
    const full = mountText + BURST_DELTA;
    await hook.rerender({ text: full, isStreaming: true });
    expect(hook.result.current.length).toBeLessThan(full.length);

    let previousLength = hook.result.current.length;
    let largestCommit = 0;
    await expect
      .poll(
        () => {
          const length = hook.result.current.length;
          largestCommit = Math.max(largestCommit, length - previousLength);
          previousLength = length;
          return length;
        },
        { interval: 1, timeout: 5_000 },
      )
      .toBe(full.length);
    expect(largestCommit).toBeLessThanOrEqual(MAX_REVEAL_CHARS_PER_COMMIT * 3);
    await hook.unmount();
  });

  it("drains the remaining backlog over a short window when streaming ends", async () => {
    const mountText = "Partial ";
    const hook = await renderHook(
      (props?: SmoothTextProps) =>
        useSmoothStreamedText(props?.text ?? mountText, props?.isStreaming ?? true),
      { initialProps: { text: mountText, isStreaming: true } },
    );

    const full = mountText + MULTI_COMMIT_DELTA;
    await hook.rerender({ text: full, isStreaming: true });
    expect(hook.result.current.text.length).toBeLessThan(full.length);

    const endedAt = performance.now();
    await hook.rerender({ text: full, isStreaming: false });
    const firstSettledFrame = hook.result.current;
    expect(firstSettledFrame.text.length).toBeLessThan(full.length);
    expect(firstSettledFrame.isRevealing).toBe(true);
    expect(full.startsWith(firstSettledFrame.text)).toBe(true);

    let observedIntermediate = false;
    await expect
      .poll(
        () => {
          const { text } = hook.result.current;
          if (text.length > firstSettledFrame.text.length && text.length < full.length) {
            observedIntermediate = true;
          }
          return text;
        },
        { interval: 5, timeout: 2_000 },
      )
      .toBe(full);
    const drainedAt = performance.now();

    expect(hook.result.current.isRevealing).toBe(false);
    expect(observedIntermediate).toBe(true);
    expect(drainedAt - endedAt).toBeLessThan(END_OF_STREAM_DRAIN_MS + 150);

    await hook.unmount();
  });

  it("resets instantly on a non-append replacement while streaming", async () => {
    const hook = await renderSmoothText({ text: "Original draft", isStreaming: true });
    expect(hook.result.current).toBe("Original draft");

    // A projection repair can rewrite the text in place; a non-append target
    // must not be typewriter-animated from a stale prefix.
    await hook.rerender({ text: "Rewritten from scratch", isStreaming: true });
    expect(hook.result.current).toBe("Rewritten from scratch");

    await hook.unmount();
  });

  it("returns the raw text under prefers-reduced-motion even while streaming", async () => {
    const originalMatchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) =>
      query === "(prefers-reduced-motion: reduce)"
        ? ({
            matches: true,
            media: query,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
          } as unknown as MediaQueryList)
        : originalMatchMedia(query),
    );

    const mountText = "Hello ";
    const hook = await renderSmoothText({ text: mountText, isStreaming: true });
    expect(hook.result.current).toBe(mountText);

    const full = mountText + MULTI_COMMIT_DELTA;
    await hook.rerender({ text: full, isStreaming: true });
    expect(hook.result.current).toBe(full);

    await hook.unmount();
  });
});
