import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PLUGIN_SDK_SOURCE_FILES = {
  "@synara/plugin-sdk": "index.ts",
  "@synara/plugin-sdk/app": "app.ts",
} as const;

export type PluginSdkSpecifier = keyof typeof PLUGIN_SDK_SOURCE_FILES;

export function resolvePluginSdkSource(specifier: PluginSdkSpecifier): string {
  const bundledSource = fileURLToPath(
    new URL(`./plugin-sdk/${PLUGIN_SDK_SOURCE_FILES[specifier]}`, import.meta.url),
  );
  return existsSync(bundledSource) ? bundledSource : fileURLToPath(import.meta.resolve(specifier));
}
