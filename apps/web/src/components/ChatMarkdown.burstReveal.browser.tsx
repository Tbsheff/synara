import { afterEach, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { render } from "vitest-browser-react";

import { MAX_REVEAL_CHARS_PER_COMMIT } from "../hooks/useSmoothStreamedText";
import ChatMarkdown from "./ChatMarkdown";

const EVIDENCE_DIRECTORY = "node_modules/.cache/burst-reveal";
const MAX_PX_PER_FRAME = 200;

const PREFIX =
  "I checked the reconnect path and the projection cursor. Here is what changed and why it matters for the resume budget.\n\n";

function buildBurst(targetLength: number): string {
  const table = [
    "| Step | Before | After |",
    "| --- | --- | --- |",
    "| Connect | 40 ms | 38 ms |",
    "| Snapshot | 210 ms | 12 ms |",
    "| Replay | 95 ms | 90 ms |",
    "| Settle | 30 ms | 28 ms |",
  ].join("\n");
  const code = [
    "```ts",
    "export function resumeCursor(state: CursorState, event: ResumeEvent) {",
    "  if (event.sequence <= state.lastSequence) return state;",
    "  const next = { ...state, lastSequence: event.sequence };",
    "  next.pending = state.pending.filter((item) => item.sequence > event.sequence);",
    "  return next;",
    "}",
    "```",
  ].join("\n");
  let burst = `The snapshot step now reuses the cached projection, so the table below shows the main gain.\n\n${table}\n\nThe cursor logic is small:\n\n${code}\n\n`;
  const filler =
    "The replay step did not move much because it is bound by the event count and not by the socket. ";
  while (burst.length < targetLength) burst += filler;
  return burst.slice(0, targetLength);
}

function buildFreshAnswer(targetLength: number): string {
  const sentence =
    "The tool run finished and the result is ready, so here is the summary of the three changes I made. ";
  let text = "";
  while (text.length < targetLength) text += sentence;
  return text.slice(0, targetLength);
}

interface FrameSample {
  readonly at: number;
  readonly chars: number;
  readonly height: number;
}

function markdownRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".chat-markdown");
}

function sampleFrame(): FrameSample {
  const root = markdownRoot();
  return {
    at: performance.now(),
    chars: root?.textContent?.length ?? 0,
    height: root?.getBoundingClientRect().height ?? 0,
  };
}

function startFrameRecorder() {
  const samples: FrameSample[] = [sampleFrame()];
  let running = true;
  const tick = () => {
    if (!running) return;
    samples.push(sampleFrame());
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return {
    samples,
    stop: () => {
      running = false;
    },
  };
}

function summarize(samples: readonly FrameSample[]) {
  let maxCharsPerFrame = 0;
  let maxPxPerFrame = 0;
  let growthFrames = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const chars = samples[index]!.chars - samples[index - 1]!.chars;
    const px = samples[index]!.height - samples[index - 1]!.height;
    if (chars > 0) growthFrames += 1;
    maxCharsPerFrame = Math.max(maxCharsPerFrame, chars);
    maxPxPerFrame = Math.max(maxPxPerFrame, px);
  }
  return { frames: samples.length, growthFrames, maxCharsPerFrame, maxPxPerFrame };
}

async function writeEvidence(name: string, value: unknown) {
  if (import.meta.env.VITE_BURST_REVEAL_EVIDENCE !== "1") return;
  await commands.writeFile(`${EVIDENCE_DIRECTORY}/${name}`, JSON.stringify(value, null, 2));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

let keySequence = 0;
function uniqueKey(label: string): string {
  keySequence += 1;
  return `burst-reveal-${label}-${Date.now()}-${keySequence}`;
}

describe("ChatMarkdown burst reveal", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("spreads a +1172-char mid-message burst with a table and a code block over frames", async () => {
    const revealKey = uniqueKey("mid");
    const screen = await render(
      <div style={{ width: 640 }}>
        <ChatMarkdown text={PREFIX} cwd={undefined} isStreaming revealKey={revealKey} />
      </div>,
    );
    await expect.poll(() => markdownRoot()?.textContent?.length ?? 0).toBeGreaterThan(50);
    await wait(400);

    const burst = buildBurst(1172);
    expect(burst.length).toBe(1172);
    const recorder = startFrameRecorder();
    await screen.rerender(
      <div style={{ width: 640 }}>
        <ChatMarkdown text={PREFIX + burst} cwd={undefined} isStreaming revealKey={revealKey} />
      </div>,
    );
    await wait(1500);
    recorder.stop();
    await nextFrame();

    const summary = summarize(recorder.samples);
    await writeEvidence("mid-message-burst.json", { summary, samples: recorder.samples });
    console.info("[burst-reveal] mid-message +1172", JSON.stringify(summary));

    expect(markdownRoot()?.textContent).toContain("bound by the event count");
    expect(summary.maxCharsPerFrame).toBeLessThanOrEqual(MAX_REVEAL_CHARS_PER_COMMIT);
    expect(summary.maxPxPerFrame).toBeLessThanOrEqual(MAX_PX_PER_FRAME);
    expect(summary.growthFrames).toBeGreaterThanOrEqual(8);
    await screen.unmount();
  });

  it("reveals a fresh streaming message whose first update is ~785 chars over several frames", async () => {
    const revealKey = uniqueKey("fresh");
    const answer = buildFreshAnswer(785);
    const recorder = startFrameRecorder();
    const screen = await render(
      <div style={{ width: 640 }}>
        <ChatMarkdown text={answer} cwd={undefined} isStreaming revealKey={revealKey} />
      </div>,
    );
    await wait(1500);
    recorder.stop();
    await nextFrame();

    const summary = summarize(recorder.samples);
    await writeEvidence("fresh-first-chunk.json", { summary, samples: recorder.samples });
    console.info("[burst-reveal] fresh +785", JSON.stringify(summary));

    expect(markdownRoot()?.textContent?.length).toBe(answer.length);
    expect(summary.maxCharsPerFrame).toBeLessThanOrEqual(MAX_REVEAL_CHARS_PER_COMMIT);
    expect(summary.maxPxPerFrame).toBeLessThanOrEqual(MAX_PX_PER_FRAME);
    expect(summary.growthFrames).toBeGreaterThanOrEqual(5);
    await screen.unmount();
  });

  it("does not replay already-revealed text when a streaming message remounts with the same key", async () => {
    const revealKey = uniqueKey("remount");
    const answer = buildFreshAnswer(785);
    const first = await render(
      <ChatMarkdown text={answer} cwd={undefined} isStreaming revealKey={revealKey} />,
    );
    await expect
      .poll(() => markdownRoot()?.textContent?.length ?? 0, { timeout: 5_000 })
      .toBe(answer.length);
    await first.unmount();

    const second = await render(
      <ChatMarkdown text={answer} cwd={undefined} isStreaming revealKey={revealKey} />,
    );
    expect(markdownRoot()?.textContent?.length).toBe(answer.length);
    await nextFrame();
    expect(markdownRoot()?.textContent?.length).toBe(answer.length);
    await second.unmount();
  });

  it("shows mount text at once for a streaming message without a reveal key", async () => {
    const answer = buildFreshAnswer(785);
    const screen = await render(<ChatMarkdown text={answer} cwd={undefined} isStreaming />);
    expect(markdownRoot()?.textContent?.length).toBe(answer.length);
    await screen.unmount();
  });
});
