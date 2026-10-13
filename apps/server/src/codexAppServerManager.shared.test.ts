import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { ThreadId, type ProviderEvent, type ServerSettings } from "@synara/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_GATEWAY_NO_CAPABILITIES,
  type AgentGatewaySessionLease,
} from "./agentGateway/sessionLease";
import { CodexAppServerManager } from "./codexAppServerManager";
import { ServerSettingsService } from "./serverSettings";
import type { CodexSharedMessage } from "./codexSharedProcess";
import { codexSharedProcessEnabled } from "./codexAppServerMode";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllEnvs();
});

async function fixture(mode: ServerSettings["codexAppServerMode"] = "shared") {
  const root = mkdtempSync(path.join(os.tmpdir(), "synara-codex-shared-"));
  const home = path.join(root, "codex");
  mkdirSync(home);
  writeFileSync(path.join(home, "config.toml"), "");
  const binaryPath = path.join(root, "codex.mjs");
  writeFileSync(binaryPath, '#!/usr/bin/env node\nconsole.log("codex-cli 0.162.1");\n');
  chmodSync(binaryPath, 0o755);
  const children: ChildProcessWithoutNullStreams[] = [];
  const requests: CodexSharedMessage[] = [];
  const loaded = new Set<string>();
  const leases: AgentGatewaySessionLease[] = [];
  let accountSnapshot: unknown = { account: { type: "apiKey" } };
  let nextThread = 0;
  let nextTurn = 0;
  const emit = (child: ChildProcessWithoutNullStreams, message: CodexSharedMessage) =>
    (child.stdout as PassThrough).write(`${JSON.stringify(message)}\n`);
  const spawnAppServer = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 51000 + children.length,
      exitCode: null,
      signalCode: null,
      killed: false,
    }) as unknown as ChildProcessWithoutNullStreams;
    children.push(child);
    child.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().trim().split("\n")) {
        const request = JSON.parse(line) as CodexSharedMessage;
        requests.push(request);
        if (!request.method || request.id === undefined) continue;
        const params = request.params as Record<string, unknown> | undefined;
        const respond = (result: unknown) =>
          queueMicrotask(() => emit(child, { id: request.id!, result }));
        if (["thread/start", "thread/resume", "thread/fork"].includes(request.method)) {
          const id =
            request.method === "thread/resume"
              ? String(params?.threadId)
              : `native-${++nextThread}`;
          loaded.add(id);
          queueMicrotask(() =>
            emit(child, { method: "thread/started", params: { thread: { id } } }),
          );
          respond({ thread: { id } });
        } else if (request.method === "thread/loaded/list")
          respond({ data: [...loaded], nextCursor: null });
        else if (request.method === "thread/unsubscribe") {
          loaded.delete(String(params?.threadId));
          respond({});
        } else if (request.method === "turn/start") respond({ turn: { id: `turn-${++nextTurn}` } });
        else if (request.method === "account/read") respond(accountSnapshot);
        else respond({});
      }
    });
    return child;
  });
  const teardownProcessTree = vi.fn(async () => ({
    escalated: false,
    signalErrors: [],
    capturedBeforeRootExit: true,
  }));
  const manager = await Effect.runPromise(
    Effect.gen(function* () {
      const services = yield* Effect.services<never>();
      return new CodexAppServerManager(services, {
        spawnAppServer,
        teardownProcessTree,
        sharedProcessGraceMs: 20,
        agentGatewayMcp: {
          endpointUrl: () => "http://127.0.0.1:9999/mcp",
          acquireSessionLease: () => {
            const lease: AgentGatewaySessionLease = {
              connection: {
                url: "http://127.0.0.1:9999/mcp",
                bearerToken: `token-${leases.length}`,
              },
              release: vi.fn(),
              retireTurn: vi.fn(async () => {}),
              cancelTurn: vi.fn(async () => {}),
            };
            leases.push(lease);
            return lease;
          },
        },
      });
    }).pipe(Effect.provide(ServerSettingsService.layerTest({ codexAppServerMode: mode }))),
  );
  const events: ProviderEvent[] = [];
  manager.on("event", (event) => events.push(event));
  const start = (id: string, environment: Record<string, string> = {}, model?: string) =>
    manager.startSession({
      threadId: ThreadId.makeUnsafe(id),
      cwd: root,
      runtimeMode: "approval-required",
      ...(model ? { model } : {}),
      providerOptions: {
        codex: {
          binaryPath,
          homePath: home,
          accountId: "test",
          environment: { HOME: root, SYNARA_HOME: path.join(root, "synara"), ...environment },
        },
      },
      agentGatewayCapabilityInput: AGENT_GATEWAY_NO_CAPABILITIES,
    });
  cleanups.push(async () => {
    await manager.stopAll();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    manager,
    root,
    home,
    binaryPath,
    children,
    requests,
    loaded,
    leases,
    events,
    start,
    setAccount: (account: { type: string; planType?: string }) => {
      accountSnapshot = { account };
    },
    spawnAppServer,
    teardownProcessTree,
    emit,
  };
}

describe("shared Codex manager", () => {
  it("uses current account capabilities when a new session joins an existing process", async () => {
    const h = await fixture();
    h.setAccount({ type: "chatgpt", planType: "pro" });
    await h.start("a", {}, "gpt-5.3-codex-spark");
    h.setAccount({ type: "chatgpt", planType: "plus" });
    await h.start("b", {}, "gpt-5.3-codex-spark");
    const opens = h.requests.filter((request) => request.method === "thread/start");
    expect((opens[0]!.params as { model: string }).model).toBe("gpt-5.3-codex-spark");
    expect((opens[1]!.params as { model: string }).model).not.toBe("gpt-5.3-codex-spark");
    expect(h.children).toHaveLength(1);
    expect(h.requests.filter((r) => r.method === "initialize")).toHaveLength(1);
  });

  it("shares metadata discovery with live threads across working directories", async () => {
    const h = await fixture();
    await h.start("a");
    mkdirSync(path.join(h.root, "other-project"));
    await h.manager.listModels({
      cwd: path.join(h.root, "other-project"),
      codexOptions: {
        binaryPath: h.binaryPath,
        homePath: h.home,
        accountId: "test",
        environment: { HOME: h.root, SYNARA_HOME: path.join(h.root, "synara") },
      },
    });
    expect(h.children).toHaveLength(1);
    expect(h.requests.filter((r) => r.method === "initialize")).toHaveLength(1);
    expect(h.manager.hasSession(ThreadId.makeUnsafe("a"))).toBe(true);
  });

  it("starts three native threads with one process and distinct MCP tokens", async () => {
    const h = await fixture();
    await Promise.all([h.start("a"), h.start("b"), h.start("c")]);
    expect(h.children).toHaveLength(1);
    expect(h.requests.filter((r) => r.method === "initialize")).toHaveLength(1);
    const opens = h.requests.filter((r) => r.method === "thread/start");
    expect(opens).toHaveLength(3);
    expect(
      new Set(opens.map((r) => JSON.stringify((r.params as { config: unknown }).config))).size,
    ).toBe(3);
    expect(h.manager.listSessions()).toHaveLength(3);
  });

  it("keeps interleaved events and approvals within their session", async () => {
    const h = await fixture();
    const sessions = await Promise.all([h.start("a"), h.start("b"), h.start("c")]);
    for (const i of [2, 0, 1]) {
      const native = (sessions[i]!.resumeCursor as { threadId: string }).threadId;
      h.emit(h.children[0]!, {
        method: "item/agentMessage/delta",
        params: {
          threadId: native,
          turnId: `turn-${i}`,
          itemId: `item-${i}`,
          delta: `private-${i}`,
        },
      });
      h.emit(h.children[0]!, {
        id: `approval-${i}`,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: native,
          turnId: `turn-${i}`,
          itemId: `tool-${i}`,
          command: ["echo", `private-${i}`],
        },
      });
    }
    await vi.waitFor(() => expect(h.events.filter((e) => e.kind === "request")).toHaveLength(3));
    for (let i = 0; i < 3; i++) {
      const id = sessions[i]!.threadId;
      const events = h.events.filter((event) => event.threadId === id);
      expect(JSON.stringify(events)).toContain(`private-${i}`);
      for (let j = 0; j < 3; j++)
        if (i !== j) expect(JSON.stringify(events)).not.toContain(`private-${j}`);
      const approval = events.find((event) => event.kind === "request")!;
      await h.manager.respondToRequest(id, approval.requestId!, "decline");
    }
    expect(
      h.requests.filter((r) => r.id?.toString().startsWith("approval-") && !r.method),
    ).toHaveLength(3);
  });

  it("stops one thread while another remains usable and stops the process after the last lease", async () => {
    const h = await fixture();
    const a = await h.start("a");
    await h.start("b");
    await h.manager.stopSession(a.threadId);
    expect(h.manager.hasSession(a.threadId)).toBe(false);
    expect(h.manager.hasSession(ThreadId.makeUnsafe("b"))).toBe(true);
    expect(h.teardownProcessTree).not.toHaveBeenCalled();
    await h.manager.sendTurn({ threadId: ThreadId.makeUnsafe("b"), input: "hello" });
    await h.manager.stopSession(ThreadId.makeUnsafe("b"));
    await vi.waitFor(() => expect(h.teardownProcessTree).toHaveBeenCalledTimes(1));
  });

  it("rotates one retired gateway token without unloading another session", async () => {
    const h = await fixture();
    const a = await h.start("a");
    const b = await h.start("b");
    const turn = await h.manager.sendTurn({ threadId: a.threadId, input: "hello" });
    const native = (a.resumeCursor as { threadId: string }).threadId;
    h.emit(h.children[0]!, {
      method: "turn/completed",
      params: { threadId: native, turn: { id: turn.turnId, status: "completed" } },
    });
    expect(await h.manager.renewAgentGatewayCredential(a.threadId)).toBe(true);
    expect(h.loaded.has((b.resumeCursor as { threadId: string }).threadId)).toBe(true);
    expect(h.children).toHaveLength(1);
    expect(h.leases).toHaveLength(3);
  });

  it("reports a crash for all hosted threads and restarts on the next start", async () => {
    const h = await fixture();
    await Promise.all([h.start("a"), h.start("b")]);
    h.children[0]!.emit("exit", 1, null);
    await vi.waitFor(() =>
      expect(h.events.filter((e) => e.method === "session/exited")).toHaveLength(2),
    );
    expect(
      h.events
        .filter((e) => e.method === "session/exited")
        .every((e) => (e.payload as { exitKind: string }).exitKind === "error"),
    ).toBe(true);
    await h.start("a");
    expect(h.children).toHaveLength(2);
  });

  it("invalidates every hosted thread when the account auth identity changes", async () => {
    const h = await fixture();
    const a = await h.start("a");
    const b = await h.start("b");
    writeFileSync(
      path.join(h.home, "auth.json"),
      JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "fixture-new-key" }),
    );
    expect(h.manager.hasSession(a.threadId)).toBe(false);
    expect(h.manager.hasSession(b.threadId)).toBe(false);
    await h.start("a");
    expect(h.children).toHaveLength(2);
  });

  it("uses the per-session fallback and splits differing process environments", async () => {
    const fallback = await fixture("per-session");
    await Promise.all([fallback.start("a"), fallback.start("b")]);
    expect(fallback.children).toHaveLength(2);
    const shared = await fixture();
    await shared.start("a", { AUDIT_MODE: "a" });
    await shared.start("b", { AUDIT_MODE: "b" });
    expect(shared.children).toHaveLength(2);
  });

  it("shares processes in Stable and honors the per-session off switch", async () => {
    expect(codexSharedProcessEnabled("shared")).toBe(true);
    expect(codexSharedProcessEnabled("per-session")).toBe(false);
    vi.stubEnv("SYNARA_DESKTOP_BUNDLE_ID", "com.emanueledipietro.synara");
    const h = await fixture();
    await Promise.all([h.start("a"), h.start("b")]);
    expect(h.children).toHaveLength(1);
    const fallback = await fixture("per-session");
    await Promise.all([fallback.start("a"), fallback.start("b")]);
    expect(fallback.children).toHaveLength(2);
  });
});
