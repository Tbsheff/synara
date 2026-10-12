import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DiffStatLabel } from "./DiffStatLabel";

describe("DiffStatLabel", () => {
  it("prints deletions with the minus sign the Changes panel uses", () => {
    const markup = renderToStaticMarkup(<DiffStatLabel additions={3} deletions={2} />);
    expect(markup).toContain("+3");
    expect(markup).toContain("−2");
    expect(markup).not.toContain("-2");
  });
});
