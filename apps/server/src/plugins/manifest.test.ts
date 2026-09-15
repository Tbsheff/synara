import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readPluginManifest } from "./manifest";

function makePlugin(packageJson: unknown): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "synara-plugin-manifest-"));
  mkdirSync(path.join(root, "src"));
  mkdirSync(path.join(root, "skills", "example"), { recursive: true });
  writeFileSync(path.join(root, "src", "server.ts"), "export default () => {}\n");
  writeFileSync(path.join(root, "src", "app.tsx"), "export default () => {}\n");
  writeFileSync(
    path.join(root, "skills", "example", "SKILL.md"),
    "---\nname: example\ndescription: Example.\n---\n",
  );
  writeFileSync(path.join(root, "package.json"), JSON.stringify(packageJson));
  return root;
}

describe("plugin manifest", () => {
  it("resolves server, app, and skill entries inside the package root", () => {
    const root = makePlugin({
      name: "@acme/synara-plugin-example",
      version: "1.2.3",
      synara: {
        displayName: "Example",
        apiVersion: 1,
        server: "./src/server.ts",
        app: "./src/app.tsx",
        skills: ["./skills"],
      },
    });

    const realRoot = realpathSync(root);
    expect(readPluginManifest(root)).toMatchObject({
      id: "@acme/synara-plugin-example",
      displayName: "Example",
      version: "1.2.3",
      apiVersion: 1,
      sourceRoot: realRoot,
      serverEntry: path.join(realRoot, "src", "server.ts"),
      appEntry: path.join(realRoot, "src", "app.tsx"),
      skillRoots: [path.join(realRoot, "skills")],
    });
  });

  it("accepts API version 2", () => {
    const root = makePlugin({
      name: "@acme/synara-plugin-tools",
      version: "1.0.0",
      synara: {
        displayName: "Tools",
        apiVersion: 2,
        server: "./src/server.ts",
      },
    });

    expect(readPluginManifest(root).apiVersion).toBe(2);
  });

  it("rejects unsupported API versions", () => {
    const root = makePlugin({
      name: "@acme/synara-plugin-future",
      version: "1.0.0",
      synara: {
        displayName: "Future",
        apiVersion: 3,
        server: "./src/server.ts",
      },
    });

    expect(() => readPluginManifest(root)).toThrow("must be 1 or 2");
  });

  it("rejects entries that leave the package root", () => {
    const root = makePlugin({
      name: "@acme/synara-plugin-example",
      version: "1.2.3",
      synara: {
        displayName: "Example",
        apiVersion: 1,
        server: "../server.ts",
      },
    });

    expect(() => readPluginManifest(root)).toThrow("must stay inside");
  });

  it("rejects symlinked entries that leave the package root", () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), "synara-plugin-outside-"));
    writeFileSync(path.join(outside, "server.ts"), "export default () => {}\n");
    const root = makePlugin({
      name: "@acme/synara-plugin-example",
      version: "1.2.3",
      synara: {
        displayName: "Example",
        apiVersion: 1,
        server: "./src/linked-server.ts",
      },
    });
    symlinkSync(path.join(outside, "server.ts"), path.join(root, "src", "linked-server.ts"));

    expect(() => readPluginManifest(root)).toThrow("must stay inside");
  });
});
