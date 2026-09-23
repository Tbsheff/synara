import type { SynaraPluginDescriptor } from "@synara/contracts";
import type { PluginContentScriptDisposer } from "@synara/plugin-sdk/app";

import type { RegisteredPluginApp } from "./registrations";

export const PLUGIN_CONTRIBUTION_KINDS = [
  "homepageSections",
  "settingsSections",
  "appOverlays",
  "navPanels",
  "threadPanelActions",
  "newThreadPanelActions",
  "pendingInteractions",
  "sidebarFooterActions",
  "sidebarNavigations",
  "threadLists",
  "threadHeaderActions",
  "browserToolbarActions",
  "fileOpeners",
  "sourceCodeRenderers",
  "diffRenderers",
  "messageDirectives",
  "messageActions",
  "commands",
  "providerIcons",
  "timelineRenderers",
  "composerCustomizations",
  "contentScripts",
  "sidebarFooterItems",
  "icons",
] as const satisfies ReadonlyArray<PluginContributionKind>;

export type PluginContributionKind = {
  [Kind in keyof RegisteredPluginApp]: NonNullable<
    RegisteredPluginApp[Kind]
  > extends ReadonlyArray<unknown>
    ? Kind
    : never;
}[keyof RegisteredPluginApp] &
  keyof RegisteredPluginApp;

export type PluginRegistration<Kind extends PluginContributionKind> =
  RegisteredPluginApp[Kind] extends ReadonlyArray<infer Registration extends object>
    ? Registration
    : never;

export type ActivePluginContribution<Kind extends PluginContributionKind> =
  PluginRegistration<Kind> & {
    readonly plugin: SynaraPluginDescriptor;
  };

type PluginContributionLists = {
  readonly [Kind in PluginContributionKind]: ReadonlyArray<PluginRegistration<Kind>>;
};

export interface PluginRuntimeTarget {
  readonly key: string;
  readonly plugin: SynaraPluginDescriptor;
  readonly appUrl?: string;
  readonly appCssUrl?: string;
}

export interface ActivePluginApp {
  readonly key: string;
  readonly plugin: SynaraPluginDescriptor;
  readonly registrations: RegisteredPluginApp;
}

function pluginRuntimeKey(pluginId: string, generation: number, appUrl?: string): string {
  return JSON.stringify([pluginId, generation, appUrl ?? null]);
}

export function createPluginTargetMap(
  plugins: readonly SynaraPluginDescriptor[],
  resolveUrl: (url: string) => string,
): ReadonlyMap<string, PluginRuntimeTarget> {
  return new Map(
    plugins.map((plugin) => {
      const appUrl = plugin.appUrl ? resolveUrl(plugin.appUrl) : undefined;
      const appCssUrl = plugin.appCssUrl ? resolveUrl(plugin.appCssUrl) : undefined;
      const target: PluginRuntimeTarget = {
        key: pluginRuntimeKey(plugin.id, plugin.generation, appUrl),
        plugin,
        ...(appUrl ? { appUrl } : {}),
        ...(appCssUrl ? { appCssUrl } : {}),
      };
      return [plugin.id, target] as const;
    }),
  );
}

export function reconcilePluginApps(
  current: readonly ActivePluginApp[],
  targets: Iterable<PluginRuntimeTarget>,
  builtIns: readonly RegisteredPluginApp[],
): readonly ActivePluginApp[] {
  const currentByKey = new Map(current.map((app) => [app.key, app]));
  const builtInsByPluginId = new Map(builtIns.map((app) => [app.pluginId, app]));
  const next: ActivePluginApp[] = [];

  for (const target of targets) {
    const loaded = currentByKey.get(target.key);
    if (loaded) {
      next.push(loaded.plugin === target.plugin ? loaded : { ...loaded, plugin: target.plugin });
      continue;
    }

    if (target.appUrl) continue;
    const builtIn = builtInsByPluginId.get(target.plugin.id);
    if (builtIn) {
      next.push({ key: target.key, plugin: target.plugin, registrations: builtIn });
    }
  }

  return next.length === current.length && next.every((app, index) => app === current[index])
    ? current
    : next;
}

export function publishLoadedPluginApp(
  current: readonly ActivePluginApp[],
  candidate: ActivePluginApp,
  targets: ReadonlyMap<string, PluginRuntimeTarget>,
): readonly ActivePluginApp[] {
  const target = targets.get(candidate.plugin.id);
  if (!target || target.key !== candidate.key) return current;

  return reconcilePluginApps(
    [
      ...current.filter((app) => app.plugin.id !== candidate.plugin.id),
      { ...candidate, plugin: target.plugin },
    ],
    targets.values(),
    [],
  );
}

export function collectPluginContributions<Kind extends PluginContributionKind>(
  apps: readonly ActivePluginApp[],
  kind: Kind,
): ReadonlyArray<ActivePluginContribution<Kind>> {
  return apps.flatMap((app) => {
    const lists: PluginContributionLists = app.registrations;
    const registrations: ReadonlyArray<PluginRegistration<Kind>> = lists[kind];
    return registrations.map((registration) => ({
      ...registration,
      plugin: app.plugin,
    }));
  });
}

interface ContentScriptScope {
  readonly app: ActivePluginApp;
  readonly controller: AbortController;
  readonly disposers: Array<{
    readonly scriptId: string;
    readonly dispose: PluginContentScriptDisposer;
  }>;
  active: boolean;
}

export type PluginContentScriptErrorHandler = (
  cause: unknown,
  details: {
    readonly phase: "mount" | "dispose";
    readonly pluginId: string;
    readonly scriptId: string;
  },
) => void;

function defaultContentScriptErrorHandler(
  cause: unknown,
  details: Parameters<PluginContentScriptErrorHandler>[1],
): void {
  console.error(
    `Plugin content script failed during ${details.phase}: ${details.pluginId}/${details.scriptId}`,
    cause,
  );
}

export class ContentScriptHost {
  readonly #scopes = new Map<string, ContentScriptScope>();
  readonly #operations = new Set<Promise<void>>();

  constructor(
    private readonly onError: PluginContentScriptErrorHandler = defaultContentScriptErrorHandler,
  ) {}

  sync(apps: readonly ActivePluginApp[]): void {
    const desiredKeys = new Set(apps.map((app) => app.key));
    for (const [key, scope] of this.#scopes) {
      if (desiredKeys.has(key)) continue;
      this.#scopes.delete(key);
      this.#track(this.#deactivate(scope));
    }

    for (const app of apps) {
      if (this.#scopes.has(app.key)) continue;
      const scope: ContentScriptScope = {
        app,
        controller: new AbortController(),
        disposers: [],
        active: true,
      };
      this.#scopes.set(app.key, scope);
      this.#track(this.#mount(scope));
    }
  }

  async whenIdle(): Promise<void> {
    while (this.#operations.size > 0) {
      await Promise.all([...this.#operations]);
    }
  }

  async dispose(): Promise<void> {
    const scopes = [...this.#scopes.values()].reverse();
    this.#scopes.clear();
    for (const scope of scopes) this.#track(this.#deactivate(scope));
    await this.whenIdle();
  }

  #track(operation: Promise<void>): void {
    this.#operations.add(operation);
    void operation.then(
      () => this.#operations.delete(operation),
      () => this.#operations.delete(operation),
    );
  }

  async #mount(scope: ContentScriptScope): Promise<void> {
    for (const script of scope.app.registrations.contentScripts) {
      if (!scope.active) return;
      let dispose: void | PluginContentScriptDisposer;
      try {
        dispose = await script.mount({
          pluginId: scope.app.plugin.id,
          generation: scope.app.plugin.generation,
          signal: scope.controller.signal,
        });
      } catch (cause) {
        this.onError(cause, {
          phase: "mount",
          pluginId: scope.app.plugin.id,
          scriptId: script.id,
        });
        continue;
      }

      if (typeof dispose !== "function") continue;
      if (scope.active) {
        scope.disposers.push({ scriptId: script.id, dispose });
      } else {
        await this.#disposeOne(scope, script.id, dispose);
      }
    }
  }

  async #deactivate(scope: ContentScriptScope): Promise<void> {
    if (!scope.active) return;
    scope.active = false;
    scope.controller.abort();
    const disposers = scope.disposers.splice(0).reverse();
    for (const entry of disposers) {
      await this.#disposeOne(scope, entry.scriptId, entry.dispose);
    }
  }

  async #disposeOne(
    scope: ContentScriptScope,
    scriptId: string,
    dispose: PluginContentScriptDisposer,
  ): Promise<void> {
    try {
      await dispose();
    } catch (cause) {
      this.onError(cause, {
        phase: "dispose",
        pluginId: scope.app.plugin.id,
        scriptId,
      });
    }
  }
}
