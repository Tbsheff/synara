import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";

import { shikiBundleGuard } from "./shiki-bundle-guard";

const diffsEntry = fileURLToPath(import.meta.resolve("@pierre/diffs"));
const diffsRequire = createRequire(diffsEntry);
const shikiRequire = createRequire(diffsRequire.resolve("shiki"));
const webRoot = fileURLToPath(new URL("..", import.meta.url));

function bundle(source: string) {
  const entry = "\0shiki-bundle-test";
  return build({
    configFile: false,
    root: webRoot,
    logLevel: "silent",
    plugins: [
      {
        name: "shiki-bundle-test-entry",
        resolveId: (id) => (id === entry ? entry : undefined),
        load: (id) => (id === entry ? source : undefined),
      },
      shikiBundleGuard(),
    ],
    worker: { plugins: () => [shikiBundleGuard()] },
    build: { write: false, minify: false, rolldownOptions: { input: entry } },
  });
}

describe("Shiki production bundles", () => {
  it("bundles the real shared highlighter with only the two GitHub themes and JS engine", async () => {
    const result = await bundle(
      `import { getSharedHighlighter } from ${JSON.stringify(diffsEntry)};
       globalThis.highlighter = getSharedHighlighter({ themes: ["github-light", "github-dark"], langs: ["typescript"], preferredHighlighter: "shiki-js" });`,
    );
    expect(result).toBeDefined();
  }, 30_000);

  it.each(["nord", "github-dark-dimmed"])("rejects a bundled third theme: %s", async (theme) => {
    const themePath = shikiRequire.resolve(`@shikijs/themes/${theme}`);
    await expect(
      bundle(`import theme from ${JSON.stringify(themePath)}; globalThis.theme = theme;`),
    ).rejects.toThrow("Unexpected Shiki theme");
  });

  it("rejects the bundled WASM engine", async () => {
    const wasmPath = diffsRequire.resolve("shiki/wasm");
    await expect(
      bundle(`globalThis.engine = import(${JSON.stringify(wasmPath)});`),
    ).rejects.toThrow("Unexpected Shiki engine");
  });

  it.each(["nord", "wasm"])("rejects %s in a worker bundle", async (asset) => {
    const importedPath =
      asset === "wasm"
        ? diffsRequire.resolve("shiki/wasm")
        : shikiRequire.resolve("@shikijs/themes/nord");
    await expect(
      bundle(
        `import Worker from ${JSON.stringify(`${importedPath}?worker`)}; globalThis.worker = new Worker();`,
      ),
    ).rejects.toThrow(/Unexpected Shiki (?:engine|theme)/);
  });
});
