import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { resolveExecutable } from "@synara/shared/executable";

export interface CodexLaunchTarget {
  readonly binaryPath: string;
  readonly env: NodeJS.ProcessEnv;
}

type CodexPackageManager = "bun" | "pnpm" | "vite-plus" | "npm";

interface CodexNativeLayout {
  readonly nativePath: string;
  readonly packageRoot: string;
  readonly installedBy: "pnpm" | "vite-plus" | null;
  readonly installedUnderBunGlobal: boolean;
}

export interface CodexNativeLaunchOptions {
  readonly cwd?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

const CODEX_PLATFORM_PACKAGE_BY_TARGET: Readonly<Record<string, string>> = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
};

const CODEX_MANAGED_BY_ENV_NAMES: Readonly<Record<CodexPackageManager, string>> = {
  bun: "CODEX_MANAGED_BY_BUN",
  pnpm: "CODEX_MANAGED_BY_PNPM",
  "vite-plus": "CODEX_MANAGED_BY_VITE_PLUS",
  npm: "CODEX_MANAGED_BY_NPM",
};

interface CodexNativeLayoutCacheEntry {
  readonly wrapperIdentity: string;
  readonly layout: CodexNativeLayout | null;
}

const codexNativeLayouts = new Map<string, CodexNativeLayoutCacheEntry>();

function codexTargetTriple(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === "linux" || platform === "android") {
    if (arch === "x64") return "x86_64-unknown-linux-musl";
    if (arch === "arm64") return "aarch64-unknown-linux-musl";
    return null;
  }
  if (platform === "darwin") {
    if (arch === "x64") return "x86_64-apple-darwin";
    if (arch === "arm64") return "aarch64-apple-darwin";
  }
  return null;
}

async function fileIdentity(filePath: string): Promise<string | null> {
  try {
    const stats = await fs.stat(filePath);
    return `${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
  } catch {
    return null;
  }
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function isCodexWrapperPackage(packageRoot: string): Promise<boolean> {
  const manifest = await readJsonRecord(path.join(packageRoot, "package.json"));
  if (manifest?.name !== "@openai/codex") return false;
  const bin = manifest.bin;
  const codexBin =
    typeof bin === "string"
      ? bin
      : bin && typeof bin === "object"
        ? (bin as Record<string, unknown>).codex
        : undefined;
  return (
    typeof codexBin === "string" &&
    path.posix.normalize(codexBin.replace(/^\.\//, "")) === "bin/codex.js"
  );
}

async function realpathOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return null;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isPnpmOwnedCodexInstall(
  nodeModulesDir: string,
  packageRoot: string,
): Promise<boolean> {
  if (!(await pathExists(path.join(nodeModulesDir, ".modules.yaml")))) return false;
  return (await realpathOrNull(path.join(nodeModulesDir, "@openai", "codex"))) === packageRoot;
}

async function isVitePlusOwnedCodexInstall(
  packagesDir: string,
  packageRoot: string,
): Promise<boolean> {
  if (path.basename(packagesDir) !== "packages") return false;
  const metadata = await readJsonRecord(path.join(packagesDir, "@openai", "codex.json"));
  if (metadata?.name !== "@openai/codex") return false;
  const installId = typeof metadata.installId === "string" ? metadata.installId : "";
  const installDir = installId.startsWith("#")
    ? path.join(packagesDir, `@openai/codex${installId}`)
    : path.join(packagesDir, "@openai/codex", installId);
  for (const nodeModulesDir of [
    path.join(installDir, "lib", "node_modules"),
    path.join(installDir, "node_modules"),
  ]) {
    if ((await realpathOrNull(path.join(nodeModulesDir, "@openai", "codex"))) === packageRoot) {
      return true;
    }
  }
  return false;
}

async function detectInstalledBy(
  packageRoot: string,
  entrypointDir: string,
): Promise<CodexNativeLayout["installedBy"]> {
  for (const startDir of new Set([packageRoot, entrypointDir])) {
    const filesystemRoot = path.parse(startDir).root;
    for (let currentDir = startDir; currentDir !== filesystemRoot; ) {
      if (await isVitePlusOwnedCodexInstall(currentDir, packageRoot)) return "vite-plus";
      if (await isPnpmOwnedCodexInstall(path.join(currentDir, "node_modules"), packageRoot)) {
        return "pnpm";
      }
      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }
    if (await isPnpmOwnedCodexInstall(path.join(filesystemRoot, "node_modules"), packageRoot)) {
      return "pnpm";
    }
  }
  return null;
}

async function resolveCodexNativeLayout(input: {
  readonly wrapperPath: string;
  readonly entrypointDir: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}): Promise<CodexNativeLayout | null> {
  const wrapperDir = path.dirname(input.wrapperPath);
  const packageRoot = await realpathOrNull(path.join(wrapperDir, ".."));
  if (!packageRoot || !(await isCodexWrapperPackage(packageRoot))) return null;
  const targetTriple = codexTargetTriple(input.platform, input.arch);
  const platformPackage = targetTriple ? CODEX_PLATFORM_PACKAGE_BY_TARGET[targetTriple] : undefined;
  if (!targetTriple || !platformPackage) return null;

  let vendorRoot: string;
  try {
    const packageJsonPath = createRequire(input.wrapperPath).resolve(
      `${platformPackage}/package.json`,
    );
    vendorRoot = path.join(path.dirname(packageJsonPath), "vendor");
  } catch {
    vendorRoot = path.join(wrapperDir, "..", "vendor");
  }
  const nativePath = path.join(vendorRoot, targetTriple, "bin", "codex");
  if (!(await pathExists(nativePath))) return null;

  return {
    nativePath,
    packageRoot,
    installedBy: await detectInstalledBy(packageRoot, input.entrypointDir),
    installedUnderBunGlobal:
      wrapperDir.includes(".bun/install/global") || wrapperDir.includes(".bun\\install\\global"),
  };
}

function resolvePackageManager(
  layout: CodexNativeLayout,
  env: NodeJS.ProcessEnv,
): CodexPackageManager {
  if (layout.installedBy) return layout.installedBy;
  if (/\bbun\//.test(env.npm_config_user_agent ?? "")) return "bun";
  if ((env.npm_execpath ?? "").includes("bun")) return "bun";
  if (layout.installedUnderBunGlobal) return "bun";
  return "npm";
}

export async function resolveCodexNativeLaunch(
  binaryPath: string,
  env: NodeJS.ProcessEnv,
  options: CodexNativeLaunchOptions = {},
): Promise<CodexLaunchTarget> {
  const unchanged = { binaryPath, env };
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return unchanged;

  const resolvedPath = resolveExecutable(binaryPath, {
    env,
    platform,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  if (!resolvedPath) return unchanged;
  const wrapperPath = await realpathOrNull(resolvedPath);
  if (
    !wrapperPath ||
    path.basename(wrapperPath) !== "codex.js" ||
    path.basename(path.dirname(wrapperPath)) !== "bin"
  ) {
    return unchanged;
  }
  const wrapperIdentity = await fileIdentity(wrapperPath);
  if (!wrapperIdentity) return unchanged;

  const arch = options.arch ?? process.arch;
  const entrypointDir = path.dirname(path.resolve(resolvedPath));
  const cacheKey = JSON.stringify([wrapperPath, entrypointDir, platform, arch]);
  const cached = codexNativeLayouts.get(cacheKey);
  const cachedLayoutIsCurrent =
    cached !== undefined &&
    cached.wrapperIdentity === wrapperIdentity &&
    (cached.layout === null || (await pathExists(cached.layout.nativePath)));
  const layout = cachedLayoutIsCurrent
    ? cached.layout
    : await resolveCodexNativeLayout({ wrapperPath, entrypointDir, platform, arch });
  if (!cachedLayoutIsCurrent) {
    codexNativeLayouts.set(cacheKey, { wrapperIdentity, layout });
  }
  if (!layout) return unchanged;

  const nativeEnv: NodeJS.ProcessEnv = { ...env, CODEX_MANAGED_PACKAGE_ROOT: layout.packageRoot };
  for (const name of Object.values(CODEX_MANAGED_BY_ENV_NAMES)) {
    delete nativeEnv[name];
  }
  nativeEnv[CODEX_MANAGED_BY_ENV_NAMES[resolvePackageManager(layout, env)]] = "1";
  return { binaryPath: layout.nativePath, env: nativeEnv };
}

export const __codexNativeLaunchTesting = {
  reset: () => codexNativeLayouts.clear(),
};
