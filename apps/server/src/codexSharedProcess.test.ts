import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  CodexSharedProcessRegistry,
  codexSharedProcessKey,
  type CodexSharedMessage,
  type CodexSharedProcessIdentity,
} from "./codexSharedProcess";

const identity: CodexSharedProcessIdentity = {
  binaryPath: "/bin/codex",
  binaryIdentity: "file-v1",
  version: "0.162.1",
  accountId: "account-a",
  authFingerprint: "auth-a",
  configSnapshot: "config-a",
  env: { CODEX_HOME: "/account-a", CODEX_SQLITE_HOME: "/account-a", CUSTOM: "secret" },
  args: ["app-server"],
  lowerPriority: true,
  platform: "darwin",
};

function harness() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 50001,
    exitCode: null,
    signalCode: null,
    killed: false,
  }) as unknown as ChildProcessWithoutNullStreams;
  const writes: CodexSharedMessage[] = [];
  const loaded = new Set<string>();
  let blockedUnload = false;
  const emit = (message: CodexSharedMessage) =>
    (child.stdout as PassThrough).write(`${JSON.stringify(message)}\n`);
  child.stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().trim().split("\n")) {
      const request = JSON.parse(line) as CodexSharedMessage;
      writes.push(request);
      if (request.method === "thread/loaded/list")
        queueMicrotask(() =>
          emit({ id: request.id!, result: { data: [...loaded], nextCursor: null } }),
        );
      else if (request.method === "thread/unsubscribe") {
        if (!blockedUnload) loaded.delete((request.params as { threadId: string }).threadId);
        queueMicrotask(() => emit({ id: request.id!, result: {} }));
      } else if (
        ["initialize", "account/read", "skills/extraRoots/set"].includes(request.method ?? "")
      )
        queueMicrotask(() => emit({ id: request.id!, result: {} }));
    }
  });
  const teardown = vi.fn(async () => ({ capturedBeforeRootExit: true }));
  const registry = new CodexSharedProcessRegistry<object>(teardown, 15);
  const spawn = vi.fn(() => child);
  const messages = [[], [], []] as CodexSharedMessage[][];
  const failures = [vi.fn(), vi.fn(), vi.fn()];
  const owners = [{}, {}, {}];
  const acquire = async () => {
    const process = await registry.acquire("account", spawn);
    for (let i = 0; i < owners.length; i++)
      process.add(owners[i]!, { message: (m) => messages[i]!.push(m), failure: failures[i]! });
    return process;
  };
  return {
    child,
    emit,
    writes,
    loaded,
    teardown,
    registry,
    spawn,
    messages,
    failures,
    owners,
    acquire,
    blockUnload: () => {
      blockedUnload = true;
    },
  };
}

describe("Codex shared process identity", () => {
  it("canonicalizes environment order and excludes undefined values", () => {
    expect(codexSharedProcessKey(identity)).toBe(
      codexSharedProcessKey({
        ...identity,
        env: {
          CUSTOM: "secret",
          CODEX_SQLITE_HOME: "/account-a",
          UNUSED: undefined,
          CODEX_HOME: "/account-a",
        },
      }),
    );
    expect(codexSharedProcessKey(identity)).not.toContain("secret");
  });

  it.each([
    { binaryPath: "/other/codex" },
    { binaryIdentity: "file-v2" },
    { version: "0.163.0" },
    { accountId: "account-b" },
    { authFingerprint: "auth-b" },
    { configSnapshot: "config-b" },
    { lowerPriority: false },
    { platform: "win32" as const },
    { args: ["app-server", "--different-capability"] },
    { env: { ...identity.env, CODEX_HOME: "/account-b" } },
    { env: { ...identity.env, CUSTOM: "other" } },
  ])("separates launch identity %j", (patch) => {
    expect(codexSharedProcessKey({ ...identity, ...patch })).not.toBe(
      codexSharedProcessKey(identity),
    );
  });
});

describe("Codex shared process routing", () => {
  it("shares acquisition and initialization across three sessions", async () => {
    const h = harness();
    const process = await h.acquire();
    const same = await h.registry.acquire("account", h.spawn);
    await Promise.all([process.initialize({}), same.initialize({}), process.initialize({})]);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.writes.filter((r) => r.method === "initialize")).toHaveLength(1);
    expect(h.writes.filter((r) => r.method === "initialized")).toHaveLength(1);
    await h.registry.stopAll();
  });

  it("routes interleaved turns, tool output, approvals and responses to their owners", async () => {
    const h = harness();
    const p = await h.acquire();
    h.owners.forEach((owner, i) => p.bind(owner, `native-${i}`));
    const requests = h.owners.map((owner, i) =>
      p.allocateRequest(owner, "turn/start", { threadId: `native-${i}` }),
    );
    for (const i of [2, 0, 1]) {
      h.emit({
        method: "item/agentMessage/delta",
        params: { threadId: `native-${i}`, delta: `text-${i}` },
      });
      h.emit({
        id: `approval-${i}`,
        method: "item/commandExecution/requestApproval",
        params: { threadId: `native-${i}`, command: `command-${i}` },
      });
      h.emit({
        method: "item/commandExecution/outputDelta",
        params: { threadId: `native-${i}`, delta: `tool-${i}` },
      });
      h.emit({ id: requests[i]!, result: { turn: { id: `turn-${i}` } } });
    }
    h.messages.forEach((messages, i) => {
      expect(messages).toHaveLength(4);
      expect(JSON.stringify(messages)).toContain(`tool-${i}`);
      for (let j = 0; j < 3; j++)
        if (j !== i) expect(JSON.stringify(messages)).not.toContain(`text-${j}`);
    });
    expect(new Set(requests).size).toBe(3);
    await h.registry.stopAll();
  });

  it("buffers thread startup events until the response binds the owner", async () => {
    const h = harness();
    const p = await h.acquire();
    const id = p.allocateRequest(h.owners[1]!, "thread/start", {});
    h.emit({ method: "thread/started", params: { thread: { id: "new-native" } } });
    expect(h.messages.flat()).toHaveLength(0);
    h.emit({ id, result: { thread: { id: "new-native" } } });
    expect(h.messages[1]).toHaveLength(2);
    expect(h.messages[0]).toHaveLength(0);
    await h.registry.stopAll();
  });

  it("fails the process when a successful open cannot identify the native lease", async () => {
    const h = harness();
    const p = await h.acquire();
    const id = p.allocateRequest(h.owners[0]!, "thread/start", {});
    h.emit({ id, result: { thread: {} } });
    for (const failure of h.failures)
      expect(failure).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("native thread ID") }),
        null,
        null,
      );
    await vi.waitFor(() => expect(h.teardown).toHaveBeenCalledTimes(1));
    await h.registry.stopAll();
  });

  it("never guesses ownership for unknown approvals or threadless tool events", async () => {
    const h = harness();
    await h.acquire();
    h.emit({
      id: "orphan",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "foreign" },
    });
    h.emit({ method: "item/agentMessage/delta", params: { delta: "private" } });
    await vi.waitFor(() => expect(h.writes.some((m) => m.id === "orphan" && m.error)).toBe(true));
    expect(h.messages.flat()).toHaveLength(0);
    await h.registry.stopAll();
  });

  it("rejects cross-session outbound thread control", async () => {
    const h = harness();
    const p = await h.acquire();
    p.bind(h.owners[0]!, "native-a");
    expect(() =>
      p.allocateRequest(h.owners[1]!, "turn/interrupt", { threadId: "native-a", turnId: "turn-a" }),
    ).toThrow("no matching");
    expect(() =>
      p.allocateRequest(h.owners[1]!, "thread/rollback", { threadId: "native-a" }),
    ).toThrow("no matching");
    await h.registry.stopAll();
  });

  it("routes known native subagents and refuses duplicate ownership", async () => {
    const h = harness();
    const p = await h.acquire();
    p.bind(h.owners[0]!, "parent");
    h.emit({
      method: "item/started",
      params: {
        threadId: "parent",
        item: { type: "collabAgentToolCall", receiverThreadIds: ["child"] },
      },
    });
    h.emit({
      method: "item/agentMessage/delta",
      params: { threadId: "child", delta: "child-text" },
    });
    expect(h.messages[0]).toHaveLength(2);
    expect(h.messages[1]).toHaveLength(0);
    expect(() => p.bind(h.owners[1]!, "parent")).toThrow("already owned");
    await h.registry.stopAll();
  });
});

describe("Codex shared process lifecycle", () => {
  it("keeps retired native threads bound to their original Synara identity", async () => {
    const h = harness();
    const p = await h.acquire();
    p.add(h.owners[0]!, { sessionId: "synara-a", message: vi.fn(), failure: vi.fn() });
    p.bind(h.owners[0]!, "native-a");
    await p.release(h.owners[0]!);
    expect(() => p.bind(h.owners[1]!, "native-a")).toThrow("already owned");
    const restored = {};
    const messages = vi.fn();
    p.add(restored, { sessionId: "synara-a", message: messages, failure: vi.fn() });
    p.bind(restored, "native-a");
    h.emit({
      method: "item/agentMessage/delta",
      params: { threadId: "native-a", delta: "restored" },
    });
    expect(messages).toHaveBeenCalledTimes(1);
    await h.registry.stopAll();
  });

  it("waits for a cancelled thread open before releasing its native lease", async () => {
    const h = harness();
    const p = await h.acquire();
    const id = p.allocateRequest(h.owners[0]!, "thread/start", {});
    p.forgetRequest(id);
    const released = p.release(h.owners[0]!);
    h.loaded.add("late-native");
    h.emit({ id, result: { thread: { id: "late-native" } } });
    await released;
    expect(h.loaded.has("late-native")).toBe(false);
    expect(h.teardown).not.toHaveBeenCalled();
    await h.registry.stopAll();
  });

  it("refuses an unproven unload without killing other hosted threads", async () => {
    const h = harness();
    const p = await h.acquire();
    p.bind(h.owners[0]!, "native-a");
    h.loaded.add("native-a");
    h.blockUnload();
    await expect(p.release(h.owners[0]!)).rejects.toThrow("did not unload");
    expect(p.members.has(h.owners[0]!)).toBe(true);
    expect(h.teardown).not.toHaveBeenCalled();
    await h.registry.stopAll();
  });

  it("unloads only the released thread and keeps other sessions live", async () => {
    const h = harness();
    const p = await h.acquire();
    h.owners.forEach((owner, i) => {
      p.bind(owner, `native-${i}`);
      h.loaded.add(`native-${i}`);
    });
    await p.release(h.owners[1]!);
    expect(h.loaded).toEqual(new Set(["native-0", "native-2"]));
    expect(h.teardown).not.toHaveBeenCalled();
    h.emit({ method: "item/agentMessage/delta", params: { threadId: "native-2", delta: "alive" } });
    expect(h.messages[2]).toHaveLength(1);
    await p.release(h.owners[0]!);
    await p.release(h.owners[2]!);
    await vi.waitFor(() => expect(h.teardown).toHaveBeenCalledTimes(1));
  });

  it("cancels the last-thread grace when a new session joins", async () => {
    const h = harness();
    const p = await h.acquire();
    for (const owner of h.owners) await p.release(owner);
    const same = await h.registry.acquire("account", h.spawn);
    same.add({}, { message: vi.fn(), failure: vi.fn() });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(same).toBe(p);
    expect(h.teardown).not.toHaveBeenCalled();
    await h.registry.stopAll();
  });

  it("fans an idle crash out as an error and restarts after verified teardown", async () => {
    const h = harness();
    await h.acquire();
    h.child.emit("exit", 0, null);
    for (const failure of h.failures)
      expect(failure).toHaveBeenCalledWith(expect.any(Error), 0, null);
    await vi.waitFor(() => expect(h.teardown).toHaveBeenCalledTimes(1));
    const replacement = await h.registry.acquire("account", h.spawn);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(replacement.failed).toBeUndefined();
    await h.registry.stopAll();
  });

  it("fails every original member and tears down when a failure handler throws", async () => {
    const h = harness();
    const p = await h.acquire();
    h.failures[0]!.mockImplementation(() => {
      p.members.delete(h.owners[1]!);
      throw new Error("session consumer failed");
    });
    expect(() => p.fail(new Error("process crashed"))).not.toThrow();
    for (const failure of h.failures) expect(failure).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.teardown).toHaveBeenCalledTimes(1));
    await h.registry.stopAll();
  });

  it("keeps a teardown failure as a replacement barrier", async () => {
    const h = harness();
    const p = await h.acquire();
    h.teardown.mockRejectedValue(new Error("exit unproven"));
    await expect(p.stop()).rejects.toThrow("exit unproven");
    await expect(h.registry.acquire("account", h.spawn)).rejects.toThrow("exit unproven");
    expect(h.spawn).toHaveBeenCalledTimes(1);
    h.teardown.mockResolvedValue({ capturedBeforeRootExit: true });
    await h.registry.stopAll();
  });
});
