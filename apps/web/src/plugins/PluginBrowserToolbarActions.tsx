import type { PluginBrowserToolbarActionProps, SynaraPluginAppContext } from "@synara/plugin-sdk/app";

import { PluginContributionErrorBoundary, usePluginContributions } from "./runtime";

export function PluginBrowserToolbarActions(props: {
  readonly context: SynaraPluginAppContext;
  readonly tabId: string;
  readonly url: string;
}) {
  const actions = usePluginContributions("browserToolbarActions");

  return actions.map((registration) => {
    const Action = registration.component;
    const actionProps: PluginBrowserToolbarActionProps = {
      context: props.context,
      plugin: registration.plugin,
      tabId: props.tabId,
      url: props.url,
    };
    return (
      <PluginContributionErrorBoundary
        key={`${registration.plugin.id}:${registration.id}:${registration.plugin.generation}:${props.tabId}`}
        plugin={registration.plugin}
        contributionId={registration.id}
        fallback={null}
      >
        <Action {...actionProps} />
      </PluginContributionErrorBoundary>
    );
  });
}
