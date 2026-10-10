import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  installPlugin,
  listPluginRecords,
  reloadPlugin,
  setPluginEnabled,
  uninstallPlugin,
} from "./management";
import { scaffoldPlugin } from "./scaffold";

describe("plugin management", () => {
  it("installs, reloads, disables, enables, and uninstalls a local plugin", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "synara-plugin-management-"));
    const baseDir = path.join(root, "home");
    const source = path.join(root, "notes");
    const scaffold = scaffoldPlugin(source);

    const installed = await installPlugin(baseDir, source);

    expect(installed.record).toMatchObject({
      id: scaffold.id,
      enabled: true,
      builtIn: false,
      sourceRoot: realpathSync(scaffold.sourceRoot),
    });
    expect(existsSync(installed.build.serverOutput)).toBe(true);
    expect(existsSync(installed.build.appOutput!)).toBe(true);
    expect(installed.skills).toHaveLength(1);
    expect(existsSync(installed.skills[0]!)).toBe(true);
    expect(listPluginRecords(baseDir).map((plugin) => plugin.id)).toContain(scaffold.id);

    const disabled = setPluginEnabled(baseDir, scaffold.id, false);
    expect(disabled.enabled).toBe(false);
    expect(existsSync(installed.skills[0]!)).toBe(false);

    const enabled = setPluginEnabled(baseDir, scaffold.id, true);
    expect(enabled.enabled).toBe(true);
    expect(existsSync(installed.skills[0]!)).toBe(true);

    const reloaded = await reloadPlugin(baseDir, scaffold.id);
    expect(reloaded.record.reloadToken).not.toBe(installed.record.reloadToken);
    expect(reloaded.build?.id).toBe(scaffold.id);

    const uninstalled = uninstallPlugin(baseDir, scaffold.id);
    expect(uninstalled).toMatchObject({
      id: scaffold.id,
      sourceRoot: realpathSync(scaffold.sourceRoot),
      removedSkills: true,
    });
    expect(existsSync(scaffold.sourceRoot)).toBe(true);
    expect(listPluginRecords(baseDir).map((plugin) => plugin.id)).not.toContain(scaffold.id);
  });

  it("can disable and uninstall a plugin after its manifest breaks", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "synara-plugin-management-"));
    const baseDir = path.join(root, "home");
    const source = path.join(root, "notes");
    const scaffold = scaffoldPlugin(source);
    await installPlugin(baseDir, source);
    writeFileSync(path.join(source, "package.json"), "not json\n");

    expect(setPluginEnabled(baseDir, scaffold.id, false).enabled).toBe(false);
    expect(() => setPluginEnabled(baseDir, scaffold.id, true)).toThrow();
    expect(uninstallPlugin(baseDir, scaffold.id).id).toBe(scaffold.id);
  });

  it("rejects a second source with the same plugin id", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "synara-plugin-management-"));
    const baseDir = path.join(root, "home");
    const firstSource = path.join(root, "first", "notes");
    const secondSource = path.join(root, "second", "notes");
    const first = scaffoldPlugin(firstSource);
    const second = scaffoldPlugin(secondSource);
    expect(second.id).toBe(first.id);

    await installPlugin(baseDir, firstSource);

    await expect(installPlugin(baseDir, secondSource)).rejects.toThrow(
      "uninstall it before installing a different source",
    );
  });
});
