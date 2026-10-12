import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import ChatMarkdown from "./ChatMarkdown";

const KATEX_FONTS = ["KaTeX_Main", "KaTeX_Math", "KaTeX_Size1", "KaTeX_Size2"] as const;
const STEP_CHARS = 3;
const STEP_INTERVAL_MS = 16;
const SETTLE_AFTER_CLOSE_MS = 400;
const MAX_SWAP_SHIFT_PX = 4;

const SINGLE_LINE_EQUATION = "$$\nE = mc^2 + \\frac{\\mathbb{E}[X]}{\\sigma^2}\n$$";
const ALIGNED_EQUATION = [
  "$$",
  "\\begin{aligned}",
  "f(x) &= \\sum_{k=0}^{n} a_k x^k \\\\",
  "g(x) &= \\frac{1}{2}\\int_0^x f(t)\\,dt",
  "\\end{aligned}",
  "$$",
].join("\n");

const SEGMENTS_PAUSING_AFTER_EACH_CLOSE = [
  `Intro line before the math.\n\n${SINGLE_LINE_EQUATION}`,
  `\n\nMiddle line between equations.\n\n${ALIGNED_EQUATION}`,
  "\n\nClosing line after the math.",
] as const;

interface FrameSample {
  readonly frame: number;
  readonly pendingCount: number;
  readonly displayCount: number;
  readonly sentinelTop: number;
  readonly lastMathHeight: number | null;
  readonly lastMathKind: "pending" | "katex" | null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

interface MathBlock {
  readonly element: Element;
  readonly measured: Element;
  readonly kind: "pending" | "katex";
}

function mathBlocks(root: Element): MathBlock[] {
  return Array.from(
    root.querySelectorAll(".chat-markdown-pending-math, .chat-markdown .katex-display"),
  )
    .filter((element) => !element.parentElement?.closest(".chat-markdown-pending-math"))
    .map((element) => {
      const isPending = element.classList.contains("chat-markdown-pending-math");
      return {
        element,
        measured: (isPending ? element.querySelector(".katex-display") : null) ?? element,
        kind: isPending ? "pending" : "katex",
      };
    });
}

function hasRawTex(block: MathBlock): boolean {
  return (
    block.kind === "pending" &&
    block.element.querySelector(".katex") === null &&
    (block.element.textContent ?? "").trim().length > 0
  );
}

function mockReducedMotion() {
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
}

async function loadKatexFonts() {
  await render(<ChatMarkdown text={"$x$ $$y$$"} cwd={undefined} />).then((warmup) =>
    document.fonts.ready.then(() => warmup.unmount()),
  );
  await Promise.all(KATEX_FONTS.map((font) => document.fonts.load(`16px ${font}`)));
}

function Harness(props: { text: string; isStreaming: boolean }) {
  return (
    <div data-testid="harness" style={{ width: 640 }}>
      <ChatMarkdown text={props.text} cwd={undefined} isStreaming={props.isStreaming} />
      <div data-testid="sentinel">Working…</div>
    </div>
  );
}

describe("ChatMarkdown display math streaming", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("swaps an open display equation to KaTeX without moving following content", async () => {
    await loadKatexFonts();
    const screen = await render(<Harness text="" isStreaming />);
    const harness = document.querySelector('[data-testid="harness"]')!;
    const sentinel = document.querySelector('[data-testid="sentinel"]')!;
    const samples: FrameSample[] = [];
    const rawTexSeen: string[] = [];
    let pendingMounts = 0;
    const seenPending = new WeakSet<Element>();
    let frame = 0;
    let sampling = true;
    const sample = () => {
      frame += 1;
      const blocks = mathBlocks(harness);
      for (const block of blocks) {
        if (block.kind !== "pending") continue;
        if (!seenPending.has(block.element)) {
          seenPending.add(block.element);
          pendingMounts += 1;
        }
        if (hasRawTex(block)) rawTexSeen.push(block.element.textContent ?? "");
      }
      const last = blocks.at(-1) ?? null;
      samples.push({
        frame,
        pendingCount: blocks.filter((block) => block.kind === "pending").length,
        displayCount: blocks.filter((block) => block.kind === "katex").length,
        sentinelTop: sentinel.getBoundingClientRect().top,
        lastMathHeight: last ? last.measured.getBoundingClientRect().height : null,
        lastMathKind: last?.kind ?? null,
      });
      if (sampling) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);

    let text = "";
    for (const segment of SEGMENTS_PAUSING_AFTER_EACH_CLOSE) {
      for (let index = 0; index < segment.length; index += STEP_CHARS) {
        text += segment.slice(index, index + STEP_CHARS);
        await screen.rerender(<Harness text={text} isStreaming />);
        await wait(STEP_INTERVAL_MS);
      }
      await wait(SETTLE_AFTER_CLOSE_MS);
    }
    await screen.rerender(<Harness text={text} isStreaming={false} />);
    await wait(SETTLE_AFTER_CLOSE_MS);
    await nextFrame();
    sampling = false;

    const pendingToKatexSwaps = samples.flatMap((current, index) => {
      const previous = samples[index - 1];
      if (!previous) return [];
      if (current.displayCount <= previous.displayCount) return [];
      if (previous.pendingCount === 0) return [];
      return [
        {
          frame: current.frame,
          sentinelShiftPx: current.sentinelTop - previous.sentinelTop,
          heightBefore: previous.lastMathHeight,
          heightAfter: current.lastMathHeight,
        },
      ];
    });
    const maxSwapShiftPx = Math.max(
      0,
      ...pendingToKatexSwaps.map((swap) => Math.abs(swap.sentinelShiftPx)),
    );
    const openEquationHeightDeltas = samples.flatMap((current, index) => {
      const previous = samples[index - 1];
      const bothOpen = previous?.lastMathKind === "pending" && current.lastMathKind === "pending";
      if (!bothOpen || previous.pendingCount !== current.pendingCount) return [];
      return [(current.lastMathHeight ?? 0) - (previous.lastMathHeight ?? 0)];
    });
    const maxOpenEquationGrowthPx = Math.max(0, ...openEquationHeightDeltas);
    const maxOpenEquationShrinkPx = Math.max(0, ...openEquationHeightDeltas.map((delta) => -delta));
    console.info(
      `[display-math] ${JSON.stringify({
        pendingMounts,
        rawTexFrames: rawTexSeen.length,
        swaps: pendingToKatexSwaps,
        maxSwapShiftPx,
        maxOpenEquationGrowthPx,
        maxOpenEquationShrinkPx,
      })}`,
    );

    expect(mathBlocks(harness).map((block) => block.kind)).toEqual(["katex", "katex"]);
    expect(pendingToKatexSwaps).toHaveLength(2);
    expect(maxSwapShiftPx).toBeLessThanOrEqual(MAX_SWAP_SHIFT_PX);
    expect(maxOpenEquationShrinkPx).toBeLessThanOrEqual(MAX_SWAP_SHIFT_PX);
    expect(rawTexSeen).toEqual([]);
  });

  it("renders a display equation closed within one update as KaTeX with no pending phase", async () => {
    mockReducedMotion();
    await loadKatexFonts();
    const screen = await render(<Harness text="Before." isStreaming />);
    const harness = document.querySelector('[data-testid="harness"]')!;
    const frameKinds: string[][] = [];
    let sampling = true;
    const sample = () => {
      frameKinds.push(mathBlocks(harness).map((block) => block.kind));
      if (sampling) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    await screen.rerender(<Harness text={`Before.\n\n${SINGLE_LINE_EQUATION}`} isStreaming />);
    await expect.poll(() => mathBlocks(harness).map((block) => block.kind)).toEqual(["katex"]);
    await nextFrame();
    sampling = false;

    expect(frameKinds.flat()).not.toContain("pending");
  });

  it("never shows raw TeX while a display equation streams in one update", async () => {
    await loadKatexFonts();
    const screen = await render(<Harness text="Before." isStreaming />);
    const harness = document.querySelector('[data-testid="harness"]')!;
    const rawTexFrames: string[] = [];
    let sampling = true;
    const sample = () => {
      for (const block of mathBlocks(harness)) {
        if (hasRawTex(block)) rawTexFrames.push(block.element.textContent ?? "");
      }
      if (sampling) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    await screen.rerender(<Harness text={`Before.\n\n${ALIGNED_EQUATION}`} isStreaming />);
    await expect
      .poll(() => mathBlocks(harness).map((block) => block.kind), { timeout: 3_000 })
      .toEqual(["katex"]);
    await nextFrame();
    sampling = false;

    expect(rawTexFrames).toEqual([]);
  });
});
