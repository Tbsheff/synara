import type { SynaraPluginDescriptor } from "@synara/contracts";
import * as PluginSdkNamespace from "@synara/plugin-sdk";
import type { JsonValue } from "@synara/plugin-sdk";
import {
  PluginAppRuntimeContext,
  type PluginAppRuntime,
  type PluginNavPanelContribution,
  type SynaraPluginAppContext,
} from "@synara/plugin-sdk/app";
import reviewQueueApp from "@synara/plugin-review-queue/app";
import { reviewQueueManifest } from "@synara/plugin-review-queue/manifest";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as ReactNamespace from "react";
import * as ReactDomNamespace from "react-dom";
import * as ReactDomClientNamespace from "react-dom/client";
import * as JsxDevRuntimeNamespace from "react/jsx-dev-runtime";
import * as JsxRuntimeNamespace from "react/jsx-runtime";
import * as PluginSdkAppNamespace from "@synara/plugin-sdk/app";
import {
  Component,
  createContext,
  useEffect,
  useContext,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";

import { ensureNativeApi } from "~/nativeApi";
import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";

import {
  collectPluginAppRegistrations,
  type RegisteredPluginApp,
} from "./registrations";

const APP_REGISTRY = [collectPluginAppRegistrations(reviewQueueManifest.id, reviewQueueApp)];

Object.assign(globalThis, {
  __synaraPluginRuntime: {
    react: ReactNamespace,
    reactDom: ReactDomNamespace,
    reactDomClient: ReactDomClientNamespace,
    jsxRuntime: JsxRuntimeNamespace,
    jsxDevRuntime: JsxDevRuntimeNamespace,
    pluginSdk: PluginSdkNamespace,
    pluginSdkApp: PluginSdkAppNamespace,
  },
});

function installPluginStyles(plugin: SynaraPluginDescriptor) {
  const selector = `link[data-synara-plugin=${JSON.stringify(plugin.id)}]`;
  document.head.querySelector(selector)?.remove();
  if (!plugin.appCssUrl) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = resolveWsHttpUrl(plugin.appCssUrl);
  link.dataset.synaraPlugin = plugin.id;
  document.head.append(link);
}

export interface ActivePluginPanel extends PluginNavPanelContribution {
  readonly plugin: SynaraPluginDescriptor;
}

const ActivePluginPanelsContext = createContext<ReadonlyArray<ActivePluginPanel>>([]);

export function PluginRuntimeProvider({ children }: { readonly children: ReactNode }) {
  const navigate = useNavigate();
  const [appRegistry, setAppRegistry] = useState<ReadonlyArray<RegisteredPluginApp>>(APP_REGISTRY);
  const loadedUrls = useRef(new Map<string, string>());
  const loadingUrls = useRef(new Map<string, string>());
  const desiredUrls = useRef(new Map<string, string>());
  const pluginsQuery = useQuery({
    queryKey: ["synara-plugins"],
    queryFn: () => ensureNativeApi().plugins.list(),
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
  const runtime = useMemo<PluginAppRuntime>(
    () => ({
      navigate: (to) => void navigate({ to }),
      editPlugin: ({ plugin, projectId }) =>
        ensureNativeApi().plugins.edit({
          pluginId: plugin.id,
          generation: plugin.generation,
          projectId,
          operationId: crypto.randomUUID(),
        }),
      call: async ({ plugin, method, contract, input }) => {
        const result = await ensureNativeApi().plugins.call({
          pluginId: plugin.id,
          generation: plugin.generation,
          method,
          input: input as JsonValue,
        });
        return contract.output.parse(result.output, "output");
      },
    }),
    [navigate],
  );
  useEffect(() => {
    if (!pluginsQuery.data) return;
    const plugins = pluginsQuery.data;
    const activeIds = new Set(plugins.map((plugin) => plugin.id));
    const nextDesiredUrls = new Map(
      plugins.flatMap((plugin) =>
        plugin.appUrl ? [[plugin.id, resolveWsHttpUrl(plugin.appUrl)] as const] : [],
      ),
    );
    desiredUrls.current = nextDesiredUrls;
    for (const [pluginId, loadedUrl] of loadedUrls.current) {
      if (nextDesiredUrls.get(pluginId) === loadedUrl) continue;
      loadedUrls.current.delete(pluginId);
      document.head
        .querySelector(`link[data-synara-plugin=${JSON.stringify(pluginId)}]`)
        ?.remove();
    }
    setAppRegistry((current) => [
      ...APP_REGISTRY.filter((entry) => activeIds.has(entry.pluginId)),
      ...current.filter(
        (entry) =>
          !APP_REGISTRY.some((builtIn) => builtIn.pluginId === entry.pluginId) &&
          loadedUrls.current.get(entry.pluginId) === nextDesiredUrls.get(entry.pluginId),
      ),
    ]);

    for (const plugin of plugins) {
      if (
        !plugin.appUrl ||
        loadedUrls.current.get(plugin.id) === plugin.appUrl ||
        loadingUrls.current.get(plugin.id) === plugin.appUrl
      ) {
        continue;
      }
      const requestedUrl = resolveWsHttpUrl(plugin.appUrl);
      loadingUrls.current.set(plugin.id, requestedUrl);
        void import(requestedUrl)
        .then((module: { readonly default?: unknown }) => {
          if (desiredUrls.current.get(plugin.id) !== requestedUrl) return;
          const registered = collectPluginAppRegistrations(
            plugin.id,
            module.default,
            requestedUrl,
          );
          installPluginStyles(plugin);
          loadedUrls.current.set(plugin.id, requestedUrl);
          setAppRegistry((current) => [
            ...current.filter((entry) => entry.pluginId !== plugin.id),
            registered,
          ]);
        })
        .catch((cause: unknown) => console.error(`Plugin app failed to load: ${plugin.id}`, cause))
        .finally(() => {
          if (loadingUrls.current.get(plugin.id) === requestedUrl) {
            loadingUrls.current.delete(plugin.id);
          }
        });
    }
  }, [pluginsQuery.data]);
  const panels = useMemo(() => {
    const activeById = new Map((pluginsQuery.data ?? []).map((plugin) => [plugin.id, plugin]));
    return appRegistry.flatMap((registered) => {
      const plugin = activeById.get(registered.pluginId);
      const currentAppUrl = plugin?.appUrl ? resolveWsHttpUrl(plugin.appUrl) : undefined;
      return plugin && registered.appUrl === currentAppUrl
        ? registered.navPanels.map((panel) => ({ ...panel, plugin }))
        : [];
    });
  }, [appRegistry, pluginsQuery.data]);

  return (
    <PluginAppRuntimeContext.Provider value={runtime}>
      <ActivePluginPanelsContext.Provider value={panels}>
        {children}
      </ActivePluginPanelsContext.Provider>
    </PluginAppRuntimeContext.Provider>
  );
}

export function usePluginNavPanels(): ReadonlyArray<ActivePluginPanel> {
  return useContext(ActivePluginPanelsContext);
}

class PluginPanelErrorBoundary extends Component<
  { readonly children: ReactNode; readonly pluginName: string },
  { readonly error: Error | null }
> {
  state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Plugin panel failed: ${this.props.pluginName}`, error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="chat-content-card flex min-h-0 flex-1 items-center justify-center bg-background p-8">
          <div className="max-w-md rounded-xl border bg-card p-6 text-center">
            <h1 className="text-base font-semibold">Plugin panel failed</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {this.props.pluginName} stopped in its own error boundary. Synara is still running.
            </p>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}

export function PluginPanel({
  pluginKey,
  panelId,
  context,
}: {
  readonly pluginKey: string;
  readonly panelId: string;
  readonly context: SynaraPluginAppContext;
}) {
  const panels = usePluginNavPanels();
  const panel = panels.find(
    (candidate) => candidate.plugin.app === pluginKey && candidate.id === panelId,
  );
  if (!panel) {
    return (
      <main className="chat-content-card flex min-h-0 flex-1 items-center justify-center bg-background p-8">
        <p className="text-sm text-muted-foreground">Plugin panel not found.</p>
      </main>
    );
  }
  const Panel = panel.component;
  return (
    <PluginPanelErrorBoundary
      key={`${panel.plugin.id}:${panel.id}:${panel.plugin.generation}`}
      pluginName={panel.plugin.displayName}
    >
      <Panel context={context} plugin={panel.plugin} />
    </PluginPanelErrorBoundary>
  );
}
