import type { SynaraPluginAppContext } from "@synara/plugin-sdk/app";

import type { ActivePluginContribution } from "./frontendRuntime";
import { PluginContributionErrorBoundary, usePluginContributions } from "./runtime";

type ActivePluginAppOverlay = ActivePluginContribution<"appOverlays">;

export function PluginAppOverlayList({
  context,
  contributions,
}: {
  readonly context: SynaraPluginAppContext;
  readonly contributions: ReadonlyArray<ActivePluginAppOverlay>;
}) {
  return contributions.map((contribution) => {
    const Component = contribution.component;
    const key = `${contribution.plugin.id}:${contribution.id}:${contribution.plugin.generation}`;
    return (
      <PluginContributionErrorBoundary
        key={key}
        plugin={contribution.plugin}
        contributionId={contribution.id}
        fallback={null}
      >
        <Component context={context} plugin={contribution.plugin} />
      </PluginContributionErrorBoundary>
    );
  });
}

export function PluginAppOverlays({ context }: { readonly context: SynaraPluginAppContext }) {
  const contributions = usePluginContributions("appOverlays");
  return <PluginAppOverlayList context={context} contributions={contributions} />;
}
