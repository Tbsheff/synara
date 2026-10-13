import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { CodexAppServerManager } from "./codexAppServerManager";
import { CodexJsonlFramer, CodexJsonlWriter } from "./codexAppServerTransport";

function harness(
  beforeLoginResponse?: (complete: (params: Record<string, unknown>) => void) => void,
  beforeStatusResponse?: (notify: (params: Record<string, unknown>) => void) => void,
) {
  const manager = new CodexAppServerManager();
  const threadId = ThreadId.makeUnsafe("mcp-thread");
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    killed: false,
  });
  const context = {
    session: {
      threadId,
      provider: "codex",
      status: "ready",
      runtimeMode: "full-access",
      resumeCursor: { threadId: "native-thread" },
    },
    sessionAttemptId: "attempt-1",
    child,
    stdoutFramer: new CodexJsonlFramer(),
    stdinWriter: new CodexJsonlWriter(stdin),
    pending: new Map(),
    nextRequestId: 1,
    stopping: false,
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    collabReceiverTurns: new Map(),
    collabReceiverParents: new Map(),
    reviewTurnIds: new Set(),
  };
  const internals = manager as unknown as {
    sessions: Map<ThreadId, unknown>;
    handleStdoutLine(context: unknown, chunk: string): void;
    handleServerNotification(context: unknown, event: { method: string; params: unknown }): void;
  };
  internals.sessions.set(threadId, context);
  const requests: { id: number; method: string; params: Record<string, unknown> }[] = [];
  let authStatus = "notLoggedIn";
  let loginError: string | undefined;
  let pages = false;
  stdin.on("data", (chunk) => {
    const request = JSON.parse(String(chunk));
    requests.push(request);
    const result =
      request.method === "mcpServerStatus/list"
        ? {
            data: [
              {
                name: request.params.cursor ? "second" : "linear",
                authStatus,
                tools: {},
                config: { token: "PRIVATE_SENTINEL" },
              },
            ],
            nextCursor: pages && !request.params.cursor ? "page-2" : null,
          }
        : { authorizationUrl: "https://login.example/authorize", loginId: "login-1" };
    const response =
      request.method === "mcpServer/oauth/login" && loginError
        ? { id: request.id, error: { code: -1, message: loginError } }
        : { id: request.id, result };
    queueMicrotask(() => {
      if (request.method === "mcpServer/oauth/login")
        beforeLoginResponse?.((params) =>
          internals.handleServerNotification(context, {
            method: "mcpServer/oauthLogin/completed",
            params,
          }),
        );
      if (request.method === "mcpServerStatus/list")
        beforeStatusResponse?.((params) =>
          internals.handleServerNotification(context, {
            method: "mcpServer/startupStatus/updated",
            params,
          }),
        );
      internals.handleStdoutLine(context, JSON.stringify(response));
    });
  });
  return {
    manager,
    threadId,
    context,
    requests,
    internals,
    setStatus: (status: string) => {
      authStatus = status;
    },
    setError: (error: string) => {
      loginError = error;
    },
    paginate: () => {
      pages = true;
    },
    complete: (params: Record<string, unknown>) =>
      internals.handleServerNotification(context, {
        method: "mcpServer/oauthLogin/completed",
        params,
      }),
  };
}

describe("Codex native MCP auth", () => {
  it("reads the owning thread's paged OAuth status and starts native login", async () => {
    const h = harness();
    h.paginate();
    const state = await h.manager.getMcpAuth({ threadId: h.threadId });
    expect(state.sessionKey).toBe("attempt-1");
    expect(state.servers.map((s) => s.name)).toEqual(["linear", "second"]);
    expect(JSON.stringify(state)).not.toContain("PRIVATE_SENTINEL");
    expect(h.requests[0]).toMatchObject({
      method: "mcpServerStatus/list",
      params: { threadId: "native-thread" },
    });
    const login = await h.manager.authenticateMcp({
      threadId: h.threadId,
      sessionKey: state.sessionKey!,
      serverName: "linear",
    });
    expect(login.authorizationUrl).toBe("https://login.example/authorize");
    expect(h.requests.at(-1)).toMatchObject({
      method: "mcpServer/oauth/login",
      params: { name: "linear", threadId: "native-thread" },
    });
  });
  it("keeps a new auth notice when an older status read finishes", async () => {
    const h = harness(undefined, (notify) =>
      notify({
        name: "linear",
        threadId: "native-thread",
        status: "failed",
        failureReason: "reauthenticationRequired",
      }),
    );
    h.setStatus("oAuth");
    const state = await h.manager.getMcpAuth({ threadId: h.threadId });
    expect(state.servers.map((server) => server.name)).toEqual(["linear"]);
  });
  it("keeps known sign-in needs while native status is unknown", async () => {
    const h = harness();
    await h.manager.getMcpAuth({ threadId: h.threadId });
    h.setStatus("unknown");
    const state = await h.manager.getMcpAuth({ threadId: h.threadId, refresh: true });
    expect(state.servers.map((server) => server.name)).toEqual(["linear"]);
  });
  it("rejects stale sessions and invented names without starting OAuth", async () => {
    const h = harness();
    await h.manager.getMcpAuth({ threadId: h.threadId });
    await expect(
      h.manager.authenticateMcp({
        threadId: h.threadId,
        sessionKey: "old-attempt",
        serverName: "linear",
      }),
    ).rejects.toThrow(/session/i);
    await expect(
      h.manager.authenticateMcp({
        threadId: h.threadId,
        sessionKey: "attempt-1",
        serverName: "invented",
      }),
    ).rejects.toThrow(/sign-in/i);
    expect(h.requests.some((r) => r.method === "mcpServer/oauth/login")).toBe(false);
  });
  it("matches completion to its attempt, preserves errors, and allows retry", async () => {
    const h = harness();
    await h.manager.getMcpAuth({ threadId: h.threadId });
    await h.manager.authenticateMcp({
      threadId: h.threadId,
      sessionKey: "attempt-1",
      serverName: "linear",
    });
    h.complete({ name: "linear", threadId: "different-thread", loginId: "login-1", success: true });
    expect((await h.manager.getMcpAuth({ threadId: h.threadId })).servers[0]?.status).toBe(
      "authenticating",
    );
    h.complete({ name: "linear", threadId: "native-thread", loginId: "old-login", success: true });
    expect((await h.manager.getMcpAuth({ threadId: h.threadId })).servers[0]?.status).toBe(
      "authenticating",
    );
    h.complete({
      name: "linear",
      threadId: "native-thread",
      loginId: "login-1",
      success: false,
      error: "Consent denied",
    });
    expect((await h.manager.getMcpAuth({ threadId: h.threadId })).servers[0]?.error).toBe(
      "Consent denied",
    );
    await h.manager.authenticateMcp({
      threadId: h.threadId,
      sessionKey: "attempt-1",
      serverName: "linear",
    });
    h.setStatus("oAuth");
    h.complete({ name: "linear", threadId: "native-thread", loginId: "login-1", success: true });
    expect((await h.manager.getMcpAuth({ threadId: h.threadId, refresh: true })).servers).toEqual(
      [],
    );
  });
  it("waits for the login ID before accepting early completion", async () => {
    const h = harness((complete) =>
      complete({ name: "linear", threadId: "native-thread", loginId: "old-login", success: true }),
    );
    await h.manager.getMcpAuth({ threadId: h.threadId });
    const result = await h.manager.authenticateMcp({
      threadId: h.threadId,
      sessionKey: "attempt-1",
      serverName: "linear",
    });
    expect(result.state.servers[0]?.status).toBe("authenticating");
    expect(result.authorizationUrl).toBeDefined();
    await expect(
      h.manager.authenticateMcp({
        threadId: h.threadId,
        sessionKey: "attempt-1",
        serverName: "linear",
      }),
    ).rejects.toThrow(/in progress/);
    expect(h.requests.filter((request) => request.method === "mcpServer/oauth/login")).toHaveLength(
      1,
    );
  });
  it("accepts the current completion before the response without opening a finished flow", async () => {
    const h = harness((complete) =>
      complete({ name: "linear", threadId: "native-thread", loginId: "login-1", success: true }),
    );
    await h.manager.getMcpAuth({ threadId: h.threadId });
    const result = await h.manager.authenticateMcp({
      threadId: h.threadId,
      sessionKey: "attempt-1",
      serverName: "linear",
    });
    expect(result.state.servers).toEqual([]);
    expect(result.authorizationUrl).toBeUndefined();
  });
  it("falls back to the exact CLI command when native login is unsupported", async () => {
    const h = harness();
    h.setError("Method not found");
    await h.manager.getMcpAuth({ threadId: h.threadId });
    const result = await h.manager.authenticateMcp({
      threadId: h.threadId,
      sessionKey: "attempt-1",
      serverName: "linear",
    });
    expect(result.authorizationUrl).toBeUndefined();
    expect(result.state.servers[0]?.action).toMatchObject({
      type: "manual",
      command: "'codex' mcp login 'linear'",
    });
  });
  it("keeps synchronous login errors in the list", async () => {
    const h = harness();
    h.setError("Registration refused");
    await h.manager.getMcpAuth({ threadId: h.threadId });
    const result = await h.manager.authenticateMcp({
      threadId: h.threadId,
      sessionKey: "attempt-1",
      serverName: "linear",
    });
    expect(result.state.servers[0]?.error).toContain("Registration refused");
  });
});
