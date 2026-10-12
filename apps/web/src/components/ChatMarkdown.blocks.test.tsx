import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { splitMarkdownBlocks } from "../lib/markdownBlocks";
import { MARKDOWN_IDENTITY_CORPUS } from "../test/markdownStreamingCorpus";
import ChatMarkdown from "./ChatMarkdown";

const rendererMode = vi.hoisted(() => ({ splitIntoBlocks: true, repairsStreamingText: true }));

vi.mock("../lib/markdownBlocks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/markdownBlocks")>();
  return {
    ...actual,
    splitMarkdownBlocks: (markdown: string) =>
      rendererMode.splitIntoBlocks
        ? actual.splitMarkdownBlocks(markdown)
        : [{ start: 0, end: markdown.length, line: 0 }],
  };
});

vi.mock("../lib/markdownStreamingRepair", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/markdownStreamingRepair")>();
  return {
    ...actual,
    createStreamingMarkdownRepair: () => {
      const repair = actual.createStreamingMarkdownRepair();
      return (markdown: string) =>
        rendererMode.repairsStreamingText ? repair(markdown) : markdown;
    },
    repairStreamingMarkdown: (markdown: string) =>
      rendererMode.repairsStreamingText ? actual.repairStreamingMarkdown(markdown) : markdown,
  };
});

vi.mock("@pierre/diffs", () => ({
  getFiletypeFromFileName: (fileName: string) => (fileName.endsWith(".ts") ? "ts" : "text"),
  getSharedHighlighter: () =>
    Promise.resolve({
      codeToHtml(code: string) {
        return `<pre class="shiki"><code>${code}</code></pre>`;
      },
    }),
}));

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

type MarkdownRenderer = (text: string, isStreaming: boolean) => string;

const HEAVY_MODULE_TEST_TIMEOUT_MS = 60_000;
const STREAMING_PREFIX_STEP = 7;
const FUZZ_DOCUMENTS = Number(process.env.MARKDOWN_BLOCK_FUZZ_DOCUMENTS ?? 600);
const FUZZ_SEED = Number(process.env.MARKDOWN_BLOCK_FUZZ_SEED ?? 20_261_011);

function createRenderer(splitIntoBlocks: boolean, repairsStreamingText = true): MarkdownRenderer {
  return (text, isStreaming) => {
    rendererMode.splitIntoBlocks = splitIntoBlocks;
    rendererMode.repairsStreamingText = repairsStreamingText;
    try {
      return renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          <ChatMarkdown text={text} cwd="/repo" isStreaming={isStreaming} />
        </QueryClientProvider>,
      );
    } finally {
      rendererMode.splitIntoBlocks = true;
      rendererMode.repairsStreamingText = true;
    }
  };
}

const renderBlocks = createRenderer(true);
const renderSingle = createRenderer(false);
const renderBlocksUnrepaired = createRenderer(true, false);
const renderSingleUnrepaired = createRenderer(false, false);

const FUZZ_REGRESSION_LIST_AND_DISPLAY_MATH_DOCUMENT = [
  "<!-- c -->",
  "Inline $x^2$ math.",
  "  - nested",
  "--",
  "    indented code",
  "\t- tab bullet",
  "     five spaces",
  "  $$",
  "    indented code",
  "1.",
  "<span>x</span>",
  "  ",
  "  continued",
  "",
  "  $$",
  "10. ten",
].join("\n");

const FUZZ_LINES = [
  "",
  "",
  "",
  "Plain paragraph text.",
  "More text with `code` and **bold**.",
  "- bullet",
  "* star bullet",
  "-",
  "1. first",
  "2. second",
  "3) paren",
  "  - nested",
  "  continued",
  "   indented three",
  "    indented code",
  "\tTabbed",
  "```",
  "```ts",
  "  ```",
  "   ```",
  "~~~",
  "````",
  "$$",
  "$$x$$",
  "> quote",
  "> ```",
  ">",
  "# Heading",
  "---",
  "===",
  "***",
  "| a | b |",
  "| - | - |",
  "<div>",
  "</div>",
  "<!-- c -->",
  "<span>x</span>",
  "- ```",
  "1. ```",
  "- [ ] task",
  "> - quoted item",
  "Inline $x^2$ math.",
  "  1. nested ordered",
  "   - three-space bullet",
  "+ plus",
  "10. ten",
  "1.",
  "1)",
  "     five spaces",
  "- - -",
  "_ _ _",
  "~~~~",
  "  ~~~",
  "$$$",
  "  $$",
  "<pre>",
  "</pre>",
  "<script>",
  "<?php",
  "-->",
  "<!--",
  "  > nested quote",
  ">     quoted code",
  "-   wide bullet",
  "-      very wide bullet",
  "  ",
  "\t- tab bullet",
  "```js title",
  "`` `",
  "Setext text",
  "--",
  "- a\n  - b",
];

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function fuzzDocument(random: () => number): string {
  const lineCount = 4 + Math.floor(random() * 14);
  return Array.from(
    { length: lineCount },
    () => FUZZ_LINES[Math.floor(random() * FUZZ_LINES.length)]!,
  ).join("\n");
}

function fuzzMismatches(left: MarkdownRenderer, right: MarkdownRenderer): string[] {
  const random = seededRandom(FUZZ_SEED);
  const mismatches: string[] = [];
  for (let index = 0; index < FUZZ_DOCUMENTS; index += 1) {
    const text = fuzzDocument(random);
    if (left(text, true) !== right(text, true)) mismatches.push(text);
  }
  return mismatches;
}

describe("ChatMarkdown block rendering", () => {
  it("splits most corpus documents into several blocks", () => {
    const splitDocuments = MARKDOWN_IDENTITY_CORPUS.filter(
      ({ text }) => splitMarkdownBlocks(text).length > 1,
    );
    expect(splitDocuments.length).toBeGreaterThanOrEqual(MARKDOWN_IDENTITY_CORPUS.length - 4);
  });

  it.each(MARKDOWN_IDENTITY_CORPUS)("renders $name identically to one pass", ({ text }) => {
    expect(renderBlocks(text, true)).toBe(renderSingle(text, true));
  });

  it("keeps a message that never streamed on the one-pass renderer", () => {
    const { text } = MARKDOWN_IDENTITY_CORPUS[0]!;
    expect(renderBlocks(text, false)).toBe(renderSingle(text, false));
  });

  it.each(MARKDOWN_IDENTITY_CORPUS)(
    "renders every streaming prefix of $name identically to one pass",
    ({ text }) => {
      for (let length = 1; length <= text.length; length += STREAMING_PREFIX_STEP) {
        const prefix = text.slice(0, length);
        expect(renderBlocks(prefix, true), JSON.stringify(prefix)).toBe(renderSingle(prefix, true));
      }
    },
    HEAVY_MODULE_TEST_TIMEOUT_MS,
  );

  it(
    "renders fuzzed block structures identically to one pass",
    () => {
      expect(fuzzMismatches(renderBlocks, renderSingle)).toEqual([]);
    },
    HEAVY_MODULE_TEST_TIMEOUT_MS,
  );

  it(
    "renders fuzzed finished text identically to one pass after the stream ends",
    () => {
      expect(fuzzMismatches(renderBlocksUnrepaired, renderSingleUnrepaired)).toEqual([]);
    },
    HEAVY_MODULE_TEST_TIMEOUT_MS,
  );

  it("renders a finished list with display math identically to one pass", () => {
    const text = FUZZ_REGRESSION_LIST_AND_DISPLAY_MATH_DOCUMENT;
    expect(renderBlocksUnrepaired(text, true)).not.toContain("chat-markdown-pending-math");
    expect(renderBlocksUnrepaired(text, true)).toBe(renderSingleUnrepaired(text, true));
    expect(renderBlocks(text, true)).toBe(renderSingle(text, true));
  });

  it.each(MARKDOWN_IDENTITY_CORPUS)(
    "renders finished $name identically to one pass after the stream ends",
    ({ text }) => {
      expect(renderBlocksUnrepaired(text, true)).toBe(renderSingleUnrepaired(text, true));
    },
  );
});
