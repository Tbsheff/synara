import "../../index.css";

import { ProjectId, ThreadId, type SynaraPluginDescriptor } from "@synara/contracts";
import type { PluginThreadHeaderActionProps } from "@synara/plugin-sdk/app";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ActivePluginContribution } from "../../plugins/frontendRuntime";
import { PluginThreadHeaderActions } from "./PluginThreadHeaderActions";

const THREAD_ID = ThreadId.makeUnsafe("thread-header-actions");
const PROJECT_ID = ProjectId.makeUnsafe("project-header-actions");

function plugin(id: string, generation: number): SynaraPluginDescriptor {
  return {
    id,
    displayName: id,
    version: "1.0.0",
    apiVersion: 2,
    generation,
    app: id,
  };
}

function action(
  id: string,
  descriptor: SynaraPluginDescriptor,
  component: (props: PluginThreadHeaderActionProps) => React.ReactNode,
): ActivePluginContribution<"threadHeaderActions"> {
  return {
    id,
    title: id,
    component,
    plugin: descriptor,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("PluginThreadHeaderActions", () => {
  it("mounts every action with its thread, project, and plugin context", async () => {
    const firstPlugin = plugin("acme.first", 1);
    const secondPlugin = plugin("acme.second", 3);

    const mounted = await render(
      <PluginThreadHeaderActions
        actions={[
          action("first", firstPlugin, ({ context, plugin: descriptor }) => (
            <output data-testid="first-action">
              {context.threadId}:{context.projectId}:{descriptor.id}
            </output>
          )),
          action("second", secondPlugin, ({ context, plugin: descriptor }) => (
            <output data-testid="second-action">
              {context.threadId}:{context.projectId}:{descriptor.id}
            </output>
          )),
        ]}
        threadId={THREAD_ID}
        projectId={PROJECT_ID}
      />,
    );

    await expect
      .element(mounted.getByTestId("first-action"))
      .toHaveTextContent(`${THREAD_ID}:${PROJECT_ID}:${firstPlugin.id}`);
    await expect
      .element(mounted.getByTestId("second-action"))
      .toHaveTextContent(`${THREAD_ID}:${PROJECT_ID}:${secondPlugin.id}`);
  });

  it("isolates a failed action with a null fallback", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failedPlugin = plugin("acme.failed", 1);
    const healthyPlugin = plugin("acme.healthy", 1);

    const mounted = await render(
      <PluginThreadHeaderActions
        actions={[
          action("failed", failedPlugin, () => {
            throw new Error("plugin action failed");
          }),
          action("healthy", healthyPlugin, () => <button type="button">Healthy action</button>),
        ]}
        threadId={THREAD_ID}
        projectId={null}
      />,
    );

    await expect.element(mounted.getByRole("button", { name: "Healthy action" })).toBeVisible();
    expect(document.body.textContent).not.toContain("Plugin contribution failed");
  });

  it("remounts an action when its plugin generation changes", async () => {
    function StatefulAction({ plugin: descriptor }: PluginThreadHeaderActionProps) {
      const [mountedGeneration] = useState(descriptor.generation);
      return <output data-testid="mounted-generation">{mountedGeneration}</output>;
    }

    const first = plugin("acme.stateful", 1);
    const mounted = await render(
      <PluginThreadHeaderActions
        actions={[action("stateful", first, StatefulAction)]}
        threadId={THREAD_ID}
        projectId={null}
      />,
    );

    await expect.element(mounted.getByTestId("mounted-generation")).toHaveTextContent("1");

    const next = plugin("acme.stateful", 2);
    await mounted.rerender(
      <PluginThreadHeaderActions
        actions={[action("stateful", next, StatefulAction)]}
        threadId={THREAD_ID}
        projectId={null}
      />,
    );

    await expect.element(mounted.getByTestId("mounted-generation")).toHaveTextContent("2");
  });
});
