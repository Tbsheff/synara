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

it("shows saved renders and enables code previews on Stable", async () => {
  expect(INLINE_HTML_RENDER_ON).toBe(true);
  const screen = await render(
    <>
      <HtmlRenderFrame document={{ title: "Saved", html: "<p>Saved</p>", height: 480 }} />
      <ChatMarkdown text={"```html\n<p>Saved</p>\n```"} cwd={undefined} />
    </>,
  );
  try {
    expect(document.querySelector("iframe")).not.toBeNull();
    expect(document.querySelector("[data-html-render-frame]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Open in panel" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Preview", exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "Preview", exact: true }).click();
    expect(screen.getByRole("button", { name: "Code", exact: true })).toBeVisible();
    expect(document.querySelectorAll("iframe")).toHaveLength(2);
    await screen.getByRole("button", { name: "Code", exact: true }).click();
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(document.querySelector(".chat-markdown-codeblock__actions")).not.toBeNull();
  } finally {
    await screen.unmount();
  }
});
