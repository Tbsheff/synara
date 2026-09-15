import type { ComponentType } from "react";

import { PluginIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { PluginContributionErrorBoundary, usePluginContributions } from "./runtime";

export function PluginGlyph(props: {
  readonly pluginId: string;
  readonly name?: string;
  readonly className?: string;
  readonly fallback?: ComponentType<{ readonly className?: string }>;
}) {
  const icons = usePluginContributions("icons");
  const registration = props.name
    ? icons.find(
        (candidate) =>
          candidate.plugin.id === props.pluginId && candidate.name === props.name,
      )
    : undefined;
  const Fallback = props.fallback ?? PluginIcon;
  if (!registration) return <Fallback className={props.className} />;

  const Icon = registration.component;
  return (
    <PluginContributionErrorBoundary
      plugin={registration.plugin}
      contributionId={`icon:${registration.name}`}
      fallback={<Fallback className={props.className} />}
    >
      <Icon
        context={{ projectId: null, threadId: null }}
        plugin={registration.plugin}
        name={registration.name}
        className={cn("inline-block", props.className)}
      />
    </PluginContributionErrorBoundary>
  );
}
