import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build, type UserConfig } from "tsdown";
import { expect, it } from "vitest";
import serverConfig from "../tsdown.config.ts";

it("minifies the packaged server while preserving error names and diagnostic source maps", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-server-bundle-"));
  try {
    const entry = path.join(root, "probe.ts");
    await fs.writeFile(
      entry,
      `export function packagedServerFailure() {
        ${Array.from({ length: 50 }, (_, i) => `console.log("probe-${i}");`).join("\n        ")}
        throw new Error("bundle stack probe");
      }
      export class PackagedServerError extends Error {}
      console.log(packagedServerFailure.name, PackagedServerError.name);
      packagedServerFailure();\n`,
    );
    const config = serverConfig as UserConfig;
    const outDir = path.join(root, "minified");
    for (const [dir, minify] of [
      [outDir, config.minify ?? false],
      [path.join(root, "plain"), false],
    ] as const) {
      await build({
        ...config,
        config: false,
        entry: [entry],
        outDir: dir,
        minify,
        sourcemap: true,
        dts: false,
      });
    }
    const output = path.join(outDir, "probe.mjs");
    expect((await fs.stat(output)).size).toBeLessThan(
      (await fs.stat(path.join(root, "plain/probe.mjs"))).size * 0.85,
    );
    const map = JSON.parse(await fs.readFile(`${output}.map`, "utf8"));
    expect(map.sources.some((source: string) => source.endsWith("probe.ts"))).toBe(true);
    let stdout = "";
    let stderr = "";
    try {
      execFileSync(process.execPath, ["--enable-source-maps", output], {
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (error) {
      const failure = error as { stdout: string; stderr: string; status: number };
      expect(failure.status).toBe(1);
      stdout = failure.stdout;
      stderr = failure.stderr;
    }
    expect(stdout).toContain("packagedServerFailure PackagedServerError");
    expect(stderr).toContain("at packagedServerFailure");
    expect(stderr).toContain("probe.ts:");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
