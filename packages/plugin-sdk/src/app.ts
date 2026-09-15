import { createContext, useCallback, useContext, type ComponentType } from "react";

import type { JsonValue, PluginRpcContract, SynaraPluginManifest } from "./index";

export interface SynaraPluginAppContext {
  readonly projectId: string | null;
  readonly threadId: string | null;
}

export type SynaraPluginDescriptor = SynaraPluginManifest & { readonly generation: number };

export interface PluginComponentProps {
  readonly context: SynaraPluginAppContext;
  readonly plugin: SynaraPluginDescriptor;
}

export type PluginHomepageSectionProps = PluginComponentProps;
export type PluginSettingsSectionProps = PluginComponentProps;
export type PluginAppOverlayProps = PluginComponentProps;
export interface PluginNavPanelProps extends PluginComponentProps {
  readonly subPath?: string;
}
export interface PluginThreadPanelProps extends PluginComponentProps {
  readonly params: JsonValue | null;
}
export interface PluginNewThreadPanelProps extends PluginComponentProps {
  readonly params: JsonValue | null;
}
export interface PluginPendingInteractionProps extends PluginComponentProps {
  readonly interaction: JsonValue;
  readonly submit: (value: JsonValue) => Promise<void>;
  readonly cancel: () => Promise<void>;
}
export interface PluginSidebarNavigationProps extends PluginComponentProps {
  readonly Original: ComponentType;
}
export interface PluginThreadListProps extends PluginComponentProps {
  readonly Original: ComponentType;
}
export type PluginThreadHeaderActionProps = PluginComponentProps;
export interface PluginBrowserToolbarActionProps extends PluginComponentProps {
  readonly tabId: string;
  readonly url: string;
}
export interface PluginFileOpenerProps extends PluginComponentProps {
  readonly path: string;
  readonly source: "workspace" | "host" | "thread-storage";
  readonly Original: ComponentType;
}
export interface PluginSourceCodeRendererProps extends PluginComponentProps {
  readonly content: string;
  readonly path: string;
  readonly Original: ComponentType;
}
export interface PluginDiffRendererProps extends PluginComponentProps {
  readonly patch: string;
  readonly path: string;
  readonly Original: ComponentType;
}
export interface PluginMessageDirectiveProps extends PluginComponentProps {
  readonly attributes: Readonly<Record<string, string>>;
  readonly source: string;
}
export interface PluginProviderIconProps extends PluginComponentProps {
  readonly className?: string;
}
export interface PluginTimelineRendererProps extends PluginComponentProps {
  readonly payload: JsonValue;
  readonly Original: ComponentType;
}
export interface PluginEnvironmentProviderInputsProps extends PluginComponentProps {
  readonly value: JsonValue | null;
  readonly onChange: (value: JsonValue | null) => void;
}
export interface PluginMachineProviderInputsProps extends PluginComponentProps {
  readonly value: JsonValue | null;
  readonly onChange: (value: JsonValue | null) => void;
}

export interface PluginComponentRegistration<Props extends PluginComponentProps> {
  readonly id: string;
  readonly component: ComponentType<Props>;
}

export interface PluginTitledComponentRegistration<Props extends PluginComponentProps>
  extends PluginComponentRegistration<Props> {
  readonly title: string;
  readonly description?: string;
}

export type PluginReplacementRegistration<Props extends PluginComponentProps> =
  PluginTitledComponentRegistration<Props>;

export type PluginHomepageSectionRegistration =
  PluginTitledComponentRegistration<PluginHomepageSectionProps>;
export interface PluginSettingsSectionRegistration
  extends PluginComponentRegistration<PluginSettingsSectionProps> {
  readonly title?: string;
  readonly description?: string;
}
export type PluginAppOverlayRegistration = PluginComponentRegistration<PluginAppOverlayProps>;

export interface PluginNavPanelContribution
  extends PluginTitledComponentRegistration<PluginNavPanelProps> {
  readonly icon?: string;
  readonly path?: string;
}

export interface PluginPanelActionContext extends PluginComponentProps {
  readonly openPanel: (options?: {
    readonly title?: string;
    readonly params?: JsonValue;
  }) => boolean;
}

export interface PluginThreadPanelActionRegistration
  extends PluginTitledComponentRegistration<PluginThreadPanelProps> {
  readonly icon?: string;
  readonly run?: (context: PluginPanelActionContext) => void | Promise<void>;
}

export interface PluginNewThreadPanelActionRegistration
  extends PluginTitledComponentRegistration<PluginNewThreadPanelProps> {
  readonly icon?: string;
  readonly run?: (context: PluginPanelActionContext) => void | Promise<void>;
}

export type PluginPendingInteractionRegistration =
  PluginComponentRegistration<PluginPendingInteractionProps>;

export type PluginActionContext = PluginComponentProps;

export interface PluginSidebarFooterActionRegistration {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
  readonly run: (context: PluginActionContext) => void | Promise<void>;
}

export type PluginSidebarNavigationRegistration =
  PluginReplacementRegistration<PluginSidebarNavigationProps>;
export type PluginThreadListRegistration = PluginReplacementRegistration<PluginThreadListProps>;
export type PluginThreadHeaderActionRegistration =
  PluginTitledComponentRegistration<PluginThreadHeaderActionProps>;
export type PluginBrowserToolbarActionRegistration =
  PluginTitledComponentRegistration<PluginBrowserToolbarActionProps>;

export interface PluginFileOpenerRegistration
  extends PluginTitledComponentRegistration<PluginFileOpenerProps> {
  readonly extensions: readonly string[];
}

export type PluginSourceCodeRendererRegistration =
  PluginReplacementRegistration<PluginSourceCodeRendererProps>;
export type PluginDiffRendererRegistration = PluginReplacementRegistration<PluginDiffRendererProps>;
export type PluginMessageDirectiveRegistration =
  PluginComponentRegistration<PluginMessageDirectiveProps>;

export interface PluginMessageActionContext extends PluginActionContext {
  readonly message: {
    readonly id: string;
    readonly role: "user" | "assistant";
    readonly text: string;
  };
  readonly selectedText?: string;
}

export interface PluginMessageActionRegistration {
  readonly id: string;
  readonly title: string;
  readonly icon?: string;
  readonly run: (context: PluginMessageActionContext) => void | Promise<void>;
}

export interface PluginCommandRegistration {
  readonly id: string;
  readonly title: string;
  readonly run: (context: PluginActionContext) => void | Promise<void>;
  readonly isAvailable?: (context: PluginActionContext) => boolean;
}

export interface PluginProviderIconRegistration {
  readonly providerKind: "agent" | "machine" | "environment";
  readonly providerId: string;
  readonly icon: ComponentType<PluginProviderIconProps>;
}

export interface PluginTimelineRendererRegistration {
  readonly kind: string;
  readonly component: ComponentType<PluginTimelineRendererProps>;
}

export interface PluginEnvironmentProviderInputsRegistration {
  readonly environmentProviderId: string;
  readonly component: ComponentType<PluginEnvironmentProviderInputsProps>;
}

export interface PluginMachineProviderInputsRegistration {
  readonly machineProviderId: string;
  readonly component: ComponentType<PluginMachineProviderInputsProps>;
}

export interface PluginComposerActionRegistration {
  readonly id: string;
  readonly title: string;
  readonly icon?: string;
  readonly run: (context: PluginActionContext) => void | Promise<void>;
}

export interface PluginComposerBannerRegistration
  extends PluginComponentRegistration<PluginComponentProps> {
  readonly chrome?: "card" | "bare";
}

export interface PluginComposerPlusMenuRegistration extends PluginComposerActionRegistration {
  readonly description?: string;
}

export interface PluginComposerRichTextEffect {
  readonly id: string;
  readonly match: (text: string) => ReadonlyArray<{ readonly from: number; readonly to: number }>;
  readonly className: string;
}

export interface PluginComposerRichTextRegistration {
  readonly effects?: readonly PluginComposerRichTextEffect[];
  readonly onDraftChange?: (draft: { readonly text: string }) => void;
}

export interface PluginComposerCustomization {
  readonly id: string;
  readonly actions?: readonly PluginComposerActionRegistration[];
  readonly banners?: readonly PluginComposerBannerRegistration[];
  readonly plusMenu?: readonly PluginComposerPlusMenuRegistration[];
  readonly richText?: PluginComposerRichTextRegistration;
}

export interface PluginContentScriptContext {
  readonly pluginId: string;
  readonly generation: number;
  readonly signal: AbortSignal;
}

export type PluginContentScriptDisposer = () => void | Promise<void>;

export interface PluginContentScriptRegistration {
  readonly id: string;
  readonly mount: (
    context: PluginContentScriptContext,
  ) =>
    | void
    | PluginContentScriptDisposer
    | Promise<void | PluginContentScriptDisposer>;
}

export interface PluginSidebarFooterItemBase {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
}

export interface PluginSidebarFooterItemAction extends PluginSidebarFooterItemBase {
  readonly kind: "action";
  readonly run: (context: PluginActionContext) => void | Promise<void>;
}

export interface PluginSidebarFooterItemDisclosure extends PluginSidebarFooterItemBase {
  readonly kind: "disclosure";
  readonly component: ComponentType<PluginComponentProps>;
}

export type PluginSidebarFooterItem =
  | PluginSidebarFooterItemAction
  | PluginSidebarFooterItemDisclosure;

export interface PluginIconProps extends PluginComponentProps {
  readonly name: string;
  readonly className?: string;
}

export interface PluginIconRegistration {
  readonly name: string;
  readonly component: ComponentType<PluginIconProps>;
}

export interface SynaraPluginAppApi {
  readonly slots: {
    readonly homepageSection: (registration: PluginHomepageSectionRegistration) => void;
    readonly settingsSection: (registration: PluginSettingsSectionRegistration) => void;
    readonly experimental_appOverlay: (registration: PluginAppOverlayRegistration) => void;
    readonly navPanel: (registration: PluginNavPanelContribution) => void;
    readonly threadPanelAction: (registration: PluginThreadPanelActionRegistration) => void;
    readonly experimental_newThreadPanelAction: (
      registration: PluginNewThreadPanelActionRegistration,
    ) => void;
    readonly pendingInteraction: (registration: PluginPendingInteractionRegistration) => void;
    readonly sidebarFooterAction: (registration: PluginSidebarFooterActionRegistration) => void;
    readonly experimental_sidebarNavigation: (
      registration: PluginSidebarNavigationRegistration,
    ) => void;
    readonly experimental_threadList: (registration: PluginThreadListRegistration) => void;
    readonly experimental_threadHeaderAction: (
      registration: PluginThreadHeaderActionRegistration,
    ) => void;
    readonly experimental_browserToolbarAction: (
      registration: PluginBrowserToolbarActionRegistration,
    ) => void;
    readonly fileOpener: (registration: PluginFileOpenerRegistration) => void;
    readonly experimental_sourceCodeRenderer: (
      registration: PluginSourceCodeRendererRegistration,
    ) => void;
    readonly experimental_diffRenderer: (registration: PluginDiffRendererRegistration) => void;
    readonly messageDirective: (registration: PluginMessageDirectiveRegistration) => void;
    readonly messageAction: (registration: PluginMessageActionRegistration) => void;
    readonly commandPaletteAction: (registration: PluginCommandRegistration) => void;
    readonly experimental_providerIcon: (registration: PluginProviderIconRegistration) => void;
    readonly experimental_timelineRenderer: (
      registration: PluginTimelineRendererRegistration,
    ) => void;
    readonly experimental_environmentProviderInputs: (
      registration: PluginEnvironmentProviderInputsRegistration,
    ) => void;
    readonly experimental_machineProviderInputs: (
      registration: PluginMachineProviderInputsRegistration,
    ) => void;
  };
  readonly composer: {
    readonly customize: (registration: PluginComposerCustomization) => void;
  };
  readonly contentScripts: {
    readonly register: (registration: PluginContentScriptRegistration) => void;
  };
  readonly commands: {
    readonly register: (registration: PluginCommandRegistration) => void;
  };
  readonly experimental_sidebarFooter: {
    readonly register: (registration: PluginSidebarFooterItem) => void;
  };
  readonly experimental_icons: {
    readonly register: (registration: PluginIconRegistration) => void;
  };
}

export type SynaraPluginAppSetup = (api: SynaraPluginAppApi) => void;

export interface SynaraPluginAppDefinition {
  readonly __synaraPluginApp: true;
  readonly setup: SynaraPluginAppSetup;
}

export type LegacySynaraPluginApp = SynaraPluginAppSetup;
export type SynaraPluginApp = SynaraPluginAppDefinition | LegacySynaraPluginApp;

export function definePluginApp(setup: SynaraPluginAppSetup): SynaraPluginAppDefinition {
  return Object.freeze({ __synaraPluginApp: true, setup });
}

export function isSynaraPluginAppDefinition(value: unknown): value is SynaraPluginAppDefinition {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SynaraPluginAppDefinition>;
  return candidate.__synaraPluginApp === true && typeof candidate.setup === "function";
}

export interface PluginAppRuntime {
  readonly call: <Input, Output>(input: {
    readonly plugin: SynaraPluginDescriptor;
    readonly method: string;
    readonly contract: PluginRpcContract<Input, Output>;
    readonly input: Input;
  }) => Promise<Output>;
  readonly editPlugin: (input: {
    readonly plugin: SynaraPluginDescriptor;
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

export function usePluginRpc(plugin: SynaraPluginDescriptor) {
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
