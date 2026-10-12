// FILE: ConversationStorageSettingsPanels.browser.tsx
// Purpose: Browser characterization for worktree association and archived-thread grouping.
// Layer: Browser UI test

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  worktrees: [
    {
      workspaceRoot: "/repo",
      path: "/repo/.worktrees/feature",
    },
  ],
  threadShells: [] as Array<Record<string, unknown>>,
  projects: [{ id: "project-1", name: "Project One" }],
  removeDeletedThreadFromClientState: vi.fn(),
  mutateAsync: vi.fn(),
  invalidateQueries: vi.fn(async () => {}),
  confirm: vi.fn(async (_message: string) => true),
  deleteArchivedThreadsFromClient: vi.fn(async (_input: { threadIds: string[] }) => {}),
  getShellSnapshot: vi.fn(async () => ({ threads: [] as Array<Record<string, unknown>> })),
  gitStatus: vi.fn(async (_input: { cwd: string }) => ({
    hasWorkingTreeChanges: true,
    workingTree: { files: [] as Array<{ path: string }>, insertions: 0, deletions: 0 },
  })),
  events: [] as string[],
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { worktrees: harness.worktrees }, isLoading: false, isError: false }),
  useMutation: () => ({ isPending: false, mutateAsync: harness.mutateAsync }),
  useQueryClient: () => ({ invalidateQueries: harness.invalidateQueries }),
}));

vi.mock("~/lib/serverReactQuery", () => ({
  serverQueryKeys: { worktrees: () => ["worktrees"] },
  serverWorktreesQueryOptions: () => ({ queryKey: ["worktrees"] }),
}));

vi.mock("~/lib/gitReactQuery", () => ({
  gitRemoveWorktreeMutationOptions: () => ({}),
}));

vi.mock("~/storeSelectors", () => ({
  createThreadShellsSelector: () => () => harness.threadShells,
}));

vi.mock("~/store", () => ({
  useStore: (selector: (store: Record<string, unknown>) => unknown) =>
    selector({
      projects: harness.projects,
      removeDeletedThreadFromClientState: harness.removeDeletedThreadFromClientState,
    }),
}));

vi.mock("~/nativeApi", () => {
  const api = {
    dialogs: { confirm: harness.confirm },
    orchestration: { getShellSnapshot: harness.getShellSnapshot },
    git: { status: harness.gitStatus },
  };
  return { readNativeApi: () => api, ensureNativeApi: () => api };
});

vi.mock("~/lib/archivedThreadDelete", () => ({
  deleteArchivedThreadsFromClient: harness.deleteArchivedThreadsFromClient,
}));

import { ArchivedSettingsPanel, WorktreesSettingsPanel } from "./ConversationStorageSettingsPanels";

function thread(overrides: Record<string, unknown>) {
  return {
    id: "thread",
    title: "Thread",
    projectId: "project-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    worktreePath: null,
    associatedWorktreePath: null,
    ...overrides,
  };
}

describe("ConversationStorageSettingsPanels", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    harness.threadShells = [];
    harness.confirm.mockReset().mockImplementation(async () => true);
    harness.deleteArchivedThreadsFromClient.mockReset().mockImplementation(async () => {});
    harness.mutateAsync.mockReset();
    harness.getShellSnapshot.mockReset().mockImplementation(async () => ({ threads: [] }));
    harness.gitStatus.mockReset().mockImplementation(async () => ({
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
    }));
  });

  it("uses one association rule for direct and associated worktree paths", async () => {
    harness.threadShells = [
      thread({
        id: "direct",
        title: "Direct link",
        worktreePath: "/repo/.worktrees/feature",
      }),
      thread({
        id: "associated",
        title: "Associated link",
        associatedWorktreePath: "/repo/.worktrees/feature",
      }),
      thread({ id: "other", title: "Other worktree", worktreePath: "/repo/.worktrees/other" }),
    ];

    await render(<WorktreesSettingsPanel active />);

    expect(document.body.textContent).toContain("Direct link");
    expect(document.body.textContent).toContain("Associated link");
    expect(document.body.textContent).not.toContain("Other worktree");
  });

  it("asks again before discarding local changes and deletes archived chats only after removal", async () => {
    const worktreePath = "/repo/.worktrees/feature";
    harness.getShellSnapshot.mockResolvedValueOnce({
      threads: [thread({ id: "archived", worktreePath, archivedAt: "2026-01-02T00:00:00.000Z" })],
    });
    harness.gitStatus.mockResolvedValueOnce({
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "src/edited.ts" }, { path: "notes.txt" }],
        insertions: 3,
        deletions: 1,
      },
    });
    harness.events = [];
    harness.mutateAsync.mockReset();
    harness.mutateAsync
      .mockImplementationOnce(async (input: { force?: boolean }) => {
        harness.events.push(`remove force=${String(input.force)}`);
        throw new Error(
          `git worktree remove failed: fatal: '${worktreePath}' contains modified or untracked files, use --force to delete it`,
        );
      })
      .mockImplementationOnce(async (input: { force?: boolean }) => {
        harness.events.push(`remove force=${String(input.force)}`);
      });
    harness.deleteArchivedThreadsFromClient.mockImplementationOnce(async () => {
      harness.events.push("delete archived chats");
    });

    await render(<WorktreesSettingsPanel active />);
    await page.getByRole("button", { name: "Delete", exact: true }).click();

    await vi.waitFor(() => expect(harness.events).toContain("delete archived chats"));
    expect(harness.events).toEqual([
      "remove force=false",
      "remove force=true",
      "delete archived chats",
    ]);
    expect(harness.confirm).toHaveBeenCalledTimes(2);
    const localChangesPrompt = harness.confirm.mock.calls[1]?.[0] ?? "";
    expect(localChangesPrompt).toContain("local changes");
    expect(localChangesPrompt).toContain("src/edited.ts");
    expect(localChangesPrompt).toContain("notes.txt");
  });

  it("uses Git status to recognize local changes when the removal error is generic", async () => {
    harness.gitStatus.mockResolvedValueOnce({
      hasWorkingTreeChanges: true,
      workingTree: { files: [{ path: "draft.md" }], insertions: 1, deletions: 0 },
    });
    harness.mutateAsync.mockReset();
    harness.mutateAsync
      .mockRejectedValueOnce(new Error("git worktree remove failed"))
      .mockResolvedValueOnce(undefined);

    await render(<WorktreesSettingsPanel active />);
    await page.getByRole("button", { name: "Delete", exact: true }).click();

    await vi.waitFor(() => expect(harness.mutateAsync).toHaveBeenCalledTimes(2));
    expect(harness.mutateAsync.mock.calls[1]?.[0]).toMatchObject({ force: true });
    expect(harness.confirm.mock.calls[1]?.[0]).toContain("draft.md");
  });

  it("keeps archived chats and the worktree when local changes are not discarded", async () => {
    const worktreePath = "/repo/.worktrees/feature";
    harness.getShellSnapshot.mockResolvedValueOnce({
      threads: [thread({ id: "archived", worktreePath, archivedAt: "2026-01-02T00:00:00.000Z" })],
    });
    harness.mutateAsync.mockReset();
    harness.mutateAsync.mockRejectedValueOnce(
      new Error(`fatal: '${worktreePath}' contains modified or untracked files, use --force`),
    );
    harness.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await render(<WorktreesSettingsPanel active />);
    await page.getByRole("button", { name: "Delete", exact: true }).click();

    await vi.waitFor(() => expect(harness.confirm).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.mutateAsync).toHaveBeenCalledTimes(1);
    expect(harness.mutateAsync.mock.calls[0]?.[0]).toMatchObject({ force: false });
    expect(harness.deleteArchivedThreadsFromClient).not.toHaveBeenCalled();
  });

  it("sorts archived threads once and keeps orphaned projects visible", async () => {
    harness.threadShells = [
      thread({
        id: "older",
        title: "Older archived",
        archivedAt: "2026-01-02T00:00:00.000Z",
      }),
      thread({
        id: "newer",
        title: "Newer archived",
        archivedAt: "2026-01-03T00:00:00.000Z",
      }),
      thread({
        id: "orphan",
        title: "Orphan archived",
        projectId: "missing-project",
        archivedAt: "2026-01-04T00:00:00.000Z",
      }),
    ];

    await render(<ArchivedSettingsPanel active />);

    const text = document.body.textContent ?? "";
    expect(text.indexOf("Newer archived")).toBeLessThan(text.indexOf("Older archived"));
    expect(text).toContain("Unknown project");
    expect(text).toContain("Orphan archived");
  });

  it("lists each archived subtree once and exposes a child archived without its parent", async () => {
    harness.threadShells = [
      thread({ id: "active-parent", title: "Active parent" }),
      thread({
        id: "recoverable-child",
        title: "Recoverable archived child",
        parentThreadId: "active-parent",
        archivedAt: "2026-01-02T00:00:00.000Z",
      }),
      thread({
        id: "archived-parent",
        title: "Archived parent",
        archivedAt: "2026-01-03T00:00:00.000Z",
      }),
      thread({
        id: "represented-child",
        title: "Represented archived child",
        parentThreadId: "archived-parent",
        archivedAt: "2026-01-03T00:00:00.000Z",
      }),
    ];

    await render(<ArchivedSettingsPanel active />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("Recoverable archived child");
    expect(text).toContain("Archived parent");
    expect(text).not.toContain("Represented archived child");
  });

  it("deletes every archived subtree, children before parents, after one confirmation", async () => {
    harness.threadShells = [
      thread({ id: "active", title: "Active thread" }),
      thread({ id: "first", title: "First archived", archivedAt: "2026-01-02T00:00:00.000Z" }),
      thread({
        id: "first-child",
        title: "First child",
        parentThreadId: "first",
        archivedAt: "2026-01-02T00:00:00.000Z",
      }),
      thread({
        id: "second",
        title: "Second archived",
        projectId: "missing-project",
        archivedAt: "2026-01-03T00:00:00.000Z",
      }),
    ];

    const screen = await render(<ArchivedSettingsPanel active />);
    await expect.element(screen.getByText("2 archived threads")).toBeVisible();
    await screen.getByRole("button", { name: "Delete all" }).click();

    await vi.waitFor(() => expect(harness.deleteArchivedThreadsFromClient).toHaveBeenCalledOnce());
    expect(harness.confirm).toHaveBeenCalledOnce();
    expect(harness.confirm.mock.calls[0]?.[0]).toContain("all 2 archived threads");
    expect(harness.deleteArchivedThreadsFromClient.mock.calls[0]?.[0]).toMatchObject({
      threadIds: ["first-child", "first", "second"],
    });
  });

  it("does not delete anything when delete all is cancelled", async () => {
    harness.threadShells = [
      thread({ id: "only", title: "Only archived", archivedAt: "2026-01-02T00:00:00.000Z" }),
    ];
    harness.confirm.mockResolvedValueOnce(false);

    const screen = await render(<ArchivedSettingsPanel active />);
    await screen.getByRole("button", { name: "Delete all" }).click();

    await vi.waitFor(() => expect(harness.confirm).toHaveBeenCalledOnce());
    expect(harness.deleteArchivedThreadsFromClient).not.toHaveBeenCalled();
  });
});
