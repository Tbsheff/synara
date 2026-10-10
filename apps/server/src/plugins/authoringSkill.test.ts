import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  ensurePluginAuthoringSkill,
  makePluginEditPrompt,
  pluginAuthoringSkillPath,
  resolvePluginAuthoringSkillSource,
} from "./authoringSkill";

describe("plugin authoring skill", () => {
  it("installs the bundled skill in the shared Synara skill root", async () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "synara-authoring-skill-"));

    const installed = await Effect.runPromise(ensurePluginAuthoringSkill(baseDir));

    expect(installed).toBe(pluginAuthoringSkillPath(baseDir));
    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(installed, "utf8")).toBe(
      readFileSync(resolvePluginAuthoringSkillSource(), "utf8"),
    );
    expect(readFileSync(installed, "utf8")).toContain("name: synara-plugin-authoring");
  });

  it("does not replace an unchanged installed skill", async () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "synara-authoring-skill-"));
    const installed = await Effect.runPromise(ensurePluginAuthoringSkill(baseDir));
    const firstModifiedAt = statSync(installed).mtimeMs;

    await Effect.runPromise(ensurePluginAuthoringSkill(baseDir));

    expect(statSync(installed).mtimeMs).toBe(firstModifiedAt);
  });

  it("binds edit chats to the plugin source and active Synara home", () => {
    const prompt = makePluginEditPrompt({
      pluginId: "@local/synara-plugin-notes",
      displayName: "Notes",
      sourceRoot: "/workspace/notes",
      baseDir: "/synara/home",
    });

    expect(prompt).toContain("$synara-plugin-authoring");
    expect(prompt).toContain("editable source root is /workspace/notes");
    expect(prompt).toContain("pass --home-dir /synara/home before plugin");
  });
});
