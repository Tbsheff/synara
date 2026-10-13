import { describe, expect, it } from "vitest";
import { AutomationId, ProjectId, ThreadId, TurnId } from "@synara/contracts";
import type { SidebarThreadSummary } from "../types";
import {
  buildProjectThreadTree,
  deriveSidebarProjectData,
  groupSidebarAutomationRuns,
  excludeHiddenProjectAgentCoordinatorThreads,
} from "./Sidebar.logic";

const id = ThreadId.makeUnsafe;
function thread(name: string, extra: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: id(name),
    projectId: ProjectId.makeUnsafe("project"),
    title: name,
    modelSelection: { provider: "codex", model: "test" },
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    session: null,
    latestTurn: null,
    createdAt: "2026-10-13T00:00:00.000Z",
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    pendingBackgroundWorkCount: 0,
    ...extra,
  };
}
const child = (name: string, parent = "parent", extra: Partial<SidebarThreadSummary> = {}) =>
  thread(name, { creationSource: "synara_mcp", sourceThreadId: id(parent), ...extra });
const rows = (threads: SidebarThreadSummary[], expanded: string[] = [], active?: string) =>
  buildProjectThreadTree({
    threads,
    expandedParentThreadIds: new Set(expanded),
    forceVisibleThreadId: active ? id(active) : undefined,
  });
const ids = (entries: ReturnType<typeof rows>) => entries.map((row) => [row.thread.id, row.depth]);

describe("owned sidebar threads", () => {
  it("collapses both MCP sources, Hub work, and automation runs, with state counts", () => {
    const threads = [
      thread("parent"),
      child("running", "parent", {
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn"),
          state: "running",
          requestedAt: "2026-10-13T00:00:00.000Z",
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
        },
      }),
      child("external", "parent", { creationSource: "external_mcp" }),
      child("hub"),
      child("run", "parent", { creationSource: "automation_run", hasPendingApprovals: true }),
    ];
    expect(ids(rows(threads))).toEqual([
      ["parent", 0],
      ["run", 1],
    ]);
    expect(rows(threads)[0]?.childStateSummary).toBe("1 running, 1 needs approval, 2 idle");
    expect(ids(rows(threads, ["parent"]))).toEqual([
      ["parent", 0],
      ["running", 1],
      ["external", 1],
      ["hub", 1],
      ["run", 1],
    ]);
  });
  it("reveals open, approval, and error paths through collapsed ancestors", () => {
    const threads = [
      thread("parent"),
      child("middle"),
      child("open", "middle"),
      child("approval", "middle", { hasPendingApprovals: true }),
      child("error", "middle", {
        latestTurn: {
          turnId: TurnId.makeUnsafe("error-turn"),
          state: "error",
          requestedAt: "2026-10-13T00:00:00.000Z",
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
        },
      }),
      child("hidden"),
    ];
    expect(ids(rows(threads, [], "open"))).toEqual([
      ["parent", 0],
      ["middle", 1],
      ["open", 2],
      ["approval", 2],
      ["error", 2],
    ]);
  });
  it("promotes missing, deleted/filtered, archived, and cross-project owners", () => {
    expect(ids(rows([child("missing", "absent")]))).toEqual([["missing", 0]]);
    expect(
      ids(rows([thread("parent", { archivedAt: "2026-10-13T00:00:00.000Z" }), child("running")])),
    ).toContainEqual(["running", 0]);
    expect(
      ids(
        rows([
          thread("parent"),
          child("other", "parent", { projectId: ProjectId.makeUnsafe("other-project") }),
        ]),
      ),
    ).toEqual([
      ["parent", 0],
      ["other", 0],
    ]);
  });
  it("keeps every source-linked cycle member reachable once", () => {
    expect(
      ids(rows([child("a", "b"), child("b", "a"), child("self", "self")], ["a", "b", "self"])),
    ).toEqual([
      ["a", 0],
      ["b", 0],
      ["self", 0],
    ]);
  });
  it("keeps native parent precedence and fork/sidechat sources flat", () => {
    expect(
      ids(
        rows(
          [
            thread("native"),
            thread("parent"),
            child("child", "parent", { parentThreadId: id("native") }),
          ],
          ["parent"],
        ),
      ),
    ).toEqual([
      ["native", 0],
      ["parent", 0],
    ]);
    expect(ids(rows([thread("parent"), thread("fork", { sourceThreadId: id("parent") })]))).toEqual(
      [
        ["parent", 0],
        ["fork", 0],
      ],
    );
  });
  it("keeps a Hub coordinator when it owns work in the same project", () => {
    expect(
      excludeHiddenProjectAgentCoordinatorThreads(
        [thread("parent"), child("hub")],
        new Set([id("parent")]),
      ).map((t) => t.id),
    ).toEqual(["parent", "hub"]);
  });
  it("keeps attention children and their parents beyond the preview cap", () => {
    const projectId = ProjectId.makeUnsafe("project");
    const threads = [
      thread("first"),
      thread("parent"),
      child("approval", "parent", { hasPendingApprovals: true }),
    ];
    const data = deriveSidebarProjectData({
      projects: [{ id: projectId, cwd: "/fixture", expanded: true }],
      sortedSidebarThreadsByProjectId: new Map([[projectId, threads]]),
      pinnedThreadIds: [],
      threadListExtraPagesByProjectCwd: new Map(),
      normalizeProjectCwd: (x) => x,
      activeSidebarThreadId: undefined,
      previewLimit: 1,
      previewPageSize: 5,
    });
    expect(data.get(projectId)?.visibleEntries.map((e) => e.thread.id)).toEqual([
      "first",
      "parent",
      "approval",
    ]);
  });
  it("uses automation targets/sources and groups only ownerless standalone runs", () => {
    const projectId = ProjectId.makeUnsafe("project");
    const definitions = [
      {
        id: AutomationId.makeUnsafe("target"),
        name: "Heartbeat",
        projectId,
        targetThreadId: id("parent"),
        sourceThreadId: id("other"),
      },
      {
        id: AutomationId.makeUnsafe("standalone"),
        name: "Nightly check",
        projectId,
        targetThreadId: null,
        sourceThreadId: null,
      },
    ];
    const threads = groupSidebarAutomationRuns({
      threads: [
        thread("parent"),
        child("run", "unused", { creationSource: "automation_run" }),
        thread("solo", { creationSource: "automation_run" }),
      ],
      definitions,
      runs: [
        { automationId: definitions[0]!.id, threadId: id("run") },
        { automationId: definitions[1]!.id, threadId: id("solo") },
      ],
    });
    expect(ids(rows([...threads], ["parent", "automation-group:standalone"]))).toEqual([
      ["automation-group:standalone", 0],
      ["solo", 1],
      ["parent", 0],
      ["run", 1],
    ]);
    expect(threads[0]?.title).toBe("Nightly check");
  });
});
