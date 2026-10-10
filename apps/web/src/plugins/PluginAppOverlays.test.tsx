import type { SynaraPluginDescriptor } from "@synara/plugin-sdk/app";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ActivePluginContribution } from "./frontendRuntime";
import { PluginAppOverlayList } from "./PluginAppOverlays";

const plugin: SynaraPluginDescriptor = {
  id: "acme.overlay",
  displayName: "Acme Overlay",
  version: "1.0.0",
  apiVersion: 2,
  generation: 3,
};

describe("PluginAppOverlayList", () => {
  it("mounts every overlay with plugin and focused chat context", () => {
    const contributions: ReadonlyArray<ActivePluginContribution<"appOverlays">> = [
      {
        id: "first",
        plugin,
        component: ({ context, plugin: receivedPlugin }) => (
          <p>{`${receivedPlugin.id}:${context.projectId}:${context.threadId}`}</p>
        ),
      },
      {
        id: "second",
        plugin,
        component: () => <p>Second overlay</p>,
      },
    ];

    const markup = renderToStaticMarkup(
      <PluginAppOverlayList
        context={{ projectId: "project-1", threadId: "thread-1" }}
        contributions={contributions}
      />,
    );

    expect(markup).toContain("acme.overlay:project-1:thread-1");
    expect(markup).toContain("Second overlay");
  });

  it("renders nothing without overlays", () => {
    const markup = renderToStaticMarkup(
      <PluginAppOverlayList context={{ projectId: null, threadId: null }} contributions={[]} />,
    );

    expect(markup).toBe("");
  });
});
