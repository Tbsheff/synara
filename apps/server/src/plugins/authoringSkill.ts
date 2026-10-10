import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";

import { writeFileStringAtomically } from "../atomicWrite";
import { synaraSkillsDir } from "../provider/skillsCatalog";

const AUTHORING_SKILL_NAME = "synara-plugin-authoring";

function authoringSkillSourceCandidates(): ReadonlyArray<string> {
  return [
    fileURLToPath(
      new URL(`../../../../.claude/skills/${AUTHORING_SKILL_NAME}/SKILL.md`, import.meta.url),
    ),
    fileURLToPath(new URL(`./builtin-skills/${AUTHORING_SKILL_NAME}/SKILL.md`, import.meta.url)),
  ];
}

export function resolvePluginAuthoringSkillSource(): string {
  const source = authoringSkillSourceCandidates().find(existsSync);
  if (!source) {
    throw new Error("Synara plugin authoring skill is missing from this installation.");
  }
  return source;
}

export function pluginAuthoringSkillPath(baseDir: string): string {
  return path.join(synaraSkillsDir(baseDir), AUTHORING_SKILL_NAME, "SKILL.md");
}

export function makePluginEditPrompt(input: {
  readonly pluginId: string;
  readonly displayName: string;
  readonly sourceRoot: string;
  readonly baseDir: string;
}): string {
  return `Use $synara-plugin-authoring to edit the ${input.displayName} Synara plugin. Its package id is ${input.pluginId}. Its editable source root is ${input.sourceRoot}. This host uses the Synara home ${input.baseDir}; pass --home-dir ${input.baseDir} before plugin in every Synara CLI command. Inspect the manifest and current source first, then ask what I want to change. Keep server and app behavior behind the public @synara/plugin-sdk boundary. Build and reload the plugin after each tested change.`;
}

export const ensurePluginAuthoringSkill = (baseDir: string) =>
  Effect.gen(function* () {
    const sourcePath = resolvePluginAuthoringSkillSource();
    const targetPath = pluginAuthoringSkillPath(baseDir);
    const contents = yield* Effect.tryPromise({
      try: () => readFile(sourcePath, "utf8"),
      catch: (cause) => new Error("Failed to read the Synara plugin authoring skill.", { cause }),
    });
    const currentContents = yield* Effect.tryPromise({
      try: () => readFile(targetPath, "utf8").catch(() => undefined),
      catch: (cause) =>
        new Error("Failed to inspect the installed plugin authoring skill.", { cause }),
    });
    if (currentContents !== contents) {
      yield* writeFileStringAtomically({ filePath: targetPath, contents });
    }
    return targetPath;
  });
