import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { scaffoldPlugin } from "./scaffold";

describe("plugin scaffold", () => {
  it("creates a full plugin with an app, server entry, and skill", () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), "synara-plugin-new-"));
    const result = scaffoldPlugin(path.join(parent, "notes"));

    expect(result.id).toBe("@local/synara-plugin-notes");
    expect(existsSync(path.join(result.sourceRoot, "src", "server.ts"))).toBe(true);
    expect(existsSync(path.join(result.sourceRoot, "src", "app.tsx"))).toBe(true);
    expect(existsSync(path.join(result.sourceRoot, "skills", "notes", "SKILL.md"))).toBe(true);
    const packageJson = JSON.parse(
      readFileSync(path.join(result.sourceRoot, "package.json"), "utf8"),
    ) as { readonly dependencies: Readonly<Record<string, string>>; readonly synara: unknown };
    expect(packageJson.synara).toBeTruthy();
    expect(packageJson.dependencies["@synara/plugin-sdk"]).toBe("file:./.synara-sdk");
    expect(existsSync(path.join(result.sourceRoot, ".synara-sdk", "src", "app.ts"))).toBe(true);
    expect(() => scaffoldPlugin(result.sourceRoot)).toThrow("already exists");
  });
});
