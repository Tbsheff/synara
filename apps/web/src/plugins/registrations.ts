import {
  isSynaraPluginAppDefinition,
  type PluginAppOverlayRegistration,
  type PluginBrowserToolbarActionRegistration,
  type PluginCommandRegistration,
  type PluginComposerCustomization,
  type PluginContentScriptRegistration,
  type PluginDiffRendererRegistration,
  type PluginEnvironmentProviderInputsRegistration,
  type PluginFileOpenerRegistration,
  type PluginHomepageSectionRegistration,
  type PluginIconRegistration,
  type PluginMachineProviderInputsRegistration,
  type PluginMessageActionRegistration,
  type PluginMessageDirectiveRegistration,
  type PluginNavPanelContribution,
  type PluginNewThreadPanelActionRegistration,
  type PluginPendingInteractionRegistration,
  type PluginProviderIconRegistration,
  type PluginSettingsSectionRegistration,
  type PluginSidebarFooterActionRegistration,
  type PluginSidebarFooterItem,
  type PluginSidebarNavigationRegistration,
  type PluginSourceCodeRendererRegistration,
  type PluginThreadHeaderActionRegistration,
  type PluginThreadListRegistration,
  type PluginThreadPanelActionRegistration,
  type PluginTimelineRendererRegistration,
  type SynaraPluginAppApi,
  type SynaraPluginAppSetup,
} from "@synara/plugin-sdk/app";

const LOCAL_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const DIRECTIVE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const EXTENSION_PATTERN = /^[a-z0-9][a-z0-9+_-]*$/;

export interface RegisteredPluginApp {
  readonly pluginId: string;
  readonly appUrl?: string;
  readonly homepageSections: ReadonlyArray<PluginHomepageSectionRegistration>;
  readonly settingsSections: ReadonlyArray<PluginSettingsSectionRegistration>;
  readonly appOverlays: ReadonlyArray<PluginAppOverlayRegistration>;
  readonly navPanels: ReadonlyArray<PluginNavPanelContribution>;
  readonly threadPanelActions: ReadonlyArray<PluginThreadPanelActionRegistration>;
  readonly newThreadPanelActions: ReadonlyArray<PluginNewThreadPanelActionRegistration>;
  readonly pendingInteractions: ReadonlyArray<PluginPendingInteractionRegistration>;
  readonly sidebarFooterActions: ReadonlyArray<PluginSidebarFooterActionRegistration>;
  readonly sidebarNavigations: ReadonlyArray<PluginSidebarNavigationRegistration>;
  readonly threadLists: ReadonlyArray<PluginThreadListRegistration>;
  readonly threadHeaderActions: ReadonlyArray<PluginThreadHeaderActionRegistration>;
  readonly browserToolbarActions: ReadonlyArray<PluginBrowserToolbarActionRegistration>;
  readonly fileOpeners: ReadonlyArray<PluginFileOpenerRegistration>;
  readonly sourceCodeRenderers: ReadonlyArray<PluginSourceCodeRendererRegistration>;
  readonly diffRenderers: ReadonlyArray<PluginDiffRendererRegistration>;
  readonly messageDirectives: ReadonlyArray<PluginMessageDirectiveRegistration>;
  readonly messageActions: ReadonlyArray<PluginMessageActionRegistration>;
  readonly commands: ReadonlyArray<PluginCommandRegistration>;
  readonly providerIcons: ReadonlyArray<PluginProviderIconRegistration>;
  readonly timelineRenderers: ReadonlyArray<PluginTimelineRendererRegistration>;
  readonly environmentProviderInputs: ReadonlyArray<PluginEnvironmentProviderInputsRegistration>;
  readonly machineProviderInputs: ReadonlyArray<PluginMachineProviderInputsRegistration>;
  readonly composerCustomizations: ReadonlyArray<PluginComposerCustomization>;
  readonly contentScripts: ReadonlyArray<PluginContentScriptRegistration>;
  readonly sidebarFooterItems: ReadonlyArray<PluginSidebarFooterItem>;
  readonly icons: ReadonlyArray<PluginIconRegistration>;
}

function requireLocalId(kind: string, id: string): string {
  if (!LOCAL_ID_PATTERN.test(id)) {
    throw new Error(`${kind}: id must contain only letters, digits, "_", or "-".`);
  }
  return id;
}

function requireUnique(kind: string, ids: Set<string>, id: string): void {
  if (ids.has(id)) throw new Error(`Duplicate ${kind} id: ${id}`);
  ids.add(id);
}

function addById<Registration extends { readonly id: string }>(
  kind: string,
  ids: Set<string>,
  registrations: Registration[],
  registration: Registration,
): void {
  const id = requireLocalId(kind, registration.id);
  requireUnique(kind, ids, id);
  registrations.push(registration);
}

function normalizeExtensions(kind: string, extensions: readonly string[]): readonly string[] {
  const normalized = extensions.map((extension) =>
    extension.trim().toLowerCase().replace(/^\./, ""),
  );
  const seen = new Set<string>();
  for (const extension of normalized) {
    if (!EXTENSION_PATTERN.test(extension)) {
      throw new Error(`${kind}: extension must be lowercase and omit the dot.`);
    }
    if (seen.has(extension)) throw new Error(`${kind}: duplicate extension: ${extension}`);
    seen.add(extension);
  }
  return normalized;
}

function validateComposerCustomization(registration: PluginComposerCustomization): void {
  requireLocalId("composer.customize", registration.id);
  for (const [kind, items] of [
    ["composer.actions", registration.actions],
    ["composer.banners", registration.banners],
    ["composer.plusMenu", registration.plusMenu],
    ["composer.richText.effects", registration.richText?.effects],
  ] as const) {
    const seen = new Set<string>();
    for (const item of items ?? []) {
      const id = requireLocalId(kind, item.id);
      requireUnique(kind, seen, id);
    }
  }
}

export function collectPluginAppRegistrations(
  pluginId: string,
  app: unknown,
  appUrl?: string,
): RegisteredPluginApp {
  const setup: SynaraPluginAppSetup =
    typeof app === "function"
      ? (app as SynaraPluginAppSetup)
      : isSynaraPluginAppDefinition(app)
        ? app.setup
        : (() => {
            throw new Error(`Plugin app has no valid default definition: ${pluginId}`);
          })();

  const homepageSections: PluginHomepageSectionRegistration[] = [];
  const settingsSections: PluginSettingsSectionRegistration[] = [];
  const appOverlays: PluginAppOverlayRegistration[] = [];
  const navPanels: PluginNavPanelContribution[] = [];
  const threadPanelActions: PluginThreadPanelActionRegistration[] = [];
  const newThreadPanelActions: PluginNewThreadPanelActionRegistration[] = [];
  const pendingInteractions: PluginPendingInteractionRegistration[] = [];
  const sidebarFooterActions: PluginSidebarFooterActionRegistration[] = [];
  const sidebarNavigations: PluginSidebarNavigationRegistration[] = [];
  const threadLists: PluginThreadListRegistration[] = [];
  const threadHeaderActions: PluginThreadHeaderActionRegistration[] = [];
  const browserToolbarActions: PluginBrowserToolbarActionRegistration[] = [];
  const fileOpeners: PluginFileOpenerRegistration[] = [];
  const sourceCodeRenderers: PluginSourceCodeRendererRegistration[] = [];
  const diffRenderers: PluginDiffRendererRegistration[] = [];
  const messageDirectives: PluginMessageDirectiveRegistration[] = [];
  const messageActions: PluginMessageActionRegistration[] = [];
  const commands: PluginCommandRegistration[] = [];
  const providerIcons: PluginProviderIconRegistration[] = [];
  const timelineRenderers: PluginTimelineRendererRegistration[] = [];
  const environmentProviderInputs: PluginEnvironmentProviderInputsRegistration[] = [];
  const machineProviderInputs: PluginMachineProviderInputsRegistration[] = [];
  const composerCustomizations: PluginComposerCustomization[] = [];
  const contentScripts: PluginContentScriptRegistration[] = [];
  const sidebarFooterItems: PluginSidebarFooterItem[] = [];
  const icons: PluginIconRegistration[] = [];
  const ids = new Map<string, Set<string>>();
  const idsFor = (kind: string) => {
    const existing = ids.get(kind);
    if (existing) return existing;
    const created = new Set<string>();
    ids.set(kind, created);
    return created;
  };
  const add = <Registration extends { readonly id: string }>(
    kind: string,
    registrations: Registration[],
    registration: Registration,
  ) => addById(kind, idsFor(kind), registrations, registration);

  const api: SynaraPluginAppApi = {
    slots: {
      homepageSection: (registration) => add("slots.homepageSection", homepageSections, registration),
      settingsSection: (registration) => add("slots.settingsSection", settingsSections, registration),
      experimental_appOverlay: (registration) =>
        add("slots.experimental_appOverlay", appOverlays, registration),
      navPanel: (registration) => add("slots.navPanel", navPanels, registration),
      threadPanelAction: (registration) =>
        add("slots.threadPanelAction", threadPanelActions, registration),
      experimental_newThreadPanelAction: (registration) =>
        add("slots.experimental_newThreadPanelAction", newThreadPanelActions, registration),
      pendingInteraction: (registration) =>
        add("slots.pendingInteraction", pendingInteractions, registration),
      sidebarFooterAction: (registration) =>
        add("slots.sidebarFooterAction", sidebarFooterActions, registration),
      experimental_sidebarNavigation: (registration) =>
        add("slots.experimental_sidebarNavigation", sidebarNavigations, registration),
      experimental_threadList: (registration) =>
        add("slots.experimental_threadList", threadLists, registration),
      experimental_threadHeaderAction: (registration) =>
        add("slots.experimental_threadHeaderAction", threadHeaderActions, registration),
      experimental_browserToolbarAction: (registration) =>
        add("slots.experimental_browserToolbarAction", browserToolbarActions, registration),
      fileOpener(registration) {
        add("slots.fileOpener", fileOpeners, {
          ...registration,
          extensions: normalizeExtensions("slots.fileOpener", registration.extensions),
        });
      },
      experimental_sourceCodeRenderer: (registration) =>
        add("slots.experimental_sourceCodeRenderer", sourceCodeRenderers, registration),
      experimental_diffRenderer: (registration) =>
        add("slots.experimental_diffRenderer", diffRenderers, registration),
      messageDirective(registration) {
        if (!DIRECTIVE_PATTERN.test(registration.id)) {
          throw new Error("slots.messageDirective: id must use lowercase kebab-case.");
        }
        requireUnique("slots.messageDirective", idsFor("slots.messageDirective"), registration.id);
        messageDirectives.push(registration);
      },
      messageAction: (registration) => add("slots.messageAction", messageActions, registration),
      commandPaletteAction: (registration) => add("commands", commands, registration),
      experimental_providerIcon(registration) {
        requireLocalId("slots.experimental_providerIcon", registration.providerId);
        const key = `${registration.providerKind}:${registration.providerId}`;
        requireUnique(
          "slots.experimental_providerIcon",
          idsFor("slots.experimental_providerIcon"),
          key,
        );
        providerIcons.push(registration);
      },
      experimental_timelineRenderer(registration) {
        if (registration.kind.length === 0) {
          throw new Error("slots.experimental_timelineRenderer: kind must not be empty.");
        }
        requireUnique(
          "slots.experimental_timelineRenderer",
          idsFor("slots.experimental_timelineRenderer"),
          registration.kind,
        );
        timelineRenderers.push(registration);
      },
      experimental_environmentProviderInputs(registration) {
        const key = requireLocalId(
          "slots.experimental_environmentProviderInputs",
          registration.environmentProviderId,
        );
        requireUnique(
          "slots.experimental_environmentProviderInputs",
          idsFor("slots.experimental_environmentProviderInputs"),
          key,
        );
        environmentProviderInputs.push(registration);
      },
      experimental_machineProviderInputs(registration) {
        const key = requireLocalId(
          "slots.experimental_machineProviderInputs",
          registration.machineProviderId,
        );
        requireUnique(
          "slots.experimental_machineProviderInputs",
          idsFor("slots.experimental_machineProviderInputs"),
          key,
        );
        machineProviderInputs.push(registration);
      },
    },
    composer: {
      customize(registration) {
        validateComposerCustomization(registration);
        requireUnique("composer.customize", idsFor("composer.customize"), registration.id);
        composerCustomizations.push(registration);
      },
    },
    contentScripts: {
      register: (registration) => add("contentScripts.register", contentScripts, registration),
    },
    commands: {
      register: (registration) => add("commands", commands, registration),
    },
    experimental_sidebarFooter: {
      register: (registration) =>
        add("experimental_sidebarFooter.register", sidebarFooterItems, registration),
    },
    experimental_icons: {
      register(registration) {
        const name = requireLocalId("experimental_icons.register", registration.name);
        requireUnique("experimental_icons.register", idsFor("experimental_icons.register"), name);
        icons.push(registration);
      },
    },
  };

  setup(api);

  return {
    pluginId,
    ...(appUrl ? { appUrl } : {}),
    homepageSections,
    settingsSections,
    appOverlays,
    navPanels,
    threadPanelActions,
    newThreadPanelActions,
    pendingInteractions,
    sidebarFooterActions,
    sidebarNavigations,
    threadLists,
    threadHeaderActions,
    browserToolbarActions,
    fileOpeners,
    sourceCodeRenderers,
    diffRenderers,
    messageDirectives,
    messageActions,
    commands,
    providerIcons,
    timelineRenderers,
    environmentProviderInputs,
    machineProviderInputs,
    composerCustomizations,
    contentScripts,
    sidebarFooterItems,
    icons,
  };
}
