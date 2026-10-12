import "../../index.css";
import { expect, it } from "vitest";
import { cdp } from "vitest/browser";
import { render } from "vitest-browser-react";
import { Dialog, DialogPopup, DialogTitle } from "./dialog";

it("disables shared dialog motion when the reader requests reduced motion", async () => {
  await render(
    <Dialog defaultOpen>
      <DialogPopup>
        <DialogTitle>Motion check</DialogTitle>
      </DialogPopup>
    </Dialog>,
  );
  const popup = document.querySelector<HTMLElement>('[data-slot="dialog-popup"]')!;
  const backdrop = document.querySelector<HTMLElement>('[data-slot="dialog-backdrop"]')!;
  const protocol = cdp() as {
    send: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  };
  await protocol.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  try {
    expect(getComputedStyle(popup).transitionDuration).toBe("0s");
    expect(getComputedStyle(backdrop).transitionDuration).toBe("0s");
  } finally {
    await protocol.send("Emulation.setEmulatedMedia", { features: [] });
  }
});
