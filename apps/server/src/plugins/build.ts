import { existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Plugin } from "esbuild";

import { readPluginManifest } from "./manifest";
import { resolvePluginSdkSource } from "./sdkSource";

const RUNTIME_SLOTS = {
  react: "react",
  "react-dom": "reactDom",
  "react-dom/client": "reactDomClient",
  "react/jsx-runtime": "jsxRuntime",
  "react/jsx-dev-runtime": "jsxDevRuntime",
  "@synara/plugin-sdk": "pluginSdk",
  "@synara/plugin-sdk/app": "pluginSdkApp",
} as const;

const webRequire = createRequire(new URL("../../../web/package.json", import.meta.url));
const serverRequire = createRequire(import.meta.url);

async function loadEsbuild(): Promise<typeof import("esbuild")> {
  const asarSegment = `${path.sep}app.asar${path.sep}`;
  const esbuildEntry = serverRequire.resolve("esbuild");
  if (!process.env.ESBUILD_BINARY_PATH && esbuildEntry.includes(asarSegment)) {
    const binarySubpath = process.platform === "win32" ? "esbuild.exe" : "bin/esbuild";
    const binaryPath = createRequire(esbuildEntry).resolve(
      `@esbuild/${process.platform}-${process.arch}/${binarySubpath}`,
    );
    process.env.ESBUILD_BINARY_PATH = binaryPath.replace(
      asarSegment,
      `${path.sep}app.asar.unpacked${path.sep}`,
    );
  }
  return import("esbuild");
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function runtimeShimSource(specifier: keyof typeof RUNTIME_SLOTS): Promise<string> {
  const resolved =
    specifier === "@synara/plugin-sdk/app" || specifier === "@synara/plugin-sdk"
      ? pathToFileURL(resolvePluginSdkSource(specifier)).href
      : pathToFileURL(webRequire.resolve(specifier)).href;
  const moduleNamespace = (await import(resolved)) as Record<string, unknown>;
  const names = Object.keys(moduleNamespace)
    .filter((name) => name !== "default" && /^[A-Za-z_$][\w$]*$/.test(name))
    .sort();
  const slot = RUNTIME_SLOTS[specifier];
  return [
    "const runtime = globalThis.__synaraPluginRuntime;",
    `if (!runtime?.${slot}) throw new Error(${JSON.stringify(`Synara did not provide the shared ${specifier} runtime.`)});`,
    `const mod = runtime.${slot};`,
    'export default ("default" in mod ? mod.default : mod);',
    ...names.map((name) => `export const ${name} = mod.${name};`),
    "",
  ].join("\n");
}

function runtimeShimPlugin(): Plugin {
  const filter = new RegExp(`^(${Object.keys(RUNTIME_SLOTS).map(escapeRegex).join("|")})$`);
  return {
    name: "synara-plugin-runtime",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter }, (args) => ({
        path: args.path,
        namespace: "synara-plugin-runtime",
      }));
      pluginBuild.onLoad({ filter: /.*/, namespace: "synara-plugin-runtime" }, async (args) => ({
        contents: await runtimeShimSource(args.path as keyof typeof RUNTIME_SLOTS),
        loader: "js",
      }));
    },
  };
}

function pluginSdkServerAlias(): Plugin {
  const sdkEntry = resolvePluginSdkSource("@synara/plugin-sdk");
  return {
    name: "synara-plugin-sdk-server",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^@synara\/plugin-sdk$/ }, () => ({
        path: sdkEntry,
        namespace: "synara-plugin-sdk",
      }));
      pluginBuild.onLoad({ filter: /.*/, namespace: "synara-plugin-sdk" }, async (args) => ({
        contents: await readFile(args.path, "utf8"),
        loader: "ts",
      }));
    },
  };
}

export interface PluginBuildResult {
  readonly id: string;
  readonly sourceRoot: string;
  readonly reloadToken: string;
  readonly outputRoot: string;
  readonly serverOutput: string;
  readonly appOutput?: string;
  readonly appCssOutput?: string;
}

export function pluginBuildOutputRoot(sourceRoot: string, reloadToken: string): string {
  return path.join(sourceRoot, "dist", "generations", reloadToken);
}

export async function buildPlugin(sourceRoot: string): Promise<PluginBuildResult> {
  const manifest = readPluginManifest(sourceRoot);
  const { build } = await loadEsbuild();
  const reloadToken = `${Date.now()}-${crypto.randomUUID()}`;
  const outputRoot = pluginBuildOutputRoot(manifest.sourceRoot, reloadToken);
  mkdirSync(outputRoot, { recursive: true });
  const serverOutput = path.join(outputRoot, "server.js");
  const serverBuild = build({
    entryPoints: [manifest.serverEntry],
    outfile: serverOutput,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: true,
    plugins: [pluginSdkServerAlias()],
  });

  let appOutput: string | undefined;
  let appCssOutput: string | undefined;
  let appBuild: Promise<unknown> = Promise.resolve();
  if (manifest.appEntry) {
    appOutput = path.join(outputRoot, "app.js");
    appBuild = build({
      entryPoints: [manifest.appEntry],
      outfile: appOutput,
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "es2022",
      sourcemap: true,
      jsx: "automatic",
      plugins: [runtimeShimPlugin()],
    });
  }
  try {
    await Promise.all([serverBuild, appBuild]);
  } catch (cause) {
    rmSync(outputRoot, { recursive: true, force: true });
    throw cause;
  }
  const cssOutput = path.join(outputRoot, "app.css");
  appCssOutput = appOutput && existsSync(cssOutput) ? cssOutput : undefined;

  return {
    id: manifest.id,
    sourceRoot: manifest.sourceRoot,
    reloadToken,
    outputRoot,
    serverOutput,
    ...(appOutput ? { appOutput } : {}),
    ...(appCssOutput ? { appCssOutput } : {}),
  };
}
