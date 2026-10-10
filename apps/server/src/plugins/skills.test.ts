import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { removePluginSkills, replacePluginSkills, syncPluginSkills } from "./skills";

describe("plugin skills", () => {
  it("copies plugin skills into the Synara skill root and removes them on uninstall", () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "synara-plugin-skills-home-"));
    const sourceRoot = mkdtempSync(path.join(os.tmpdir(), "synara-plugin-skills-source-"));
    const skillRoot = path.join(sourceRoot, "skills");
    mkdirSync(path.join(skillRoot, "review"), { recursive: true });
    writeFileSync(
      path.join(skillRoot, "review", "SKILL.md"),
      "---\nname: review\ndescription: Review changes.\n---\n",
    );

    const installed = syncPluginSkills(baseDir, "@acme/synara-plugin-example", [skillRoot]);

    expect(installed).toHaveLength(1);
    expect(readFileSync(installed[0]!, "utf8")).toContain("name: review");
    removePluginSkills(baseDir, "@acme/synara-plugin-example");
    expect(existsSync(installed[0]!)).toBe(false);
  });

  it("keeps installed skills when a replacement has duplicate names", () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "synara-plugin-skills-home-"));
    const sourceRoot = mkdtempSync(path.join(os.tmpdir(), "synara-plugin-skills-source-"));
    const firstRoot = path.join(sourceRoot, "first");
    const secondRoot = path.join(sourceRoot, "second");
    for (const root of [firstRoot, secondRoot]) {
      mkdirSync(path.join(root, "review"), { recursive: true });
      writeFileSync(
        path.join(root, "review", "SKILL.md"),
        `---\nname: review\ndescription: ${path.basename(root)}.\n---\n`,
      );
    }
    const [installed] = syncPluginSkills(baseDir, "@acme/synara-plugin-example", [firstRoot]);

    expect(() =>
      syncPluginSkills(baseDir, "@acme/synara-plugin-example", [firstRoot, secondRoot]),
    ).toThrow("Duplicate plugin skill directory");
    expect(readFileSync(installed!, "utf8")).toContain("description: first");
  });

  it("restores installed skills when the control update fails", () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "synara-plugin-skills-home-"));
    const sourceRoot = mkdtempSync(path.join(os.tmpdir(), "synara-plugin-skills-source-"));
    const firstRoot = path.join(sourceRoot, "first");
    const secondRoot = path.join(sourceRoot, "second");
    for (const [root, description] of [
      [firstRoot, "first"],
      [secondRoot, "second"],
    ] as const) {
      mkdirSync(path.join(root, "review"), { recursive: true });
      writeFileSync(
        path.join(root, "review", "SKILL.md"),
        `---\nname: review\ndescription: ${description}.\n---\n`,
      );
    }
    const [installed] = syncPluginSkills(baseDir, "@acme/synara-plugin-example", [firstRoot]);

    expect(() =>
      replacePluginSkills(baseDir, "@acme/synara-plugin-example", [secondRoot], () => {
        throw new Error("control update failed");
      }),
    ).toThrow("control update failed");
    expect(readFileSync(installed!, "utf8")).toContain("description: first");
  });
});
