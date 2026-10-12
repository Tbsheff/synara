import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import ChatMarkdown from "./ChatMarkdown";

const harness = vi.hoisted(() => ({
  copy: vi.fn(async (_text: string) => {}),
  toast: vi.fn(),
  activate: undefined as (() => void) | undefined,
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("../hooks/useCopyToClipboard", async (original) => ({
  ...(await original<typeof import("../hooks/useCopyToClipboard")>()),
  copyTextToClipboard: harness.copy,
}));
vi.mock("./ui/toast", () => ({ toastManager: { add: harness.toast } }));
vi.mock("./ui/icon-button", () => ({
  IconButton: (props: ComponentProps<"button"> & { label: string }) => {
    if (props.label === "Copy code") harness.activate = props.onClick as () => void;
    return createElement("button", { "aria-label": props.label }, props.children);
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  harness.activate = undefined;
  harness.copy.mockResolvedValue();
});

function renderCode() {
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChatMarkdown cwd={undefined} text={"```python\n    if ok:\n        run()\n```"} />
    </QueryClientProvider>,
  );
  expect(harness.activate).toBeDefined();
  harness.activate!();
}

it("copies the raw fenced source without removing its indentation", async () => {
  renderCode();
  expect(harness.copy).toHaveBeenCalledWith("    if ok:\n        run()\n");
});

it("reports a rejected code copy", async () => {
  harness.copy.mockRejectedValueOnce(new Error("denied"));
  renderCode();
  await vi.waitFor(() =>
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Could not copy code" }),
    ),
  );
});
