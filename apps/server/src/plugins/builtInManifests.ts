import { puckManifest } from "@synara/plugin-puck/manifest";
import { reviewQueueManifest } from "@synara/plugin-review-queue/manifest";
import type { SynaraPluginManifest } from "@synara/plugin-sdk";

export const builtInPluginManifests: readonly SynaraPluginManifest[] = [
  reviewQueueManifest,
  puckManifest,
];

export function isBuiltInPluginId(pluginId: string): boolean {
  return builtInPluginManifests.some((manifest) => manifest.id === pluginId);
}
