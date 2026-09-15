import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeHarness = vi.hoisted(() => ({
  contributions: new Map<string, readonly unknown[]>(),
}));

vi.mock("./runtime", () => ({
  usePluginContributions: (kind: string) => runtimeHarness.contributions.get(kind) ?? [],
  PluginContributionErrorBoundary: ({ children }: { children: ReactNode }) => children,
}));

import {
  PluginSidebarNavigationSurface,
  PluginThreadListSurface,
} from "./PluginSidebar";
import { pluginSidebarContributionKey } from "./PluginSidebar.logic";

const context = { projectId: "project-1", threadId: "thread-1" };
const plugin = {
  id: "@acme/sidebar",
  displayName: "Acme Sidebar",
  version: "1.0.0",
  apiVersion: 2 as const,
  generation: 1,
};

describe("PluginSidebar exclusive surfaces", () => {
  beforeEach(() => runtimeHarness.contributions.clear());

  it("renders Original when no saved navigation provider is available", () => {
    const html = renderToStaticMarkup(
      <PluginSidebarNavigationSurface context={context} selectedProvider="missing">
        <div>Original navigation</div>
      </PluginSidebarNavigationSurface>,
    );

    expect(html).toContain("Original navigation");
  });

  it("gives a selected thread-list provider access to Original", () => {
    const contribution = {
      id: "threads",
      title: "Compact threads",
      plugin,
      component: ({ Original }: { Original: React.ComponentType }) => (
        <div>
          Custom thread list
          <Original />
        </div>
      ),
    };
    runtimeHarness.contributions.set("threadLists", [contribution]);

    const html = renderToStaticMarkup(
      <PluginThreadListSurface
        context={context}
        selectedProvider={pluginSidebarContributionKey(contribution)}
      >
        <div>Original thread list</div>
      </PluginThreadListSurface>,
    );

    expect(html).toContain("Custom thread list");
    expect(html).toContain("Original thread list");
  });
});
