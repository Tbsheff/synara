import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import "../index.css";
import { RuntimeUsageControls } from "./BranchToolbar";

afterEach(() => cleanup());

describe("task-invoked Computer", () => {
  it("keeps access rules available without a persistent Computer switch", async () => {
    const onRuntime = vi.fn();
    await render(
      <RuntimeUsageControls runtimeMode="approval-required" onRuntimeModeChange={onRuntime} />,
    );
    await page.getByRole("button").click();
    await expect
      .element(page.getByRole("menuitemradio", { name: /Computer:/ }))
      .not.toBeInTheDocument();
    await page.getByRole("menuitemradio", { name: /Full access/ }).click();
    expect(onRuntime).toHaveBeenCalledExactlyOnceWith("full-access");
  });
});

it.each(["approval-required", "full-access"] as const)(
  "shows the current %s mode in a narrow composer",
  async (mode) => {
    await render(
      <div className="@container" style={{ width: 320 }}>
        <RuntimeUsageControls runtimeMode={mode} onRuntimeModeChange={vi.fn()} />
      </div>,
    );
    const label = mode === "full-access" ? "Full access" : "Ask for approval";
    const button = page.getByRole("button", { name: new RegExp(label) });
    await expect.element(button).toBeVisible();
    const span = button.element().querySelector("span.truncate")!;
    expect(span.getBoundingClientRect().width).toBeGreaterThan(30);
    expect(getComputedStyle(span).position).not.toBe("absolute");
  },
);
