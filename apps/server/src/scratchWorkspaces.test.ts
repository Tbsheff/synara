// FILE: scratchWorkspaces.test.ts
// Purpose: Verifies per-thread scratch workspace paths stay inside their
//          private root even when thread ids contain path-like characters.
// Layer: Server filesystem utility tests

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { ThreadId } from "@synara/contracts";
import {
  SYNARA_BETA_BUNDLE_ID,
  SYNARA_DESKTOP_BUNDLE_ID_ENV,
  SYNARA_PRODUCTION_BUNDLE_ID,
} from "@synara/shared/desktopIdentity";
import { SCRATCH_WORKSPACES_DIRNAME } from "@synara/shared/threadWorkspace";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureIsolatedScratchWorkspace,
  resolveScratchWorkspaceCwd,
  resolveScratchWorkspacesRoot,
} from "./scratchWorkspaces";

const testScratchParent = mkdtempSync(path.join(tmpdir(), "synara-scratch-test-"));
const testScratchRoot = path.join(testScratchParent, SCRATCH_WORKSPACES_DIRNAME);

afterAll(() => {
  rmSync(testScratchParent, { recursive: true, force: true });
});

function ensureTestScratchWorkspace(threadId: ThreadId): string {
  return ensureIsolatedScratchWorkspace(threadId, testScratchRoot);
}

describe("ensureIsolatedScratchWorkspace", () => {
  it("keeps the default scratch root in a private user cache outside the checkout", () => {
    const root = resolveScratchWorkspacesRoot();
    const workspace = ensureIsolatedScratchWorkspace(ThreadId.makeUnsafe("default-root"));
    try {
      expect(path.relative(process.cwd(), root).startsWith("..")).toBe(true);
      expect(path.relative(homedir(), root).startsWith("..")).toBe(false);
      expect(path.dirname(root)).toMatch(/\.synara-[a-f0-9]{16}$/);
      expect(workspace.startsWith(`${root}${path.sep}`)).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("creates a readable per-thread directory under the scratch root", () => {
    const workspace = ensureTestScratchWorkspace(ThreadId.makeUnsafe("thread-1"));
    try {
      expect(workspace).toContain(`${path.sep}${SCRATCH_WORKSPACES_DIRNAME}${path.sep}thread-1-`);
      expect(path.relative(testScratchRoot, workspace).startsWith("..")).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("securely reuses a matching legacy workspace without breaking historical paths", () => {
    const threadId = ThreadId.makeUnsafe("legacy-thread");
    const migratedRoot = path.join(testScratchParent, "migrated", SCRATCH_WORKSPACES_DIRNAME);
    const legacyRoot = path.join(testScratchParent, "legacy", SCRATCH_WORKSPACES_DIRNAME);
    const initialWorkspace = ensureIsolatedScratchWorkspace(threadId, migratedRoot);
    const workspaceSegment = path.basename(initialWorkspace);
    rmSync(migratedRoot, { recursive: true, force: true });

    const legacyWorkspace = path.join(legacyRoot, workspaceSegment);
    mkdirSync(legacyWorkspace, { recursive: true });
    writeFileSync(path.join(legacyWorkspace, "resume.txt"), "preserved");
    if (process.platform !== "win32") {
      chmodSync(legacyRoot, 0o777);
    }

    const resumedWorkspace = ensureIsolatedScratchWorkspace(threadId, migratedRoot, legacyRoot);

    expect(resumedWorkspace).toBe(legacyWorkspace);
    expect(readFileSync(path.join(resumedWorkspace, "resume.txt"), "utf8")).toBe("preserved");
    if (process.platform !== "win32") {
      expect(statSync(legacyRoot).mode & 0o1777).toBe(0o1777);
      expect(statSync(resumedWorkspace).mode & 0o777).toBe(0o700);
    }
  });

  it.skipIf(process.platform === "win32")(
    "does not reuse a workspace through an untrusted legacy-root symlink",
    () => {
      const threadId = ThreadId.makeUnsafe("symlinked-legacy-root");
      const privateRoot = path.join(
        testScratchParent,
        "private-fallback",
        SCRATCH_WORKSPACES_DIRNAME,
      );
      const legacyRoot = path.join(testScratchParent, "legacy-link");
      const redirectedRoot = mkdtempSync(path.join(tmpdir(), "synara-legacy-redirect-"));
      const workspaceSegment = path.basename(
        ensureIsolatedScratchWorkspace(threadId, privateRoot, redirectedRoot),
      );
      rmSync(privateRoot, { recursive: true, force: true });
      mkdirSync(path.join(redirectedRoot, workspaceSegment), { recursive: true });
      symlinkSync(redirectedRoot, legacyRoot, "dir");
      try {
        const workspace = resolveScratchWorkspaceCwd(
          threadId,
          path.join(legacyRoot, workspaceSegment),
          {
            workspaceRoot: privateRoot,
            legacyWorkspaceRoot: legacyRoot,
          },
        );
        expect(workspace).toBe(path.join(privateRoot, workspaceSegment));
      } finally {
        unlinkSync(legacyRoot);
        rmSync(redirectedRoot, { recursive: true, force: true });
      }
    },
  );

  it("gives Synara Beta its own scratch root so copied thread IDs never share a folder", () => {
    const homeDirectory = path.join(testScratchParent, "home");
    const stableRoot = resolveScratchWorkspacesRoot({
      homeDirectory,
      env: { [SYNARA_DESKTOP_BUNDLE_ID_ENV]: SYNARA_PRODUCTION_BUNDLE_ID },
    });
    const betaRoot = resolveScratchWorkspacesRoot({
      homeDirectory,
      env: { [SYNARA_DESKTOP_BUNDLE_ID_ENV]: SYNARA_BETA_BUNDLE_ID },
    });
    expect(betaRoot).not.toBe(stableRoot);
    expect(resolveScratchWorkspacesRoot({ homeDirectory, env: {} })).toBe(stableRoot);
    expect(path.dirname(betaRoot)).toMatch(/\.synara-[a-f0-9]{16}$/);
  });

  it("gives an imported thread its own scratch folder instead of the other app's", () => {
    const threadId = ThreadId.makeUnsafe("imported-scratch-thread");
    const ownRoot = path.join(testScratchParent, "beta-cache", SCRATCH_WORKSPACES_DIRNAME);
    const foreignRoot = path.join(testScratchParent, "stable-cache", SCRATCH_WORKSPACES_DIRNAME);
    const legacyRoot = path.join(testScratchParent, "beta-legacy");
    const foreignWorkspace = ensureIsolatedScratchWorkspace(threadId, foreignRoot, legacyRoot);
    writeFileSync(path.join(foreignWorkspace, "notes.md"), "from stable");

    const resolved = resolveScratchWorkspaceCwd(threadId, foreignWorkspace, {
      workspaceRoot: ownRoot,
      legacyWorkspaceRoot: legacyRoot,
    });

    expect(resolved).toBe(path.join(ownRoot, path.basename(foreignWorkspace)));
    expect(statSync(resolved).isDirectory()).toBe(true);
    writeFileSync(path.join(resolved, "notes.md"), "edited in beta");
    expect(readFileSync(path.join(foreignWorkspace, "notes.md"), "utf8")).toBe("from stable");
  });

  describe("in Synara Beta", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("never adopts Stable's shared temp-folder scratch workspace", () => {
      vi.stubEnv(SYNARA_DESKTOP_BUNDLE_ID_ENV, SYNARA_BETA_BUNDLE_ID);
      const threadId = ThreadId.makeUnsafe(`beta-legacy-${process.pid}-${Date.now()}`);
      const ownRoot = path.join(testScratchParent, "beta-own", SCRATCH_WORKSPACES_DIRNAME);
      const segment = path.basename(ensureIsolatedScratchWorkspace(threadId, ownRoot, ownRoot));
      rmSync(ownRoot, { recursive: true, force: true });
      const sharedLegacyWorkspace = path.join(tmpdir(), SCRATCH_WORKSPACES_DIRNAME, segment);
      mkdirSync(sharedLegacyWorkspace, { recursive: true });
      try {
        const resolved = resolveScratchWorkspaceCwd(threadId, sharedLegacyWorkspace, {
          workspaceRoot: ownRoot,
        });
        expect(resolved).toBe(path.join(ownRoot, segment));
      } finally {
        rmSync(sharedLegacyWorkspace, { recursive: true, force: true });
      }
    });
  });

  it("leaves non-scratch persisted workspaces unchanged", () => {
    const projectCwd = path.join(testScratchParent, "project");
    expect(resolveScratchWorkspaceCwd(ThreadId.makeUnsafe("project-thread"), projectCwd)).toBe(
      projectCwd,
    );
  });

  it("repairs a persisted legacy cwd before session recovery", () => {
    const threadId = ThreadId.makeUnsafe("persisted-legacy-thread");
    const privateRoot = path.join(testScratchParent, "recovery", SCRATCH_WORKSPACES_DIRNAME);
    const legacyRoot = path.join(testScratchParent, "persisted", SCRATCH_WORKSPACES_DIRNAME);
    const workspaceSegment = path.basename(ensureIsolatedScratchWorkspace(threadId, privateRoot));
    rmSync(privateRoot, { recursive: true, force: true });
    const legacyWorkspace = path.join(legacyRoot, workspaceSegment);
    mkdirSync(legacyWorkspace, { recursive: true });
    if (process.platform !== "win32") {
      chmodSync(legacyRoot, 0o755);
      chmodSync(legacyWorkspace, 0o755);
    }

    expect(
      resolveScratchWorkspaceCwd(threadId, legacyWorkspace, {
        workspaceRoot: privateRoot,
        legacyWorkspaceRoot: legacyRoot,
      }),
    ).toBe(legacyWorkspace);
    if (process.platform !== "win32") {
      expect(statSync(legacyRoot).mode & 0o777).toBe(0o755);
      expect(statSync(legacyWorkspace).mode & 0o777).toBe(0o700);
    }
  });

  it("revalidates a persisted private scratch cwd before session recovery", () => {
    const threadId = ThreadId.makeUnsafe("persisted-private-thread");
    const privateRoot = path.join(testScratchParent, "private", SCRATCH_WORKSPACES_DIRNAME);
    const legacyRoot = path.join(testScratchParent, "unused-legacy");
    const privateWorkspace = ensureIsolatedScratchWorkspace(threadId, privateRoot, legacyRoot);
    if (process.platform !== "win32") {
      chmodSync(privateWorkspace, 0o755);
    }

    expect(
      resolveScratchWorkspaceCwd(threadId, privateWorkspace, {
        workspaceRoot: privateRoot,
        legacyWorkspaceRoot: legacyRoot,
      }),
    ).toBe(privateWorkspace);
    if (process.platform !== "win32") {
      expect(statSync(privateWorkspace).mode & 0o777).toBe(0o700);
    }
  });

  it("does not let path-like thread ids escape the scratch root", () => {
    const workspace = ensureTestScratchWorkspace(ThreadId.makeUnsafe("../outside/thread"));
    try {
      const relative = path.relative(testScratchRoot, workspace);
      expect(relative.startsWith("..")).toBe(false);
      expect(path.isAbsolute(relative)).toBe(false);
      expect(workspace).not.toContain(`${path.sep}..${path.sep}`);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("uses owner-only permissions on POSIX", () => {
    const workspace = ensureTestScratchWorkspace(ThreadId.makeUnsafe("private-thread"));
    try {
      expect(statSync(workspace).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "tightens permissions when reusing an existing scratch workspace",
    () => {
      const threadId = ThreadId.makeUnsafe("reused-private-thread");
      const workspace = ensureTestScratchWorkspace(threadId);
      try {
        chmodSync(workspace, 0o755);
        expect(statSync(workspace).mode & 0o777).toBe(0o755);

        expect(ensureTestScratchWorkspace(threadId)).toBe(workspace);
        expect(statSync(workspace).mode & 0o777).toBe(0o700);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "tightens permissions when reusing the shared scratch root",
    () => {
      const workspace = ensureTestScratchWorkspace(ThreadId.makeUnsafe("private-root"));
      try {
        chmodSync(testScratchRoot, 0o777);

        ensureTestScratchWorkspace(ThreadId.makeUnsafe("private-root"));

        expect(statSync(testScratchRoot).mode & 0o777).toBe(0o700);
      } finally {
        chmodSync(testScratchRoot, 0o700);
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses to follow a reused scratch workspace symlink",
    () => {
      const threadId = ThreadId.makeUnsafe("symlinked-private-thread");
      const workspace = ensureTestScratchWorkspace(threadId);
      const redirected = mkdtempSync(path.join(tmpdir(), "synara-scratch-redirect-"));
      rmSync(workspace, { recursive: true, force: true });
      symlinkSync(redirected, workspace, "dir");
      try {
        expect(() => ensureTestScratchWorkspace(threadId)).toThrow(
          /open without following symlinks/,
        );
      } finally {
        unlinkSync(workspace);
        rmSync(redirected, { recursive: true, force: true });
      }
    },
  );
});
