import { describe, expect, it } from "vitest";

import {
  LONG_STREAMING_MESSAGE,
  LONG_STREAMING_MESSAGE_BLOCKS,
} from "../test/markdownStreamingCorpus";
import { remarkMarkdownBlockOrigin, splitMarkdownBlocks } from "./markdownBlocks";

function blockTexts(markdown: string): string[] {
  return splitMarkdownBlocks(markdown).map((block) => markdown.slice(block.start, block.end));
}

describe("splitMarkdownBlocks", () => {
  it("covers the whole text with contiguous blocks and correct line origins", () => {
    const blocks = splitMarkdownBlocks(LONG_STREAMING_MESSAGE);
    expect(blocks[0]!.start).toBe(0);
    expect(blocks.at(-1)!.end).toBe(LONG_STREAMING_MESSAGE.length);
    for (const [index, block] of blocks.entries()) {
      if (index > 0) expect(block.start).toBe(blocks[index - 1]!.end);
      expect(block.line).toBe(LONG_STREAMING_MESSAGE.slice(0, block.start).split("\n").length - 1);
    }
  });

  it("splits a realistic answer at every top-level block boundary", () => {
    expect(
      blockTexts(LONG_STREAMING_MESSAGE).map((text) => text.replace(/^\n+|\n+$/g, "")),
    ).toEqual(LONG_STREAMING_MESSAGE_BLOCKS);
  });

  it("keeps fenced code and display math with blank lines in one block", () => {
    expect(blockTexts("```md\n# a\n\nb\n```\n\nafter")).toEqual([
      "```md\n# a\n\nb\n```\n",
      "\nafter",
    ]);
    expect(blockTexts("$$\na\n\nb\n$$\n\nafter")).toEqual(["$$\na\n\nb\n$$\n", "\nafter"]);
    expect(blockTexts("````\n```\n\nx\n````\n\nafter")).toEqual([
      "````\n```\n\nx\n````\n",
      "\nafter",
    ]);
  });

  it("keeps an unclosed fence open to the end of the text", () => {
    expect(blockTexts("intro\n\n```ts\nconst a = 1;\n\nconst b = 2;")).toEqual([
      "intro\n",
      "\n```ts\nconst a = 1;\n\nconst b = 2;",
    ]);
  });

  it("keeps loose lists and indented continuations together", () => {
    expect(blockTexts("- a\n\n- b\n\n  more b\n\nafter")).toEqual([
      "- a\n\n- b\n\n  more b\n",
      "\nafter",
    ]);
    expect(blockTexts("1. a\n\n   ```sh\n   x\n\n   y\n   ```\n\n2. b\n\nend")).toEqual([
      "1. a\n\n   ```sh\n   x\n\n   y\n   ```\n\n2. b\n",
      "\nend",
    ]);
  });

  it("keeps indented code with blank lines together", () => {
    expect(blockTexts("    a\n\n    b\n\nafter")).toEqual(["    a\n\n    b\n", "\nafter"]);
  });

  it("does not split when cross-block references are present", () => {
    expect(splitMarkdownBlocks("See [docs][d].\n\n[d]: https://example.com\n\nMore.")).toHaveLength(
      1,
    );
    expect(splitMarkdownBlocks("Claim[^1].\n\n[^1]: Source.")).toHaveLength(1);
  });

  it("stops splitting after an html block that can span blank lines", () => {
    expect(blockTexts("a\n\n<!--\n\n```\n\n-->\n\nb")).toEqual([
      "a\n",
      "\n<!--\n\n```\n\n-->\n\nb",
    ]);
  });

  it("stops splitting when a list fence cannot be attributed", () => {
    expect(splitMarkdownBlocks("- a\nlazy\n  ```\n\nb\n\n```\n\nc")).toHaveLength(1);
  });

  it("treats a column-zero fence after a nested fence as a new top-level fence", () => {
    expect(blockTexts("- a\n  ```\n```\n\ninside\n\nX")).toEqual([
      "- a\n  ```\n```\n\ninside\n\nX",
    ]);
  });

  it("returns one empty block for empty text", () => {
    expect(splitMarkdownBlocks("")).toEqual([{ start: 0, end: 0, line: 0 }]);
  });
});

describe("remarkMarkdownBlockOrigin", () => {
  it("shifts positions without mutating shared points", () => {
    const shared = { line: 1, column: 1, offset: 0 };
    const tree = {
      position: { start: shared, end: { line: 2, column: 1, offset: 5 } },
      children: [{ position: { start: shared, end: { line: 1, column: 3, offset: 2 } } }],
    };
    remarkMarkdownBlockOrigin({ offset: 100, line: 10 })(tree);
    expect(tree.position.start).toEqual({ line: 11, column: 1, offset: 100 });
    expect(tree.children[0]!.position.start).toEqual({ line: 11, column: 1, offset: 100 });
    expect(tree.children[0]!.position.end).toEqual({ line: 11, column: 3, offset: 102 });
    expect(shared).toEqual({ line: 1, column: 1, offset: 0 });
  });
});
