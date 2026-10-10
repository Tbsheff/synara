import type { SynaraPluginDescriptor } from "@synara/plugin-sdk/app";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ActivePluginContribution } from "./frontendRuntime";
import { PluginSettingsSectionList } from "./PluginSettingsSections";
import { normalizeSettingsSection, SETTINGS_NAV_ITEMS } from "../settingsNavigation";

const plugin: SynaraPluginDescriptor = {
  id: "acme.tools",
  displayName: "Acme Tools",
  version: "1.0.0",
  apiVersion: 2,
  generation: 7,
};

describe("PluginSettingsSectionList", () => {
  it("keeps one stable host-owned Extensions settings destination", () => {
    expect(normalizeSettingsSection("extensions")).toBe("extensions");
    expect(SETTINGS_NAV_ITEMS.filter(({ id }) => id === "extensions")).toEqual([
      expect.objectContaining({
        group: "integrations",
        label: "Extensions",
      }),
    ]);
  });

  it("renders every section with host-owned labels and plugin context", () => {
    const contributions: ReadonlyArray<ActivePluginContribution<"settingsSections">> = [
      {
        id: "account",
        title: "Account",
        description: "Configure the Acme account.",
        plugin,
        component: ({ context, plugin: receivedPlugin }) => (
          <p>{`${receivedPlugin.id}:${context.projectId}:${context.threadId ?? "none"}`}</p>
        ),
      },
      {
        id: "plain",
        plugin,
        component: () => <p>Plain settings</p>,
      },
    ];

    const markup = renderToStaticMarkup(
      <PluginSettingsSectionList
        context={{ projectId: "project-1", threadId: null }}
        contributions={contributions}
      />,
    );

    expect(markup).toContain("Account");
    expect(markup).toContain("Configure the Acme account.");
    expect(markup).toContain("acme.tools:project-1:none");
    expect(markup).toContain("Plain settings");
  });

  it("shows a stable empty state when no plugin has settings", () => {
    const markup = renderToStaticMarkup(
      <PluginSettingsSectionList
        context={{ projectId: null, threadId: null }}
        contributions={[]}
      />,
    );

    expect(markup).toContain("No extension settings are available.");
  });
});
