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
    page.getByRole("button", { name: "Reorder First" }).element().focus();
    await userEvent.keyboard("{Space}{ArrowDown}{Space}");
    expect(onReorder).toHaveBeenCalledWith("first", "second");
  } finally {
    await screen.unmount();
  }
});
