import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";

import { JsonRpcStdioRequestRegistry } from "@synara/shared/jsonrpc-stdio";
import { decodeSubagentReceiverThreadIds } from "@synara/shared/subagents";

import { CodexJsonlFramer, CodexJsonlWriter } from "./codexAppServerTransport";

export interface CodexSharedProcessIdentity {
  readonly binaryPath: string;
  readonly binaryIdentity: string;
  readonly version: string;
  readonly accountId: string;
  readonly authFingerprint: string;
  readonly env: NodeJS.ProcessEnv;
  readonly args: readonly string[];
  readonly lowerPriority: boolean;
  readonly platform: NodeJS.Platform;
}

export function codexSharedProcessKey(identity: CodexSharedProcessIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...identity,
        env: Object.entries(identity.env)
          .filter((entry): entry is [string, string] => entry[1] !== undefined)
          .sort(([a], [b]) => a.localeCompare(b)),
      }),
    )
    .digest("hex");
}

export interface CodexSharedMessage {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

interface Member {
  readonly message: (message: CodexSharedMessage) => void;
  readonly failure: (error: Error, code: number | null, signal: NodeJS.Signals | null) => void;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function threadId(params: unknown): string | undefined {
  const value = record(params);
  const id = value?.threadId ?? record(value?.thread)?.id ?? value?.conversationId;
  return typeof id === "string" ? id : undefined;
}

const GLOBAL_NOTIFICATIONS = new Set([
  "account/updated",
  "account/rateLimits/updated",
  "configWarning",
  "deprecationNotice",
]);

export class CodexSharedProcess<T extends object> {
  readonly framer = new CodexJsonlFramer();
  readonly writer: CodexJsonlWriter;
  readonly members = new Map<T, Member>();
  readonly routes = new Map<string, T>();
  private readonly controls = new JsonRpcStdioRequestRegistry({
    responseError: ({ method, error }) => new Error(`${method} failed: ${String(error.message)}`),
  });
  private readonly requests = new Map<number, { owner: T; method: string }>();
  private readonly early = new Map<string, CodexSharedMessage[]>();
  private earlyBytes = 0;
  private nextId = 1;
  private initialization: Promise<unknown> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private shutdown: Promise<void> | undefined;
  failed: Error | undefined;
  capturedBeforeExit = false;

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    private readonly teardown: (child: ChildProcessWithoutNullStreams) => Promise<{
      readonly capturedBeforeRootExit?: boolean;
    }>,
    private readonly onStopped: () => void,
    private readonly graceMs: number,
  ) {
    this.writer = new CodexJsonlWriter(child.stdin);
    this.controls.processStarted();
    child.stdout.on("data", this.onData);
    child.stdout.once("end", () => {
      if (this.shutdown || this.failed) return;
      try {
        this.framer.finish();
        this.fail(new Error("Shared Codex app-server stdout closed before shutdown."));
      } catch (error) {
        this.fail(error);
      }
    });
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code, signal) => {
      if (!this.shutdown && !this.failed)
        this.fail(
          new Error(`Shared Codex app-server exited (code=${code}, signal=${signal}).`),
          code,
          signal,
        );
    });
  }

  get stopping(): boolean {
    return this.shutdown !== undefined || this.failed !== undefined;
  }

  add(owner: T, member: Member): void {
    if (this.stopping) throw this.failed ?? new Error("Shared Codex app-server is stopping.");
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.members.set(owner, member);
  }

  initialize(params: unknown, skillsDir?: string): Promise<unknown> {
    return (this.initialization ??= (async () => {
      await this.control("initialize", params);
      await this.write({ method: "initialized" });
      if (skillsDir) {
        try {
          await this.control("skills/extraRoots/set", { extraRoots: [skillsDir] });
        } catch {
          if (this.stopping) throw this.failed ?? new Error("Shared Codex initialization failed.");
        }
      }
      try {
        return await this.control("account/read", {});
      } catch {
        if (this.stopping) throw this.failed ?? new Error("Shared Codex initialization failed.");
        return undefined;
      }
    })());
  }

  allocateRequest(owner: T, method: string, params: unknown): number {
    if (this.stopping) throw this.failed ?? new Error("Shared Codex app-server is stopping.");
    if (method === "thread/resume") {
      const id = threadId(params);
      if (id) this.bind(owner, id);
    }
    const id = this.nextId++;
    this.requests.set(id, { owner, method });
    return id;
  }

  forgetRequest(id: number): void {
    const request = this.requests.get(id);
    if (request && ["thread/start", "thread/resume", "thread/fork"].includes(request.method))
      return;
    this.requests.delete(id);
    if (!this.hasThreadOpenRequest()) this.clearEarly();
  }

  bind(owner: T, id: string): void {
    const previous = this.routes.get(id);
    if (previous && previous !== owner)
      throw new Error("Codex native thread is already owned by another Synara session.");
    this.routes.set(id, owner);
    const buffered = this.early.get(id);
    this.early.delete(id);
    if (buffered) {
      for (const message of buffered) {
        this.earlyBytes -= Buffer.byteLength(JSON.stringify(message));
        this.deliver(owner, message);
      }
    }
  }

  write(message: unknown): Promise<void> {
    return this.writer.write(message).catch((error) => {
      this.fail(error);
      throw error;
    });
  }

  async loadedThreadIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = record(await this.control("thread/loaded/list", { limit: 100, cursor }));
      if (!Array.isArray(response?.data) || response.data.some((id) => typeof id !== "string"))
        throw new Error("Codex did not return a verifiable loaded thread list.");
      for (const id of response.data) ids.add(id as string);
      if (response.nextCursor === null) return ids;
      if (typeof response.nextCursor !== "string" || seen.has(response.nextCursor))
        throw new Error("Codex loaded thread pagination did not converge.");
      cursor = response.nextCursor;
      seen.add(cursor);
    } while (seen.size < 1_000);
    throw new Error("Codex loaded thread list exceeded its page limit.");
  }

  async unload(owner: T): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const opening = [...this.requests.values()].some(
        (request) =>
          request.owner === owner &&
          ["thread/start", "thread/resume", "thread/fork"].includes(request.method),
      );
      if (!opening) break;
      if (attempt >= 80) throw new Error("Codex thread open is still pending; retry Stop.");
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    const ids = Array.from(this.routes, ([id, candidate]) =>
      candidate === owner ? id : null,
    ).filter((id): id is string => id !== null);
    for (const id of ids) await this.control("thread/unsubscribe", { threadId: id });
    if (ids.length === 0) return;
    for (let attempt = 0; attempt < 20; attempt++) {
      const loaded = await this.loadedThreadIds();
      if (ids.every((id) => !loaded.has(id))) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Codex did not unload this session's native threads; retry Stop.");
  }

  async release(owner: T): Promise<void> {
    if (this.stopping) {
      await this.stop();
    } else {
      await this.unload(owner);
    }
    this.members.delete(owner);
    for (const [id, candidate] of this.routes) if (candidate === owner) this.routes.delete(id);
    for (const [id, request] of this.requests)
      if (request.owner === owner) this.requests.delete(id);
    if (this.members.size === 0 && !this.stopping) {
      this.idleTimer = setTimeout(() => void this.stop().catch(() => undefined), this.graceMs);
      this.idleTimer.unref();
    }
  }

  stop(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.writer.close(this.failed ?? new Error("Shared Codex app-server stopped."));
    this.controls.rejectAll(this.failed ?? new Error("Shared Codex app-server stopped."));
    this.child.stdout.off("data", this.onData);
    this.framer.close();
    this.clearEarly();
    this.shutdown = this.teardown(this.child).then(
      (result) => {
        this.capturedBeforeExit = result.capturedBeforeRootExit === true;
        this.onStopped();
      },
      (error: unknown) => {
        this.failed = error instanceof Error ? error : new Error(String(error));
        this.shutdown = undefined;
        throw error;
      },
    );
    return this.shutdown;
  }

  fail(cause: unknown, code: number | null = null, signal: NodeJS.Signals | null = null): void {
    if (this.failed || this.shutdown) return;
    this.failed = cause instanceof Error ? cause : new Error(String(cause));
    for (const member of [...this.members.values()]) member.failure(this.failed, code, signal);
    void this.stop().catch(() => undefined);
  }

  private control(method: string, params: unknown): Promise<unknown> {
    return this.controls.requestWithId(
      this.nextId++,
      method,
      params,
      (message) => this.write(message),
      method === "initialize" || method === "account/read" || method === "skills/extraRoots/set"
        ? 20_000
        : 2_000,
    );
  }

  private readonly onData = (chunk: Buffer): void => {
    if (this.stopping) return;
    try {
      for (const line of this.framer.push(chunk)) {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        const message = record(value) as CodexSharedMessage | undefined;
        if (message) this.route(message);
      }
    } catch (error) {
      this.fail(error);
    }
  };

  private route(message: CodexSharedMessage): void {
    if (!message.method && message.id !== undefined) {
      const request = typeof message.id === "number" ? this.requests.get(message.id) : undefined;
      if (!request) {
        this.controls.handleResponse({
          id: message.id,
          result: message.result,
          ...(message.error ? { error: message.error } : {}),
        });
        return;
      }
      if (
        !message.error &&
        ["thread/start", "thread/resume", "thread/fork"].includes(request.method)
      ) {
        const id = threadId(message.result);
        if (id) {
          try {
            this.bind(request.owner, id);
          } catch (error) {
            this.requests.delete(message.id as number);
            this.deliver(request.owner, {
              id: message.id,
              error: {
                code: -32602,
                message: error instanceof Error ? error.message : String(error),
              },
            });
            return;
          }
        }
      }
      this.requests.delete(message.id as number);
      this.deliver(request.owner, message);
      if (!this.hasThreadOpenRequest()) this.clearEarly();
      return;
    }
    if (!message.method) return;
    const id = threadId(message.params);
    const owner = id ? this.routes.get(id) : undefined;
    if (owner) {
      const params = record(message.params);
      const item = record(params?.item) ?? params;
      if (item?.type === "collabAgentToolCall" || item?.type === "collabToolCall") {
        for (const child of decodeSubagentReceiverThreadIds(item))
          if (!this.routes.has(child)) this.bind(owner, child);
      }
      this.deliver(owner, message);
    } else if (message.id !== undefined) {
      void this.write({
        id: message.id,
        error: { code: -32602, message: "No Synara session owns this Codex thread request." },
      }).catch(() => undefined);
    } else if (!id && GLOBAL_NOTIFICATIONS.has(message.method)) {
      for (const candidate of this.members.keys()) this.deliver(candidate, message);
    } else if (id && this.hasThreadOpenRequest()) {
      const bytes = Buffer.byteLength(JSON.stringify(message));
      if (this.earlyBytes + bytes > 16 * 1024 * 1024)
        throw new Error("Shared Codex startup event buffer exceeded its byte limit.");
      const buffered = this.early.get(id) ?? [];
      buffered.push(message);
      this.early.set(id, buffered);
      this.earlyBytes += bytes;
    }
  }

  private hasThreadOpenRequest(): boolean {
    return [...this.requests.values()].some((r) =>
      ["thread/start", "thread/resume", "thread/fork"].includes(r.method),
    );
  }

  private clearEarly(): void {
    this.early.clear();
    this.earlyBytes = 0;
  }

  private deliver(owner: T, message: CodexSharedMessage): void {
    this.members.get(owner)?.message(message);
  }
}

export class CodexSharedProcessRegistry<T extends object> {
  private readonly entries = new Map<string, CodexSharedProcess<T>>();

  constructor(
    private readonly teardown: ConstructorParameters<typeof CodexSharedProcess<T>>[1],
    private readonly graceMs = 1_000,
  ) {}

  async acquire(
    key: string,
    spawn: () => ChildProcessWithoutNullStreams,
  ): Promise<CodexSharedProcess<T>> {
    const existing = this.entries.get(key);
    if (existing?.stopping) await existing.stop();
    const current = this.entries.get(key);
    if (current) return current;
    const process = new CodexSharedProcess<T>(
      spawn(),
      this.teardown,
      () => {
        if (this.entries.get(key) === process) this.entries.delete(key);
      },
      this.graceMs,
    );
    this.entries.set(key, process);
    return process;
  }

  async stopAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.entries.values()].map((process) => process.stop()),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, "Shared Codex process trees did not prove exit.");
  }
}
