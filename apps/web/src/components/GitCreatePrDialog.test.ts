import { describe, expect, it } from "vitest";

import { buildPullRequestCompareUrl, resolveCreatePrCommitFields } from "./GitCreatePrDialog";

describe("resolveCreatePrCommitFields", () => {
  const commit = { commitMessage: "feat: add a", filePaths: ["src/a.ts"] };

  it("keeps the commit dialog's message and file selection when the PR chain commits", () => {
    expect(resolveCreatePrCommitFields("commit_push_pr", commit)).toEqual({
      commitMessage: "feat: add a",
      filePaths: ["src/a.ts"],
    });
    expect(
      resolveCreatePrCommitFields("commit_push", {
        commitMessage: null,
        filePaths: null,
        commitScope: "staged",
      }),
    ).toEqual({ commitScope: "staged" });
  });

  it("drops the commit fields when the PR chain does not commit", () => {
    expect(resolveCreatePrCommitFields("create_pr", commit)).toEqual({});
    expect(resolveCreatePrCommitFields("push", commit)).toEqual({});
    expect(resolveCreatePrCommitFields("commit_push_pr", null)).toEqual({});
  });
});

describe("buildPullRequestCompareUrl", () => {
  it("prefills title and body and keeps slashes in branch names", () => {
    const url = buildPullRequestCompareUrl({
      repoUrl: "https://github.com/acme/app",
      baseBranch: "main",
      headBranch: "feature/a b",
      title: "Add a & b",
      body: "Line 1\nLine 2",
    });
    expect(url.startsWith("https://github.com/acme/app/compare/main...feature/a%20b?")).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get("expand")).toBe("1");
    expect(params.get("title")).toBe("Add a & b");
    expect(params.get("body")).toBe("Line 1\nLine 2");
  });

  it("omits empty title and body", () => {
    const url = buildPullRequestCompareUrl({
      repoUrl: "https://github.com/acme/app",
      baseBranch: "main",
      headBranch: "topic",
      title: null,
      body: "",
    });
    expect(url).toBe("https://github.com/acme/app/compare/main...topic?expand=1");
  });
});
