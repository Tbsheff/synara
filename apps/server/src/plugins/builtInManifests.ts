import type { SynaraPluginManifest } from "@synara/plugin-sdk";

export const builtInPluginManifests: readonly SynaraPluginManifest[] = [];

export function isBuiltInPluginId(pluginId: string): boolean {
  return builtInPluginManifests.some((manifest) => manifest.id === pluginId);
}
