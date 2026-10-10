import { ORIGINAL_PLUGIN_SIDEBAR_PROVIDER } from "./PluginSidebar.logic";

const PLUGIN_SIDEBAR_PREFERENCES_STORAGE_KEY = "synara:plugin-sidebar:v1";

export interface PluginSidebarPreferences {
  readonly navigationProvider: string;
  readonly threadListProvider: string;
}

export const DEFAULT_PLUGIN_SIDEBAR_PREFERENCES: PluginSidebarPreferences = Object.freeze({
  navigationProvider: ORIGINAL_PLUGIN_SIDEBAR_PROVIDER,
  threadListProvider: ORIGINAL_PLUGIN_SIDEBAR_PROVIDER,
});

function sanitizeProvider(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : ORIGINAL_PLUGIN_SIDEBAR_PROVIDER;
}

export function readPluginSidebarPreferences(): PluginSidebarPreferences {
  if (typeof window === "undefined") return DEFAULT_PLUGIN_SIDEBAR_PREFERENCES;

  try {
    const raw = window.localStorage.getItem(PLUGIN_SIDEBAR_PREFERENCES_STORAGE_KEY);
    if (!raw) return DEFAULT_PLUGIN_SIDEBAR_PREFERENCES;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return DEFAULT_PLUGIN_SIDEBAR_PREFERENCES;
    }
    const values = parsed as Record<string, unknown>;
    return {
      navigationProvider: sanitizeProvider(values.navigationProvider),
      threadListProvider: sanitizeProvider(values.threadListProvider),
    };
  } catch {
    return DEFAULT_PLUGIN_SIDEBAR_PREFERENCES;
  }
}

export function persistPluginSidebarPreferences(preferences: PluginSidebarPreferences): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      PLUGIN_SIDEBAR_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        navigationProvider: sanitizeProvider(preferences.navigationProvider),
        threadListProvider: sanitizeProvider(preferences.threadListProvider),
      }),
    );
  } catch {
    return;
  }
}
