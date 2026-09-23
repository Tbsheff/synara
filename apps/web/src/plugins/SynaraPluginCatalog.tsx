import {
  usePluginRuntime,
  type SynaraPluginAppContext,
  type SynaraPluginDescriptor,
} from "@synara/plugin-sdk/app";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import {
  SettingsCard,
  SettingsEmptyState,
  SettingsSectionShell,
} from "~/components/settings/SettingsPanelPrimitives";
import { Button } from "~/components/ui/button";
import { PluginIcon } from "~/lib/icons";
import { ensureNativeApi } from "~/nativeApi";

import { SYNARA_PLUGINS_QUERY_KEY, usePluginNavPanels } from "./runtime";

export function SynaraPluginList({
  layout,
  projectId,
  plugins,
  panelByPluginId,
  loading = false,
  onOpen,
  onEdit,
}: {
  readonly layout: "settings" | "library";
  readonly projectId: string | null;
  readonly plugins: ReadonlyArray<SynaraPluginDescriptor>;
  readonly panelByPluginId: Readonly<Record<string, string>>;
  readonly loading?: boolean;
  readonly onOpen: (plugin: SynaraPluginDescriptor) => void;
  readonly onEdit: (plugin: SynaraPluginDescriptor) => void;
}) {
  const body =
    loading && plugins.length === 0 ? (
      <p className="px-4 py-3 text-sm text-muted-foreground">Loading plugins…</p>
    ) : plugins.length === 0 ? (
      <SettingsEmptyState>
        No Synara plugins are loaded. Built-in plugins such as Puck and Review Queue appear here
        after the app starts.
      </SettingsEmptyState>
    ) : (
      <ul className={layout === "library" ? "grid grid-cols-1 sm:grid-cols-2" : "grid"}>
        {plugins.map((plugin) => {
          const canOpen = Boolean(plugin.app && panelByPluginId[plugin.id]);
          return (
            <li
              key={`${plugin.id}:${plugin.generation}`}
              className="flex items-center gap-3 px-3 py-3"
            >
              <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-[14px] border border-border/60 bg-background">
                <PluginIcon className="size-5 text-muted-foreground" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold text-foreground">
                  {plugin.displayName}
                </p>
                <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                  {plugin.id} · v{plugin.version}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {canOpen ? (
                  <Button type="button" size="xs" variant="outline" onClick={() => onOpen(plugin)}>
                    Open
                  </Button>
                ) : null}
                {plugin.editable && projectId ? (
                  <Button type="button" size="xs" variant="ghost" onClick={() => onEdit(plugin)}>
                    Edit
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    );

  if (layout === "library") {
    return (
      <section aria-label="Synara plugins">
        <h2 className="px-3 pb-1 pt-2 text-[15px] font-semibold text-foreground">Synara</h2>
        <div className="rounded-xl border border-border/60 bg-background/40">{body}</div>
      </section>
    );
  }

  return (
    <SettingsSectionShell title="Installed plugins">
      <SettingsCard divided={false}>{body}</SettingsCard>
    </SettingsSectionShell>
  );
}

export function SynaraPluginCatalog({
  context,
  layout = "settings",
}: {
  readonly context: SynaraPluginAppContext;
  readonly layout?: "settings" | "library";
}) {
  const navigate = useNavigate();
  const runtime = usePluginRuntime();
  const panels = usePluginNavPanels();
  const pluginsQuery = useQuery({
    queryKey: SYNARA_PLUGINS_QUERY_KEY,
    queryFn: () => ensureNativeApi().plugins.list(),
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
  const plugins = pluginsQuery.data ?? [];
  const panelByPluginId = Object.fromEntries(
    panels.flatMap((panel) => (panel.plugin.app ? [[panel.plugin.id, panel.id]] : [])),
  );

  return (
    <SynaraPluginList
      layout={layout}
      projectId={context.projectId}
      plugins={plugins}
      panelByPluginId={panelByPluginId}
      loading={pluginsQuery.isLoading}
      onOpen={(plugin) => {
        const panelId = panelByPluginId[plugin.id];
        if (!plugin.app || !panelId) return;
        void navigate({
          to: "/extensions/$pluginKey/$panelId",
          params: { pluginKey: plugin.app, panelId },
        });
      }}
      onEdit={(plugin) => {
        if (!context.projectId || !plugin.editable) return;
        void runtime
          .editPlugin({ plugin, projectId: context.projectId })
          .then((result: { readonly threadId: string }) => {
            runtime.navigate(`/${result.threadId}`);
          });
      }}
    />
  );
}
