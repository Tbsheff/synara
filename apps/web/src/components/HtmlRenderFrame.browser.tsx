import "../index.css";

import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import ChatMarkdown from "./ChatMarkdown";
import { HtmlRenderFrame } from "./HtmlRenderFrame";

describe("inline HTML", () => {
  it("adds Preview after a block settles, defaults to Code, and isolates its scripts", async () => {
    let parentAccess: unknown;
    const receive = (event: MessageEvent<unknown>) => {
      if (typeof event.data === "object" && event.data !== null && "parentAccess" in event.data)
        parentAccess = event.data.parentAccess;
    };
    window.addEventListener("message", receive);
    const html =
      '<!doctype html><html><body><h1>Chart</h1><script>var access;try{access=parent.document.body.tagName}catch(e){access=null}parent.postMessage({parentAccess:access},"*");</script></body></html>';
    const screen = await render(
      <ChatMarkdown text={"```html\n" + html} cwd={undefined} isStreaming />,
    );
    try {
      expect(document.querySelector('button[aria-pressed="false"]')?.textContent).not.toBe(
        "Preview",
      );
      expect(document.querySelector("iframe")).toBeNull();
      await screen.rerender(
        <ChatMarkdown text={"```html\n" + html + "\n```"} cwd={undefined} isStreaming={false} />,
      );
      await expect
        .poll(() => document.querySelector(".chat-markdown-codeblock__actions")?.textContent)
        .toContain("Preview");
      expect(document.querySelector("iframe")).toBeNull();
      await screen.getByRole("button", { name: "Preview", exact: true }).click();
      const frame = document.querySelector("iframe");
      expect(frame?.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
      expect(frame?.hasAttribute("srcdoc")).toBe(true);
      expect(frame?.hasAttribute("src")).toBe(false);
      await expect.poll(() => parentAccess).toBeNull();
      await screen.getByRole("button", { name: "Code", exact: true }).click();
      expect(document.querySelector("iframe")).toBeNull();
    } finally {
      window.removeEventListener("message", receive);
      await screen.unmount();
    }
  });

  it("clamps actual frame messages without moving later content or a detached reader", async () => {
    const html = `<div style="height:120px">Page</div><script>window.addEventListener('message',function(e){if(e.data==='grow')parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{height:10000}},'*');});</script>`;
    const screen = await render(
      <div data-test-scroller style={{ height: 200, overflow: "auto" }}>
        <div style={{ height: 500 }} />
        <HtmlRenderFrame document={{ title: "Page", html, height: 2000 }} />
        <p data-test-after>Reply</p>
      </div>,
    );
    try {
      const frame = document.querySelector<HTMLIFrameElement>("iframe")!;
      expect(getComputedStyle(frame).borderTopWidth).toBe("0px");
      expect(getComputedStyle(frame).borderBottomWidth).toBe("0px");
      await expect.poll(() => frame.getBoundingClientRect().height).toBe(120);
      const scroller = document.querySelector<HTMLElement>("[data-test-scroller]")!;
      scroller.scrollTop = 100;
      const after = document.querySelector("[data-test-after]")!.getBoundingClientRect().top;
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          data: {
            jsonrpc: "2.0",
            method: "ui/notifications/size-changed",
            params: { height: 800 },
          },
        }),
      );
      expect(frame.getBoundingClientRect().height).toBe(120);
      frame.contentWindow?.postMessage("grow", "*");
      await expect.poll(() => frame.getBoundingClientRect().height).toBe(2000);
      expect(scroller.scrollTop).toBe(100);
      expect(document.querySelector("[data-test-after]")!.getBoundingClientRect().top).toBe(after);
      expect(
        document.querySelector("[data-html-render-frame]")!.getBoundingClientRect().height,
      ).toBe(2000);
    } finally {
      await screen.unmount();
    }
  });

  it("blocks app-origin fetch and remote scripts with the first CSP", async () => {
    let blocked = false;
    const receive = (event: MessageEvent<unknown>) => {
      if (event.data === "html-fetch-blocked") blocked = true;
    };
    window.addEventListener("message", receive);
    const html = `<meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline'"><script>fetch(${JSON.stringify(location.origin + "/html-security-probe")}).then(function(){parent.postMessage('unexpected-fetch','*')},function(){parent.postMessage('html-fetch-blocked','*')});</script>`;
    const screen = await render(<HtmlRenderFrame document={{ title: "CSP", html, height: 480 }} />);
    try {
      await expect.poll(() => blocked).toBe(true);
    } finally {
      window.removeEventListener("message", receive);
      await screen.unmount();
    }
  });

  it("opens the same sandboxed page in the shared dialog", async () => {
    const screen = await render(
      <HtmlRenderFrame document={{ title: "Chart", html: "<p>Chart</p>", height: 480 }} />,
    );
    try {
      await page.getByTitle("Chart", { exact: true }).hover();
      const open = screen.getByRole("button", { name: "Open in panel" });
      await expect.element(open).toBeVisible();
      await open.click();
      const dialog = page.getByRole("dialog", { name: "Chart", exact: true });
      await expect.element(dialog).toBeVisible();
      await expect
        .poll(() => document.querySelector('[role="dialog"] iframe')?.getAttribute("sandbox"))
        .toBe("allow-scripts allow-forms");
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect.element(dialog).not.toBeInTheDocument();
      expect(document.querySelectorAll("iframe")).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it("sends theme and font changes without reloading the page", async () => {
    const root = document.documentElement;
    const previousStyle = root.getAttribute("style");
    const wasDark = root.classList.contains("dark");
    let observed: unknown;
    const receive = (event: MessageEvent<unknown>) => {
      if (typeof event.data === "object" && event.data !== null && "observedTheme" in event.data)
        observed = event.data.observedTheme;
    };
    window.addEventListener("message", receive);
    const html = `<p>Theme</p><script>window.addEventListener('message',function(e){if(e.data&&e.data.method==='ui/notifications/host-context-changed'){var s=getComputedStyle(document.documentElement);parent.postMessage({observedTheme:{foreground:s.getPropertyValue('--foreground').trim(),fontSize:s.getPropertyValue('--font-size').trim(),appearance:document.documentElement.style.colorScheme}},'*');}});</script>`;
    const screen = await render(
      <HtmlRenderFrame document={{ title: "Theme", html, height: 480 }} />,
    );
    try {
      await expect.poll(() => observed).toBeDefined();
      const frame = document.querySelector<HTMLIFrameElement>("iframe")!;
      const srcdoc = frame.srcdoc;
      root.style.setProperty("--foreground", "#123456");
      root.style.setProperty("--app-font-size-ui", "19px");
      root.classList.add("dark");
      await expect
        .poll(() => observed)
        .toEqual({ foreground: "#123456", fontSize: "19px", appearance: "dark" });
      expect(document.querySelector("iframe")).toBe(frame);
      expect(frame.srcdoc).toBe(srcdoc);
    } finally {
      window.removeEventListener("message", receive);
      await screen.unmount();
      root.classList.toggle("dark", wasDark);
      if (previousStyle === null) root.removeAttribute("style");
      else root.setAttribute("style", previousStyle);
    }
  });

  it("keeps user HTML as code", async () => {
    const screen = await render(
      <ChatMarkdown text={"```html\n<p>User code</p>\n```"} cwd={undefined} variant="user" />,
    );
    try {
      expect(document.querySelector("iframe")).toBeNull();
      expect(
        document.querySelector(".chat-markdown-codeblock__actions")?.textContent,
      ).not.toContain("Preview");
    } finally {
      await screen.unmount();
    }
  });
});
