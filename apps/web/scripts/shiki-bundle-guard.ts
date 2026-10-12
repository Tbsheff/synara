import type { Plugin } from "vite";

export function shikiBundleGuard(): Plugin {
  return {
    name: "synara-shiki-bundle-guard",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const [id, module] of Object.entries(chunk.modules)) {
          if (module.renderedLength === 0) continue;
          const normalized = id.replaceAll("\\", "/");
          const theme = normalized.match(/\/@shikijs\/themes\/dist\/([^/]+)\.mjs(?:\?|$)/)?.[1];
          if (theme && theme !== "github-light" && theme !== "github-dark") {
            this.error(`Unexpected Shiki theme in ${chunk.fileName}: ${theme}`);
          }
          if (
            /\/@shikijs\/engine-oniguruma\//.test(normalized) ||
            /\/shiki\/dist\/(?:wasm|onig|engine-oniguruma)[^/]*\.(?:mjs|wasm)(?:\?|$)/.test(
              normalized,
            ) ||
            /\/@pierre\/theme\/dist\//.test(normalized)
          ) {
            this.error(`Unexpected Shiki engine or theme in ${chunk.fileName}: ${id}`);
          }
        }
      }
    },
  };
}
