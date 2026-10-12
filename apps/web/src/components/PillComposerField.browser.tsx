import { useState } from "react";
import { expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { PillComposerField } from "./PillComposerField";

function Harness({ onSubmit }: { onSubmit: (value: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <PillComposerField
      value={value}
      onValueChange={setValue}
      onSubmit={() => onSubmit(value)}
      canSubmit={value.trim().length > 0}
      disabled={false}
      placeholder="Send a follow-up"
      ariaLabel="Follow-up message"
      submitLabel="Send follow-up"
    />
  );
}

it("submits on Enter, keeps Shift+Enter as a new line, and gates the send button", async () => {
  const onSubmit = vi.fn();
  await render(<Harness onSubmit={onSubmit} />);
  const field = page.getByRole("textbox", { name: "Follow-up message" });
  const send = page.getByRole("button", { name: "Send follow-up" });
  await expect.element(send).toBeDisabled();

  await field.click();
  await userEvent.keyboard("first{Shift>}{Enter}{/Shift}second");
  expect(onSubmit).not.toHaveBeenCalled();
  await expect.element(send).toBeEnabled();

  await userEvent.keyboard("{Enter}");
  expect(onSubmit).toHaveBeenCalledWith("first\nsecond");
});
