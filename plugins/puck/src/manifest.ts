import type { SynaraPluginManifest } from "@synara/plugin-sdk";

export const puckManifest = {
  id: "@synara/plugin-puck",
  displayName: "Puck",
  version: "0.1.0",
  apiVersion: 2,
  app: "puck",
  sourcePath: "plugins/puck",
} as const satisfies SynaraPluginManifest;
