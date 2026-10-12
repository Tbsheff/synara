import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.stubGlobal("window", { location: { protocol: "synara:" } });
vi.stubEnv("DEV", false);
const { INLINE_HTML_RENDER_ON } = await import("../betaFeatures");
vi.unstubAllGlobals();
vi.unstubAllEnvs();

it("hides stored HTML frames on the production desktop scheme", async () => {
  const { HtmlRenderFrame } = await import("./HtmlRenderFrame");
  expect(INLINE_HTML_RENDER_ON).toBe(false);
  expect(
    renderToStaticMarkup(
      <HtmlRenderFrame document={{ title: "Saved", html: "<p>Saved</p>", height: 480 }} />,
    ),
  ).toBe("");
});

it("keeps settled HTML fences as code on the production desktop scheme", async () => {
  const { default: ChatMarkdown } = await import("./ChatMarkdown");
  const markup = renderToStaticMarkup(
    <ChatMarkdown text={"```html\n<p>Saved</p>\n```"} cwd={undefined} />,
  );
  expect(markup).toContain("chat-markdown-codeblock__actions");
  expect(markup).toContain("&lt;p&gt;Saved&lt;/p&gt;");
  expect(markup).not.toContain(">Preview</button>");
  expect(markup).not.toContain("<iframe");
}, 30_000);
