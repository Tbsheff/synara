// FILE: ComposerVoiceRecorderBar.browser.tsx
// Purpose: Verifies voice recording exposes cancel plus a send-styled primary stop action.
// Layer: Browser UI test
// Depends on: vitest browser rendering and ComposerVoiceRecorderBar.

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerVoiceRecorderBar } from "./ComposerVoiceRecorderBar";

describe("ComposerVoiceRecorderBar", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("uses the send treatment for stop while keeping cancel separate", async () => {
    const onDiscard = vi.fn();
    const onStop = vi.fn();
    const screen = await render(
      <ComposerVoiceRecorderBar
        durationLabel="0:03"
        isRecording
        isTranscribing={false}
        waveformLevels={[0.2, 0.6, 0.4]}
        onDiscard={onDiscard}
        onStop={onStop}
      />,
    );

    const stopButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Stop voice recording"]',
    );
    expect(stopButton).not.toBeNull();
    expect(stopButton?.className).toContain("bg-[var(--color-text-foreground)]");
    expect(stopButton?.className).toContain("text-[var(--color-background-surface)]");
    expect(document.querySelector('button[aria-label="Send voice note"]')).toBeNull();

    await page.getByRole("button", { name: "Stop voice recording" }).click();
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Cancel voice recording" }).click();
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);

    await screen.unmount();
  });

  it("keeps cancel available while the voice note transcribes", async () => {
    const onDiscard = vi.fn();
    const onStop = vi.fn();
    const screen = await render(
      <ComposerVoiceRecorderBar
        durationLabel="0:03"
        isRecording={false}
        isTranscribing
        waveformLevels={[0.2, 0.6, 0.4]}
        onDiscard={onDiscard}
        onStop={onStop}
      />,
    );

    const cancelButton = page.getByRole("button", { name: "Cancel transcription" });
    await expect.element(cancelButton).toBeEnabled();
    await expect
      .element(page.getByRole("button", { name: "Transcribing voice note" }))
      .toBeDisabled();

    await cancelButton.click();
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();

    await screen.unmount();
  });
});
