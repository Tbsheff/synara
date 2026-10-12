import { beforeEach, describe, expect, it, vi } from "vitest";

const sharedHighlighterMock = vi.hoisted(() => {
  const highlighter = {
    codeToHtml: vi.fn((code: string, options: { lang: string }) => {
      if (options.lang !== "text" && options.lang !== "typescript") {
        throw new Error(`Language ${options.lang} not loaded`);
      }
      return `<pre class="shiki"><code><span class="line">${code}</span></code></pre>`;
    }),
  };
  const getSharedHighlighter = vi.fn(async ({ langs }: { langs: string[] }) => {
    const language = langs[0];
    if (language !== "text" && language !== "typescript") {
      throw new Error(`resolveLanguage: "${language}" not found in bundled or custom languages`);
    }
    return highlighter;
  });
  return { getSharedHighlighter, highlighter };
});

vi.mock("@pierre/diffs", () => ({
  getFiletypeFromFileName: () => "text",
  getSharedHighlighter: sharedHighlighterMock.getSharedHighlighter,
}));

const { resolveDiffThemeName } = await import("./diffRendering");
const {
  appendPlainTextToHighlightedHtml,
  getSyntaxHighlighterPromise,
  highlightCodeToHtmlWithFallback,
} = await import("./syntaxHighlighting");

function loadCountFor(language: string): number {
  return sharedHighlighterMock.getSharedHighlighter.mock.calls.filter(
    ([options]) => options.langs[0] === language,
  ).length;
}

describe("getSyntaxHighlighterPromise", () => {
  beforeEach(() => {
    sharedHighlighterMock.highlighter.codeToHtml.mockClear();
  });

  it.each(["pyt", "txt-unknown", "plaintext-unknown"])(
    "caches the failed language %s so later calls reuse one settled promise",
    async (language) => {
      const first = getSyntaxHighlighterPromise(language);
      await expect(first).resolves.toBe(sharedHighlighterMock.highlighter);

      const second = getSyntaxHighlighterPromise(language);
      const third = getSyntaxHighlighterPromise(language);
      expect(second).toBe(first);
      expect(third).toBe(first);
      expect(loadCountFor(language)).toBe(1);
    },
  );

  it("highlights a failed language as text without retrying the grammar", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const highlighter = await getSyntaxHighlighterPromise("brokenlang");

    highlightCodeToHtmlWithFallback(highlighter, "a", "brokenlang", resolveDiffThemeName("dark"));
    highlightCodeToHtmlWithFallback(highlighter, "b", "brokenlang", resolveDiffThemeName("dark"));

    const langs = sharedHighlighterMock.highlighter.codeToHtml.mock.calls.map(
      ([, options]) => options.lang,
    );
    expect(langs).toEqual(["text", "text"]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps a working language on its own promise", async () => {
    const promise = getSyntaxHighlighterPromise("typescript");
    await promise;
    expect(getSyntaxHighlighterPromise("typescript")).toBe(promise);
    expect(loadCountFor("typescript")).toBe(1);
  });
});

describe("appendPlainTextToHighlightedHtml", () => {
  it("escapes the plain tail and places it inside the highlighted code element", () => {
    const html = '<pre class="shiki"><code><span class="line">const a</span></code></pre>';
    expect(appendPlainTextToHighlightedHtml(html, " = <b>&\nnext")).toBe(
      '<pre class="shiki"><code><span class="line">const a</span> = &lt;b&gt;&amp;\nnext</code></pre>',
    );
  });

  it("returns the html unchanged when there is no tail", () => {
    const html = "<pre><code></code></pre>";
    expect(appendPlainTextToHighlightedHtml(html, "")).toBe(html);
  });
});
