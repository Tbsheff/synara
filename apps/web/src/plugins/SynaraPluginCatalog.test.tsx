import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SynaraPluginList } from "./SynaraPluginCatalog";

describe("SynaraPluginList", () => {
  it("lists loaded Synara plugins and their open action", () => {
    const markup = renderToStaticMarkup(
      <SynaraPluginList
        layout="settings"
        projectId="project-1"
        plugins={[
          {
            id: "@synara/plugin-puck",
            displayName: "Puck",
            version: "0.1.0",
            apiVersion: 2,
            generation: 1,
            app: "puck",
          },
        ]}
        panelByPluginId={{ "@synara/plugin-puck": "orbs" }}
        onOpen={() => undefined}
        onEdit={() => undefined}
      />,
    );
    expect(markup).toContain("Puck");
    expect(markup).toContain("@synara/plugin-puck");
    expect(markup).toContain("Open");
  });

  it("shows a loaded-empty copy when no plugins are active", () => {
    const markup = renderToStaticMarkup(
      <SynaraPluginList
        layout="library"
        projectId={null}
        plugins={[]}
        panelByPluginId={{}}
        onOpen={() => undefined}
        onEdit={() => undefined}
      />,
    );
    expect(markup).toContain("No Synara plugins are loaded");
  });
});
