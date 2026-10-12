import { MessageId, ProjectId, ThreadId, TurnId } from "@synara/contracts";
import {
  SYNARA_BETA_BUNDLE_ID,
  SYNARA_DESKTOP_BUNDLE_ID_ENV,
  SYNARA_PRODUCTION_BUNDLE_ID,
} from "@synara/shared/desktopIdentity";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkpointRefForThreadMessageStart,
  checkpointRefForThreadRevertRescue,
  checkpointRefForThreadTurn,
  checkpointRefForThreadTurnLive,
  checkpointRefForThreadTurnStart,
  checkpointRefForThreadTurnInManagedFamily,
  checkpointRefForThreadTurnStartInManagedFamily,
  isManagedCheckpointRefForThread,
  parseManagedCheckpointRef,
  resolveProjectCwdForKind,
  resolveThreadWorkspaceCwd,
} from "./Utils.ts";

describe("managed checkpoint refs", () => {
  const threadId = ThreadId.makeUnsafe("thread-1");

  it("creates canonical Synara refs", () => {
    expect(checkpointRefForThreadTurn(threadId, 4)).toMatch(/^refs\/synara\/checkpoints\//);
  });

  describe("per-app namespace", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const allNewRefs = () => [
      checkpointRefForThreadTurn(threadId, 1),
      checkpointRefForThreadTurnStart(threadId, TurnId.makeUnsafe("turn-1")),
      checkpointRefForThreadMessageStart(threadId, MessageId.makeUnsafe("message-1")),
      checkpointRefForThreadTurnLive(threadId, TurnId.makeUnsafe("turn-1")),
      checkpointRefForThreadRevertRescue(threadId, "token"),
    ];

    it("keeps Stable refs under refs/synara", () => {
      vi.stubEnv(SYNARA_DESKTOP_BUNDLE_ID_ENV, SYNARA_PRODUCTION_BUNDLE_ID);
      for (const ref of allNewRefs()) {
        expect(ref.startsWith("refs/synara/checkpoints/")).toBe(true);
      }
    });

    it("writes Beta refs under refs/synara-beta so copied thread IDs never collide", () => {
      vi.stubEnv(SYNARA_DESKTOP_BUNDLE_ID_ENV, SYNARA_BETA_BUNDLE_ID);
      for (const ref of allNewRefs()) {
        expect(ref.startsWith("refs/synara-beta/checkpoints/")).toBe(true);
        expect(isManagedCheckpointRefForThread(ref, threadId)).toBe(true);
      }
    });
  });

  it("recognizes a structurally valid persisted ref for the same thread", () => {
    const canonical = checkpointRefForThreadTurn(threadId, 4);
    const historical = canonical.replace("refs/synara/", "refs/historical/");
    expect(parseManagedCheckpointRef(historical)?.namespace).toBe("historical");
    expect(isManagedCheckpointRefForThread(historical, threadId)).toBe(true);
  });

  it("rejects malformed refs and refs belonging to a different thread", () => {
    expect(parseManagedCheckpointRef("refs/heads/feature")).toBeNull();
    expect(
      isManagedCheckpointRefForThread(
        checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-2"), 4),
        threadId,
      ),
    ).toBe(false);
  });

  it("reconstructs turn and turn-start refs in an existing managed family", () => {
    const historical = checkpointRefForThreadTurn(threadId, 4).replace(
      "refs/synara/",
      "refs/historical/",
    );

    expect(checkpointRefForThreadTurnInManagedFamily(historical, threadId, 0)).toBe(
      historical.replace(/\/turn\/4$/, "/turn/0"),
    );
    expect(
      checkpointRefForThreadTurnStartInManagedFamily(
        historical,
        threadId,
        TurnId.makeUnsafe("turn-1"),
      ),
    ).toMatch(/^refs\/historical\/checkpoints\/.+\/turn-start\//);
  });
});

describe("resolveProjectCwdForKind", () => {
  it("uses the workspace root for a chat-kind project once a worktree is materialized", () => {
    expect(
      resolveProjectCwdForKind({
        kind: "chat",
        workspaceRoot: "/tmp/chat-root",
        worktreePath: "/tmp/chat-worktree",
      }),
    ).toBe("/tmp/chat-root");
  });

  it("defaults to treating the workspace root as real when kind is unknown/absent", () => {
    expect(
      resolveProjectCwdForKind({
        kind: undefined,
        workspaceRoot: "/tmp/unknown-root",
        worktreePath: null,
      }),
    ).toBe("/tmp/unknown-root");
  });
});

describe("resolveThreadWorkspaceCwd", () => {
  const projectId = ProjectId.makeUnsafe("project-1");

  it("resolves undefined for a chat-kind thread with no worktree", () => {
    expect(
      resolveThreadWorkspaceCwd({
        thread: { projectId, envMode: "local", worktreePath: null },
        projects: [{ id: projectId, kind: "chat", workspaceRoot: "/tmp/chat-root" }],
      }),
    ).toBeUndefined();
  });

  it("resolves the workspace root for a studio-kind thread with no worktree", () => {
    expect(
      resolveThreadWorkspaceCwd({
        thread: { projectId, envMode: "local", worktreePath: null },
        projects: [{ id: projectId, kind: "studio", workspaceRoot: "/tmp/studio-root" }],
      }),
    ).toBe("/tmp/studio-root");
  });

  it("prefers an ordinary Studio working directory without treating it as a worktree", () => {
    expect(
      resolveThreadWorkspaceCwd({
        thread: {
          projectId,
          envMode: "local",
          worktreePath: null,
          workingDirectory: "/tmp/reference-folder",
        },
        projects: [{ id: projectId, kind: "studio", workspaceRoot: "/tmp/studio-root" }],
      }),
    ).toBe("/tmp/reference-folder");
  });

  it("resolves the materialized worktree path for a chat-kind thread once a worktree exists", () => {
    expect(
      resolveThreadWorkspaceCwd({
        thread: { projectId, envMode: "worktree", worktreePath: "/tmp/chat-worktree" },
        projects: [{ id: projectId, kind: "chat", workspaceRoot: "/tmp/chat-root" }],
      }),
    ).toBe("/tmp/chat-worktree");
  });
});
