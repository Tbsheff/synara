import { describe, expect, it } from "vitest";

import {
  formatParsedActionLabel,
  formatPermissionProfileLines,
  humanizePermissionKey,
  MORE_PERMISSIONS_LABEL,
} from "./ComposerPendingApprovalPanel.logic";

describe("formatPermissionProfileLines", () => {
  it("formats the Codex permission profile for people", () => {
    expect(
      formatPermissionProfileLines({
        network: { enabled: true },
        fileSystem: { read: ["/repo/docs"], write: ["/repo/src", "/repo/test"] },
      }),
    ).toEqual([
      { label: "Internet access", values: [] },
      { label: "View files", values: ["/repo/docs"] },
      { label: "Edit files", values: ["/repo/src", "/repo/test"] },
    ]);
  });

  it("falls back to humanized keys without raw JSON", () => {
    const lines = formatPermissionProfileLines({
      macosAutomation: { bundleIds: ["com.apple.Terminal"], allowAll: false },
      network: { enabled: false },
    });
    expect(lines).toEqual([
      { label: "Macos automation · bundle ids", values: ["com.apple.Terminal"] },
      { label: "Macos automation · allow all", values: ["No"] },
    ]);
    expect(lines.flatMap((line) => line.values.concat(line.label)).join(" ")).not.toMatch(/[{}]/u);
  });

  it("adds the dropped object arrays and deep values as raw JSON", () => {
    const lines = formatPermissionProfileLines({
      macosAutomation: {
        bundleIds: ["com.apple.Terminal", { id: "com.apple.Notes", scope: "read" }],
      },
      deep: { a: { b: { c: { d: "too deep" } } } },
      fileSystem: { read: ["/repo/docs", { glob: "**/*.env" }] },
      network: { enabled: false },
    });

    expect(lines.slice(0, -1)).toEqual([
      { label: "Macos automation · bundle ids", values: ["com.apple.Terminal"] },
      { label: "View files", values: ["/repo/docs"] },
    ]);
    const more = lines.at(-1);
    expect(more).toMatchObject({ label: MORE_PERMISSIONS_LABEL, values: [] });
    expect(JSON.parse(more?.rawJson ?? "null")).toEqual({
      macosAutomation: { bundleIds: [{ id: "com.apple.Notes", scope: "read" }] },
      deep: { a: { b: { c: { d: "too deep" } } } },
      fileSystem: { read: [{ glob: "**/*.env" }] },
    });
    expect(more?.rawJson).toContain("\n  ");
  });

  it("caps the raw JSON of dropped permissions", () => {
    const lines = formatPermissionProfileLines({
      rules: Array.from({ length: 200 }, (_, index) => ({ pattern: `rule-${index}`, bigint: 1n })),
    });
    const rawJson = lines.at(-1)?.rawJson ?? "";

    expect(rawJson.length).toBe(2_000);
    expect(rawJson.endsWith("…")).toBe(true);
    expect(rawJson).toContain('"bigint": "1"');
  });

  it("humanizes camel and snake case keys", () => {
    expect(humanizePermissionKey("fileSystem")).toBe("File system");
    expect(humanizePermissionKey("allow_list")).toBe("Allow list");
  });
});

describe("formatParsedActionLabel", () => {
  it("describes each parsed command action", () => {
    expect(formatParsedActionLabel({ type: "read", path: "src/a.ts", name: "a.ts" })).toBe(
      "Read a.ts",
    );
    expect(formatParsedActionLabel({ type: "search", query: "foo", path: "src" })).toBe(
      "Search for foo in src",
    );
    expect(formatParsedActionLabel({ type: "list_files", path: "src" })).toBe("List files in src");
    expect(formatParsedActionLabel({ type: "unknown", command: "make" })).toBe("make");
  });
});
