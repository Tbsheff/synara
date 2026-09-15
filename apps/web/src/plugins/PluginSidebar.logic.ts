export const ORIGINAL_PLUGIN_SIDEBAR_PROVIDER = "original";

export interface PluginSidebarContributionIdentity {
  readonly id: string;
  readonly plugin: {
    readonly id: string;
  };
}

export function pluginSidebarContributionKey(
  contribution: PluginSidebarContributionIdentity,
): string {
  return JSON.stringify([contribution.plugin.id, contribution.id]);
}

export function resolvePluginSidebarContribution<
  Contribution extends PluginSidebarContributionIdentity,
>(
  contributions: readonly Contribution[],
  selectedProvider: string,
): Contribution | null {
  if (selectedProvider === ORIGINAL_PLUGIN_SIDEBAR_PROVIDER) return null;
  return (
    contributions.find(
      (contribution) => pluginSidebarContributionKey(contribution) === selectedProvider,
    ) ?? null
  );
}

export function splitPluginSidebarFooterContributions<Contribution>(
  contributions: readonly Contribution[],
  visibleLimit: number,
): {
  readonly visible: readonly Contribution[];
  readonly overflow: readonly Contribution[];
} {
  const safeLimit = Math.max(0, Math.floor(visibleLimit));
  return {
    visible: contributions.slice(0, safeLimit),
    overflow: contributions.slice(safeLimit),
  };
}

export function togglePluginSidebarDisclosure(
  openKey: string | null,
  requestedKey: string,
): string | null {
  return openKey === requestedKey ? null : requestedKey;
}
