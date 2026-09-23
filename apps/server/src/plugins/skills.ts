import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

import { synaraSkillsDir } from "../provider/skillsCatalog";

function installKey(pluginId: string): string {
  return `plugin-${createHash("sha256").update(pluginId).digest("hex").slice(0, 16)}`;
}

export function pluginSkillsInstallRoot(baseDir: string, pluginId: string): string {
  return path.join(synaraSkillsDir(baseDir), installKey(pluginId));
}

function skillDirectories(skillRoot: string): string[] {
  if (existsSync(path.join(skillRoot, "SKILL.md"))) return [skillRoot];
  return readdirSync(skillRoot, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(path.join(skillRoot, entry.name, "SKILL.md")),
    )
    .map((entry) => path.join(skillRoot, entry.name));
}

export function syncPluginSkills(
  baseDir: string,
  pluginId: string,
  skillRoots: ReadonlyArray<string>,
): string[] {
  const targetRoot = pluginSkillsInstallRoot(baseDir, pluginId);
  const skills = skillRoots.flatMap(skillDirectories);
  const names = new Set<string>();
  for (const skillDirectory of skills) {
    const name = path.basename(skillDirectory);
    if (names.has(name)) throw new Error(`Duplicate plugin skill directory: ${name}`);
    names.add(name);
  }

  const nonce = `${process.pid}.${crypto.randomUUID()}`;
  const stagedRoot = `${targetRoot}.${nonce}.tmp`;
  const backupRoot = `${targetRoot}.${nonce}.backup`;
  mkdirSync(stagedRoot, { recursive: true, mode: 0o700 });
  const installed: string[] = [];
  let movedPrevious = false;
  try {
    for (const skillDirectory of skills) {
      const name = path.basename(skillDirectory);
      const target = path.join(stagedRoot, name);
      cpSync(skillDirectory, target, { recursive: true });
      installed.push(path.join(targetRoot, name, "SKILL.md"));
    }
    if (existsSync(targetRoot)) {
      renameSync(targetRoot, backupRoot);
      movedPrevious = true;
    }
    renameSync(stagedRoot, targetRoot);
    rmSync(backupRoot, { recursive: true, force: true });
  } catch (cause) {
    rmSync(stagedRoot, { recursive: true, force: true });
    if (movedPrevious && !existsSync(targetRoot)) renameSync(backupRoot, targetRoot);
    throw cause;
  }
  return installed;
}

export function removePluginSkills(baseDir: string, pluginId: string): boolean {
  const targetRoot = pluginSkillsInstallRoot(baseDir, pluginId);
  if (!existsSync(targetRoot)) return false;
  rmSync(targetRoot, { recursive: true, force: true });
  return true;
}

export function replacePluginSkills<Value>(
  baseDir: string,
  pluginId: string,
  skillRoots: ReadonlyArray<string>,
  commit: (installed: ReadonlyArray<string>) => Value,
): Value {
  const targetRoot = pluginSkillsInstallRoot(baseDir, pluginId);
  const backupRoot = `${targetRoot}.${process.pid}.${crypto.randomUUID()}.transaction-backup`;
  const hadPrevious = existsSync(targetRoot);
  if (hadPrevious) cpSync(targetRoot, backupRoot, { recursive: true });
  try {
    const installed = syncPluginSkills(baseDir, pluginId, skillRoots);
    const result = commit(installed);
    rmSync(backupRoot, { recursive: true, force: true });
    return result;
  } catch (cause) {
    rmSync(targetRoot, { recursive: true, force: true });
    if (hadPrevious) renameSync(backupRoot, targetRoot);
    throw cause;
  }
}
