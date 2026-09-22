import * as PluginSdkNamespace from "@synara/plugin-sdk";
import type { JsonValue } from "@synara/plugin-sdk";
import {
  PluginAppRuntimeContext,
  type PluginAppRuntime,
  type SynaraPluginAppContext,
  type SynaraPluginDescriptor,
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

import { collectPluginAppRegistrations } from "./registrations";
import {
  collectPluginContributions,
  ContentScriptHost,
  createPluginTargetMap,
  publishLoadedPluginApp,
  reconcilePluginApps,
  type ActivePluginApp,
  type ActivePluginContribution,
  type PluginContributionKind,
  type PluginRuntimeTarget,
} from "./frontendRuntime";

const BUILT_IN_APP_REGISTRATIONS = [
  collectPluginAppRegistrations(reviewQueueManifest.id, reviewQueueApp),
];

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

function syncPluginStyles(apps: readonly ActivePluginApp[]): void {
  const desiredStyles = new Map(
    apps.flatMap((app) =>
      app.plugin.appCssUrl
        ? [
            [
              app.key,
              { pluginId: app.plugin.id, href: resolveWsHttpUrl(app.plugin.appCssUrl) },
            ] as const,
          ]
        : [],
    ),
  );

  const installedStyles = new Map<string, HTMLLinkElement>();
  for (const link of document.head.querySelectorAll<HTMLLinkElement>(
    "link[data-synara-plugin], link[data-synara-plugin-key]",
  )) {
    const key = link.dataset.synaraPluginKey;
    if (!key) {
      link.remove();
      continue;
    }
    const desired = desiredStyles.get(key);
    if (!desired || link.href !== desired.href) {
      link.remove();
      continue;
    }
    installedStyles.set(key, link);
  }

  for (const [key, style] of desiredStyles) {
    if (installedStyles.has(key)) continue;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = style.href;
    link.dataset.synaraPlugin = style.pluginId;
    link.dataset.synaraPluginKey = key;
    document.head.append(link);
  }
}

function clearPluginStyles(): void {
  for (const link of document.head.querySelectorAll(
    "link[data-synara-plugin], link[data-synara-plugin-key]",
  )) {
    link.remove();
  }
}

const ActivePluginAppsContext = createContext<ReadonlyArray<ActivePluginApp>>([]);

export function PluginRuntimeProvider({ children }: { readonly children: ReactNode }) {
  const navigate = useNavigate();
  const [activeApps, setActiveApps] = useState<ReadonlyArray<ActivePluginApp>>([]);
  const activeAppsRef = useRef<ReadonlyArray<ActivePluginApp>>([]);
  const loadingKeys = useRef(new Set<string>());
  const desiredTargets = useRef<ReadonlyMap<string, PluginRuntimeTarget>>(new Map());
  const contentScriptHost = useMemo(() => new ContentScriptHost(), []);
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
          createdAt: new Date().toISOString(),
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
    const applyActiveApps = (nextApps: readonly ActivePluginApp[]) => {
      activeAppsRef.current = nextApps;
      contentScriptHost.sync(nextApps);
      syncPluginStyles(nextApps);
      setActiveApps(nextApps);
    };
    const targets = createPluginTargetMap(pluginsQuery.data, resolveWsHttpUrl);
    desiredTargets.current = targets;
    const currentApps = reconcilePluginApps(
      activeAppsRef.current,
      targets.values(),
      BUILT_IN_APP_REGISTRATIONS,
    );
    applyActiveApps(currentApps);

    for (const target of targets.values()) {
      if (
        !target.appUrl ||
        currentApps.some((app) => app.key === target.key) ||
        loadingKeys.current.has(target.key)
      ) {
        continue;
      }
      loadingKeys.current.add(target.key);
      void import(/* @vite-ignore */ target.appUrl)
        .then((module: { readonly default?: unknown }) => {
          if (desiredTargets.current.get(target.plugin.id)?.key !== target.key) return;
          const registered = collectPluginAppRegistrations(
            target.plugin.id,
            module.default,
            target.appUrl,
          );
          const nextApps = publishLoadedPluginApp(
            activeAppsRef.current,
            { key: target.key, plugin: target.plugin, registrations: registered },
            desiredTargets.current,
          );
          if (nextApps === activeAppsRef.current) return;
          applyActiveApps(nextApps);
        })
        .catch((cause: unknown) =>
          console.error(`Plugin app failed to load: ${target.plugin.id}`, cause),
        )
        .finally(() => {
          loadingKeys.current.delete(target.key);
        });
    }
  }, [contentScriptHost, pluginsQuery.data, pluginsQuery.dataUpdatedAt]);

  useEffect(
    () => () => {
      activeAppsRef.current = [];
      desiredTargets.current = new Map();
      void contentScriptHost.dispose();
      clearPluginStyles();
    },
    [contentScriptHost],
  );

  return (
    <PluginAppRuntimeContext.Provider value={runtime}>
      <ActivePluginAppsContext.Provider value={activeApps}>
        {children}
      </ActivePluginAppsContext.Provider>
    </PluginAppRuntimeContext.Provider>
  );
}

export function usePluginContributions<Kind extends PluginContributionKind>(
  kind: Kind,
): ReadonlyArray<ActivePluginContribution<Kind>> {
  const apps = useContext(ActivePluginAppsContext);
  return useMemo(() => collectPluginContributions(apps, kind), [apps, kind]);
}

export type ActivePluginPanel = ActivePluginContribution<"navPanels">;

export function usePluginNavPanels(): ReadonlyArray<ActivePluginPanel> {
  return usePluginContributions("navPanels");
}

export interface PluginContributionErrorBoundaryProps {
  readonly children: ReactNode;
  readonly plugin: SynaraPluginDescriptor;
  readonly contributionId?: string;
  readonly fallback?: ReactNode;
  readonly onError?: (error: Error) => void;
}

export class PluginContributionErrorBoundary extends Component<
  PluginContributionErrorBoundaryProps,
  { readonly error: Error | null }
> {
  override state: { readonly error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `Plugin contribution failed: ${this.props.plugin.id}${this.props.contributionId ? `/${this.props.contributionId}` : ""}`,
      error,
      info,
    );
    this.props.onError?.(error);
  }

  override componentDidUpdate(previous: Readonly<PluginContributionErrorBoundaryProps>) {
    if (
      this.state.error &&
      (previous.plugin.id !== this.props.plugin.id ||
        previous.plugin.generation !== this.props.plugin.generation ||
        previous.contributionId !== this.props.contributionId)
    ) {
      this.setState({ error: null });
    }
  }

  override render() {
    if (this.state.error) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return (
        <main className="chat-content-card flex min-h-0 flex-1 items-center justify-center bg-background p-8">
          <div className="max-w-md rounded-xl border bg-card p-6 text-center">
            <h1 className="text-ui font-semibold">Plugin contribution failed</h1>
            <p className="mt-2 text-ui-sm text-muted-foreground">
              {this.props.plugin.displayName} stopped in its own error boundary. Synara is still
              running.
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
        <p className="text-ui-sm text-muted-foreground">Plugin panel not found.</p>
      </main>
    );
  }
  const Panel = panel.component;
  return (
    <PluginContributionErrorBoundary
      key={`${panel.plugin.id}:${panel.id}:${panel.plugin.generation}`}
      plugin={panel.plugin}
      contributionId={panel.id}
    >
      <Panel context={context} plugin={panel.plugin} />
    </PluginContributionErrorBoundary>
  );
}
