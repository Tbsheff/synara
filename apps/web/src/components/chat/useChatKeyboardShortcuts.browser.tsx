import "../../index.css";

import { ThreadId } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { CodeEditorPane } from "../codeEditor/CodeEditorPane";
import { useChatKeyboardShortcuts } from "./useChatKeyboardShortcuts";

afterEach(cleanup);

type ShortcutsInput = Parameters<typeof useChatKeyboardShortcuts>[0];

function Harness({ openThreadFind }: { openThreadFind: ShortcutsInput["setThreadFindOpen"] }) {
  const [value, setValue] = useState("file-only-term\nsecond line\n");
  const findInputs = {
    surfaceMode: "single",
    isFocusedPane: true,
    activeThreadId: ThreadId.makeUnsafe("find-routing"),
    composerFormRef: { current: null },
    terminalState: { terminalOpen: false } as ShortcutsInput["terminalState"],
    terminalWorkspaceTerminalTabActive: false,
    shouldRenderChatPaneContent: true,
    keybindings: [],
    setThreadFindOpen: openThreadFind,
    setThreadFindFocusNonce: () => undefined,
  } satisfies Partial<ShortcutsInput>;
  useChatKeyboardShortcuts(findInputs as ShortcutsInput);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: 500 }}>
      <input aria-label="Chat composer" />
      <div data-browser-panel="true">
        <input aria-label="Browser page input" />
      </div>
      <textarea className="xterm-helper-textarea" aria-label="Terminal input" />
      <CodeEditorPane
        value={value}
        valueVersion={0}
        fileName="focus.txt"
        resolvedTheme="light"
        onChange={setValue}
        onSave={() => undefined}
      />
    </div>
  );
}

it("routes Cmd+F by file, chat, browser, and terminal focus", async () => {
  const openThreadFind = vi.fn();
  await render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { enabled: false } } })}
    >
      <Harness openThreadFind={openThreadFind} />
    </QueryClientProvider>,
  );
  const modifier = /Mac/.test(navigator.platform) ? "Meta" : "Control";
  const editor = page.getByRole("textbox", { name: "Edit focus.txt" });
  await editor.click({ position: { x: 15, y: 5 } });
  await userEvent.keyboard(`{${modifier}>}f{/${modifier}}`);
  await expect.element(page.getByRole("textbox", { name: "Find in file" })).toBeVisible();
  expect(openThreadFind).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  await expect
    .poll(() => (editor.element().getRootNode() as ShadowRoot).activeElement === editor.element())
    .toBe(true);
  await page.getByRole("textbox", { name: "Chat composer" }).click();
  await userEvent.keyboard(`{${modifier}>}f{/${modifier}}`);
  expect(openThreadFind).toHaveBeenCalledWith(true);
  openThreadFind.mockClear();
  for (const label of ["Browser page input", "Terminal input"]) {
    const input = page.getByRole("textbox", { name: label }).element();
    (input as HTMLElement).focus();
    const event = new KeyboardEvent("keydown", {
      key: "f",
      metaKey: modifier === "Meta",
      ctrlKey: modifier === "Control",
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(openThreadFind).not.toHaveBeenCalled();
  }
});
