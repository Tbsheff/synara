import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, commands } from "vitest/browser";
import { render } from "vitest-browser-react";

import { MAX_SYNTAX_HIGHLIGHT_INPUT_CHARS } from "../lib/syntaxHighlightingLoader";
import ChatMarkdown from "./ChatMarkdown";

const metrics = vi.hoisted(() => ({
  inputChars: [] as number[],
  htmlChars: 0,
  cacheBytes: 0,
  fake: false,
}));

vi.mock("../lib/syntaxHighlighting", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/syntaxHighlighting")>();
  return {
    ...actual,
    highlightCodeToHtmlWithFallback: (
      ...args: Parameters<typeof actual.highlightCodeToHtmlWithFallback>
    ) => {
      metrics.inputChars.push(args[1].length);
      const html = metrics.fake
        ? `<pre class="shiki"><code>${args[1]
            .split("\n")
            .map((line) => `<span class="line">${line}</span>`)
            .join("\n")}</code></pre>`
        : actual.highlightCodeToHtmlWithFallback(...args);
      metrics.htmlChars = Math.max(metrics.htmlChars, html.length);
      return html;
    },
    cacheSyntaxHighlightedHtml: (...args: Parameters<typeof actual.cacheSyntaxHighlightedHtml>) => {
      metrics.cacheBytes += Math.max(args[1].length * 2, args[2].length * 3);
      return actual.cacheSyntaxHighlightedHtml(...args);
    },
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

function codeText() {
  return document.querySelector(".chat-markdown-codeblock pre")?.textContent;
}

describe("ChatMarkdown highlight size limit", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stops highlighting above the limit without replacing PRE or changing line geometry", async () => {
    reduceMotion();
    metrics.fake = true;
    metrics.inputChars = [];
    const code = "x".repeat(MAX_SYNTAX_HIGHLIGHT_INPUT_CHARS - 1);
    const screen = await render(
      <ChatMarkdown text={`\`\`\`text\n${code}`} cwd={undefined} isStreaming />,
    );
    await expect.poll(() => document.querySelector(".chat-markdown-shiki pre")).not.toBeNull();
    await expect.poll(() => codeText() === `${code}\n`).toBe(true);
    const pre = document.querySelector(".chat-markdown-codeblock pre")!;
    const height = pre.getBoundingClientRect().height;
    expect(metrics.inputChars).toContain(MAX_SYNTAX_HIGHLIGHT_INPUT_CHARS);
    await screen.rerender(
      <ChatMarkdown text={`\`\`\`text\n${code}y`} cwd={undefined} isStreaming />,
    );
    await expect.poll(() => codeText() === `${code}y\n`).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(metrics.inputChars.every((length) => length <= MAX_SYNTAX_HIGHLIGHT_INPUT_CHARS)).toBe(
      true,
    );
    expect(document.querySelector(".chat-markdown-codeblock pre") === pre).toBe(true);
    expect(pre.getBoundingClientRect().height).toBe(height);
    await screen.rerender(
      <ChatMarkdown text={`\`\`\`text\n${code}y\n\`\`\``} cwd={undefined} findQuery="xy" />,
    );
    await expect
      .poll(() => document.querySelector('[data-chat-find-match="true"]')?.textContent)
      .toBe("xy");
    await screen.unmount();
    metrics.fake = false;
  }, 30_000);

  it("measures a one MiB TypeScript stream", async () => {
    reduceMotion();
    metrics.fake = false;
    metrics.inputChars = [];
    metrics.htmlChars = 0;
    metrics.cacheBytes = 0;
    const screen = await render(
      <ChatMarkdown text="```typescript\nconst warmup = 1;" cwd={undefined} isStreaming />,
    );
    await expect.poll(() => document.querySelector(".chat-markdown-shiki pre")).not.toBeNull();
    const session = cdp() as {
      send(method: "HeapProfiler.collectGarbage"): Promise<void>;
      send(method: "Runtime.getHeapUsage"): Promise<{ usedSize: number }>;
    };
    await session.send("HeapProfiler.collectGarbage");
    const before = (await session.send("Runtime.getHeapUsage")).usedSize;
    const line = "const value: number = 42;\n";
    const source =
      line.repeat(Math.ceil((1024 * 1024) / line.length)).slice(0, 1024 * 1024 - 1) + "\n";
    let peakBytes = before;
    for (let length = 128 * 1024; length <= source.length; length += 128 * 1024) {
      const code = source.slice(0, length);
      await screen.rerender(
        <ChatMarkdown text={`\`\`\`typescript\n${code}`} cwd={undefined} isStreaming />,
      );
      await expect.poll(() => codeText()?.length).toBe(code.length + (code.endsWith("\n") ? 0 : 1));
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      peakBytes = Math.max(peakBytes, (await session.send("Runtime.getHeapUsage")).usedSize);
    }
    await screen.rerender(
      <ChatMarkdown text={`\`\`\`typescript\n${source}\`\`\``} cwd={undefined} />,
    );
    await expect.poll(() => codeText()?.length).toBe(source.length);
    await session.send("HeapProfiler.collectGarbage");
    const settledBytes = (await session.send("Runtime.getHeapUsage")).usedSize - before;
    const walker = document.createTreeWalker(
      document.querySelector(".chat-markdown-codeblock")!,
      NodeFilter.SHOW_ALL,
    );
    let domNodes = 0;
    while (walker.nextNode()) domNodes++;
    await commands.writeFile(
      `node_modules/.cache/markdown-perf/${import.meta.env.VITE_MARKDOWN_PERF_PHASE ?? "after"}-limit.json`,
      JSON.stringify({
        sourceChars: source.length,
        maxHighlightedChars: Math.max(...metrics.inputChars),
        htmlChars: metrics.htmlChars,
        cacheBytes: metrics.cacheBytes,
        sampledPeakBytes: peakBytes - before,
        settledBytes,
        domNodes,
      }),
    );
    await screen.unmount();
  }, 180_000);
});
