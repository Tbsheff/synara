import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  parseCheckpointFilesFromRawNumstat,
  parseCheckpointFilesFromUnifiedDiff,
} from "./Diffs.ts";

describe("parseCheckpointFilesFromUnifiedDiff", () => {
  it("returns empty list for empty diff", async () => {
    expect(await Effect.runPromise(parseCheckpointFilesFromUnifiedDiff(""))).toEqual([]);
  });

  it("parses per-file additions and deletions", async () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,3 @@",
      " one",
      "-two",
      "+two updated",
      "+three",
      "diff --git a/src/b.ts b/src/b.ts",
      "index 3333333..4444444 100644",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -3,2 +3,0 @@",
      "-old",
      "-stale",
      "",
    ].join("\n");

    expect(await Effect.runPromise(parseCheckpointFilesFromUnifiedDiff(diff))).toEqual([
      { path: "a.txt", kind: "modified", additions: 2, deletions: 1 },
      { path: "src/b.ts", kind: "modified", additions: 0, deletions: 2 },
    ]);
  });

  it("parses rename-only diffs with zero line changes", async () => {
    const diff = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 100%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "",
    ].join("\n");

    expect(await Effect.runPromise(parseCheckpointFilesFromUnifiedDiff(diff))).toEqual([
      { path: "src/new.ts", kind: "renamed", additions: 0, deletions: 0 },
    ]);
  });

  it("normalizes CRLF input before parsing", async () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1,2 @@",
      "-one",
      "+one updated",
      "+two",
      "",
    ].join("\r\n");

    expect(await Effect.runPromise(parseCheckpointFilesFromUnifiedDiff(diff))).toEqual([
      { path: "a.txt", kind: "modified", additions: 2, deletions: 1 },
    ]);
  });

  it("merges duplicate entries for the same file path", async () => {
    const diff = [
      "diff --git a/CLAUDE.md b/CLAUDE.md",
      "index 1111111..2222222 100644",
      "--- a/CLAUDE.md",
      "+++ b/CLAUDE.md",
      "@@ -1 +1,2 @@",
      "-one",
      "+one updated",
      "+two",
      "diff --git a/CLAUDE.md b/CLAUDE.md",
      "index 2222222..3333333 100644",
      "--- a/CLAUDE.md",
      "+++ b/CLAUDE.md",
      "@@ -4,2 +5,0 @@",
      "-three",
      "-four",
      "",
    ].join("\n");

    expect(await Effect.runPromise(parseCheckpointFilesFromUnifiedDiff(diff))).toEqual([
      { path: "CLAUDE.md", kind: "modified", additions: 2, deletions: 3 },
    ]);
  });

  it("preserves deleted-file status in checkpoint summaries", async () => {
    const diff = [
      "diff --git a/src/removed.ts b/src/removed.ts",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/src/removed.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-removed",
      "",
    ].join("\n");

    expect(await Effect.runPromise(parseCheckpointFilesFromUnifiedDiff(diff))).toEqual([
      { path: "src/removed.ts", kind: "deleted", additions: 0, deletions: 1 },
    ]);
  });
});

describe("parseCheckpointFilesFromRawNumstat", () => {
  it("returns empty list for empty output", () => {
    expect(parseCheckpointFilesFromRawNumstat("")).toEqual([]);
  });

  it("reads raw status and numstat records, including renames and binary files", () => {
    const output = [
      ":100644 100644 1111111 2222222 M",
      ":colon\tand tab.txt",
      ":100644 100644 3333333 3333333 R100",
      "old name.txt",
      "new\tname.txt",
      ":000000 100644 0000000 4444444 A",
      "image.png",
      ":100644 000000 5555555 0000000 D",
      "gone.ts",
      "3\t1\t:colon\tand tab.txt",
      "0\t0\t",
      "old name.txt",
      "new\tname.txt",
      "-\t-\timage.png",
      "0\t7\tgone.ts",
      "",
    ].join("\0");

    expect(parseCheckpointFilesFromRawNumstat(output)).toEqual([
      { path: ":colon\tand tab.txt", kind: "modified", additions: 3, deletions: 1 },
      { path: "gone.ts", kind: "deleted", additions: 0, deletions: 7 },
      { path: "image.png", kind: "added", additions: 0, deletions: 0 },
      { path: "new\tname.txt", kind: "renamed", additions: 0, deletions: 0 },
    ]);
  });
});

describe("parseCheckpointFilesFromUnifiedDiff parity with the former @pierre/diffs parser", () => {
  const parse = (diff: string) => Effect.runPromise(parseCheckpointFilesFromUnifiedDiff(diff));

  it("summarizes git renames, copies, adds, deletes, binary, and mode changes", async () => {
    const diff = [
      "diff --git a/old.txt b/new.txt",
      "similarity index 90%",
      "rename from old.txt",
      "rename to new.txt",
      "index 1111111..2222222 100644",
      "--- a/old.txt",
      "+++ b/new.txt",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-before",
      "+after",
      "diff --git a/src.txt b/copy.txt",
      "similarity index 100%",
      "copy from src.txt",
      "copy to copy.txt",
      "diff --git a/added.txt b/added.txt",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/added.txt",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "index 4444444..0000000",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/image.png b/image.png",
      "index 5555555..6666666 100644",
      "Binary files a/image.png and b/image.png differ",
      "diff --git a/run.sh b/run.sh",
      "old mode 100644",
      "new mode 100755",
      'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
      "index 7777777..8888888 100644",
      '--- "a/caf\\303\\251.txt"',
      '+++ "b/caf\\303\\251.txt"',
      "@@ -1 +1,2 @@",
      " hi",
      "+there",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect(await parse(diff)).toEqual([
      { path: "added.txt", kind: "added", additions: 2, deletions: 0 },
      { path: "café.txt", kind: "modified", additions: 1, deletions: 0 },
      { path: "copy.txt", kind: "renamed", additions: 0, deletions: 0 },
      { path: "gone.txt", kind: "deleted", additions: 0, deletions: 1 },
      { path: "image.png", kind: "modified", additions: 0, deletions: 0 },
      { path: "new.txt", kind: "renamed", additions: 1, deletions: 1 },
      { path: "run.sh", kind: "modified", additions: 0, deletions: 0 },
    ]);
    expect(await parse(diff.replace(/\n/g, "\r\n"))).toEqual(await parse(diff));
  });

  it("splits plain unified diffs by hunk counts, not by content lines that look like headers", async () => {
    const diff = [
      "diff -ruN a/f.txt b/f.txt",
      "--- a/f.txt\t2026-10-11 00:06:41",
      "+++ b/f.txt\t2026-10-11 00:06:41",
      "@@ -1,3 +1,3 @@",
      " one",
      "--- dash",
      " three",
      "+four",
      "diff -ruN a/new.txt b/new.txt",
      "--- a/new.txt\t1969-12-31 17:00:00",
      "+++ b/new.txt\t2026-10-11 00:06:41",
      "@@ -0,0 +1 @@",
      "+x",
      "",
    ].join("\n");
    expect(await parse(diff)).toEqual([
      { path: "b/f.txt", kind: "renamed", additions: 1, deletions: 1 },
      { path: "b/new.txt", kind: "renamed", additions: 1, deletions: 0 },
    ]);
  });

  it("sums a file across format-patch commits", async () => {
    const diff = [
      "From 1111111111111111111111111111111111111111 Mon Sep 17 00:00:00 2001",
      "Subject: [PATCH 1/2] first",
      "",
      "---",
      "diff --git a/same.txt b/same.txt",
      "index 1..2 100644",
      "--- a/same.txt",
      "+++ b/same.txt",
      "@@ -1 +1,2 @@",
      " a",
      "+b",
      "--",
      "2.0",
      "",
      "From 2222222222222222222222222222222222222222 Mon Sep 17 00:00:00 2001",
      "Subject: [PATCH 2/2] second",
      "",
      "---",
      "diff --git a/same.txt b/same.txt",
      "index 2..3 100644",
      "--- a/same.txt",
      "+++ b/same.txt",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "+c",
      "--",
      "2.0",
      "",
    ].join("\n");
    expect(await parse(diff)).toEqual([
      { path: "same.txt", kind: "modified", additions: 2, deletions: 1 },
    ]);
  });
});
