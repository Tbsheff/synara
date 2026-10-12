import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { QueuedComposerTurn } from "../../composerDraftStore";
import { ComposerQueuedHeader } from "./ComposerQueuedHeader";

const QUEUED_TURN = {
  id: "queued-1",
  kind: "chat",
  createdAt: "2026-10-11T00:00:00.000Z",
  previewText: "Refactor the parser\nThen update the hidden second-line instructions",
  prompt: "Refactor the parser\nThen update the hidden second-line instructions",
  images: [{ id: "image-1" }, { id: "image-2" }],
  files: [{ id: "file-1" }],
  assistantSelections: [],
  browserAnnotations: [],
  terminalContexts: [],
  fileComments: [],
  pastedTexts: [],
  pullRequestContexts: [],
  skills: [],
  mentions: [],
} as unknown as QueuedComposerTurn;

describe("ComposerQueuedHeader", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("previews the full queued prompt without changing the queue", async () => {
    const onSteer = vi.fn();
    const onRemove = vi.fn();
    const onEdit = vi.fn();
    const screen = await render(
      <ComposerQueuedHeader
        queuedTurns={[QUEUED_TURN]}
        onSteer={onSteer}
        onRemove={onRemove}
        onEdit={onEdit}
      />,
    );

    const toggle = page.getByRole("button", { name: "Show full queued follow-up" });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    const regionId = toggle.element().getAttribute("aria-controls");
    expect(regionId).toBeTruthy();
    const region = document.getElementById(regionId!);
    expect(region?.closest("[aria-hidden='true']")).not.toBeNull();

    await toggle.click();

    const hideToggle = page.getByRole("button", { name: "Hide full queued follow-up" });
    await expect.element(hideToggle).toHaveAttribute("aria-expanded", "true");
    expect(region?.closest("[aria-hidden='true']")).toBeNull();
    expect(region?.textContent).toContain("Then update the hidden second-line instructions");
    expect(region?.textContent).toContain("2 images");
    expect(region?.textContent).toContain("1 file");

    await hideToggle.click();
    await expect
      .element(page.getByRole("button", { name: "Show full queued follow-up" }))
      .toHaveAttribute("aria-expanded", "false");

    expect(onSteer).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();

    await screen.unmount();
  });
});
