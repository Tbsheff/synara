import { ThreadId } from "@synara/contracts";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  cleanupDeletedThreadResources,
  cleanupSucceededUnlessInterrupted,
  closeThreadTerminalScopes,
  holdWorktreesWithUnresolvedCleanup,
  isThreadCurrentlyArchived,
} from "./ThreadDeletionReactor";
import { classifyManagedWorktreeRemovalCandidates } from "../../managedWorktrees";
import * as threadDeletion from "./ThreadDeletionReactor";
import { TerminalError } from "../../terminal/Services/Manager";

describe("terminal scope cleanup", () => {
  it("closes dock terminals even when the host terminal close fails", async () => {
    const close = vi.fn(() => Effect.void as Effect.Effect<void, TerminalError>);
    close.mockReturnValueOnce(Effect.fail(new TerminalError({ message: "host close failed" })));
    const result = await Effect.runPromise(
      closeThreadTerminalScopes(
        { close, closeSessionsOpenedAtOrBefore: () => Effect.void },
        ThreadId.makeUnsafe("host"),
        true,
      ),
    );
    expect(result).toBe(false);
    expect(close.mock.calls).toEqual([
      [{ threadId: "host", deleteHistory: true }],
      [{ threadId: "dock-terminal:host", deleteHistory: true }],
    ]);
  });

  it("preserves the archive generation fence for both terminal scopes", async () => {
    const close = vi.fn(() => Effect.void);
    const closeSessionsOpenedAtOrBefore = vi.fn(() => Effect.void);
    const archivedAt = "2026-09-09T12:00:00.000Z";
    const result = await Effect.runPromise(
      closeThreadTerminalScopes(
        { close, closeSessionsOpenedAtOrBefore },
        ThreadId.makeUnsafe("host"),
        false,
        archivedAt,
      ),
    );
    expect(result).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(closeSessionsOpenedAtOrBefore.mock.calls).toEqual([
      [{ threadId: "host", openedAtOrBefore: archivedAt }],
      [{ threadId: "dock-terminal:host", openedAtOrBefore: archivedAt }],
    ]);
  });
});

describe("isThreadCurrentlyArchived", () => {
  it("rejects stale archive cleanup after an undo has cleared archivedAt", () => {
    expect(isThreadCurrentlyArchived({ archivedAt: null })).toBe(false);
    expect(isThreadCurrentlyArchived(undefined)).toBe(false);
    expect(isThreadCurrentlyArchived({ archivedAt: "2026-07-23T20:00:00.000Z" })).toBe(true);
  });
});

describe("cleanupSucceededUnlessInterrupted", () => {
  const threadId = ThreadId.makeUnsafe("thread-deletion-reactor-test");

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      cleanupSucceededUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

describe("cleanupDeletedThreadResources", () => {
  const runCleanup = (stopped: boolean) => {
    const calls: string[] = [];
    return Effect.runPromise(
      cleanupDeletedThreadResources({
        threadId: ThreadId.makeUnsafe("deleted"),
        stopThreadProcesses: Effect.sync(() => {
          calls.push("stop");
          return stopped;
        }),
        pruneManagedWorktrees: Effect.sync(() => {
          calls.push("prune");
        }),
        purgeThreadData: Effect.sync(() => {
          calls.push("purge");
        }),
      }),
    ).then(() => calls);
  };

  it("keeps the worktree when provider or terminal cleanup fails", async () => {
    await expect(runCleanup(false)).resolves.toEqual(["stop"]);
  });

  it("prunes the worktree and purges data after processes stop", async () => {
    await expect(runCleanup(true)).resolves.toEqual(["stop", "prune", "purge"]);
  });
});

describe("holdWorktreesWithUnresolvedCleanup", () => {
  it("keeps a worktree with unresolved cleanup out of a later global prune pass", () => {
    const inventory = [
      { path: "/wt/stuck", workspaceRoot: "/repo" },
      { path: "/wt/shared", workspaceRoot: "/repo" },
      { path: "/wt/cleaned", workspaceRoot: "/repo" },
    ];
    const deletedAt = "2026-10-01T00:00:00.000Z";
    const threads = [
      { id: "stuck", worktreePath: "/wt/stuck", archivedAt: null, deletedAt },
      { id: "stuck-shared", worktreePath: "/wt/shared", archivedAt: null, deletedAt },
      { id: "other-shared", worktreePath: "/wt/shared", archivedAt: null, deletedAt },
      { id: "cleaned", worktreePath: "/wt/cleaned", archivedAt: null, deletedAt },
    ];
    const candidates = classifyManagedWorktreeRemovalCandidates({
      inventory,
      canonicalByRecordedPath: new Map(inventory.map((entry) => [entry.path, entry.path])),
      threads: holdWorktreesWithUnresolvedCleanup(threads, new Set(["stuck", "stuck-shared"])),
    });
    expect(candidates.map((candidate) => candidate.entry.path)).toEqual(["/wt/cleaned"]);
  });

  it("leaves the thread list untouched when every cleanup resolved", () => {
    const threads = [{ id: "a", archivedAt: null, deletedAt: "2026-10-01T00:00:00.000Z" }];
    expect(holdWorktreesWithUnresolvedCleanup(threads, new Set())).toBe(threads);
  });
});

describe("checkpoint retention", () => {
  it("purges orphan start refs for only the deleted thread in all managed families", async () => {
    const execute = vi
      .fn()
      .mockReturnValueOnce(
        Effect.succeed({
          code: 0,
          stderr: "",
          stdout:
            "refs/synara/checkpoints/ZGVsZXRlZA/turn-start/b3JwaGFu\nrefs/legacy/checkpoints/ZGVsZXRlZA/message-start/b3JwaGFu\nrefs/synara/checkpoints/cGVlcg/turn/1\nrefs/heads/main\n",
        }),
      )
      .mockReturnValue(Effect.succeed({ code: 0, stdout: "", stderr: "" }));
    expect(typeof threadDeletion.purgeThreadCheckpointRefs).toBe("function");
    await Effect.runPromise(
      threadDeletion.purgeThreadCheckpointRefs(
        { execute },
        "/repo",
        ThreadId.makeUnsafe("deleted"),
      ),
    );
    expect(execute.mock.calls.slice(1).map(([input]) => input.args)).toEqual([
      ["update-ref", "-d", "refs/synara/checkpoints/ZGVsZXRlZA/turn-start/b3JwaGFu"],
      ["update-ref", "-d", "refs/legacy/checkpoints/ZGVsZXRlZA/message-start/b3JwaGFu"],
    ]);
  });
});
