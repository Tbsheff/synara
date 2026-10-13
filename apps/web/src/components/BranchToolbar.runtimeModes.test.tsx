import type { ProviderKind } from "@synara/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { RuntimeUsageControls } from "./BranchToolbar";

vi.mock("./ui/menu", () => {
  const Content = ({ children, value }: { children?: ReactNode; value?: string }) => (
    <div data-mode={value}>{children}</div>
  );
  return Object.fromEntries(
    ["Menu", "MenuItem", "MenuRadioGroup", "MenuRadioItem", "MenuSeparator", "MenuTrigger"].map(
      (key) => [key, Content],
    ),
  );
});
vi.mock("./chat/ComposerPickerMenuPopup", () => ({
  ComposerPickerMenuPopup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

it.each(["pi", "antigravity", "omp", "codex"] as const)(
  "offers approval-required only for capable %s without changing saved access",
  (provider: ProviderKind) => {
    const onChange = vi.fn();
    const html = renderToStaticMarkup(
      <RuntimeUsageControls
        provider={provider}
        runtimeMode="approval-required"
        onRuntimeModeChange={onChange}
      />,
    );
    expect(html.match(/data-mode="approval-required"/g)?.length).toBe(
      provider === "pi" || provider === "antigravity" ? 1 : 2,
    );
    expect(onChange).not.toHaveBeenCalled();
  },
);

it.each([
  [
    "codex",
    "Allow workspace edits and commands; ask when an action needs access outside the sandbox",
  ],
  [
    "claudeAgent",
    "Ask before file edits and commands that need permission; saved Claude rules still apply",
  ],
  ["opencode", "Ask for actions that need permission under the provider rules"],
] as const)("describes supervised access for %s", (provider, description) => {
  const html = renderToStaticMarkup(
    <RuntimeUsageControls
      provider={provider}
      runtimeMode="approval-required"
      onRuntimeModeChange={vi.fn()}
    />,
  );
  expect(html).toContain(description);
  expect(html).not.toContain("Always ask to edit external files and use the internet");
});
