import { Profiler, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import { render } from "vitest-browser-react";

import { extractAbsoluteFilesystemPaths } from "../markdown-links";
import { LONG_STREAMING_MESSAGE_BLOCKS } from "../test/markdownStreamingCorpus";
import ChatMarkdown from "./ChatMarkdown";

const splitMode = vi.hoisted(() => ({ singlePass: false }));

vi.mock("../lib/markdownBlocks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/markdownBlocks")>();
  return {
    ...actual,
    splitMarkdownBlocks: (markdown: string) =>
      splitMode.singlePass
        ? [{ start: 0, end: markdown.length, line: 0 }]
        : actual.splitMarkdownBlocks(markdown),
  };
});

const renderCounters = vi.hoisted(() => ({
  textOffsets: [] as number[],
  codeBodies: [] as string[],
}));

vi.mock("../lib/codeFence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/codeFence")>();
  return {
    ...actual,
    dedentCode: (code: string) => {
      renderCounters.codeBodies.push(code);
      return actual.dedentCode(code);
    },
  };
});

vi.mock("./ChatMarkdownFind", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ChatMarkdownFind")>();
  return {
    ...actual,
    FindAwareMarkdownText: (props: { text: string; sourceOffset: number }) => {
      renderCounters.textOffsets.push(props.sourceOffset);
      return actual.FindAwareMarkdownText(props);
    },
  };
});

const EVIDENCE_DIRECTORY = "node_modules/.cache/smooth-blocks";
const PHASE = import.meta.env.VITE_SMOOTH_BLOCKS_PHASE ?? "after";
const REPEATS = 3;
const STREAM_STEP_CHARS = 40;
const NETWORK_FLUSH_CHARS = 120;
const NETWORK_FLUSH_INTERVAL_MS = 100;
const LAYOUT_EPSILON_PX = 0.5;
const KATEX_FONTS = ["KaTeX_Main", "KaTeX_Math", "KaTeX_Size1", "KaTeX_Size2"] as const;

const BLOCKS = Array.from({ length: REPEATS }, (_, repeat) =>
  LONG_STREAMING_MESSAGE_BLOCKS.map((block) =>
    block
      .replaceAll("4000", `400${repeat}`)
      .replaceAll("3779", `377${repeat}`)
      .replaceAll("resetCursorOnClose", `resetCursorOnClose${repeat}`),
  ),
).flat();
const MESSAGE = BLOCKS.join("\n\n");
const BLOCK_STARTS = BLOCKS.reduce<number[]>((starts, block, index) => {
  starts.push(index === 0 ? 0 : starts[index - 1]! + BLOCKS[index - 1]!.length + 2);
  return starts;
}, []);

function openBlockIndexAt(length: number): number {
  let index = 0;
  while (index + 1 < BLOCK_STARTS.length && BLOCK_STARTS[index + 1]! < length) index += 1;
  return index;
}

function codeBodyBlockIndex(body: string, openBlockIndex: number): number {
  const trimmedBody = body.trimEnd();
  return BLOCKS.slice(0, openBlockIndex + 1).findLastIndex((block) => block.includes(trimmedBody));
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function writeEvidence(name: string, value: unknown) {
  await commands.writeFile(
    `${EVIDENCE_DIRECTORY}/${PHASE}-${name}.json`,
    JSON.stringify(value, null, 2),
  );
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

function summarize(values: readonly number[]) {
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    mean: Number((total / Math.max(1, values.length)).toFixed(3)),
    p50: Number(percentile(values, 0.5).toFixed(3)),
    p95: Number(percentile(values, 0.95).toFixed(3)),
    max: Number(Math.max(0, ...values).toFixed(3)),
  };
}

function freshRoot(): HTMLElement {
  return document.querySelectorAll<HTMLElement>(".chat-markdown")[1]!;
}

function markdownRoot(): HTMLElement {
  return document.querySelector<HTMLElement>(".chat-markdown")!;
}

function settledElements(): HTMLElement[] {
  const root = document.querySelector<HTMLElement>(".chat-markdown");
  if (!root) return [];
  const children = Array.from(root.children) as HTMLElement[];
  return children.slice(0, -1);
}

const TRACKED_STYLE_PROPERTIES = [
  "font-size",
  "line-height",
  "font-family",
  "font-weight",
  "margin-top",
  "margin-bottom",
  "padding-top",
  "padding-bottom",
] as const;

function snapshotLayout() {
  return Array.from(markdownRoot().querySelectorAll<HTMLElement>("*")).map((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      tag: element.tagName,
      rect: [rect.top, rect.left, rect.width, rect.height].map((value) => Math.round(value * 10)),
      style: TRACKED_STYLE_PROPERTIES.map((property) => style.getPropertyValue(property)),
    };
  });
}

function withProfiler(element: ReactElement, durations: number[]) {
  return (
    <Profiler
      id="chat-markdown"
      onRender={(_id, _phase, actualDuration) => {
        durations.push(actualDuration);
      }}
    >
      {element}
    </Profiler>
  );
}

describe("ChatMarkdown block streaming", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-renders only the open block while a long message streams", async () => {
    mockReducedMotion();
    const singlePassDurations: number[] = [];
    const blockDurations: number[] = [];
    const singlePassRenderMs: number[] = [];
    const blockRenderMs: number[] = [];
    const settledRenderSteps: {
      knownPathsChanged: boolean;
      length: number;
      textOffsets: number[];
      codeRenders: number;
    }[] = [];
    let settledTextRenders = 0;
    let settledCodeRenders = 0;
    let length = STREAM_STEP_CHARS;
    const renderVariant = (durations: number[]) =>
      withProfiler(
        <ChatMarkdown text={MESSAGE.slice(0, length)} cwd={undefined} isStreaming />,
        durations,
      );
    splitMode.singlePass = true;
    const singlePassScreen = await render(renderVariant(singlePassDurations));
    splitMode.singlePass = false;
    const blockScreen = await render(renderVariant(blockDurations));
    await wait(300);

    while (length < MESSAGE.length) {
      length = Math.min(MESSAGE.length, length + STREAM_STEP_CHARS);
      const previousOpenBlockIndex = openBlockIndexAt(length - STREAM_STEP_CHARS);
      const settledBoundary = BLOCK_STARTS[Math.max(0, previousOpenBlockIndex - 1)]!;
      const knownPathsChanged =
        extractAbsoluteFilesystemPaths(MESSAGE.slice(0, length)).join("\n") !==
        extractAbsoluteFilesystemPaths(MESSAGE.slice(0, length - STREAM_STEP_CHARS)).join("\n");

      splitMode.singlePass = true;
      singlePassDurations.length = 0;
      await singlePassScreen.rerender(renderVariant(singlePassDurations));
      await nextFrame();
      await wait(0);
      singlePassRenderMs.push(singlePassDurations.reduce((sum, value) => sum + value, 0));

      splitMode.singlePass = false;
      blockDurations.length = 0;
      renderCounters.textOffsets.length = 0;
      renderCounters.codeBodies.length = 0;
      await blockScreen.rerender(renderVariant(blockDurations));
      await nextFrame();
      await wait(0);
      blockRenderMs.push(blockDurations.reduce((sum, value) => sum + value, 0));

      const textOffsets = renderCounters.textOffsets.filter((offset) => offset < settledBoundary);
      const codeRenders = renderCounters.codeBodies.filter((body) => {
        const blockIndex = codeBodyBlockIndex(body, openBlockIndexAt(length));
        return blockIndex >= 0 && blockIndex < previousOpenBlockIndex - 1;
      }).length;
      settledTextRenders += textOffsets.length;
      settledCodeRenders += codeRenders;
      if (textOffsets.length > 0 || codeRenders > 0) {
        settledRenderSteps.push({ knownPathsChanged, length, textOffsets, codeRenders });
      }
    }

    const result = {
      messageChars: MESSAGE.length,
      updates: blockRenderMs.length,
      singlePassRenderMs: summarize(singlePassRenderMs),
      blockRenderMs: summarize(blockRenderMs),
      singlePassLastQuarterRenderMs: summarize(
        singlePassRenderMs.slice(-Math.floor(singlePassRenderMs.length / 4)),
      ),
      blockLastQuarterRenderMs: summarize(
        blockRenderMs.slice(-Math.floor(blockRenderMs.length / 4)),
      ),
      settledTextRenders,
      settledCodeRenders,
      settledRenderSteps,
    };
    await writeEvidence("render-cost", result);
    await singlePassScreen.unmount();
    await blockScreen.unmount();

    expect(settledRenderSteps.filter((step) => !step.knownPathsChanged)).toEqual([]);
    expect(result.blockRenderMs.mean).toBeLessThan(result.singlePassRenderMs.mean);
  });

  it("keeps settled content still while text reveals smoothly", async () => {
    await render(<ChatMarkdown text={"$x$ $$y$$ **z**"} cwd={undefined} />).then((warmup) =>
      document.fonts.ready.then(() => warmup.unmount()),
    );
    await Promise.all(KATEX_FONTS.map((font) => document.fonts.load(`16px ${font}`)));
    const screen = await render(<ChatMarkdown text="" cwd={undefined} isStreaming />);
    const positions = new WeakMap<HTMLElement, number[]>();
    let frames = 0;
    let shiftedFrames = 0;
    let maxShiftPx = 0;
    const shiftDetails: unknown[] = [];
    let sampling = true;
    const sample = () => {
      frames += 1;
      let shifted = false;
      for (const element of settledElements()) {
        const rect = element.getBoundingClientRect();
        const current = [rect.top, rect.left, rect.width, rect.height];
        const previous = positions.get(element);
        if (previous) {
          const delta = Math.max(
            ...current.map((value, index) => Math.abs(value - previous[index]!)),
          );
          if (delta > LAYOUT_EPSILON_PX) {
            shifted = true;
            maxShiftPx = Math.max(maxShiftPx, delta);
            shiftDetails.push({
              element: `${element.tagName}.${element.className}`,
              text: (element.textContent ?? "").slice(0, 60),
              previous,
              current,
              following: (element.nextElementSibling?.textContent ?? "").slice(0, 60),
            });
          }
        }
        positions.set(element, current);
      }
      if (shifted) shiftedFrames += 1;
      if (sampling) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);

    for (let length = NETWORK_FLUSH_CHARS; ; length += NETWORK_FLUSH_CHARS) {
      const text = MESSAGE.slice(0, Math.min(length, MESSAGE.length));
      await screen.rerender(<ChatMarkdown text={text} cwd={undefined} isStreaming />);
      await wait(NETWORK_FLUSH_INTERVAL_MS);
      if (length >= MESSAGE.length) break;
    }
    await wait(800);
    await expect
      .poll(() => markdownRoot().textContent?.includes("browser harness covers the transcript"))
      .toBe(true);
    await wait(1_500);
    const streamingLayout = snapshotLayout();
    await screen.rerender(<ChatMarkdown text={MESSAGE} cwd={undefined} isStreaming={false} />);
    await wait(1_500);
    await nextFrame();
    sampling = false;
    const finalLayout = snapshotLayout();
    const layoutDiffs = finalLayout.flatMap((entry, index) => {
      const before = streamingLayout[index] ?? null;
      return JSON.stringify(before) === JSON.stringify(entry)
        ? []
        : [{ index, before, after: entry }];
    });

    const streamedHtml = markdownRoot().innerHTML;
    const freshScreen = await render(
      <ChatMarkdown text={MESSAGE} cwd={undefined} isStreaming={false} />,
    );
    let finalMatchesFreshMount = false;
    for (let attempt = 0; attempt < 50 && !finalMatchesFreshMount; attempt += 1) {
      await wait(100);
      finalMatchesFreshMount = freshRoot().innerHTML === markdownRoot().innerHTML;
    }
    const freshHtml = freshRoot().innerHTML;
    await freshScreen.unmount();
    let firstHtmlDifference = 0;
    while (
      firstHtmlDifference < streamedHtml.length &&
      streamedHtml[firstHtmlDifference] === freshHtml[firstHtmlDifference]
    ) {
      firstHtmlDifference += 1;
    }

    const result = {
      finalMatchesFreshMount,
      htmlDifference: finalMatchesFreshMount
        ? null
        : [
            streamedHtml.slice(firstHtmlDifference - 80, firstHtmlDifference + 120),
            freshHtml.slice(firstHtmlDifference - 80, firstHtmlDifference + 120),
          ],
      frames,
      shiftedFrames,
      shiftDetails: shiftDetails.slice(0, 5),
      maxShiftPx: Number(maxShiftPx.toFixed(2)),
      streamingElementCount: streamingLayout.length,
      finalElementCount: finalLayout.length,
      streamToFinalDiffs: layoutDiffs.length,
      firstDiffs: layoutDiffs.slice(0, 5),
    };
    await writeEvidence("layout", result);
    await screen.unmount();

    expect(result.shiftedFrames).toBe(0);
    expect(result.finalMatchesFreshMount).toBe(true);
    expect(result.streamToFinalDiffs).toBe(0);
  });

  it("mounts a finished long message", async () => {
    const durations: number[] = [];
    const mountMs: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      durations.length = 0;
      const screen = await render(
        withProfiler(
          <ChatMarkdown text={MESSAGE} cwd={undefined} isStreaming={false} />,
          durations,
        ),
      );
      mountMs.push(durations.reduce((sum, value) => sum + value, 0));
      await screen.unmount();
    }
    await writeEvidence("mount", { messageChars: MESSAGE.length, mountMs: summarize(mountMs) });
    expect(mountMs.length).toBe(5);
  });
});
