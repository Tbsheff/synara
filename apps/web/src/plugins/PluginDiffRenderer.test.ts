import type { SynaraPluginDescriptor } from "@synara/contracts";
import type { PluginDiffRendererProps } from "@synara/plugin-sdk/app";
import { describe, expect, it } from "vitest";

import type { ActivePluginContribution } from "./frontendRuntime";
import { selectPluginDiffRenderer, shouldUsePluginDiffRenderer } from "./PluginDiffRenderer";

const Component = (_props: PluginDiffRendererProps) => null;
const plugin: SynaraPluginDescriptor = {
  id: "acme.diff",
  displayName: "Acme Diff",
  version: "1.0.0",
  apiVersion: 2,
  generation: 1,
  app: "acme-diff",
};

describe("PluginDiffRenderer selection", () => {
  it("uses the first active renderer", () => {
    const first: ActivePluginContribution<"diffRenderers"> = {
      id: "first",
      title: "First",
      component: Component,
      plugin,
    };
    const second: ActivePluginContribution<"diffRenderers"> = {
      ...first,
      id: "second",
      title: "Second",
    };

    expect(selectPluginDiffRenderer([first, second])).toBe(first);
    expect(selectPluginDiffRenderer([])).toBeNull();
  });

  it("does not replace missing patches or git-ref snapshots", () => {
    expect(shouldUsePluginDiffRenderer({ patch: "diff --git a/a b/a", isGitRef: false })).toBe(
      true,
    );
    expect(shouldUsePluginDiffRenderer({ patch: null, isGitRef: false })).toBe(false);
    expect(shouldUsePluginDiffRenderer({ patch: "diff --git a/a b/a", isGitRef: true })).toBe(
      false,
    );
  });
});
