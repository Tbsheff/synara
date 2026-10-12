import { describe, expect, it } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getRenderablePatch } from "~/lib/diffRendering";
import { GitFileRow, resolveGitPanelWorkspace } from "./GitPanel";

describe("resolveGitPanelWorkspace", () => {
  it("waits for a pending worktree instead of falling back to the main checkout", () => {
    expect(
      resolveGitPanelWorkspace({ projectCwd: "/repo", envMode: "worktree", worktreePath: null }),
    ).toEqual({ pending: true, cwd: null });
  });

  it("uses the worktree once it exists and the project checkout for local threads", () => {
    expect(
      resolveGitPanelWorkspace({
        projectCwd: "/repo",
        envMode: "worktree",
        worktreePath: "/worktrees/a",
      }),
    ).toEqual({ pending: false, cwd: "/worktrees/a" });
    expect(
      resolveGitPanelWorkspace({ projectCwd: "/repo", envMode: "local", worktreePath: null }),
    ).toEqual({ pending: false, cwd: "/repo" });
  });
});

it("keeps the stage action visible while its row has keyboard focus", () => {
  const patch = getRenderablePatch(
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
    "stage-focus",
  );
  if (patch?.kind !== "files") throw new Error("Expected file diff");
  const html = renderToStaticMarkup(
    createElement(GitFileRow, {
      fileDiff: patch.files[0]!,
      theme: "light",
      isSelected: false,
      actionLabel: "Stage file",
      actionIcon: "stage",
      actionDisabled: false,
      onSelect: () => undefined,
      onAction: () => undefined,
    }),
  );
  expect(html).toContain("group-focus-within:opacity-100");
  expect(html).toContain("focus-visible:opacity-100");
});
