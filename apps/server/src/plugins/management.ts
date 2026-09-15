import { realpathSync, watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { reviewQueueManifest } from "@synara/plugin-review-queue/manifest";

import { buildPlugin, type PluginBuildResult } from "./build";
import {
  findPluginSource,
  installPluginControl,
  readPluginControl,
  removePluginControl,
  updatePluginControl,
} from "./control";
import { readPluginManifest } from "./manifest";
import { removePluginSkills, replacePluginSkills, syncPluginSkills } from "./skills";

export interface PluginManagementRecord {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: 1 | 2;
  readonly app: string | null;
  readonly enabled: boolean;
  readonly reloadToken: string;
  readonly sourceRoot: string | null;
  readonly builtIn: boolean;
  readonly error?: string;
}

function reviewQueueSourceRoot(cwd: string): string | null {
  if (!reviewQueueManifest.sourcePath) return null;
  return (
    findPluginSource(cwd, reviewQueueManifest.sourcePath) ??
    findPluginSource(
      path.dirname(fileURLToPath(import.meta.url)),
      reviewQueueManifest.sourcePath,
    ) ??
    null
  );
}

export function listPluginRecords(baseDir: string, cwd = process.cwd()): PluginManagementRecord[] {
  const control = readPluginControl(baseDir);
  const builtInControl = control.plugins[reviewQueueManifest.id];
  const records: PluginManagementRecord[] = [
    {
      id: reviewQueueManifest.id,
      name: reviewQueueManifest.displayName,
      version: reviewQueueManifest.version,
      apiVersion: reviewQueueManifest.apiVersion,
      app: reviewQueueManifest.app ?? null,
      enabled: builtInControl?.enabled ?? true,
      reloadToken: builtInControl?.reloadToken ?? "",
      sourceRoot: reviewQueueSourceRoot(cwd),
      builtIn: true,
    },
  ];

  for (const [id, entry] of Object.entries(control.plugins)) {
    if (id === reviewQueueManifest.id || !entry.sourceRoot) continue;
    try {
      const manifest = readPluginManifest(entry.sourceRoot);
      records.push({
        id,
        name: manifest.displayName,
        version: manifest.version,
        apiVersion: manifest.apiVersion,
        app: manifest.appEntry ? manifest.appKey : null,
        enabled: entry.enabled,
        reloadToken: entry.reloadToken,
        sourceRoot: manifest.sourceRoot,
        builtIn: false,
        ...(manifest.id === id
          ? {}
          : { error: `Installed id ${id} does not match manifest id ${manifest.id}.` }),
      });
    } catch (cause) {
      records.push({
        id,
        name: id,
        version: "unknown",
        apiVersion: 1,
        app: null,
        enabled: entry.enabled,
        reloadToken: entry.reloadToken,
        sourceRoot: entry.sourceRoot,
        builtIn: false,
        error: cause instanceof Error ? cause.message : "Plugin manifest could not be read.",
      });
    }
  }
  return records.sort(
    (left, right) =>
      Number(right.builtIn) - Number(left.builtIn) || left.id.localeCompare(right.id),
  );
}

export function resolvePluginRecord(
  baseDir: string,
  input: string,
  cwd = process.cwd(),
): PluginManagementRecord {
  const record = listPluginRecords(baseDir, cwd).find((candidate) => {
    const shortId = candidate.id
      .split("/")
      .at(-1)
      ?.replace(/^synara-plugin-/, "");
    return candidate.id === input || candidate.app === input || shortId === input;
  });
  if (!record) throw new Error(`Unknown Synara plugin: ${input}`);
  return record;
}

export async function installPlugin(
  baseDir: string,
  sourcePath: string,
): Promise<{
  readonly record: PluginManagementRecord;
  readonly build: PluginBuildResult;
  readonly skills: ReadonlyArray<string>;
}> {
  const manifest = readPluginManifest(path.resolve(sourcePath));
  if (manifest.id === reviewQueueManifest.id) {
    throw new Error("The built-in Review Queue plugin cannot be replaced with plugin install.");
  }
  const installedSource = readPluginControl(baseDir).plugins[manifest.id]?.sourceRoot;
  if (installedSource && realpathSync(installedSource) !== manifest.sourceRoot) {
    throw new Error(
      `Plugin ${manifest.id} is already installed from ${installedSource}; uninstall it before installing a different source.`,
    );
  }
  const buildResult = await buildPlugin(manifest.sourceRoot);
  const skills = replacePluginSkills(baseDir, manifest.id, manifest.skillRoots, (installed) => {
    installPluginControl(baseDir, manifest.id, manifest.sourceRoot, buildResult.reloadToken);
    return installed;
  });
  return {
    record: resolvePluginRecord(baseDir, manifest.id),
    build: buildResult,
    skills,
  };
}

export async function reloadPlugin(
  baseDir: string,
  input: string,
): Promise<{ readonly record: PluginManagementRecord; readonly build?: PluginBuildResult }> {
  const record = resolvePluginRecord(baseDir, input);
  if (record.error) throw new Error(record.error);
  if (record.sourceRoot) {
    const buildResult = await buildPlugin(record.sourceRoot);
    const manifest = readPluginManifest(record.sourceRoot);
    return replacePluginSkills(baseDir, record.id, manifest.skillRoots, () => {
      updatePluginControl(baseDir, record.id, (current) => ({
        ...current,
        reloadToken: buildResult.reloadToken,
      }));
      return {
        record: resolvePluginRecord(baseDir, record.id),
        build: buildResult,
      };
    });
  } else if (!record.builtIn) {
    throw new Error(`Plugin source is not available: ${record.id}`);
  }
  updatePluginControl(baseDir, record.id, (current) => ({
    ...current,
    reloadToken: `${Date.now()}-${crypto.randomUUID()}`,
  }));
  return { record: resolvePluginRecord(baseDir, record.id) };
}

export function setPluginEnabled(
  baseDir: string,
  input: string,
  enabled: boolean,
): PluginManagementRecord {
  const record = resolvePluginRecord(baseDir, input);
  if (record.error && enabled) throw new Error(record.error);
  const skillSourceRoot = enabled && !record.enabled && !record.builtIn ? record.sourceRoot : null;
  if (skillSourceRoot) {
    const manifest = readPluginManifest(skillSourceRoot);
    syncPluginSkills(baseDir, record.id, manifest.skillRoots);
  }
  try {
    updatePluginControl(baseDir, record.id, (current) => ({ ...current, enabled }));
  } catch (cause) {
    if (skillSourceRoot) removePluginSkills(baseDir, record.id);
    throw cause;
  }
  if (!enabled && !record.builtIn && record.sourceRoot) removePluginSkills(baseDir, record.id);
  return resolvePluginRecord(baseDir, record.id);
}

export function uninstallPlugin(
  baseDir: string,
  input: string,
): { readonly id: string; readonly sourceRoot: string | null; readonly removedSkills: boolean } {
  const record = resolvePluginRecord(baseDir, input);
  if (record.builtIn) throw new Error("Built-in Synara plugins cannot be uninstalled.");
  if (!removePluginControl(baseDir, record.id))
    throw new Error(`Plugin is not installed: ${record.id}`);
  const removedSkills = removePluginSkills(baseDir, record.id);
  return { id: record.id, sourceRoot: record.sourceRoot, removedSkills };
}

export async function watchPlugin(
  baseDir: string,
  sourcePath: string,
  onBuild: (result: Awaited<ReturnType<typeof reloadPlugin>>) => void,
  onError: (cause: unknown) => void,
): Promise<never> {
  const installed = await installPlugin(baseDir, sourcePath);
  onBuild({ record: installed.record, build: installed.build });
  const sourceRoot = installed.record.sourceRoot!;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let pending = false;
  const rebuild = async () => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      onBuild(await reloadPlugin(baseDir, installed.record.id));
    } catch (cause) {
      onError(cause);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        void rebuild();
      }
    }
  };
  const scheduleRebuild = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void rebuild(), 150);
  };
  const watcher = watch(sourceRoot, { recursive: true }, (_event, fileName) => {
    const relative = fileName?.toString() ?? "";
    const parts = relative.replaceAll("\\", "/").split("/");
    if (
      !relative ||
      parts.some((part) => part === "dist" || part === "node_modules" || part === ".git")
    ) {
      return;
    }
    scheduleRebuild();
  });
  watcher.on("error", onError);
  return new Promise<never>(() => undefined);
}
