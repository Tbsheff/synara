import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  installPluginControl,
  pluginControlPath,
  findPluginSource,
  readPluginControl,
  removePluginControl,
  updatePluginControl,
} from "./control";

describe("plugin control", () => {
  it("defaults plugins to enabled and keeps control writes valid", () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "synara-plugin-control-"));
    expect(readPluginControl(baseDir)).toEqual({ plugins: {} });

    updatePluginControl(baseDir, "acme.plugin", (current) => ({
      ...current,
      enabled: false,
    }));

    expect(readPluginControl(baseDir).plugins["acme.plugin"]).toEqual({
      enabled: false,
      reloadToken: "",
    });
    expect(JSON.parse(readFileSync(pluginControlPath(baseDir), "utf8"))).toBeTruthy();
  });

  it("finds an editable plugin source from a nested project directory", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "synara-plugin-source-"));
    const source = path.join(root, "plugins", "example");
    const nested = path.join(root, "apps", "server");
    mkdirSync(source, { recursive: true });
    mkdirSync(nested, { recursive: true });

    expect(findPluginSource(nested, "plugins/example")).toBe(realpathSync(source));
  });

  it("stores and removes an external plugin source", () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "synara-plugin-control-"));
    const sourceRoot = mkdtempSync(path.join(os.tmpdir(), "synara-plugin-source-"));

    installPluginControl(baseDir, "@acme/synara-plugin-example", sourceRoot);

    expect(readPluginControl(baseDir).plugins["@acme/synara-plugin-example"]).toMatchObject({
      enabled: true,
      sourceRoot: realpathSync(sourceRoot),
    });
    expect(removePluginControl(baseDir, "@acme/synara-plugin-example")).toBe(true);
    expect(readPluginControl(baseDir).plugins["@acme/synara-plugin-example"]).toBeUndefined();
  });
});
