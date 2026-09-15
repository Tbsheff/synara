import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { isContainedPath } from "../workspace/realPathContainment";

export interface LocalPluginManifest {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly apiVersion: 1;
  readonly appKey: string;
  readonly sourceRoot: string;
  readonly serverEntry: string;
  readonly appEntry?: string;
  readonly skillRoots: ReadonlyArray<string>;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function resolveEntry(root: string, value: unknown, name: string, kind: "file" | "directory") {
  const declared = requireString(value, name);
  const declaredPath = path.resolve(root, declared);
  if (declaredPath === root || !isContainedPath(root, declaredPath)) {
    throw new Error(`${name} must stay inside the plugin package root.`);
  }
  if (!existsSync(declaredPath)) throw new Error(`${name} does not exist: ${declared}`);
  const resolved = realpathSync(declaredPath);
  if (!isContainedPath(root, resolved)) {
    throw new Error(`${name} must stay inside the plugin package root.`);
  }
  const stat = statSync(resolved);
  if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) {
    throw new Error(`${name} must point to a ${kind}.`);
  }
  return resolved;
}

export function pluginAppKey(pluginId: string): string {
  const readable =
    pluginId
      .split("/")
      .at(-1)
      ?.replace(/^synara-plugin-/, "")
      .replace(/[^a-zA-Z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "plugin";
  const digest = createHash("sha256").update(pluginId).digest("hex").slice(0, 8);
  return `${readable}-${digest}`;
}

export function pluginAssetKey(pluginId: string): string {
  return createHash("sha256").update(pluginId).digest("hex").slice(0, 24);
}

export function readPluginManifest(sourceRoot: string): LocalPluginManifest {
  const root = realpathSync(sourceRoot);
  const packageJsonPath = path.join(root, "package.json");
  const packageJson = requireRecord(JSON.parse(readFileSync(packageJsonPath, "utf8")), "package.json");
  const synara = requireRecord(packageJson.synara, "package.json synara field");
  const packageName = requireString(packageJson.name, "package.json name");
  const id = synara.id === undefined ? packageName : requireString(synara.id, "synara.id");
  if (synara.apiVersion !== 1) throw new Error("synara.apiVersion must be 1.");
  const skills = synara.skills ?? [];
  if (!Array.isArray(skills)) throw new Error("synara.skills must be an array of paths.");

  return {
    id,
    displayName: requireString(synara.displayName, "synara.displayName"),
    version: requireString(packageJson.version, "package.json version"),
    apiVersion: 1,
    appKey: pluginAppKey(id),
    sourceRoot: root,
    serverEntry: resolveEntry(root, synara.server, "synara.server", "file"),
    ...(synara.app === undefined
      ? {}
      : { appEntry: resolveEntry(root, synara.app, "synara.app", "file") }),
    skillRoots: skills.map((entry, index) =>
      resolveEntry(root, entry, `synara.skills[${index}]`, "directory"),
    ),
  };
}
