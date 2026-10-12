import { describe, expect, it } from "vitest";
import { HTML_RENDER_MAX_BYTES } from "@synara/contracts";
import {
  buildHtmlRenderSrcdoc,
  clampHtmlRenderHeight,
  htmlRenderFrameHeight,
  readHtmlRenderContentHeight,
  readHtmlRenderDocument,
} from "./htmlRender";
import { INLINE_HTML_RENDER_BETA_FEATURE, isBetaFeatureEnabled } from "./betaFeatures";

describe("HTML render", () => {
  it("puts the CSP before all page content and installs the height bridge", () => {
    const html =
      "<!doctype html><html><head><script>page()</script></head><body>Hello</body></html>";
    const srcdoc = buildHtmlRenderSrcdoc(html, {
      appearance: "dark",
      variables: { "--foreground": "#eee", "--bad": "</style><script>bad()</script>" },
    });
    expect(srcdoc).toMatch(
      /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/,
    );
    expect(srcdoc.indexOf("Content-Security-Policy")).toBeLessThan(srcdoc.indexOf("<script>"));
    expect(srcdoc).toContain("connect-src 'none'");
    expect(srcdoc).toContain("form-action 'none'");
    expect(srcdoc).toContain("base-uri 'none'");
    expect(srcdoc).toContain("ResizeObserver");
    expect(srcdoc).toContain("ui/notifications/size-changed");
    expect(srcdoc).toContain(html);
    expect(srcdoc).not.toContain("<script>bad()");
  });

  it.each([
    [1, 80],
    [80.6, 81],
    [2100, 2000],
    [Infinity, 80],
    [NaN, 80],
  ])("clamps %s to %s", (height, expected) => {
    expect(clampHtmlRenderHeight(height)).toBe(expected);
  });

  it("fits content inside the fixed reservation", () => {
    expect(htmlRenderFrameHeight(480)).toBe(480);
    expect(htmlRenderFrameHeight(480, 100)).toBe(100);
    expect(htmlRenderFrameHeight(480, 5000)).toBe(480);
    expect(htmlRenderFrameHeight(5000, 5000)).toBe(2000);
  });

  it("accepts only finite height notifications from the current frame", () => {
    const source = {};
    const data = {
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { height: 5000 },
    };
    expect(readHtmlRenderContentHeight({ source, data }, source)).toBe(2000);
    expect(readHtmlRenderContentHeight({ source: {}, data }, source)).toBeUndefined();
    expect(readHtmlRenderContentHeight({ source: null, data }, null)).toBeUndefined();
    for (const height of [0, -1, NaN, Infinity, "100", undefined]) {
      expect(
        readHtmlRenderContentHeight({ source, data: { ...data, params: { height } } }, source),
      ).toBeUndefined();
    }
    expect(
      readHtmlRenderContentHeight({ source, data: { ...data, method: "other" } }, source),
    ).toBeUndefined();
  });

  it("validates stored documents and counts UTF-8 bytes", () => {
    const page = { title: "Chart", html: "x".repeat(HTML_RENDER_MAX_BYTES), height: 480 };
    expect(readHtmlRenderDocument(page)).toEqual(page);
    for (const change of [
      { html: page.html + "x" },
      { html: "é".repeat(HTML_RENDER_MAX_BYTES) },
      { title: " " },
      { title: "x".repeat(201) },
      { html: " " },
      { height: 79 },
      { height: 2001 },
      { height: 80.5 },
    ]) {
      expect(readHtmlRenderDocument({ ...page, ...change })).toBeUndefined();
    }
  });

  it("keeps inline HTML out of Stable", () => {
    expect(isBetaFeatureEnabled(INLINE_HTML_RENDER_BETA_FEATURE, "production")).toBe(false);
    expect(isBetaFeatureEnabled(INLINE_HTML_RENDER_BETA_FEATURE, "beta")).toBe(true);
  });
});
