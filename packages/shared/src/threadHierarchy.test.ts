import { describe, expect, it } from "vitest";

import { collectOwnedThreadDescendants, collectSubagentDescendants } from "./threadHierarchy";

function thread(id: string, parentThreadId?: string | null) {
  return { id, parentThreadId: parentThreadId ?? null };
}

describe("collectSubagentDescendants", () => {
  it("collects nested descendants breadth-first and excludes the root", () => {
    const threads = [
      thread("root"),
      thread("child-a", "root"),
      thread("grandchild", "child-a"),
      thread("child-b", "root"),
      thread("unrelated"),
      thread("unrelated-child", "unrelated"),
    ];

    expect(collectSubagentDescendants(threads, "root").map((entry) => entry.id)).toEqual([
      "child-a",
      "child-b",
      "grandchild",
    ]);
  });

  it("survives cyclic and self-referential linkage", () => {
    const threads = [
      thread("root"),
      thread("child", "root"),
      // Corrupted rows: the root claims the child as its parent, and a thread points at itself.
      { id: "root", parentThreadId: "child" },
      thread("self", "self"),
    ];

    expect(collectSubagentDescendants(threads, "root").map((entry) => entry.id)).toEqual(["child"]);
  });
});

describe("collectOwnedThreadDescendants", () => {
  it("preserves source-only rows without turning them into native subagents", () => {
    const parent = { id: "parent", projectId: "p" };
    const child = {
      id: "child",
      projectId: "p",
      creationSource: "synara_mcp",
      sourceThreadId: "parent",
    };
    const hub = {
      id: "hub-work",
      projectId: "p",
      creationSource: "external_mcp",
      sourceThreadId: "child",
    };
    const run = {
      id: "run",
      projectId: "p",
      creationSource: "automation_run",
      sourceThreadId: "parent",
    };
    const result = collectOwnedThreadDescendants([parent, child, hub, run], "parent");
    expect(result).toEqual([child, run, hub]);
    expect(result[0]).toBe(child);
    expect(result[0]).not.toHaveProperty("parentThreadId");
  });
  it("ignores missing, deleted, and cross-project owners and survives cycles", () => {
    const threads = [
      { id: "parent", projectId: "p", sourceThreadId: "child", creationSource: "synara_mcp" },
      { id: "child", projectId: "p", sourceThreadId: "parent", creationSource: "synara_mcp" },
      { id: "other", projectId: "q", sourceThreadId: "parent", creationSource: "synara_mcp" },
      { id: "deleted", projectId: "p", deletedAt: "now" },
      { id: "orphan", projectId: "p", sourceThreadId: "deleted", creationSource: "synara_mcp" },
      { id: "missing", projectId: "p", sourceThreadId: "absent", creationSource: "synara_mcp" },
    ];
    expect(collectOwnedThreadDescendants(threads, "parent").map((t) => t.id)).toEqual(["child"]);
    expect(collectOwnedThreadDescendants(threads, "deleted")).toEqual([]);
  });
});
