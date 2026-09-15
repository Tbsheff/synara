import { createContext, useCallback, useContext, type ComponentType } from "react";

import type { PluginRpcContract, SynaraPluginManifest } from "./index";

export interface SynaraPluginAppContext {
  readonly projectId: string | null;
  readonly threadId: string | null;
}

export interface PluginNavPanelProps {
  readonly context: SynaraPluginAppContext;
  readonly plugin: SynaraPluginManifest & { readonly generation: number };
}

export interface PluginNavPanelContribution {
  readonly id: string;
  readonly title: string;
  readonly component: ComponentType<PluginNavPanelProps>;
}

export interface SynaraPluginAppApi {
  readonly slots: {
    readonly navPanel: (contribution: PluginNavPanelContribution) => void;
  };
}

export type SynaraPluginApp = (api: SynaraPluginAppApi) => void;

export function definePluginApp(app: SynaraPluginApp): SynaraPluginApp {
  return app;
}

export interface PluginAppRuntime {
  readonly call: <Input, Output>(input: {
    readonly plugin: SynaraPluginManifest & { readonly generation: number };
    readonly method: string;
    readonly contract: PluginRpcContract<Input, Output>;
    readonly input: Input;
  }) => Promise<Output>;
  readonly editPlugin: (input: {
    readonly plugin: SynaraPluginManifest & { readonly generation: number };
    readonly projectId: string;
  }) => Promise<{ readonly threadId: string }>;
  readonly navigate: (to: string) => void;
}

export const PluginAppRuntimeContext = createContext<PluginAppRuntime | null>(null);

export function usePluginRuntime(): PluginAppRuntime {
  const runtime = useContext(PluginAppRuntimeContext);
  if (!runtime) throw new Error("Plugin app runtime is not available.");
  return runtime;
}

export function usePluginRpc(plugin: SynaraPluginManifest & { readonly generation: number }) {
  const runtime = usePluginRuntime();
  return useCallback(
    <Input, Output>(
      method: string,
      contract: PluginRpcContract<Input, Output>,
      input: Input,
    ) => runtime.call({ plugin, method, contract, input }),
    [plugin.generation, plugin.id, runtime],
  );
}
