// @vitest-environment happy-dom

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useComposerCommandMenuItems } from "./useComposerCommandMenuItems";

const slashTrigger = {
  kind: "slash-command" as const,
  query: "",
  rangeStart: 0,
  rangeEnd: 1,
};

function renderCommandItems(
  overrides: Partial<Parameters<typeof useComposerCommandMenuItems>[0]> = {},
) {
  return renderHook(() =>
    useComposerCommandMenuItems({
      composerTrigger: slashTrigger,
      provider: "codex",
      providerPlugins: [],
      providerNativeCommands: [],
      providerSkills: [],
      workspaceEntries: [],
      searchableModelOptions: [],
      supportsFastSlashCommand: false,
      canOfferCompactCommand: false,
      canOfferReviewCommand: false,
      canOfferForkCommand: false,
      canOfferSideCommand: false,
      canOfferExportCommand: true,
      dynamicAgents: [],
      ...overrides,
    }),
  ).result.current;
}

describe("useComposerCommandMenuItems", () => {
  it("offers the app export command and hides a colliding provider command", () => {
    const items = renderCommandItems({
      providerNativeCommands: [{ name: "export", description: "Provider export" }],
    });

    expect(items).toContainEqual(
      expect.objectContaining({ type: "slash-command", command: "export" }),
    );
    expect(items).not.toContainEqual(
      expect.objectContaining({ type: "provider-native-command", command: "export" }),
    );
  });

  it("honors a surface app-command allowlist without hiding the provider alternative", () => {
    const items = renderCommandItems({
      providerNativeCommands: [{ name: "export", description: "Provider export" }],
      surfaceAppSlashCommands: new Set(["clear"]),
    });

    expect(
      items.filter((item) => item.type === "slash-command").map((item) => item.command),
    ).toEqual(["clear"]);
    expect(items).toContainEqual(
      expect.objectContaining({ type: "provider-native-command", command: "export" }),
    );
  });
});
