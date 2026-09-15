import type { SynaraPluginDescriptor } from "@synara/contracts";
import type { PluginContentScriptRegistration } from "@synara/plugin-sdk/app";
import { describe, expect, it, vi } from "vitest";

import { collectPluginAppRegistrations } from "./registrations";
import {
  collectPluginContributions,
  ContentScriptHost,
  createPluginTargetMap,
  PLUGIN_CONTRIBUTION_KINDS,
  publishLoadedPluginApp,
  reconcilePluginApps,
  type ActivePluginApp,
} from "./frontendRuntime";

const resolveUrl = (url: string) => new URL(url, "http://127.0.0.1:58090").href;

function plugin(
  generation: number,
  appUrl = "/api/plugin-assets/acme/app.js?v=one",
): SynaraPluginDescriptor {
  return {
    id: "acme.plugin",
    displayName: "Acme",
    version: "1.0.0",
    apiVersion: 2,
    generation,
    app: "acme",
    appUrl,
  };
}

function activePluginApp(descriptor: SynaraPluginDescriptor): ActivePluginApp {
  const target = createPluginTargetMap([descriptor], resolveUrl).get(descriptor.id);
  if (!target) throw new Error("Expected a plugin target.");
  return {
    key: target.key,
    plugin: target.plugin,
    registrations: collectPluginAppRegistrations(descriptor.id, () => undefined, target.appUrl),
  };
}

describe("frontend plugin runtime state", () => {
  it("keeps one resolved key for an unchanged plugin bundle", () => {
    const descriptor = plugin(1);
    const first = createPluginTargetMap([descriptor], resolveUrl).get(descriptor.id);
    const second = createPluginTargetMap([{ ...descriptor }], resolveUrl).get(descriptor.id);

    expect(first?.appUrl).toBe("http://127.0.0.1:58090/api/plugin-assets/acme/app.js?v=one");
    expect(second?.key).toBe(first?.key);
    expect(reconcilePluginApps([activePluginApp(descriptor)], second ? [second] : [], [])).toHaveLength(
      1,
    );
  });

  it("exposes every registration collection and attaches its plugin", () => {
    const app = activePluginApp(plugin(1));
    const registrationKinds = Object.entries(app.registrations)
      .filter(([, value]) => Array.isArray(value))
      .map(([kind]) => kind);

    expect(PLUGIN_CONTRIBUTION_KINDS).toEqual(registrationKinds);
    const withPanel: ActivePluginApp = {
      ...app,
      registrations: {
        ...app.registrations,
        navPanels: [{ id: "panel", title: "Panel", component: () => null }],
      },
    };
    expect(collectPluginContributions([withPanel], "navPanels")[0]?.plugin).toBe(app.plugin);
  });

  it("rejects a bundle that finishes after its generation became stale", () => {
    const oldApp = activePluginApp(plugin(1));
    const targets = createPluginTargetMap([plugin(2)], resolveUrl);

    expect(publishLoadedPluginApp([], oldApp, targets)).toEqual([]);
  });

  it("deactivates the old generation before a replacement loads or fails", () => {
    const oldApp = activePluginApp(plugin(1));
    const replacement = createPluginTargetMap([plugin(2)], resolveUrl);

    expect(reconcilePluginApps([oldApp], [...replacement.values()], [])).toEqual([]);
  });
});

describe("ContentScriptHost", () => {
  it("mounts once and aborts before disposing in reverse order", async () => {
    const events: string[] = [];
    const descriptor = plugin(1);
    const registrations: PluginContentScriptRegistration[] = [
      {
        id: "first",
        mount: ({ pluginId, generation, signal }) => {
          events.push(`mount:first:${pluginId}:${generation}:${signal.aborted}`);
          return () => events.push(`dispose:first:${signal.aborted}`);
        },
      },
      {
        id: "second",
        mount: ({ signal }) => {
          events.push(`mount:second:${signal.aborted}`);
          return () => events.push(`dispose:second:${signal.aborted}`);
        },
      },
    ];
    const app = {
      ...activePluginApp(descriptor),
      registrations: {
        ...activePluginApp(descriptor).registrations,
        contentScripts: registrations,
      },
    };
    const host = new ContentScriptHost();

    host.sync([app]);
    host.sync([app]);
    await host.whenIdle();
    host.sync([]);
    await host.whenIdle();

    expect(events).toEqual([
      "mount:first:acme.plugin:1:false",
      "mount:second:false",
      "dispose:second:true",
      "dispose:first:true",
    ]);
  });

  it("cleans up a late mount instead of activating it", async () => {
    let finishMount: ((dispose: () => void) => void) | undefined;
    let mountSignal: AbortSignal | undefined;
    const dispose = vi.fn();
    const descriptor = plugin(1);
    const app = activePluginApp(descriptor);
    const host = new ContentScriptHost();
    const script: PluginContentScriptRegistration = {
      id: "late",
      mount: ({ signal }) =>
        new Promise<() => void>((resolve) => {
          mountSignal = signal;
          expect(signal.aborted).toBe(false);
          finishMount = resolve;
        }),
    };

    host.sync([
      {
        ...app,
        registrations: { ...app.registrations, contentScripts: [script] },
      },
    ]);
    host.sync([]);
    expect(mountSignal?.aborted).toBe(true);
    finishMount?.(dispose);
    await host.whenIdle();

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("contains mount and cleanup errors and disposes all scripts", async () => {
    const errors: unknown[] = [];
    const disposed = vi.fn();
    const descriptor = plugin(1);
    const app = activePluginApp(descriptor);
    const host = new ContentScriptHost((cause) => errors.push(cause));

    host.sync([
      {
        ...app,
        registrations: {
          ...app.registrations,
          contentScripts: [
            { id: "bad-mount", mount: () => Promise.reject(new Error("mount")) },
            {
              id: "bad-cleanup",
              mount: () => () => {
                disposed();
                throw new Error("cleanup");
              },
            },
          ],
        },
      },
    ]);
    await host.whenIdle();
    await host.dispose();

    expect(disposed).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(2);
  });
});
