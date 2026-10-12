import katex from "katex";
import { describe, expect, it } from "vitest";

import { closePartialTex, renderPendingDisplayMath } from "./pendingDisplayMath";

function renderDisplay(source: string): string {
  return katex.renderToString(source, {
    displayMode: true,
    output: "htmlAndMathml",
    strict: false,
    throwOnError: true,
  });
}

describe("closePartialTex", () => {
  it.each([
    ["\\frac{a}{", "\\frac{a}{}"],
    ["x + \\sig", "x +"],
    ["\\begin{aligned}\na &= b \\\\", "\\begin{aligned}\na &= b\n\\end{aligned}"],
    ["\\begin{aligned}\na &= b\n\\end{alig", "\\begin{aligned}\na &= b\n\\end{aligned}"],
    ["\\left( \\frac{1}{2", "\\left( \\frac{1}{2}\\right."],
    ["\\left( \\frac{\\left[ a_", "\\left( \\frac{\\left[ a\\right.}\\right."],
    ["x^", "x"],
  ])("closes %j", (source, expected) => {
    expect(closePartialTex(source)).toBe(expected);
  });
});

describe("renderPendingDisplayMath", () => {
  it("renders complete TeX exactly as a settled display equation", () => {
    expect(renderPendingDisplayMath("E = mc^2")).toBe(renderDisplay("E = mc^2"));
  });

  it("renders partial TeX through KaTeX instead of raw text", () => {
    for (const source of [
      "\\frac{a}{",
      "x + \\sig",
      "\\begin{aligned}\na &= b \\\\\nc &= \\frac{d}{",
      "\\begin{aligned}\na &= b\n\\end{alig",
    ]) {
      const html = renderPendingDisplayMath(source);
      expect(html).toContain('class="katex-display"');
      expect(html).not.toContain("katex-error");
    }
  });

  it("falls back to the complete lines when the last line cannot be closed", () => {
    expect(renderPendingDisplayMath("a + b\n\\frac{a}{b}}")).toBe(renderDisplay("a + b"));
  });

  it("renders nothing for empty or unrenderable TeX", () => {
    expect(renderPendingDisplayMath("")).toBeNull();
    expect(renderPendingDisplayMath("  \n")).toBeNull();
    expect(renderPendingDisplayMath("}")).toBeNull();
  });

  it.each([
    "\\frac{\\mathbb{E}[X]}{\\sigma^2}",
    "E = mc^2 + \\frac{\\mathbb{E}[X]}{\\sigma^2}",
    "\\left( \\frac{a_1}{b^2} \\right) \\leftarrow x",
    [
      "\\begin{aligned}",
      "f(x) &= \\sum_{k=0}^{n} a_k x^k \\\\",
      "g(x) &= \\frac{1}{2}\\int_0^x f(t)\\,dt",
      "\\end{aligned}",
    ].join("\n"),
  ])("keeping the last render never drops an equation or row while %j streams", (source) => {
    let renderedRows = 0;
    let html: string | null = null;
    for (let length = 1; length <= source.length; length += 1) {
      html = renderPendingDisplayMath(source.slice(0, length)) ?? html;
      if (renderedRows > 0) expect({ length, html }).not.toEqual({ length, html: null });
      const rows = html === null ? 0 : Math.max(1, (html.match(/class="mtr"/g) ?? []).length);
      expect({ length, rows: Math.max(rows, renderedRows) }).toEqual({ length, rows });
      renderedRows = rows;
    }
  });
});
