import { afterEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import { render } from "vitest-browser-react";

import ChatMarkdown from "./ChatMarkdown";

const EVIDENCE_DIRECTORY = "node_modules/.cache/smooth-verify";

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
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

function codeBlockText(): string {
  return document.querySelector(".chat-markdown-codeblock pre")?.textContent ?? "";
}

function markdownText(): string {
  return document.querySelector(".chat-markdown")?.textContent ?? "";
}

function plainTailLength(code: Element): number {
  const lines = Array.from(code.querySelectorAll(".line"));
  const highlightedLength = lines.reduce(
    (total, element) => total + (element.textContent?.length ?? 0),
    Math.max(0, lines.length - 1),
  );
  return (code.textContent?.length ?? 0) - highlightedLength;
}

async function writeEvidence(name: string, value: unknown) {
  if (import.meta.env.VITE_SMOOTH_VERIFY_EVIDENCE !== "1") return;
  await commands.writeFile(`${EVIDENCE_DIRECTORY}/${name}`, JSON.stringify(value, null, 2));
}

const CODE_LINES = Array.from(
  { length: 60 },
  (_, index) => `const value${index} = compute(${index}, "item-${index}");`,
);

const RAW_SYNTAX_MARKERS = ["](", "[", "$$", "*", "_", "`", "|"] as const;

const MIXED_FIXTURE_CHUNKS = [
  "Read the ",
  "[setup guide](https://exa",
  "mple.com/setup) first, then **bo",
  "ld text** and `inline co",
  "de` here.\n\n$$\nE = m",
  "c^2\n$$\n\n| Name | Age |",
  "\n| --- | --- |\n| Ada | 36 |\n\nSee [the ",
  "reference](https://example.com/ref",
  ") for _more det",
  "ails_.",
];

async function streamAndSample(chunks: readonly string[], chunkIntervalMs: number) {
  let text = "";
  const screen = await render(<ChatMarkdown text="" cwd={undefined} isStreaming />);
  const samples: Array<{ at: number; text: string }> = [];
  let sampling = true;
  const sample = (at: number) => {
    samples.push({ at, text: markdownText() });
    if (sampling) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);

  for (const chunk of chunks) {
    text += chunk;
    await screen.rerender(<ChatMarkdown text={text} cwd={undefined} isStreaming />);
    samples.push({ at: performance.now(), text: markdownText() });
    await new Promise((resolve) => setTimeout(resolve, chunkIntervalMs));
  }
  const streamEndedAt = performance.now();
  await screen.rerender(<ChatMarkdown text={text} cwd={undefined} isStreaming={false} />);
  await new Promise((resolve) => setTimeout(resolve, 400));
  sampling = false;
  await nextFrame();
  return { screen, samples, streamEndedAt, finalText: text };
}

function rawSyntaxFlashes(samples: ReadonlyArray<{ at: number; text: string }>) {
  return samples.flatMap((sample) =>
    RAW_SYNTAX_MARKERS.filter((marker) => sample.text.includes(marker)).map((marker) => ({
      at: sample.at,
      marker,
      text: sample.text,
    })),
  );
}

describe("ChatMarkdown smooth streaming", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the open code block's newest text within one frame of its arrival", async () => {
    mockReducedMotion();
    let text = "Here is the module:\n\n```ts\n";
    const screen = await render(<ChatMarkdown text={text} cwd={undefined} isStreaming />);

    text += `${CODE_LINES[0]}\n`;
    await screen.rerender(<ChatMarkdown text={text} cwd={undefined} isStreaming />);
    await expect
      .poll(() => document.querySelector(".chat-markdown-codeblock .chat-markdown-shiki"), {
        timeout: 10_000,
      })
      .not.toBeNull();

    const arrivals: Array<{
      line: number;
      framesUntilVisible: number;
      highlighted: boolean;
      plainTailChars: number;
    }> = [];
    for (let line = 1; line < CODE_LINES.length; line += 1) {
      text += `${CODE_LINES[line]}\n`;
      await screen.rerender(<ChatMarkdown text={text} cwd={undefined} isStreaming />);
      let framesUntilVisible = 0;
      while (!codeBlockText().includes(CODE_LINES[line]!) && framesUntilVisible < 30) {
        await nextFrame();
        framesUntilVisible += 1;
      }
      const shikiCode = document.querySelector(".chat-markdown-shiki code");
      arrivals.push({
        line,
        framesUntilVisible,
        highlighted: shikiCode !== null,
        plainTailChars: shikiCode === null ? 0 : plainTailLength(shikiCode),
      });
    }

    text += "```\n\nDone.";
    await screen.rerender(<ChatMarkdown text={text} cwd={undefined} isStreaming />);
    await expect.poll(() => codeBlockText()).toContain(CODE_LINES.at(-1)!);
    await expect
      .poll(
        () => document.querySelector(".chat-markdown-shiki code")?.querySelectorAll(".line").length,
      )
      .toBeGreaterThanOrEqual(CODE_LINES.length);

    await writeEvidence("code-block-arrival.json", {
      lines: arrivals.length,
      maxFramesUntilVisible: Math.max(...arrivals.map((arrival) => arrival.framesUntilVisible)),
      arrivalsWithPlainTail: arrivals.filter((arrival) => arrival.plainTailChars > 0).length,
      arrivals,
    });

    expect(arrivals.every((arrival) => arrival.highlighted)).toBe(true);
    expect(arrivals.every((arrival) => arrival.framesUntilVisible <= 1)).toBe(true);
    await screen.unmount();
  });

  it.each([
    ["reduced-motion", "reduced motion with chunk cuts inside each construct", true, false],
    ["smooth-reveal", "the smooth reveal cutting at any character", false, false],
    ["every-prefix", "every character prefix rendered in turn", true, true],
  ])("never flashes raw syntax: %s (%s)", async (evidenceName, _label, reduced, perCharacter) => {
    if (reduced) mockReducedMotion();
    const chunks = perCharacter ? [...MIXED_FIXTURE_CHUNKS.join("")] : MIXED_FIXTURE_CHUNKS;
    const run = await streamAndSample(chunks, perCharacter ? 0 : 60);

    const flashes = rawSyntaxFlashes(run.samples);
    const settled = await render(
      <ChatMarkdown text={run.finalText} cwd={undefined} isStreaming={false} />,
    );
    const settledText = settled.container.querySelector(".chat-markdown")?.textContent ?? "";
    const streamedFinalText = run.screen.container.querySelector(".chat-markdown")?.textContent;

    const lengths = run.samples.map((sample) => sample.text.length);
    const jumps = lengths.slice(1).map((length, index) => length - lengths[index]!);
    const streamJumps = jumps
      .filter((_, index) => run.samples[index + 1]!.at < run.streamEndedAt)
      .filter((jump) => jump > 0)
      .toSorted((left, right) => left - right);
    const endJumps = jumps.filter((_, index) => run.samples[index + 1]!.at >= run.streamEndedAt);
    await writeEvidence(`raw-syntax-frames-${evidenceName}.json`, {
      frames: run.samples.length,
      flashes,
      streamJumpP95: streamJumps[Math.floor(streamJumps.length * 0.95)] ?? 0,
      maxEndJump: Math.max(0, ...endJumps),
      settledMatchesStreamedFinal: settledText === streamedFinalText,
      samples: run.samples,
    });

    expect(flashes).toEqual([]);
    expect(streamedFinalText).toBe(settledText);
    expect(run.samples.length).toBeGreaterThan(10);
    await settled.unmount();
    await run.screen.unmount();
  });

  it("renders literal partial syntax unmodified once the message is final", async () => {
    const screen = await render(
      <ChatMarkdown text={"Use [label]( and **bold"} cwd={undefined} isStreaming={false} />,
    );
    expect(markdownText()).toContain("[label](");
    expect(markdownText()).toContain("**bold");
    await screen.unmount();
  });
});
