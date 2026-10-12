import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, commands } from "vitest/browser";
import { render } from "vitest-browser-react";

import ChatMarkdown from "./ChatMarkdown";

interface HeapSession {
  send(method: "HeapProfiler.collectGarbage"): Promise<void>;
  send(method: "HeapProfiler.takeHeapSnapshot", params: { reportProgress: boolean }): Promise<void>;
  send(method: "Runtime.getHeapUsage"): Promise<{ usedSize: number }>;
  on(
    event: "HeapProfiler.addHeapSnapshotChunk",
    listener: (event: { chunk: string }) => void,
  ): void;
  off(
    event: "HeapProfiler.addHeapSnapshotChunk",
    listener: (event: { chunk: string }) => void,
  ): void;
}

const phase = import.meta.env.VITE_MARKDOWN_PERF_PHASE ?? "after";

vi.mock("../lib/markdownBlocks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/markdownBlocks")>();
  return {
    ...actual,
    createMarkdownBlockTextCache: () =>
      import.meta.env.VITE_MARKDOWN_PERF_PHASE === "before"
        ? (
            markdown: string,
            source: string,
            blocks: ReturnType<typeof actual.splitMarkdownBlocks>,
          ) =>
            blocks.map((block, index) => ({
              ...block,
              text: markdown.slice(block.start, block.end),
              sourceText: source.slice(
                block.start,
                index === blocks.length - 1 ? undefined : block.end,
              ),
            }))
        : actual.createMarkdownBlockTextCache(),
  };
});

function reduceMotion() {
  const original = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query) =>
    query === "(prefers-reduced-motion: reduce)"
      ? ({
          matches: true,
          addEventListener() {},
          removeEventListener() {},
        } as unknown as MediaQueryList)
      : original(query),
  );
}

async function heapBytes() {
  const session = cdp() as HeapSession;
  await session.send("HeapProfiler.collectGarbage");
  return (await session.send("Runtime.getHeapUsage")).usedSize;
}

describe("ChatMarkdown performance measurements", () => {
  afterEach(() => vi.restoreAllMocks());

  it("releases parent messages from 100 sealed block contexts", async () => {
    reduceMotion();
    const screen = await render(<ChatMarkdown text="warmup" cwd={undefined} isStreaming />);
    const before = await heapBytes();
    for (let index = 0; index < 100; index++) {
      const text =
        Array.from(
          { length: index + 1 },
          (_, n) => String(n).padStart(5, "0") + "x".repeat(10478) + "\n\n",
        ).join("") + "tail";
      await screen.rerender(<ChatMarkdown text={text} cwd={undefined} isStreaming />);
      await expect.poll(() => document.querySelectorAll(".chat-markdown p").length).toBe(index + 2);
    }
    const retainedBytes = (await heapBytes()) - before;
    const chunks: string[] = [];
    const session = cdp() as HeapSession;
    const collect = (event: { chunk: string }) => chunks.push(event.chunk);
    session.on("HeapProfiler.addHeapSnapshotChunk", collect);
    await session.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
    session.off("HeapProfiler.addHeapSnapshotChunk", collect);
    for (let index = 0; index < chunks.length; index += 16) {
      await commands.writeFile(
        `node_modules/.cache/markdown-perf/${phase}-blocks-${index / 16}.heap-part`,
        chunks.slice(index, index + 16).join(""),
      );
    }
    await commands.writeFile(
      `node_modules/.cache/markdown-perf/${phase}-blocks.json`,
      JSON.stringify({ retainedBytes, blocks: 100, messageChars: 1_048_504 }),
    );
    await screen.unmount();
    if (phase !== "before") expect(retainedBytes).toBeLessThan(15 * 1024 * 1024);
  }, 180_000);
});
