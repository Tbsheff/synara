import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  callbacks: [] as Array<(input: { workspaceRoot: string; worktreePath: string }) => Promise<void>>,
  removeWorktree: vi.fn(),
  deleteArchived: vi.fn(),
  confirm: vi.fn(),
  status: vi.fn(),
  getShellSnapshot: vi.fn(),
  invalidateQueries: vi.fn(async () => undefined),
  toast: vi.fn(),
  useStore: vi.fn(),
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <T,>(callback: T) => {
    harness.callbacks.push(callback as (typeof harness.callbacks)[number]);
    return callback;
  },
  useMemo: <T,>(factory: () => T) => factory(),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: { worktrees: [] }, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: harness.invalidateQueries }),
  useMutation: () => ({ mutateAsync: harness.removeWorktree }),
}));
vi.mock("~/store", () => ({ useStore: harness.useStore }));
vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({
    git: { status: harness.status },
    dialogs: { confirm: harness.confirm },
    orchestration: { getShellSnapshot: harness.getShellSnapshot },
  }),
  ensureNativeApi: () => {
    throw new Error("unexpected fallback");
  },
}));
vi.mock("~/lib/archivedThreadDelete", () => ({
  deleteArchivedThreadsFromClient: harness.deleteArchived,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: harness.toast } }));

import { WorktreesSettingsPanel } from "./ConversationStorageSettingsPanels";

const input = { workspaceRoot: "/repo", worktreePath: "/repo/worktree" };
function remove() {
  WorktreesSettingsPanel({ active: true });
  return harness.callbacks[0]!(input);
}

describe("Settings worktree deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.callbacks = [];
    harness.useStore.mockReturnValueOnce(vi.fn()).mockReturnValueOnce([]);
    harness.getShellSnapshot.mockResolvedValue({
      threads: [{ id: "archived", worktreePath: input.worktreePath, archivedAt: "2026-01-01" }],
    });
    harness.confirm.mockResolvedValue(true);
    harness.removeWorktree.mockResolvedValue(undefined);
    harness.deleteArchived.mockResolvedValue(undefined);
    harness.status.mockResolvedValue({
      hasWorkingTreeChanges: true,
      workingTree: { files: [{ path: "local.txt" }] },
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("removes safely before deleting archived chats and asks before force", async () => {
    harness.removeWorktree.mockRejectedValueOnce(new Error("contains modified or untracked files"));
    await remove();
    expect(harness.removeWorktree.mock.calls.map(([call]) => call.force)).toEqual([false, true]);
    expect(harness.confirm).toHaveBeenCalledTimes(2);
    expect(harness.confirm.mock.calls[1]?.[0]).toContain("local.txt");
    expect(harness.removeWorktree.mock.invocationCallOrder[1]).toBeLessThan(
      harness.deleteArchived.mock.invocationCallOrder[0]!,
    );
  });

  it("keeps chats and files when the user keeps local changes", async () => {
    harness.removeWorktree.mockRejectedValueOnce(new Error("contains modified or untracked files"));
    harness.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await remove();
    expect(harness.removeWorktree).toHaveBeenCalledExactlyOnceWith({
      cwd: input.workspaceRoot,
      path: input.worktreePath,
      force: false,
    });
    expect(harness.deleteArchived).not.toHaveBeenCalled();
  });

  it("keeps archived chats if worktree removal fails", async () => {
    harness.removeWorktree.mockRejectedValueOnce(new Error("permission denied"));
    harness.status.mockResolvedValue({ hasWorkingTreeChanges: false, workingTree: { files: [] } });
    await remove();
    expect(harness.deleteArchived).not.toHaveBeenCalled();
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Could not delete worktree" }),
    );
  });
});
