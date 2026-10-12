import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { CodexAppServerManager } from "./codexAppServerManager.ts";
import * as codexProcessEnv from "./codexProcessEnv.ts";

vi.mock("./codexProcessEnv.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./codexProcessEnv.ts")>();
  return { ...actual, prepareCodexAuthTracking: vi.fn(actual.prepareCodexAuthTracking) };
});

const roots: string[] = [];
const authReads = vi.mocked(codexProcessEnv.prepareCodexAuthTracking);

beforeEach(() => authReads.mockClear());
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function managerWithSharedHomeSessions(cwds: ReadonlyArray<string>) {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-reads-"));
  roots.push(homePath);
  fs.writeFileSync(
    path.join(homePath, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "acct", access_token: "t" } }),
  );
  const codexOptions = { homePath };
  const authTracking = codexProcessEnv.prepareCodexAuthTracking(codexOptions);
  const authFingerprint = codexProcessEnv.readCodexPreparedAuthTrackingFingerprint(authTracking);
  const manager = new CodexAppServerManager();
  const sessions = (manager as unknown as { sessions: Map<ThreadId, unknown> }).sessions;
  cwds.forEach((cwd, index) => {
    const threadId = ThreadId.makeUnsafe(`shared-home-${index}`);
    sessions.set(threadId, {
      session: { provider: "codex", threadId, status: "ready", runtimeMode: "full-access", cwd },
      child: {
        exitCode: null,
        signalCode: null,
        killed: false,
        stdin: { writable: true, writableEnded: false, destroyed: false },
      },
      codexOptions,
      authTracking,
      authFingerprint,
    });
  });
  authReads.mockClear();
  return { manager, codexOptions };
}

it("reads auth once per Codex home when listing and inspecting sessions", () => {
  const { manager } = managerWithSharedHomeSessions(["/a", "/b", "/c", "/d", "/e"]);

  expect(manager.listSessions()).toHaveLength(5);
  expect(authReads).toHaveBeenCalledTimes(1);

  authReads.mockClear();
  expect(manager.inspectSessions()).toHaveLength(5);
  expect(authReads).toHaveBeenCalledTimes(1);
});

it("skips auth reads for sessions that cannot serve a discovery request", async () => {
  const { manager, codexOptions } = managerWithSharedHomeSessions([
    "/other-1",
    "/other-2",
    "/other-3",
    "/target",
  ]);
  const resolve = (
    manager as unknown as {
      resolveContextForDiscovery: (
        threadId: string | undefined,
        cwd: string,
        codexOptions: unknown,
      ) => Promise<{ session: { cwd: string } }>;
    }
  ).resolveContextForDiscovery.bind(manager);

  const context = await resolve(undefined, "/target", codexOptions);

  expect(context.session.cwd).toBe("/target");
  expect(authReads).toHaveBeenCalledTimes(1);
});
