import { describe, expect, it } from "vitest";

import { repairStreamingMarkdown } from "./markdownStreamingRepair";

describe("repairStreamingMarkdown", () => {
  it.each([
    ["an unfinished link destination", "See [the docs](https://exa", "See "],
    ["a link label waiting for its destination", "See [the docs]", "See "],
    ["an unclosed link label", "See [the do", "See "],
    ["an unfinished link inside bold", "**Read [docs](http", "**Read**"],
    ["a partial image", "Diagram:\n![arch](./images/ar", "Diagram:\n"],
    ["a partial image alt text", "![arch", ""],
    ["an open bold span", "This is **important", "This is **important**"],
    [
      "an open bold span with trailing space",
      "This is **very important ",
      "This is **very important**",
    ],
    ["an open underscore span", "Use _care", "Use _care_"],
    ["an open asterisk span", "Use *care", "Use *care*"],
    ["nested open spans", "**bold _both", "**bold _both_**"],
    ["a bare bold opener", "Text **", "Text "],
    ["a partial bold closer", "Then **bold text*", "Then **bold text**"],
    ["a partial strong underscore closer", "Then __bold_", "Then __bold__"],
    ["a bare italic opener after a closed span", "**done** _", "**done** "],
    ["an open inline code span", "Run `bun run te", "Run `bun run te`"],
    ["an open double-backtick span", "Run ``a ` b", "Run ``a ` b``"],
    ["a bare backtick opener", "Run `", "Run "],
    ["emphasis markers inside open inline code", "Run `a **b", "Run `a **b`"],
    ["a partial opening fence", "Code:\n``", "Code:\n"],
    [
      "an unclosed display math block",
      "Formula:\n\n$$\n\\frac{a}{",
      "Formula:\n\n```synara-pending-math\n\\frac{a}{\n```",
    ],
    [
      "an indented unclosed display math block with backticks",
      "1. Step\n\n   $$\n   a ``` b",
      "1. Step\n\n   ````synara-pending-math\n   a ``` b\n   ````",
    ],
    ["a bare dollar at the end of a line", "Formula:\n\n$", "Formula:\n\n"],
    [
      "a partial display math closer",
      "Formula:\n\n$$\na^2\n$",
      "Formula:\n\n```synara-pending-math\na^2\n```",
    ],
    ["a bare dollar after a word", "It costs $", "It costs "],
    ["a bare list marker line", "text\n- ", "text\n"],
    ["a bare task marker line", "text\n- [ ", "text\n"],
    ["a bare heading marker line", "Intro\n\n## ", "Intro\n\n"],
    ["a bare quote marker line", "Intro\n\n> ", "Intro\n\n"],
    ["an unclosed inline display math", "Inline $$x^2", "Inline "],
    [
      "a display math opener followed by a newline",
      "Formula:\n\n$$\n",
      "Formula:\n\n```synara-pending-math\n```",
    ],
    ["a table header row without its delimiter", "| Name | Age |", "| Name | Age |\n| --- | --- |"],
    [
      "a terminated table header row",
      "Intro\n\n| Name | Age |\n",
      "Intro\n\n| Name | Age |\n| --- | --- |",
    ],
    ["a partial table delimiter", "| Name | Age |\n| :", "| Name | Age |\n| --- | --- |"],
    ["a bare table delimiter pipe", "| Name | Age |\n|", "| Name | Age |\n| --- | --- |"],
    ["a one-cell table start", "Intro\n\n| Na", "Intro\n\n"],
    [
      "a partial closing fence inside open code",
      "```ts\nconst a = 1;\n``",
      "```ts\nconst a = 1;\n",
    ],
  ])("repairs %s", (_label, input, expected) => {
    expect(repairStreamingMarkdown(input)).toBe(expected);
  });

  it.each([
    ["an open code fence", "```python\nx = [1, 2](3\ny = **z\n$$"],
    ["a code fence still on its info line", "```pyt"],
    ["a closed link", "See [the docs](https://example.com) now."],
    ["link syntax inside inline code", "Use `[x](` literally"],
    ["closed display math", "$$\na^2 + b^2\n$$\n\nDone."],
    ["snake_case identifiers", "Call foo_bar_baz with a_b"],
    ["closed emphasis", "**bold** and _italic_ and *more*"],
    ["a list bullet", "* item"],
    ["a closing bold run", "**bold\nstill bold**"],
    ["arithmetic asterisks", "Compute 2*3 = 6"],
    ["escaped markers", "Price \\*not emphasis and \\[not a link"],
    ["a complete table", "| a | b |\n| --- | --- |\n| 1 | 2 |"],
    ["a short delimiter the table repair pads", "| Name | Age |\n| --"],
    ["a table body row", "| a | b |\n| --- | --- |\n| 1 |"],
    ["a closed fence", "```ts\nconst a = [1](2;\n```\n"],
    ["a checkbox item", "- [ ] task"],
    ["plain prose", "Hello world."],
    ["an empty string", ""],
    [
      "a stray display math marker in an earlier paragraph",
      "Costs $$ extra.\n\nNext paragraph keeps going",
    ],
    [
      "a long unclosed bracket in prose",
      `Interval [0, 10) is half-open and ${"the explanation keeps going ".repeat(4)}`,
    ],
    ["a long bracketed label at the end", `See [${"a long bracketed aside ".repeat(4)}]`],
  ])("leaves %s unchanged", (_label, input) => {
    expect(repairStreamingMarkdown(input)).toBe(input);
  });

  it("converges to the unmodified final text for every streamed prefix", () => {
    const final = [
      "Intro with **bold** text and a [link](https://example.com/path).",
      "",
      "![diagram](./diagram.png)",
      "",
      "$$",
      "E = mc^2",
      "$$",
      "",
      "| Name | Age |",
      "| --- | --- |",
      "| Ada | 36 |",
      "",
      "```ts",
      "const value = `x`;",
      "```",
      "",
      "Done with _style_ and `code`.",
    ].join("\n");

    expect(repairStreamingMarkdown(final)).toBe(final);
    for (let length = 1; length <= final.length; length += 1) {
      const repaired = repairStreamingMarkdown(final.slice(0, length));
      expect(repaired).not.toMatch(/\]\((?![^)\n]*\))/);
      const mathDelimiters = repaired.match(/\$\$/g)?.length ?? 0;
      expect(mathDelimiters % 2).toBe(0);
    }
  });
});
