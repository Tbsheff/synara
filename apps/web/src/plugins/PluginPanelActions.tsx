import { ThreadId } from "@synara/contracts";
import type { PluginPanelActionContext, SynaraPluginAppContext } from "@synara/plugin-sdk/app";
import { useCallback, useRef, useState } from "react";

import { ChatHeaderButton } from "~/components/chat/chatHeaderControls";
import { randomUUID } from "~/lib/utils";
import type { PluginPanelScope } from "~/rightDockStore.logic";
import { useRightDockStore } from "~/rightDockStore";
import { toastManager } from "~/components/ui/toast";

import type { ActivePluginContribution } from "./frontendRuntime";
import { PluginGlyph } from "./PluginGlyph";
import { usePluginContributions } from "./runtime";

export type ActivePluginPanelAction =
  | ActivePluginContribution<"threadPanelActions">
  | ActivePluginContribution<"newThreadPanelActions">;

function PluginPanelActionButton(props: {
  readonly action: ActivePluginPanelAction;
  readonly context: SynaraPluginAppContext;
  readonly scope: PluginPanelScope;
}) {
  const openPane = useRightDockStore((store) => store.openPane);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const run = useCallback(() => {
    if (pendingRef.current || !props.context.threadId) return;
    pendingRef.current = true;
    setPending(true);
    const openPanel: PluginPanelActionContext["openPanel"] = (options) => {
      if (!props.context.threadId) return false;
      openPane(ThreadId.makeUnsafe(props.context.threadId), {
        kind: "plugin",
        paneId: `plugin:${props.scope}:${props.action.plugin.id}:${props.action.id}:${randomUUID()}`,
        pluginId: props.action.plugin.id,
        pluginContributionId: props.action.id,
        pluginPanelScope: props.scope,
        pluginTitle: options?.title ?? props.action.title,
        pluginParams: options?.params ?? null,
      });
      return true;
    };
    const actionContext: PluginPanelActionContext = {
      context: props.context,
      plugin: props.action.plugin,
      openPanel,
    };
    const result = props.action.run ? props.action.run(actionContext) : openPanel();
    void Promise.resolve(result)
      .catch((cause: unknown) => {
        console.error(
          `Plugin panel action failed: ${props.action.plugin.id}/${props.action.id}`,
          cause,
        );
        toastManager.add({
          type: "error",
          title: "Extension panel failed",
          description: props.action.title,
        });
      })
      .finally(() => {
        pendingRef.current = false;
        setPending(false);
      });
  }, [openPane, props.action, props.context, props.scope]);

  return (
    <ChatHeaderButton
      type="button"
      disabled={pending || !props.context.threadId}
      title={props.action.title}
      onClick={run}
    >
      <span className="flex size-3.5 items-center justify-center">
        <PluginGlyph
          pluginId={props.action.plugin.id}
          name={props.action.icon}
          className="size-3.5"
        />
      </span>
      <span className="max-w-24 truncate">{props.action.title}</span>
    </ChatHeaderButton>
  );
}

export function usePluginPanelActions(scope: PluginPanelScope): readonly ActivePluginPanelAction[] {
  const kind = scope === "thread" ? "threadPanelActions" : "newThreadPanelActions";
  return usePluginContributions(kind);
}

export function PluginPanelActionList(props: {
  readonly actions: readonly ActivePluginPanelAction[];
  readonly context: SynaraPluginAppContext;
  readonly scope: PluginPanelScope;
}) {
  return props.actions.map((action) => (
    <PluginPanelActionButton
      key={`${action.plugin.id}:${action.plugin.generation}:${action.id}`}
      action={action}
      context={props.context}
      scope={props.scope}
    />
  ));
}

export function PluginPanelActionButtons(props: {
  readonly context: SynaraPluginAppContext;
  readonly scope: PluginPanelScope;
}) {
  const actions = usePluginPanelActions(props.scope);
  return <PluginPanelActionList {...props} actions={actions} />;
}
