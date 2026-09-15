import type {
  PluginMessageActionContext,
  SynaraPluginAppContext,
} from "@synara/plugin-sdk/app";
import { memo, useCallback, useRef, useState } from "react";

import { ZapIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { MessageActionButton, MESSAGE_ACTION_ICON_CLASS_NAME } from "~/components/chat/MessageActionButton";
import { toastManager } from "~/components/ui/toast";

import type { ActivePluginContribution } from "./frontendRuntime";
import { usePluginContributions } from "./runtime";

export type PluginMessageReference = PluginMessageActionContext["message"];
type ActivePluginMessageAction = ActivePluginContribution<"messageActions">;
export type PluginMessageActionErrorHandler = (
  cause: unknown,
  pluginId: string,
  actionId: string,
) => void;

function defaultPluginMessageActionErrorHandler(
  cause: unknown,
  pluginId: string,
  actionId: string,
): void {
  console.error(`Plugin message action failed: ${pluginId}/${actionId}`, cause);
  toastManager.add({
    type: "error",
    title: "Plugin action failed",
    description: cause instanceof Error ? cause.message : "Try again.",
  });
}

export async function invokePluginMessageAction(input: {
  readonly action: ActivePluginMessageAction;
  readonly context: SynaraPluginAppContext;
  readonly message: PluginMessageReference;
  readonly selectedText?: string;
  readonly onError?: PluginMessageActionErrorHandler;
}): Promise<void> {
  const { action, context, message, selectedText } = input;
  try {
    await action.run({
      context,
      message,
      plugin: action.plugin,
      ...(selectedText === undefined ? {} : { selectedText }),
    });
  } catch (cause) {
    (input.onError ?? defaultPluginMessageActionErrorHandler)(cause, action.plugin.id, action.id);
  }
}

interface PluginMessageActionButtonProps {
  readonly action: ActivePluginMessageAction;
  readonly context: SynaraPluginAppContext;
  readonly message: PluginMessageReference;
  readonly selectedText?: string;
  readonly presentation: "footer" | "selection";
  readonly className?: string;
  readonly onError?: PluginMessageActionErrorHandler;
}

const PluginMessageActionButton = memo(function PluginMessageActionButton(
  props: PluginMessageActionButtonProps,
) {
  const latestProps = useRef(props);
  latestProps.current = props;
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const run = useCallback(() => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    const current = latestProps.current;
    void invokePluginMessageAction({
      action: current.action,
      context: current.context,
      message: current.message,
      ...(current.selectedText === undefined ? {} : { selectedText: current.selectedText }),
      ...(current.onError ? { onError: current.onError } : {}),
    }).finally(() => {
      pendingRef.current = false;
      setPending(false);
    });
  }, []);

  if (props.presentation === "selection") {
    return (
      <button
        type="button"
        aria-label={props.action.title}
        title={props.action.title}
        disabled={pending}
        className="pointer-events-auto inline-flex h-7 flex-none items-center justify-center whitespace-nowrap px-2.5 text-xs text-[var(--color-text-foreground)] outline-none hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-40"
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          run();
        }}
      >
        {props.action.title}
      </button>
    );
  }

  return (
    <MessageActionButton
      label={props.action.title}
      tooltip={props.action.title}
      disabled={pending}
      className={cn(props.className, "disabled:text-muted-foreground/35")}
      onClick={run}
    >
      <ZapIcon className={MESSAGE_ACTION_ICON_CLASS_NAME} />
    </MessageActionButton>
  );
});

export const PluginMessageActionItems = memo(function PluginMessageActionItems(props: {
  readonly context: SynaraPluginAppContext;
  readonly message: PluginMessageReference;
  readonly selectedText?: string;
  readonly presentation: "footer" | "selection";
  readonly className?: string;
  readonly onError?: PluginMessageActionErrorHandler;
}) {
  const actions = usePluginContributions("messageActions");
  return actions.map((action) => (
    <PluginMessageActionButton
      key={`${action.plugin.id}:${action.plugin.generation}:${action.id}`}
      action={action}
      context={props.context}
      message={props.message}
      presentation={props.presentation}
      {...(props.selectedText === undefined ? {} : { selectedText: props.selectedText })}
      {...(props.className ? { className: props.className } : {})}
      {...(props.onError ? { onError: props.onError } : {})}
    />
  ));
});
