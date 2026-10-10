import type { SynaraPluginDescriptor } from "@synara/contracts";
import type { PluginSourceCodeRendererProps } from "@synara/plugin-sdk/app";
import { describe, expect, it } from "vitest";

import type { ActivePluginContribution } from "./frontendRuntime";
import { selectPluginSourceCodeRenderer } from "./PluginSourceCodeRenderer";

const Component = (_props: PluginSourceCodeRendererProps) => null;
const plugin: SynaraPluginDescriptor = {
  id: "acme.source",
  displayName: "Acme Source",
  version: "1.0.0",
  apiVersion: 2,
  generation: 1,
  app: "acme-source",
};

describe("PluginSourceCodeRenderer selection", () => {
  it("uses the first active renderer and keeps an empty registry on Original", () => {
    const first: ActivePluginContribution<"sourceCodeRenderers"> = {
      id: "first",
      title: "First",
      component: Component,
      plugin,
    };
    const second: ActivePluginContribution<"sourceCodeRenderers"> = {
      ...first,
      id: "second",
      title: "Second",
    };

    expect(selectPluginSourceCodeRenderer([first, second])).toBe(first);
    expect(selectPluginSourceCodeRenderer([])).toBeNull();
  });
});
