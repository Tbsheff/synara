import { describe, expect, it } from "vitest";

import { deriveReasoningHeading } from "./reasoningHeading.ts";

describe("deriveReasoningHeading", () => {
  it("uses the first non-empty line and unwraps a bold-only title", () => {
    expect(
      deriveReasoningHeading(
        "\n**Inspecting the parser**:\n\nI read the tokenizer.\n\n**Checking cancellation**\n\nThe fiber is interrupted.",
      ),
    ).toBe("Inspecting the parser");
  });

  it("strips Markdown from a plain first line", () => {
    expect(
      deriveReasoningHeading(
        "<!-- note -->\n- Read `src/index.ts` and [docs](https://x.dev)\n\nPlan",
      ),
    ).toBe("Read src/index.ts and docs");
  });

  it("strips heading markers and inline emphasis", () => {
    expect(deriveReasoningHeading("## Looking at *the* __store__")).toBe("Looking at the store");
  });

  it("returns undefined for empty or comment-only summaries", () => {
    expect(deriveReasoningHeading(undefined)).toBeUndefined();
    expect(deriveReasoningHeading("  \n\n")).toBeUndefined();
    expect(deriveReasoningHeading("<!-- encrypted -->")).toBeUndefined();
  });

  it("caps long headings", () => {
    const heading = deriveReasoningHeading(`**${"a".repeat(400)}**`);
    expect(heading?.length).toBe(160);
    expect(heading?.endsWith("…")).toBe(true);
  });

  it("does not cut an emoji in half at the cap", () => {
    const heading = deriveReasoningHeading(`${"a".repeat(158)}\u{1F600}${"b".repeat(40)}`);
    expect(heading).toBe(`${"a".repeat(158)}…`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(heading ?? "")).toBe(false);
  });
});
