import { describe, expect, it } from "vitest";

import {
  ORIGINAL_PLUGIN_SIDEBAR_PROVIDER,
  pluginSidebarContributionKey,
  resolvePluginSidebarContribution,
  splitPluginSidebarFooterContributions,
  togglePluginSidebarDisclosure,
} from "./PluginSidebar.logic";

const contributions = [
  { id: "compact", plugin: { id: "@acme/compact", generation: 1 } },
  { id: "teams", plugin: { id: "@acme/teams", generation: 2 } },
] as const;

describe("PluginSidebar logic", () => {
  it("keeps Original as the explicit default and resolves a saved provider by stable identity", () => {
    expect(resolvePluginSidebarContribution(contributions, ORIGINAL_PLUGIN_SIDEBAR_PROVIDER)).toBe(
      null,
    );

    const selectedKey = pluginSidebarContributionKey(contributions[1]);
    expect(resolvePluginSidebarContribution(contributions, selectedKey)).toBe(contributions[1]);
  });

  it("falls back to Original when the selected provider is missing or disabled", () => {
    expect(resolvePluginSidebarContribution(contributions, '["@missing/plugin","threads"]')).toBe(
      null,
    );
  });

  it("caps direct footer controls and sends the rest to overflow", () => {
    expect(splitPluginSidebarFooterContributions(["a", "b", "c", "d"], 2)).toEqual({
      visible: ["a", "b"],
      overflow: ["c", "d"],
    });
  });

  it("keeps only one footer disclosure open", () => {
    expect(togglePluginSidebarDisclosure(null, "first")).toBe("first");
    expect(togglePluginSidebarDisclosure("first", "second")).toBe("second");
    expect(togglePluginSidebarDisclosure("second", "second")).toBe(null);
  });
});
