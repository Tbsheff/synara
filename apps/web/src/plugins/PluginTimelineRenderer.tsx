import type { JsonValue } from "@synara/plugin-sdk";
import type { SynaraPluginAppContext } from "@synara/plugin-sdk/app";
import { memo, type ComponentType } from "react";

import type { ActivePluginContribution } from "./frontendRuntime";
import { PluginContributionErrorBoundary, usePluginContributions } from "./runtime";

type ActivePluginTimelineRenderer = ActivePluginContribution<"timelineRenderers">;

export function resolvePluginTimelineRenderer(
  renderers: readonly ActivePluginTimelineRenderer[],
  kind: string,
): ActivePluginTimelineRenderer | null {
  const matches = renderers.filter((renderer) => renderer.kind === kind);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export const PluginTimelineRendererHost = memo(function PluginTimelineRendererHost(props: {
  readonly kind: string;
  readonly payload: JsonValue;
  readonly context: SynaraPluginAppContext;
  readonly Original: ComponentType;
}) {
  const renderers = usePluginContributions("timelineRenderers");
  const renderer = resolvePluginTimelineRenderer(renderers, props.kind);
  if (!renderer) return <props.Original />;
  const Component = renderer.component;
  return (
    <PluginContributionErrorBoundary
      plugin={renderer.plugin}
      contributionId={renderer.kind}
      fallback={<props.Original />}
    >
      <Component
        context={props.context}
        plugin={renderer.plugin}
        payload={props.payload}
        Original={props.Original}
      />
    </PluginContributionErrorBoundary>
  );
});
