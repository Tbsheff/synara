import type { SynaraPluginAppContext } from "@synara/plugin-sdk/app";
import {
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  createContext,
  type ReactNode,
} from "react";

import { EllipsisIcon, LayoutSidebarIcon, PluginIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { SidebarGlyph } from "~/components/sidebarGlyphs";
import { SidebarIconButton } from "~/components/SidebarIconButton";
import { SidebarLeadingIcon } from "~/components/SidebarLeadingIcon";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "~/components/ui/sidebar";
import { toastManager } from "~/components/ui/toast";
import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
  SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
} from "~/sidebarRowStyles";

import type { ActivePluginContribution } from "./frontendRuntime";
import {
  ORIGINAL_PLUGIN_SIDEBAR_PROVIDER,
  pluginSidebarContributionKey,
  resolvePluginSidebarContribution,
  splitPluginSidebarFooterContributions,
  togglePluginSidebarDisclosure,
} from "./PluginSidebar.logic";
import {
  persistPluginSidebarPreferences,
  readPluginSidebarPreferences,
  type PluginSidebarPreferences,
} from "./PluginSidebar.preferences";
import { PluginContributionErrorBoundary, usePluginContributions } from "./runtime";

const MAX_VISIBLE_FOOTER_ACTIONS = 2;
const MAX_VISIBLE_FOOTER_ITEMS = 2;

const OriginalSidebarSurfaceContext = createContext<ReactNode>(null);

function OriginalSidebarSurface() {
  return useContext(OriginalSidebarSurfaceContext);
}

export function usePluginSidebarPreferences(): readonly [
  PluginSidebarPreferences,
  (patch: Partial<PluginSidebarPreferences>) => void,
] {
  const [preferences, setPreferences] = useState(readPluginSidebarPreferences);
  const updatePreferences = useCallback((patch: Partial<PluginSidebarPreferences>) => {
    setPreferences((current) => {
      const next = { ...current, ...patch };
      persistPluginSidebarPreferences(next);
      return next;
    });
  }, []);
  return [preferences, updatePreferences] as const;
}

export function PluginSidebarNavigationSurface({
  children,
  context,
  selectedProvider,
}: {
  readonly children: ReactNode;
  readonly context: SynaraPluginAppContext;
  readonly selectedProvider: string;
}) {
  const contributions = usePluginContributions("sidebarNavigations");
  const selected = resolvePluginSidebarContribution(contributions, selectedProvider);
  if (!selected) return children;

  const Navigation = selected.component;
  return (
    <OriginalSidebarSurfaceContext.Provider value={children}>
      <PluginContributionErrorBoundary
        key={`${selected.plugin.id}:${selected.id}:${selected.plugin.generation}`}
        plugin={selected.plugin}
        contributionId={selected.id}
        fallback={children}
      >
        <Navigation context={context} plugin={selected.plugin} Original={OriginalSidebarSurface} />
      </PluginContributionErrorBoundary>
    </OriginalSidebarSurfaceContext.Provider>
  );
}

export function PluginThreadListSurface({
  children,
  context,
  selectedProvider,
}: {
  readonly children: ReactNode;
  readonly context: SynaraPluginAppContext;
  readonly selectedProvider: string;
}) {
  const contributions = usePluginContributions("threadLists");
  const selected = resolvePluginSidebarContribution(contributions, selectedProvider);
  if (!selected) return children;

  const ThreadList = selected.component;
  return (
    <OriginalSidebarSurfaceContext.Provider value={children}>
      <PluginContributionErrorBoundary
        key={`${selected.plugin.id}:${selected.id}:${selected.plugin.generation}`}
        plugin={selected.plugin}
        contributionId={selected.id}
        fallback={children}
      >
        <ThreadList context={context} plugin={selected.plugin} Original={OriginalSidebarSurface} />
      </PluginContributionErrorBoundary>
    </OriginalSidebarSurfaceContext.Provider>
  );
}

type ActiveFooterAction = ActivePluginContribution<"sidebarFooterActions">;
type ActiveFooterItem = ActivePluginContribution<"sidebarFooterItems">;
type RunnableFooterContribution =
  | ActiveFooterAction
  | Extract<ActiveFooterItem, { kind: "action" }>;

function footerContributionKey(
  kind: "action" | "item",
  contribution: ActiveFooterAction | ActiveFooterItem,
): string {
  return `${kind}:${pluginSidebarContributionKey(contribution)}`;
}

function PluginFooterItemRow({
  item,
  onRun,
  onToggleDisclosure,
  open,
  pending,
}: {
  readonly item: ActiveFooterItem;
  readonly onRun: (contribution: RunnableFooterContribution) => void;
  readonly onToggleDisclosure: (item: ActiveFooterItem) => void;
  readonly open: boolean;
  readonly pending: boolean;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="sm"
        aria-expanded={item.kind === "disclosure" ? open : undefined}
        disabled={pending}
        className={cn(
          SIDEBAR_HEADER_ROW_CLASS_NAME,
          SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
          SIDEBAR_ROW_HOVER_CLASS_NAME,
        )}
        onClick={() => {
          if (item.kind === "action") onRun(item);
          else onToggleDisclosure(item);
        }}
      >
        <SidebarLeadingIcon size="sm" tone={SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME}>
          <SidebarGlyph icon={PluginIcon} variant="leading" />
        </SidebarLeadingIcon>
        <span className="min-w-0 flex-1 truncate">{item.title}</span>
        {item.kind === "disclosure" ? <DisclosureChevron open={open} /> : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function PluginFooterDisclosure({
  context,
  item,
}: {
  readonly context: SynaraPluginAppContext;
  readonly item: Extract<ActiveFooterItem, { kind: "disclosure" }>;
}) {
  const Disclosure = item.component;
  return (
    <DisclosureRegion open className="px-1 pt-1">
      <PluginContributionErrorBoundary
        key={`${item.plugin.id}:${item.id}:${item.plugin.generation}`}
        plugin={item.plugin}
        contributionId={item.id}
        fallback={
          <p className="px-2 py-1.5 text-ui-xs text-destructive">This plugin panel failed.</p>
        }
      >
        <Disclosure context={context} plugin={item.plugin} />
      </PluginContributionErrorBoundary>
    </DisclosureRegion>
  );
}

function ProviderChoices({
  contributions,
  label,
  selectedProvider,
  onSelect,
}: {
  readonly contributions: readonly (
    | ActivePluginContribution<"sidebarNavigations">
    | ActivePluginContribution<"threadLists">
  )[];
  readonly label: string;
  readonly selectedProvider: string;
  readonly onSelect: (provider: string) => void;
}) {
  const availableKeys = useMemo(
    () => new Set(contributions.map(pluginSidebarContributionKey)),
    [contributions],
  );
  const unavailable =
    selectedProvider !== ORIGINAL_PLUGIN_SIDEBAR_PROVIDER && !availableKeys.has(selectedProvider);

  return (
    <MenuGroup>
      <MenuGroupLabel>{label}</MenuGroupLabel>
      <MenuRadioGroup value={selectedProvider} onValueChange={onSelect}>
        <MenuRadioItem value={ORIGINAL_PLUGIN_SIDEBAR_PROVIDER} closeOnClick>
          Original
        </MenuRadioItem>
        {contributions.map((contribution) => {
          const key = pluginSidebarContributionKey(contribution);
          return (
            <MenuRadioItem key={key} value={key} closeOnClick>
              <span className="min-w-0 truncate">{contribution.title}</span>
            </MenuRadioItem>
          );
        })}
        {unavailable ? (
          <MenuRadioItem value={selectedProvider} disabled>
            Unavailable (using Original)
          </MenuRadioItem>
        ) : null}
      </MenuRadioGroup>
    </MenuGroup>
  );
}

export function PluginSidebarFooterExtensions({
  context,
  onManageExtensions,
  preferences,
  updatePreferences,
}: {
  readonly context: SynaraPluginAppContext;
  readonly onManageExtensions: () => void;
  readonly preferences: PluginSidebarPreferences;
  readonly updatePreferences: (patch: Partial<PluginSidebarPreferences>) => void;
}) {
  const footerActions = usePluginContributions("sidebarFooterActions");
  const footerItems = usePluginContributions("sidebarFooterItems");
  const sidebarNavigations = usePluginContributions("sidebarNavigations");
  const threadLists = usePluginContributions("threadLists");
  const [openDisclosureKey, setOpenDisclosureKey] = useState<string | null>(null);
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const pendingKeysRef = useRef(new Set<string>());
  const actionSplit = splitPluginSidebarFooterContributions(
    footerActions,
    MAX_VISIBLE_FOOTER_ACTIONS,
  );
  const itemSplit = splitPluginSidebarFooterContributions(footerItems, MAX_VISIBLE_FOOTER_ITEMS);
  const hasProviderChoices = sidebarNavigations.length > 0 || threadLists.length > 0;
  const hasOverflow = actionSplit.overflow.length > 0 || itemSplit.overflow.length > 0;
  const hasContributions = footerActions.length > 0 || footerItems.length > 0 || hasProviderChoices;
  const activeDisclosure = footerItems.find(
    (item): item is Extract<ActiveFooterItem, { kind: "disclosure" }> =>
      item.kind === "disclosure" && footerContributionKey("item", item) === openDisclosureKey,
  );

  const runContribution = useCallback(
    async (contribution: RunnableFooterContribution) => {
      const kind = "kind" in contribution ? "item" : "action";
      const key = footerContributionKey(kind, contribution);
      if (pendingKeysRef.current.has(key)) return;
      pendingKeysRef.current.add(key);
      setPendingKeys(new Set(pendingKeysRef.current));
      try {
        await contribution.run({ context, plugin: contribution.plugin });
      } catch (cause: unknown) {
        console.error(
          `Plugin sidebar action failed: ${contribution.plugin.id}/${contribution.id}`,
          cause,
        );
        toastManager.add({
          type: "error",
          title: "Plugin action failed",
          description: `${contribution.title} could not run.`,
        });
      } finally {
        pendingKeysRef.current.delete(key);
        setPendingKeys(new Set(pendingKeysRef.current));
      }
    },
    [context],
  );

  const toggleDisclosure = useCallback((item: ActiveFooterItem) => {
    const key = footerContributionKey("item", item);
    setOpenDisclosureKey((current) => togglePluginSidebarDisclosure(current, key));
  }, []);

  if (!hasContributions) return null;

  return (
    <div className="flex flex-col gap-1">
      {itemSplit.visible.length > 0 ? (
        <SidebarMenu className="gap-1">
          {itemSplit.visible.map((item) => {
            const key = footerContributionKey("item", item);
            return (
              <PluginFooterItemRow
                key={key}
                item={item}
                open={openDisclosureKey === key}
                pending={pendingKeys.has(key)}
                onRun={(contribution) => void runContribution(contribution)}
                onToggleDisclosure={toggleDisclosure}
              />
            );
          })}
        </SidebarMenu>
      ) : null}
      {activeDisclosure ? (
        <PluginFooterDisclosure context={context} item={activeDisclosure} />
      ) : null}

      <div className="flex items-center justify-end gap-1 px-1">
        {actionSplit.visible.map((action) => {
          const key = footerContributionKey("action", action);
          return (
            <SidebarIconButton
              key={key}
              icon={PluginIcon}
              label={action.title}
              tooltip={action.title}
              disabled={pendingKeys.has(key)}
              onClick={() => void runContribution(action)}
            />
          );
        })}
        <Menu>
          <SidebarIconButton
            render={<MenuTrigger />}
            icon={hasOverflow ? EllipsisIcon : LayoutSidebarIcon}
            label="Plugin sidebar options"
            tooltip="Plugin sidebar options"
          />
          <ComposerPickerMenuPopup align="end" side="top" className="w-64 min-w-64">
            {actionSplit.overflow.length > 0 ? (
              <MenuGroup>
                <MenuGroupLabel>Actions</MenuGroupLabel>
                {actionSplit.overflow.map((action) => {
                  const key = footerContributionKey("action", action);
                  return (
                    <MenuItem
                      key={key}
                      disabled={pendingKeys.has(key)}
                      onClick={() => void runContribution(action)}
                    >
                      <PluginIcon className="size-3.5" />
                      <span className="min-w-0 truncate">{action.title}</span>
                    </MenuItem>
                  );
                })}
              </MenuGroup>
            ) : null}
            {itemSplit.overflow.length > 0 ? (
              <MenuGroup>
                <MenuGroupLabel>Footer items</MenuGroupLabel>
                {itemSplit.overflow.map((item) => {
                  const key = footerContributionKey("item", item);
                  return (
                    <MenuItem
                      key={key}
                      disabled={item.kind === "action" && pendingKeys.has(key)}
                      onClick={() => {
                        if (item.kind === "action") void runContribution(item);
                        else toggleDisclosure(item);
                      }}
                    >
                      <PluginIcon className="size-3.5" />
                      <span className="min-w-0 truncate">{item.title}</span>
                    </MenuItem>
                  );
                })}
              </MenuGroup>
            ) : null}
            {hasOverflow && hasProviderChoices ? <MenuSeparator /> : null}
            {sidebarNavigations.length > 0 ? (
              <ProviderChoices
                contributions={sidebarNavigations}
                label="Navigation"
                selectedProvider={preferences.navigationProvider}
                onSelect={(navigationProvider) => updatePreferences({ navigationProvider })}
              />
            ) : null}
            {threadLists.length > 0 ? (
              <ProviderChoices
                contributions={threadLists}
                label="Thread list"
                selectedProvider={preferences.threadListProvider}
                onSelect={(threadListProvider) => updatePreferences({ threadListProvider })}
              />
            ) : null}
            <MenuSeparator />
            <MenuItem onClick={onManageExtensions}>
              <PluginIcon className="size-3.5" />
              <span>Manage extensions</span>
            </MenuItem>
          </ComposerPickerMenuPopup>
        </Menu>
      </div>
    </div>
  );
}
