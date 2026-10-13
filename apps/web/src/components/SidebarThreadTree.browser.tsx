import "../index.css";
import { useState } from "react";
import { ProjectId, ThreadId, TurnId } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { SidebarThreadSummary } from "../types";
import { buildProjectThreadTree } from "./Sidebar.logic";
import { readSidebarUiState, persistSidebarUiState } from "./Sidebar.uiState";
import { SidebarThreadRowContent } from "./SidebarThreadRowContent";
import { SidebarThreadTree } from "./SidebarThreadTree";

const id = ThreadId.makeUnsafe;
function thread(name: string, extra: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: id(name),
    title: name,
    projectId: ProjectId.makeUnsafe("fixture"),
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
const threads = [
  thread("Parent"),
  thread("Running child", {
    creationSource: "synara_mcp",
    sourceThreadId: id("Parent"),
    latestTurn: {
      turnId: TurnId.makeUnsafe("turn"),
      state: "running",
      requestedAt: "2026-10-13T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      assistantMessageId: null,
    },
  }),
  thread("Idle child", { creationSource: "external_mcp", sourceThreadId: id("Parent") }),
  thread("Approval child", {
    creationSource: "synara_mcp",
    sourceThreadId: id("Parent"),
    hasPendingApprovals: true,
  }),
];
function Harness({ onOpen }: { onOpen: () => void }) {
  const [expanded, setExpanded] = useState(
    () => new Set(readSidebarUiState().expandedParentThreadIds ?? []),
  );
  const rows = buildProjectThreadTree({ threads, expandedParentThreadIds: expanded });
  return (
    <div style={{ width: 360 }}>
      <SidebarThreadTree
        entries={rows.map((row) => ({
          kind: "thread",
          rowId: row.thread.id,
          rootRowId: row.rootThreadId,
          ...row,
        }))}
        activeThreadId={null}
        expandedParentThreadIds={expanded}
        renderRow={(row) => (
          <div role="button" tabIndex={0} className="flex gap-1 px-2 py-1" onClick={onOpen}>
            <SidebarThreadRowContent
              thread={row.thread}
              variant="standard"
              isActive={false}
              terminalEntryPoint={false}
              terminalStatus={null}
              terminalCount={0}
              nested={row.depth > 0}
              childStateSummary={row.childStateSummary}
              childrenExpanded={expanded.has(row.thread.id)}
              onToggleChildren={() => {
                const next = new Set(expanded);
                if (next.has(row.thread.id)) next.delete(row.thread.id);
                else next.add(row.thread.id);
                setExpanded(next);
                persistSidebarUiState({
                  ...readSidebarUiState(),
                  expandedParentThreadIds: [...next],
                });
              }}
            />
          </div>
        )}
      />
    </div>
  );
}
afterEach(() => {
  localStorage.removeItem("synara:sidebar-ui:v1");
  document.body.innerHTML = "";
});
describe("sidebar owned-child disclosure", () => {
  it("starts collapsed, shows counts and approval, and expands without opening the parent", async () => {
    const onOpen = vi.fn();
    const screen = await render(<Harness onOpen={onOpen} />);
    await expect.element(screen.getByText("1 running, 1 approval, 1 idle")).toBeVisible();
    await expect.element(screen.getByText("Approval child")).toBeVisible();
    await expect.element(screen.getByText("Idle child")).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Expand children of Parent", exact: true }).click();
    await expect.element(screen.getByText("Idle child")).toBeVisible();
    await expect.element(screen.getByText("Running child")).toBeVisible();
    expect(onOpen).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Collapse children of Parent", exact: true }).click();
    await expect.element(screen.getByText("Idle child")).not.toBeInTheDocument();
    await expect.element(screen.getByText("Approval child")).toBeVisible();
  });
  it("remembers the expanded parent on a fresh mount", async () => {
    persistSidebarUiState({ ...readSidebarUiState(), expandedParentThreadIds: ["Parent"] });
    const screen = await render(<Harness onOpen={() => {}} />);
    await expect.element(screen.getByText("Idle child")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Collapse children of Parent", exact: true }))
      .toHaveAttribute("aria-expanded", "true");
  });
});
