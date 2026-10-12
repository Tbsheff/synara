import { describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import { render } from "vitest-browser-react";

import { StableShikiHtml } from "./StableShikiHtml";

const calls = vi.hoisted(() => ({ parses: 0, lineProps: 0 }));

vi.mock("../lib/shikiHtmlLines", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/shikiHtmlLines")>();
  return {
    ...actual,
    parseShikiHtml: (...args: Parameters<typeof actual.parseShikiHtml>) => {
      calls.parses++;
      return actual.parseShikiHtml(...args);
    },
    htmlAttributesToReactProps: (...args: Parameters<typeof actual.htmlAttributesToReactProps>) => {
      if (args[0].class === "line") calls.lineProps++;
      return actual.htmlAttributesToReactProps(...args);
    },
  };
});

function propsAt(update: number) {
  const prefix = Math.floor(update / 10);
  const html = `<pre class="shiki" style="color: #333"><code><span class="line"><span style="color: red">const a = ${prefix};</span></span>\n<span class="line">stable</span></code></pre>`;
  const plainTail = "<& tail".repeat(update % 10);
  return {
    html,
    plainTail,
    combinedHtml: html.replace(
      "</code>",
      `${plainTail.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</code>`,
    ),
  };
}

describe("Shiki prefix parsing", () => {
  it("parses and builds lines only when the highlighted prefix changes", async () => {
    calls.parses = 0;
    calls.lineProps = 0;
    const screen = await render(<StableShikiHtml {...propsAt(0)} />);
    const pre = document.querySelector(".chat-markdown-shiki pre");
    const firstLine = pre?.querySelector(".line");
    for (let update = 1; update < 60; update++) {
      await screen.rerender(<StableShikiHtml {...propsAt(update)} />);
      expect(document.querySelector(".chat-markdown-shiki pre")).toBe(pre);
      if (update < 10) expect(pre?.querySelector(".line")).toBe(firstLine);
      expect(pre?.textContent).toBe(
        `const a = ${Math.floor(update / 10)};\nstable${propsAt(update).plainTail}`,
      );
    }
    await commands.writeFile(
      `node_modules/.cache/markdown-perf/${import.meta.env.VITE_MARKDOWN_PERF_PHASE ?? "after"}-parses.json`,
      JSON.stringify({
        updates: 60,
        prefixChanges: 6,
        parses: calls.parses,
        lineProps: calls.lineProps,
      }),
    );
    await screen.unmount();
    expect(calls.parses).toBe(6);
    expect(calls.lineProps).toBe(12);
  });

  it("keeps escaped tails and find marks when the parser cannot split the HTML", async () => {
    const html = '<pre class="shiki"><code><mark>found</mark></code></pre>';
    const plainTail = "<& tail";
    const combinedHtml = '<pre class="shiki"><code><mark>found</mark>&lt;&amp; tail</code></pre>';
    const screen = await render(<StableShikiHtml {...{ html, plainTail, combinedHtml }} />);
    expect(document.querySelector(".chat-markdown-shiki pre")?.textContent).toBe("found<& tail");
    expect(document.querySelector("mark")?.textContent).toBe("found");
    await screen.unmount();
  });
});
