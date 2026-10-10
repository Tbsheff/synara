import type { ProjectId, ThreadId } from "@synara/contracts";

import type { ActivePluginContribution } from "../../plugins/frontendRuntime";
import { PluginContributionErrorBoundary } from "../../plugins/runtime";

export interface PluginThreadHeaderActionsProps {
  readonly actions: ReadonlyArray<ActivePluginContribution<"threadHeaderActions">>;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
}

export function PluginThreadHeaderActions({
  actions,
  threadId,
  projectId,
}: PluginThreadHeaderActionsProps) {
  return actions.map((action) => {
    const Action = action.component;
    const key = `${action.plugin.id}:${action.id}:${action.plugin.generation}`;

    return (
      <PluginContributionErrorBoundary
        key={key}
        plugin={action.plugin}
        contributionId={action.id}
        fallback={null}
      >
        <Action context={{ threadId, projectId }} plugin={action.plugin} />
      </PluginContributionErrorBoundary>
    );
  });
}
