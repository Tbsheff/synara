import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { gitIndexHasAssumeUnchangedEntries } from "./GitIndexFile.ts";

const repos: string[] = [];

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

function git(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync("git", args, { cwd }).toString();
}

function makeRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "synara-git-index-file-"));
  repos.push(cwd);
  git(cwd, ["init", "-q"]);
  writeFileSync(join(cwd, "a.txt"), "a\n");
  writeFileSync(join(cwd, "b.txt"), "b\n");
  git(cwd, ["add", "a.txt", "b.txt"]);
  const blob = git(cwd, ["hash-object", "-w", "a.txt"]).trim();
  const longPath = `${"nested-directory-name/".repeat(220)}file.txt`;
  git(cwd, ["update-index", "--add", "--cacheinfo", `100644,${blob},${longPath}`]);
  return cwd;
}

const scan = (cwd: string) =>
  gitIndexHasAssumeUnchangedEntries(readFileSync(join(cwd, ".git", "index")));

describe("gitIndexHasAssumeUnchangedEntries", () => {
  it.each([2, 3, 4])("reads index version %i", (version) => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, "intent.txt"), "intent\n");
    git(cwd, ["add", "--intent-to-add", "intent.txt"]);
    git(cwd, ["update-index", "--index-version", String(version)]);

    expect(scan(cwd)).toBe(false);

    git(cwd, ["update-index", "--assume-unchanged", "b.txt"]);
    expect(scan(cwd)).toBe(true);
  });

  it("refuses split indexes and malformed data", () => {
    const cwd = makeRepo();
    git(cwd, ["update-index", "--split-index"]);

    expect(scan(cwd)).toBeNull();
    expect(gitIndexHasAssumeUnchangedEntries(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(gitIndexHasAssumeUnchangedEntries(readFileSync(join(cwd, "a.txt")))).toBeNull();
  });
});
