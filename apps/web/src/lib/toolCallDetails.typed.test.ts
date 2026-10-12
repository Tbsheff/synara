import { describe, expect, it } from "vitest";

import { getRenderablePatch } from "./diffRendering";
import {
  buildToolImageViews,
  buildTypedCommandView,
  buildTypedToolCallView,
  buildTypedWebSearchView,
  countUnifiedDiffLines,
  deriveCommandFooter,
  deriveWorkLogToolDetails,
  describeResultBlock,
  effectiveFileChangeKind,
  effectiveFileChangeMovePath,
  fileChangeDisplayPath,
  formatToolJson,
  isWebSearchQueryEmpty,
  renderableFileChangePatch,
  resolveFileChangeStat,
  webSearchResultLabel,
} from "./toolCallDetails";

describe("deriveCommandFooter", () => {
  it.each([
    [{ status: "running", exitCode: undefined, interrupted: undefined }, null],
    [{ status: "completed", exitCode: 0, interrupted: undefined }, "Success"],
    [{ status: "failed", exitCode: 2, interrupted: undefined }, "Exit code 2"],
    [{ status: "completed", exitCode: null, interrupted: undefined }, "Exit code unknown"],
    [{ status: "completed", exitCode: 1, interrupted: true }, "Stopped"],
    [{ status: "cancelled", exitCode: undefined, interrupted: undefined }, "Stopped"],
    [{ status: "completed", exitCode: undefined, interrupted: undefined }, "Success"],
    [{ status: "failed", exitCode: undefined, interrupted: undefined }, "Failed"],
  ] as const)("%j → %s", (input, label) => {
    expect(deriveCommandFooter(input)?.label ?? null).toBe(label);
  });
});

describe("buildTypedCommandView", () => {
  it("shows the live tail while running", () => {
    const view = buildTypedCommandView({
      command: { command: "bun install", cwd: "/repo" },
      status: "running",
      liveOutput: { tail: "[output truncated]\nresolving", truncated: true, totalChars: 30_000 },
    });
    expect(view.output).toBe("[output truncated]\nresolving");
    expect(view.isLiveOutput).toBe(true);
    expect(view.outputTruncated).toBe(true);
    expect(view.outputTotalChars).toBe(30_000);
    expect(view.footer).toBeNull();
    expect(view.cwd).toBe("/repo");
  });

  it("prefers the final output once completed", () => {
    const view = buildTypedCommandView({
      command: { command: "ls", output: "a\nb", exitCode: 0 },
      status: "completed",
      liveOutput: { tail: "a", truncated: false, totalChars: 1 },
    });
    expect(view.output).toBe("a\nb");
    expect(view.isLiveOutput).toBe(false);
    expect(view.footer?.label).toBe("Success");
  });

  it("keeps the Claude stdout and stderr split", () => {
    const view = buildTypedCommandView({
      command: { command: "make", stdout: "built", stderr: "warning: x", exitCode: 0 },
      status: "completed",
    });
    expect(view.output).toBeNull();
    expect(view.stdout).toBe("built");
    expect(view.stderr).toBe("warning: x");
  });

  it("falls back to the entry command and records stdin", () => {
    const view = buildTypedCommandView({
      command: { lastStdin: "y\n" },
      status: "completed",
      fallbackCommand: "npx create",
    });
    expect(view.command).toBe("npx create");
    expect(view.lastStdin).toBe("y\n");
  });
});

describe("legacy output fallback", () => {
  it("fills missing typed output and exit code from the legacy details", () => {
    const view = buildTypedCommandView({
      command: { command: "false", cwd: "/repo" },
      status: "failed",
      fallbackOutput: { output: "boom", exitCode: 1, truncated: true },
    });
    expect(view.output).toBe("boom");
    expect(view.footer?.label).toBe("Exit code 1");
    expect(view.outputTruncated).toBe(true);
  });

  it("keeps typed values over legacy ones", () => {
    const view = buildTypedCommandView({
      command: { command: "ls", output: "typed", exitCode: 0 },
      status: "completed",
      fallbackOutput: { output: "legacy", exitCode: 3 },
    });
    expect(view.output).toBe("typed");
    expect(view.footer?.label).toBe("Success");
  });
});

describe("renderableFileChangePatch", () => {
  it("adds file headers to bare hunks", () => {
    expect(
      renderableFileChangePatch({
        path: "src/a.ts",
        kind: "update",
        unifiedDiff: "@@ -1 +1 @@\n-a\n+b",
      }),
    ).toBe("--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-a\n+b");
    expect(
      renderableFileChangePatch({ path: "n.ts", kind: "add", unifiedDiff: "@@ -0,0 +1 @@\n+x" }),
    ).toBe("--- /dev/null\n+++ n.ts\n@@ -0,0 +1 @@\n+x");
  });

  it("never renders an in-place Codex edit as a rename", () => {
    const hunk = "@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n three\n+four";
    const cases = [
      { path: "/private/tmp/proj/scratch.txt", kind: "update" as const, unifiedDiff: hunk },
      {
        path: "/private/tmp/proj/scratch.txt",
        kind: "move" as const,
        movePath: "/tmp/proj/scratch.txt",
        unifiedDiff: hunk,
      },
      {
        path: "scratch.txt",
        kind: "move" as const,
        movePath: "/private/tmp/proj/scratch.txt",
        unifiedDiff: hunk,
      },
      {
        path: "scratch.txt",
        kind: "update" as const,
        unifiedDiff: `--- a/scratch.txt\n+++ b/scratch.txt\n${hunk}`,
      },
    ];
    for (const change of cases) {
      const renderable = getRenderablePatch(
        renderableFileChangePatch(change, "/tmp/proj"),
        "test-in-place-edit",
      );
      expect(renderable?.kind).toBe("files");
      const fileDiff = renderable?.kind === "files" ? renderable.files[0] : undefined;
      expect(fileDiff?.type).toBe("change");
      expect(fileDiff?.prevName).toBeUndefined();
    }
  });

  it("still renders a real move as a rename", () => {
    const renderable = getRenderablePatch(
      renderableFileChangePatch({
        path: "src/old.ts",
        kind: "move",
        movePath: "src/new.ts",
        unifiedDiff: "@@ -1 +1 @@\n-a\n+b",
      }),
      "test-real-move",
    );
    const fileDiff = renderable?.kind === "files" ? renderable.files[0] : undefined;
    expect(fileDiff?.type).toBe("rename-changed");
  });

  it("keeps diffs that already have headers", () => {
    const diff = "--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-a\n+b";
    expect(renderableFileChangePatch({ path: "src/a.ts", kind: "update", unifiedDiff: diff })).toBe(
      diff,
    );
    expect(renderableFileChangePatch({ path: "src/a.ts", kind: "update" })).toBeUndefined();
  });
});

describe("file change helpers", () => {
  const diff = "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n+more\n context";
  it("counts diff lines when stats are missing", () => {
    expect(countUnifiedDiffLines(diff)).toEqual({ additions: 2, deletions: 1 });
    expect(resolveFileChangeStat({ path: "x.ts", kind: "update", unifiedDiff: diff })).toEqual({
      additions: 2,
      deletions: 1,
    });
  });

  it("prefers typed stats", () => {
    expect(
      resolveFileChangeStat({ path: "x.ts", kind: "update", unifiedDiff: diff, additions: 9 }),
    ).toEqual({ additions: 9, deletions: 0 });
  });

  it("uses the destination of a move", () => {
    expect(fileChangeDisplayPath({ path: "a.ts", kind: "move", movePath: "b.ts" })).toBe("b.ts");
  });

  it.each([
    ["/private/tmp/p/a.txt", "/tmp/p/a.txt", undefined],
    ["a.txt", "/private/tmp/p/a.txt", "/tmp/p"],
    ["./a.txt", "/repo/a.txt", "/repo"],
    ["/repo/a.txt", "a.txt", undefined],
  ])("treats %s → %s as an edit in place", (path, movePath, cwd) => {
    const change = { path, kind: "move" as const, movePath };
    expect(effectiveFileChangeMovePath(change, cwd)).toBeNull();
    expect(effectiveFileChangeKind(change, cwd)).toBe("update");
    expect(fileChangeDisplayPath(change, cwd)).toBe(path);
  });

  it("keeps a move to another file", () => {
    const change = { path: "/repo/a.txt", kind: "move" as const, movePath: "/repo/b.txt" };
    expect(effectiveFileChangeMovePath(change, "/repo")).toBe("/repo/b.txt");
    expect(effectiveFileChangeKind(change, "/repo")).toBe("move");
  });
});

describe("tool call details", () => {
  it("formats arguments and structured content as JSON text", () => {
    expect(formatToolJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(formatToolJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(formatToolJson("not json")).toBe("not json");
    expect(formatToolJson({})).toBeNull();
  });

  it("builds every section", () => {
    const view = buildTypedToolCallView({
      toolName: "mcp__linear__get_issue",
      server: "linear",
      arguments: { id: "ENG-1" },
      resultText: "Issue ENG-1",
      resultTruncated: true,
      structuredContent: { id: "ENG-1" },
      error: "partial failure",
      images: [{ source: "omitted", reason: "too large" }],
      otherBlocks: [{ blockType: "document", mediaType: "application/pdf", title: "spec.pdf" }],
    });
    expect(view.argumentsText).toContain("ENG-1");
    expect(view.resultText).toBe("Issue ENG-1");
    expect(view.resultTruncated).toBe(true);
    expect(view.structuredContentText).toContain('"id"');
    expect(view.error).toBe("partial failure");
    expect(view.images).toHaveLength(1);
    expect(view.otherBlocks).toEqual(["PDF document: spec.pdf"]);
    expect(view.server).toBe("linear");
    expect(view.isEmpty).toBe(false);
  });

  it("reports an empty result", () => {
    expect(buildTypedToolCallView({ toolName: "x" }).isEmpty).toBe(true);
  });

  it("describes other result blocks", () => {
    expect(describeResultBlock({ blockType: "search_result", title: "Docs" })).toBe(
      "Search result: Docs",
    );
    expect(describeResultBlock({ blockType: "tool_reference" })).toBe("Tool reference");
  });
});

describe("buildToolImageViews", () => {
  it("routes stored attachments, local paths, and omitted images", () => {
    const views = buildToolImageViews([
      { source: "file", path: "thread-1/att_1.png", mediaType: "image/png" },
      { source: "file", path: "/Users/me/shot.png" },
      { source: "omitted", reason: "Image not stored", mediaType: "image/jpeg" },
    ]);
    expect(views.map((view) => view.kind)).toEqual(["attachment", "local-file", "omitted"]);
    expect(views[0]!.src).toBe("/attachments/thread-1/att_1.png");
    expect(views[1]!.src).toBe("/Users/me/shot.png");
    expect(views[2]!.reason).toBe("Image not stored");
  });

  it("refuses relative paths that leave the attachments folder", () => {
    const [view] = buildToolImageViews([{ source: "file", path: "../secrets.png" }]);
    expect(view!.kind).toBe("omitted");
    expect(view!.src).toBeNull();
  });

  it("encodes attachment path segments", () => {
    const [view] = buildToolImageViews([{ source: "file", path: "a b/c#d.png" }]);
    expect(view!.src).toBe("/attachments/a%20b/c%23d.png");
  });
});

describe("web search details", () => {
  it("collects queries, domains and results", () => {
    const view = buildTypedWebSearchView({
      query: "effect",
      queries: ["effect", "effect schema"],
      allowedDomains: ["effect.website"],
      results: [{ url: "https://effect.website", title: "Effect" }, { url: " " }],
      resultsTruncated: true,
    });
    expect(view.queries).toEqual(["effect", "effect schema"]);
    expect(view.allowedDomains).toEqual(["effect.website"]);
    expect(view.results).toHaveLength(1);
    expect(view.resultsTruncated).toBe(true);
    expect(view.isEmpty).toBe(false);
  });

  it("dedupes by full URL and labels results by title, else host and path", () => {
    const view = buildTypedWebSearchView({
      query: "bun",
      results: [
        { url: "https://www.thoughtworks.com/radar/languages-and-frameworks/bun" },
        { url: "https://www.thoughtworks.com/radar/languages-and-frameworks/bun/" },
        { url: "https://WWW.thoughtworks.com/radar/languages-and-frameworks/bun#top" },
        { url: "https://www.thoughtworks.com/radar/tools/bun", title: "Bun | Technology Radar" },
        { url: "https://www.thoughtworks.com/", title: "www.thoughtworks.com" },
        { url: "https://www.thoughtworks.com/insights?page=2" },
        { url: "https://www.thoughtworks.com/insights?page=2" },
        { url: "https://www.thoughtworks.com/insights?page=3" },
      ],
    });
    expect(view.results.map(webSearchResultLabel)).toEqual([
      "www.thoughtworks.com/radar/languages-and-frameworks/bun",
      "Bun | Technology Radar",
      "www.thoughtworks.com",
      "www.thoughtworks.com/insights",
      "www.thoughtworks.com/insights",
    ]);
    expect(webSearchResultLabel({ url: "not a url" })).toBe("not a url");
  });

  it("detects an empty query", () => {
    expect(isWebSearchQueryEmpty({ query: "  " })).toBe(true);
    expect(isWebSearchQueryEmpty({ action: { type: "open_page", url: "https://a.dev" } })).toBe(
      false,
    );
  });
});

describe("legacy command payloads", () => {
  it("reads the exit code and output from data.item", () => {
    const details = deriveWorkLogToolDetails({
      label: "Ran command",
      command: "false",
      itemType: "command_execution",
      payload: { data: { item: { exitCode: 1, aggregatedOutput: "boom" } } },
    });
    expect(details?.output?.exitCode).toBe(1);
    expect(details?.output?.output).toBe("boom");
  });
});

describe("command output shown once", () => {
  it("never shows the combined Claude output next to its stdout/stderr split", () => {
    const ticks = "tick1\ntick2\n";
    const view = buildTypedCommandView({
      command: { command: "for i in 1 2", output: ticks, stdout: ticks, exitCode: 0 },
      status: "completed",
    });
    expect(view.output).toBeNull();
    expect(view.stdout).toBe(ticks);
    expect(view.footer?.label).toBe("Success");
  });

  it("drops the leading Claude `Exit code N` line that the footer already shows", () => {
    const view = buildTypedCommandView({
      command: {
        command: "ls /nonexistent",
        output: "Exit code 1\nls: /nonexistent: No such file or directory",
        exitCode: 1,
      },
      status: "failed",
    });
    expect(view.output).toBe("ls: /nonexistent: No such file or directory");
    expect(view.footer?.label).toBe("Exit code 1");
    expect(
      buildTypedCommandView({
        command: { command: "x", output: "Exit code 2\nboom", exitCode: 1 },
        status: "failed",
      }).output,
    ).toBe("Exit code 2\nboom");
  });

  it("keeps the first line of a live tail", () => {
    const view = buildTypedCommandView({
      command: { command: "for i in $(seq 1 3); do echo tick$i; done" },
      status: "running",
      liveOutput: { tail: "tick1\ntick2\ntick3\n", truncated: false, totalChars: 18 },
    });
    expect(view.output).toBe("tick1\ntick2\ntick3\n");
  });

  it("never treats the request summary of a running command as its output", () => {
    const details = deriveWorkLogToolDetails({
      label: "Bash",
      itemType: "command_execution",
      command: "for i in $(seq 1 12); do echo tick$i; sleep 1; done",
      detail: "Bash: for i in $(seq 1 12); do echo tick$i; sleep 1; done",
      payload: { data: {} },
    });
    expect(details?.output).toBeUndefined();
  });
});
