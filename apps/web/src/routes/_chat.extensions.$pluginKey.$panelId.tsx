import { createFileRoute } from "@tanstack/react-router";

import { useLatestProjectStore } from "~/latestProjectStore";
import { PluginPanel } from "~/plugins/runtime";

function PluginPanelRoute() {
  const { pluginKey, panelId } = Route.useParams();
  const projectId = useLatestProjectStore((state) => state.latestProjectId);
  return (
    <PluginPanel pluginKey={pluginKey} panelId={panelId} context={{ projectId, threadId: null }} />
  );
}

export const Route = createFileRoute("/_chat/extensions/$pluginKey/$panelId")({
  component: PluginPanelRoute,
});
