import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildPlugin } from "./build";

describe("plugin build", () => {
  it("builds server and app entries while sharing the host React runtime", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "synara-plugin-build-"));
    mkdirSync(path.join(root, "src"));
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "@acme/synara-plugin-build-test",
        version: "0.1.0",
        synara: {
          displayName: "Build Test",
          apiVersion: 1,
          server: "./src/server.ts",
          app: "./src/app.tsx",
        },
      }),
    );
    writeFileSync(
      path.join(root, "src", "server.ts"),
      'import { definePlugin } from "@synara/plugin-sdk"; export default definePlugin(() => {});\n',
    );
    writeFileSync(
      path.join(root, "src", "app.tsx"),
      'import { definePluginApp } from "@synara/plugin-sdk/app"; import { createElement } from "react"; export default definePluginApp(() => void createElement("div"));\n',
    );

    const result = await buildPlugin(root);
    const realRoot = realpathSync(root);

    expect(result.outputRoot).toBe(
      path.join(realRoot, "dist", "generations", result.reloadToken),
    );
    expect(result.serverOutput).toBe(path.join(result.outputRoot, "server.js"));
    expect(result.appOutput).toBe(path.join(result.outputRoot, "app.js"));
    expect(existsSync(result.serverOutput)).toBe(true);
    expect(existsSync(result.appOutput!)).toBe(true);
    expect(readFileSync(result.appOutput!, "utf8")).toContain("__synaraPluginRuntime");
  });

  it("keeps the last successful generation intact when the next build fails", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "synara-plugin-build-"));
    mkdirSync(path.join(root, "src"));
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "@acme/synara-plugin-build-test",
        version: "0.1.0",
        synara: {
          displayName: "Build Test",
          apiVersion: 1,
          server: "./src/server.ts",
        },
      }),
    );
    const serverEntry = path.join(root, "src", "server.ts");
    writeFileSync(serverEntry, "export default () => {};\n");
    const first = await buildPlugin(root);
    writeFileSync(serverEntry, "export default ;\n");

    await expect(buildPlugin(root)).rejects.toThrow();
    expect(readFileSync(first.serverOutput, "utf8")).toContain("export");
  });
});
