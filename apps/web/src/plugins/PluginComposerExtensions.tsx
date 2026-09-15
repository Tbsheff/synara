import type {
  PluginActionContext,
  PluginComposerActionContext,
  PluginComposerController,
  SynaraPluginAppContext,
} from "@synara/plugin-sdk/app";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuTrigger } from "~/components/ui/menu";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { toastManager } from "~/components/ui/toast";

import { PluginGlyph } from "./PluginGlyph";
import { PluginContributionErrorBoundary, usePluginContributions } from "./runtime";

export type PluginComposerHost = PluginComposerController;

function usePluginComposerObservers(text: string) {
  const customizations = usePluginContributions("composerCustomizations");
  useEffect(() => {
    for (const customization of customizations) {
      try {
        customization.richText?.onDraftChange?.({ text });
      } catch (cause) {
        console.error(
          `Plugin composer observer failed: ${customization.plugin.id}/${customization.id}`,
          cause,
        );
      }
    }
  }, [customizations, text]);
  return customizations;
}

async function runComposerAction(input: {
  readonly title: string;
  readonly run: (context: PluginComposerActionContext) => void | Promise<void>;
  readonly context: SynaraPluginAppContext;
  readonly plugin: PluginComposerActionContext["plugin"];
  readonly composer: PluginComposerHost;
}) {
  try {
    await input.run({ context: input.context, plugin: input.plugin, composer: input.composer });
  } catch (cause) {
    console.error(`Plugin composer action failed: ${input.plugin.id}/${input.title}`, cause);
    toastManager.add({
      type: "error",
      title: "Extension action failed",
      description: input.title,
    });
  }
}

async function runCommand(input: {
  readonly title: string;
  readonly run: (context: PluginActionContext) => void | Promise<void>;
  readonly context: SynaraPluginAppContext;
  readonly plugin: PluginActionContext["plugin"];
}) {
  try {
    await input.run({ context: input.context, plugin: input.plugin });
  } catch (cause) {
    console.error(`Plugin command failed: ${input.plugin.id}/${input.title}`, cause);
    toastManager.add({
      type: "error",
      title: "Extension command failed",
      description: input.title,
    });
  }
}

export function PluginComposerBanners(props: {
  readonly context: SynaraPluginAppContext;
  readonly text: string;
}) {
  const customizations = usePluginComposerObservers(props.text);
  return customizations.flatMap((customization) =>
    (customization.banners ?? []).map((banner) => {
      const Banner = banner.component;
      return (
        <PluginContributionErrorBoundary
          key={`${customization.plugin.id}:${customization.plugin.generation}:${customization.id}:${banner.id}`}
          plugin={customization.plugin}
          contributionId={`${customization.id}:${banner.id}`}
          fallback={null}
        >
          <div className={banner.chrome === "bare" ? undefined : "border-b bg-muted/30 px-3 py-2"}>
            <Banner context={props.context} plugin={customization.plugin} />
          </div>
        </PluginContributionErrorBoundary>
      );
    }),
  );
}

export function PluginComposerControls(props: {
  readonly context: SynaraPluginAppContext;
  readonly composer: PluginComposerHost;
}) {
  const customizations = usePluginContributions("composerCustomizations");
  const commandContributions = usePluginContributions("commands");
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const pendingRef = useRef<string | null>(null);
  const actions = useMemo(
    () =>
      customizations.flatMap((customization) =>
        (customization.actions ?? []).map((action) => ({ customization, action })),
      ),
    [customizations],
  );
  const plusItems = useMemo(
    () =>
      customizations.flatMap((customization) =>
        (customization.plusMenu ?? []).map((action) => ({ customization, action })),
      ),
    [customizations],
  );
  const commands = useMemo(
    () =>
      commandContributions.filter((command) => {
        if (!command.isAvailable) return true;
        try {
          return command.isAvailable({ context: props.context, plugin: command.plugin });
        } catch (cause) {
          console.error(
            `Plugin command availability failed: ${command.plugin.id}/${command.id}`,
            cause,
          );
          return false;
        }
      }),
    [commandContributions, props.context],
  );
  const menuPluginId = plusItems[0]?.customization.plugin.id ?? commands[0]?.plugin.id;
  const run = (entry: (typeof actions)[number] | (typeof plusItems)[number]) => {
    const key = `${entry.customization.plugin.id}:${entry.customization.id}:${entry.action.id}`;
    if (pendingRef.current) return;
    pendingRef.current = key;
    setPendingKey(key);
    void runComposerAction({
      title: entry.action.title,
      run: entry.action.run,
      context: props.context,
      plugin: entry.customization.plugin,
      composer: props.composer,
    }).finally(() => {
      pendingRef.current = null;
      setPendingKey(null);
    });
  };
  const runRegisteredCommand = (command: (typeof commands)[number]) => {
    const key = `${command.plugin.id}:command:${command.id}`;
    if (pendingRef.current) return;
    pendingRef.current = key;
    setPendingKey(key);
    void runCommand({
      title: command.title,
      run: command.run,
      context: props.context,
      plugin: command.plugin,
    }).finally(() => {
      pendingRef.current = null;
      setPendingKey(null);
    });
  };

  return (
    <>
      {actions.map((entry) => {
        const key = `${entry.customization.plugin.id}:${entry.customization.id}:${entry.action.id}`;
        return (
          <Button
            key={key}
            type="button"
            size="sm"
            variant="ghost"
            className="shrink-0 gap-1.5 px-2 text-xs"
            disabled={pendingKey === key}
            onClick={() => run(entry)}
          >
            <PluginGlyph
              pluginId={entry.customization.plugin.id}
              name={entry.action.icon}
              className="size-3.5"
            />
            {entry.action.title}
          </Button>
        );
      })}
      {menuPluginId ? (
        <Menu modal={false}>
          <MenuTrigger
            render={
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="shrink-0 px-2"
                aria-label="Extension composer actions"
                title="Extension composer actions"
              />
            }
          >
            <PluginGlyph
              pluginId={menuPluginId}
              className="size-3.5"
            />
          </MenuTrigger>
          <ComposerPickerMenuPopup align="start" side="top" className="w-64 min-w-64">
            {plusItems.map((entry) => {
              const key = `${entry.customization.plugin.id}:${entry.customization.id}:${entry.action.id}`;
              return (
                <MenuItem key={key} disabled={pendingKey === key} onClick={() => run(entry)}>
                  <PluginGlyph
                    pluginId={entry.customization.plugin.id}
                    name={entry.action.icon}
                    className="size-3.5"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{entry.action.title}</span>
                    {entry.action.description ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {entry.action.description}
                      </span>
                    ) : null}
                  </span>
                </MenuItem>
              );
            })}
            {commands.map((command) => {
              const key = `${command.plugin.id}:command:${command.id}`;
              return (
                <MenuItem
                  key={key}
                  disabled={pendingKey === key}
                  onClick={() => runRegisteredCommand(command)}
                >
                  <PluginGlyph pluginId={command.plugin.id} className="size-3.5" />
                  <span className="min-w-0 flex-1 truncate">{command.title}</span>
                </MenuItem>
              );
            })}
          </ComposerPickerMenuPopup>
        </Menu>
      ) : null}
    </>
  );
}
