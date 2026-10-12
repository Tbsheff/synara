import "../index.css";

import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { INLINE_HTML_RENDER_ON } from "../betaFeatures";
import ChatMarkdown from "./ChatMarkdown";
import { HtmlRenderFrame } from "./HtmlRenderFrame";

vi.mock("@synara/shared/betaFeatures", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synara/shared/betaFeatures")>()),
  desktopFlavorFromProtocol: () => "production",
}));

it("keeps saved renders and code previews inert on Stable", async () => {
  expect(INLINE_HTML_RENDER_ON).toBe(false);
  const screen = await render(
    <>
      <HtmlRenderFrame document={{ title: "Saved", html: "<p>Saved</p>", height: 480 }} />
      <ChatMarkdown text={"```html\n<p>Saved</p>\n```"} cwd={undefined} />
    </>,
  );
  try {
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector("[data-html-render-frame]")).toBeNull();
    expect(screen.getByRole("button", { name: "Open in panel" }).query()).toBeNull();
    expect(screen.getByRole("button", { name: "Preview", exact: true }).query()).toBeNull();
    expect(screen.getByRole("button", { name: "Code", exact: true }).query()).toBeNull();
    expect(document.querySelector(".chat-markdown-codeblock__actions")).not.toBeNull();
  } finally {
    await screen.unmount();
  }
});
