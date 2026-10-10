import { describe, expect, it } from "vitest";

import { resolvePluginTimelineRenderer } from "./PluginTimelineRenderer";

describe("PluginTimelineRendererHost", () => {
  it("renders a matching stable kind and gives it the host fallback", () => {
    const contributions = [
      {
        kind: "example:review",
        component: ({ payload, Original: Fallback }: any) => (
          <div>
            plugin row:{String(payload.value)} <Fallback />
          </div>
        ),
        plugin: {
          id: "example",
          displayName: "Example",
          version: "1.0.0",
          apiVersion: 1,
          generation: 1,
          enabled: true,
          source: "local",
        },
      },
    ];

    expect(resolvePluginTimelineRenderer(contributions as any, "example:review")).toBe(
      contributions[0],
    );
  });

  it("uses the original for no match, collisions, and component crashes", () => {
    const plugin = {
      id: "example",
      displayName: "Example",
      version: "1.0.0",
      apiVersion: 1,
      generation: 1,
      enabled: true,
      source: "local",
    };
    const contributions = [
      { kind: "collision", component: () => <div>one</div>, plugin },
      { kind: "collision", component: () => <div>two</div>, plugin: { ...plugin, id: "two" } },
      {
        kind: "crash",
        component: () => {
          throw new Error("boom");
        },
        plugin,
      },
    ];

    expect(resolvePluginTimelineRenderer(contributions as any, "missing")).toBeNull();
    expect(resolvePluginTimelineRenderer(contributions as any, "collision")).toBeNull();
    expect(resolvePluginTimelineRenderer(contributions as any, "crash")).toBe(contributions[2]);
  });
});
