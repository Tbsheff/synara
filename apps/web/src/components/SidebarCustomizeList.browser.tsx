import "../index.css";
import { page, userEvent } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { SidebarCustomizeList } from "./SidebarCustomizeList";

it("reorders sidebar entries with the keyboard", async () => {
  const onReorder = vi.fn();
  const Icon = () => <span />;
  const screen = await render(
    <SidebarCustomizeList
      items={[
        { id: "first", icon: Icon, label: "First", visible: true },
        { id: "second", icon: Icon, label: "Second", visible: true },
      ]}
      onReorder={onReorder}
      onVisibleChange={() => {}}
    />,
  );
  try {
    const handle = page.getByRole("button", { name: "Reorder First" });
    const announcement = page.getByRole("status");
    handle.element().focus();
    await expect.element(handle).toHaveFocus();
    await userEvent.keyboard("[Space]");
    await expect.element(handle).toHaveAttribute("aria-pressed", "true");
    await expect.element(announcement).toHaveTextContent("droppable area first");
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(announcement).toHaveTextContent("droppable area second");
    expect(onReorder).not.toHaveBeenCalled();
    await userEvent.keyboard("[Space]");
    await expect.element(handle).not.toHaveAttribute("aria-pressed", "true");
    expect(onReorder).toHaveBeenCalledWith("first", "second");
    expect(onReorder).toHaveBeenCalledOnce();
  } finally {
    await screen.unmount();
  }
});
