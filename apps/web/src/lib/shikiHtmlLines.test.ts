import { describe, expect, it } from "vitest";

import { htmlAttributesToReactProps, parseShikiHtml } from "./shikiHtmlLines";

const SHIKI_HTML =
  '<pre class="shiki github-light" style="background-color:#fff;color:#24292e;--shiki-dark:#e1e4e8" tabindex="0"><code><span class="line"><span style="color:#D73A49">const</span> a = 1;</span>\n<span class="line"></span>\n<span class="line">b &amp;&amp; c</span></code></pre>';

describe("parseShikiHtml", () => {
  it("splits Shiki output into per-line html", () => {
    const parsed = parseShikiHtml(SHIKI_HTML)!;
    expect(parsed.lines.map((line) => line.html)).toEqual([
      '<span style="color:#D73A49">const</span> a = 1;',
      "",
      "b &amp;&amp; c",
    ]);
    expect(parsed.lines[0]!.attributes).toEqual({ class: "line" });
  });

  it("converts element attributes to React props", () => {
    const parsed = parseShikiHtml(SHIKI_HTML)!;
    expect(htmlAttributesToReactProps(parsed.preAttributes)).toEqual({
      className: "shiki github-light",
      style: { backgroundColor: "#fff", color: "#24292e", "--shiki-dark": "#e1e4e8" },
      tabIndex: "0",
    });
  });

  it("rejects html it cannot split safely", () => {
    expect(parseShikiHtml("<div>plain</div>")).toBeNull();
    expect(parseShikiHtml("<pre><code>a\nb</code></pre>")).toBeNull();
  });

  it("accepts an empty code block", () => {
    expect(parseShikiHtml('<pre class="shiki"><code></code></pre>')?.lines).toEqual([]);
  });
});
