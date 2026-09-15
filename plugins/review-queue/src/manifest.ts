import type { SynaraPluginManifest } from "@synara/plugin-sdk";

export const reviewQueueManifest = {
  id: "@synara/plugin-review-queue",
  displayName: "Review Queue",
  version: "0.1.0",
  apiVersion: 1,
  app: "review-queue",
  sourcePath: "plugins/review-queue",
} as const satisfies SynaraPluginManifest;
