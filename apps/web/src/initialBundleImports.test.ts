import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.join(SRC_DIR, "routes");
const SOURCE_EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx"];
const STATIC_IMPORT_PATTERN =
  /^\s*(?:import|export)\s+(type\s+)?(?:[^;=()]*?\s+from\s+)?["']([^"']+)["']/gm;

function resolveSourceFile(fromFile: string, specifier: string): string | null {
  const bare = specifier.split("?")[0]!;
  const base = bare.startsWith("~/")
    ? path.join(SRC_DIR, bare.slice(2))
    : bare.startsWith(".")
      ? path.resolve(path.dirname(fromFile), bare)
      : null;
  if (base === null) return null;
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function isSeparateRouteChunk(file: string, entryFiles: ReadonlySet<string>): boolean {
  if (entryFiles.has(file)) return false;
  if (path.basename(file) === "routeTree.gen.ts") return true;
  return path.dirname(file) === ROUTES_DIR && !path.basename(file).startsWith("-");
}

function staticImportClosure(entryRelativePaths: readonly string[]) {
  const entryFiles = new Set(entryRelativePaths.map((entry) => path.join(SRC_DIR, entry)));
  const files = new Set<string>();
  const packages = new Set<string>();
  const pending = [...entryFiles];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file) || isSeparateRouteChunk(file, entryFiles)) continue;
    files.add(file);
    if (!/\.tsx?$/.test(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(STATIC_IMPORT_PATTERN)) {
      const [, typeOnly, specifier] = match;
      if (typeOnly || !specifier) continue;
      const resolved = resolveSourceFile(file, specifier);
      if (resolved) {
        pending.push(resolved);
      } else if (!specifier.startsWith(".") && !specifier.startsWith("~/")) {
        packages.add(specifier);
      }
    }
  }
  const relativeFiles = new Set([...files].map((file) => path.relative(SRC_DIR, file)));
  return { files: relativeFiles, packages };
}

describe("initial bundle static imports", () => {
  it("keeps markdown, KaTeX and release notes out of the app shell and chat layout", () => {
    const { files, packages } = staticImportClosure([
      "main.tsx",
      "routes/__root.tsx",
      "routes/_chat.tsx",
    ]);

    expect(files.has("components/Sidebar.tsx")).toBe(true);
    expect(files.has("components/ChatMarkdown.tsx")).toBe(false);
    expect(files.has("whatsNew/entries.ts")).toBe(false);
    expect(packages.has("rehype-katex")).toBe(false);
    expect(packages.has("@pierre/diffs/edit")).toBe(false);
  });

  it("keeps the code editor and highlighter lazy on the thread route", () => {
    const { files, packages } = staticImportClosure(["routes/_chat.$threadId.tsx"]);

    expect(files.has("components/WorkspaceFilePreview.tsx")).toBe(true);
    expect(files.has("lib/syntaxHighlighting.ts")).toBe(false);
    expect(packages.has("@pierre/diffs/edit")).toBe(false);
  });
});
