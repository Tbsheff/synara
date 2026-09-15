import type { JsonValue } from "@synara/plugin-sdk";
import type { SynaraPluginAppContext } from "@synara/plugin-sdk/app";
import type { PluginPanelScope } from "~/rightDockStore.logic";

import { usePluginPanelActions } from "./PluginPanelActions";
import { PluginContributionErrorBoundary } from "./runtime";

export function PluginPanelPane(props: {
  readonly context: SynaraPluginAppContext;
  readonly pluginId: string | null;
  readonly contributionId: string | null;
  readonly scope: PluginPanelScope | null;
  readonly params: JsonValue | null;
}) {
  const panels = usePluginPanelActions(props.scope ?? "thread");
  const panel = panels.find(
    (candidate) =>
      candidate.plugin.id === props.pluginId && candidate.id === props.contributionId,
  );
  if (!panel) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        This extension panel is not available.
      </div>
    );
  }
  const Panel = panel.component;
  return (
    <PluginContributionErrorBoundary
      key={`${panel.plugin.id}:${panel.id}:${panel.plugin.generation}`}
      plugin={panel.plugin}
      contributionId={panel.id}
      fallback={
        <div className="flex h-full items-center justify-center p-6 text-sm text-destructive">
          This extension panel failed.
        </div>
      }
    >
      <Panel context={props.context} plugin={panel.plugin} params={props.params} />
    </PluginContributionErrorBoundary>
  );
}
