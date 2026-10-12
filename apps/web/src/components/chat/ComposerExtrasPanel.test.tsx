import type { ProviderKind } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ComposerExtrasPanel } from "./ComposerExtrasPanel";

vi.mock("./useAppSnapWindows", () => ({
  useAppSnapWindows: () => ({ available: false, windows: [], busy: false }),
}));

it.each(["pi", "antigravity", "omp", "codex"] as const)(
  "renders Plan only for capable %s",
  (provider: ProviderKind) => {
    const html = renderToStaticMarkup(
      <ComposerExtrasPanel
        provider={provider}
        interactionMode="default"
        supportsFastMode={false}
        fastModeEnabled={false}
        panelId="test-extras"
        onAddAttachments={() => {}}
        onToggleFastMode={() => {}}
        onInteractionModeChange={() => {}}
        onInsertGoal={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html.includes("Plan mode")).toBe(provider !== "pi" && provider !== "antigravity");
  },
);
