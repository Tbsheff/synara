import { afterEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import { render } from "vitest-browser-react";

import { visibleTextNodes } from "../hooks/useStreamingTextReveal";
import { LONG_STREAMING_MESSAGE } from "../test/markdownStreamingCorpus";
import ChatMarkdown from "./ChatMarkdown";

const EVIDENCE_DIRECTORY = "node_modules/.cache/smooth-blocks";
const PHASE = import.meta.env.VITE_SMOOTH_BLOCKS_PHASE ?? "after";

const CODE_LINES = Array.from(
  { length: 40 },
  (_, index) => `  const value${index} = compute(${index}, "item-${index}");`,
);

const ANSWER = [
  "## Resume latency",
  "The reader requests a fresh snapshot on the first reconnect tick. The extra round trip costs about 12 ms on a local socket, which is inside the budget we agreed on for the transport.",
  "The latency model is roughly linear in the backlog:",
  "$$\nT_{resume} = T_{connect} + \\frac{B}{r_{drain}} + \\sum_{i=1}^{n} w_i\n$$",
  "where B is the buffered event count and r is the drain rate. The full computation is below.",
  `\`\`\`ts\nexport function computeAll() {\n${CODE_LINES.join("\n")}\n}\n\`\`\``,
  "That is the whole change. The tests cover the close and error paths, and the browser harness covers the transcript resume after a restart.",
].join("\n\n");

interface ArrivalPlan {
  readonly name: string;
  readonly chunks: readonly { readonly atMs: number; readonly chars: number }[];
}

function steadyPlan(name: string, charsPerSecond: number, intervalMs: number, firstChunk = 0) {
  const chunks: { atMs: number; chars: number }[] = [];
  let sent = 0;
  let atMs = 0;
  if (firstChunk > 0) {
    chunks.push({ atMs, chars: firstChunk });
    sent = firstChunk;
  }
  while (sent < ANSWER.length) {
    atMs += intervalMs;
    const chars = Math.max(1, Math.round((charsPerSecond * intervalMs) / 1000));
    chunks.push({ atMs, chars });
    sent += chars;
  }
  return { name, chunks };
}

const PLANS: readonly ArrivalPlan[] = [
  steadyPlan("codex", 150, 65),
  steadyPlan("claude", 600, 100, 243),
];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function visibleText(root: Element): string {
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(".katex") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) text += node.nodeValue ?? "";
  return text;
}

function hiddenRevealChars(): number {
  let count = 0;
  for (const [name, highlight] of CSS.highlights) {
    if (!name.startsWith("chat-stream-reveal") || !name.endsWith("--1")) continue;
    for (const range of highlight) count += range.toString().length;
  }
  return count;
}

function revealRangeCount(): number {
  let count = 0;
  for (const [name, highlight] of CSS.highlights) {
    if (name.startsWith("chat-stream-reveal")) count += highlight.size;
  }
  return count;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

function round(value: number): number {
  return Number(value.toFixed(1));
}

async function measurePlan(plan: ArrivalPlan) {
  const screen = await render(<ChatMarkdown text="" cwd={undefined} isStreaming />);
  const root = document.querySelector(".chat-markdown")!;
  let preRemovals = 0;
  const preRemovalTimes: number[] = [];
  const removedSnippets: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (
          node instanceof Element &&
          (node.matches("pre.shiki") || node.querySelector("pre.shiki"))
        ) {
          preRemovals += 1;
          preRemovalTimes.push(performance.now());
          removedSnippets.push(
            `${(record.target as Element).className}|${node.outerHTML.slice(0, 160)}`,
          );
        }
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });

  const frames: {
    at: number;
    chars: number;
    height: number;
    codeHeight: number;
    bareDollar: boolean;
    revealRanges: number;
    hiddenChars: number;
  }[] = [];
  let sampling = true;
  const sample = (at: number) => {
    const text = visibleText(root);
    const code = root.querySelector(".chat-markdown-codeblock");
    frames.push({
      at,
      chars: text.length,
      height: root.getBoundingClientRect().height,
      codeHeight: code?.getBoundingClientRect().height ?? 0,
      bareDollar: text.includes("$"),
      revealRanges: revealRangeCount(),
      hiddenChars: hiddenRevealChars(),
    });
    if (sampling) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);

  const startedAt = performance.now();
  let sent = 0;
  for (const chunk of plan.chunks) {
    const delay = startedAt + chunk.atMs - performance.now();
    if (delay > 0) await wait(delay);
    sent = Math.min(ANSWER.length, sent + chunk.chars);
    await screen.rerender(
      <ChatMarkdown text={ANSWER.slice(0, sent)} cwd={undefined} isStreaming />,
    );
  }
  const streamEndedAt = performance.now();
  await screen.rerender(<ChatMarkdown text={ANSWER} cwd={undefined} isStreaming={false} />);
  await wait(1_000);
  const revealRangesAfterSettle = revealRangeCount();
  sampling = false;
  observer.disconnect();
  await screen.unmount();

  const streamFrames = frames.filter((frame) => frame.at <= streamEndedAt + 300);
  const deltas = streamFrames.slice(1).map((frame, index) => ({
    at: frame.at,
    chars: frame.chars - streamFrames[index]!.chars,
    height: frame.height - streamFrames[index]!.height,
    codeHeight: frame.codeHeight - streamFrames[index]!.codeHeight,
  }));
  const growing = deltas.filter((delta) => delta.chars !== 0);
  const updateIntervals = growing.slice(1).map((delta, index) => delta.at - growing[index]!.at);
  const firstWindow = deltas.filter((delta) => delta.at - startedAt <= 1_500 && delta.chars > 0);
  let longestStallMs = 0;
  let longestStallEndChars = 0;
  let lastChangeAt = streamFrames[0]?.at ?? startedAt;
  for (const delta of deltas) {
    if (delta.chars !== 0) {
      if (delta.at - lastChangeAt > longestStallMs) {
        longestStallMs = delta.at - lastChangeAt;
        longestStallEndChars = streamFrames.find((frame) => frame.at === delta.at)?.chars ?? 0;
      }
      lastChangeAt = delta.at;
    }
  }
  return {
    plan: plan.name,
    frames: deltas.length,
    framesWithTextChangePct: round((growing.length / Math.max(1, deltas.length)) * 100),
    updateIntervalMs: {
      p50: round(percentile(updateIntervals, 0.5)),
      p90: round(percentile(updateIntervals, 0.9)),
    },
    charsPerUpdate: {
      p50: percentile(
        growing.map((delta) => delta.chars),
        0.5,
      ),
      p90: percentile(
        growing.map((delta) => delta.chars),
        0.9,
      ),
      max: Math.max(0, ...growing.map((delta) => delta.chars)),
    },
    firstWindowCharsPerUpdate: {
      p50: percentile(
        firstWindow.map((delta) => delta.chars),
        0.5,
      ),
      p90: percentile(
        firstWindow.map((delta) => delta.chars),
        0.9,
      ),
      max: Math.max(0, ...firstWindow.map((delta) => delta.chars)),
    },
    heightGrowthPx: {
      p50: round(
        percentile(
          deltas.map((delta) => delta.height),
          0.5,
        ),
      ),
      p99: round(
        percentile(
          deltas.map((delta) => delta.height),
          0.99,
        ),
      ),
      max: round(Math.max(0, ...deltas.map((delta) => delta.height))),
    },
    codeGrowthMaxPx: round(Math.max(0, ...deltas.map((delta) => delta.codeHeight))),
    longestTextStallMs: round(longestStallMs),
    longestStallContext: ANSWER.slice(
      Math.max(0, longestStallEndChars - 40),
      longestStallEndChars + 10,
    ),
    bareDollarFrames: streamFrames.filter((frame) => frame.bareDollar).length,
    framesWithFadePct: round(
      (streamFrames.filter((frame) => frame.revealRanges > 0).length /
        Math.max(1, streamFrames.length)) *
        100,
    ),
    maxRevealRanges: Math.max(0, ...streamFrames.map((frame) => frame.revealRanges)),
    hiddenRevealChars: {
      p50: percentile(
        streamFrames.map((frame) => frame.hiddenChars),
        0.5,
      ),
      p95: percentile(
        streamFrames.map((frame) => frame.hiddenChars),
        0.95,
      ),
      max: Math.max(0, ...streamFrames.map((frame) => frame.hiddenChars)),
    },
    revealRangesAfterSettle,
    preRemovals,
    removedSnippets,
    preRemovalsAfterStreamEndMs: preRemovalTimes.map((at) => round(at - streamEndedAt)),
  };
}

describe("ChatMarkdown live cadence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reveals steadily through math and code for Codex- and Claude-like arrival", async () => {
    const results = [];
    for (const plan of PLANS) results.push(await measurePlan(plan));
    await commands.writeFile(
      `${EVIDENCE_DIRECTORY}/${PHASE}-live-cadence.json`,
      JSON.stringify(results, null, 2),
    );
    for (const result of results) {
      expect(result.bareDollarFrames).toBe(0);
      expect(result.preRemovals).toBe(0);
      expect(result.revealRangesAfterSettle).toBe(0);
    }
  });

  it("keeps per-commit reveal tracking cheap on a long message", async () => {
    const longMessage = Array.from({ length: 10 }, () => LONG_STREAMING_MESSAGE).join("\n\n");
    const screen = await render(<ChatMarkdown text={longMessage} cwd={undefined} />);
    const root = document.querySelector<HTMLElement>(".chat-markdown")!;
    const samples: number[] = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const startedAt = performance.now();
      const nodes = visibleTextNodes(root);
      nodes.map((node) => node.data).join("");
      samples.push(performance.now() - startedAt);
    }
    const result = {
      messageChars: longMessage.length,
      textNodes: visibleTextNodes(root).length,
      commitTrackingMs: { p50: round(percentile(samples, 0.5)), max: round(Math.max(...samples)) },
    };
    await commands.writeFile(
      `${EVIDENCE_DIRECTORY}/${PHASE}-reveal-tracking-cost.json`,
      JSON.stringify(result, null, 2),
    );
    await screen.unmount();
    expect(result.commitTrackingMs.p50).toBeLessThan(8);
  });
});
