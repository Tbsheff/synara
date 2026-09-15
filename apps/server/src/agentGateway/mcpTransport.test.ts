import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ThreadId, TurnId, type OrchestrationThreadShell } from "@synara/contracts";
import { createPluginRegistry, type JsonValue } from "@synara/plugin-sdk";
import { reviewQueueContract } from "@synara/plugin-review-queue/contract";
import { reviewQueueManifest } from "@synara/plugin-review-queue/manifest";
import reviewQueuePlugin from "@synara/plugin-review-queue/server";
import { Deferred, Effect, Fiber, Option } from "effect";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeAgentGatewayBrowserTools } from "./browserTools.ts";
import { BrowserHostRpcError } from "../browserAutomation/browserHostRpcClient.ts";
import { makeAgentGatewaySessionRegistry } from "./Layers/AgentGatewaySessionRegistry.ts";
import type { AgentGatewayCredentialsShape } from "./Services/AgentGatewayCredentials.ts";
import { makeAgentGatewayInFlightRequestRegistry } from "./inFlightRequestRegistry.ts";
import { makeAgentGatewayMcpTransport } from "./mcpTransport.ts";
import { FALLBACK_OBJECT_DESCRIPTION } from "./sanitizeToolInputSchema.ts";
import { countSchemaKeyOccurrences, isJsonRecord } from "./schemaTestUtils.ts";
import { acquireAgentGatewaySessionLease, type AgentGatewaySessionLease } from "./sessionLease.ts";
import type { ToolEntry } from "./toolRuntime.ts";
import { makePluginAgentToolEntries, pluginAgentToolName } from "./pluginTools.ts";

const NOW = "2026-07-22T03:00:00.000Z";

function makeThread(threadId: string): OrchestrationThreadShell {
  return {
    id: ThreadId.makeUnsafe(threadId),
    projectId: ProjectId.makeUnsafe("project-mcp-cancellation"),
    title: threadId,
    modelSelection: { provider: "codex", model: "gpt-5.6-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    envMode: "local",
    branch: null,
    worktreePath: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
    createBranchFlowCompleted: false,
    isPinned: false,
    parentThreadId: null,
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: null,
    forkSourceThreadId: null,
    sidechatSourceThreadId: null,
    lastKnownPr: null,
    latestTurn: {
      turnId: TurnId.makeUnsafe(`turn-${threadId}`),
      state: "running",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: null,
      assistantMessageId: null,
    },
    latestUserMessageAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    handoff: null,
    session: null,
  };
}

function makeTransport(input: {
  readonly tool: ToolEntry;
  readonly extraTools?: ReadonlyArray<ToolEntry>;
  readonly dynamicTools?: () => Effect.Effect<ReadonlyArray<ToolEntry>, Error>;
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
}) {
  const threads = new Map(input.threads.map((thread) => [String(thread.id), thread]));
  let nextSession = 0;
  let nextRandomPartIsSession = true;
  const sessionRegistry = makeAgentGatewaySessionRegistry({
    randomId: () => {
      if (nextRandomPartIsSession) {
        nextSession += 1;
        nextRandomPartIsSession = false;
        return `session-${nextSession}`;
      }
      nextRandomPartIsSession = true;
      return `token-${nextSession}`;
    },
  });
  const inFlightRequests = makeAgentGatewayInFlightRequestRegistry();
  const credentials = {
    verifySession: sessionRegistry.verify,
    bindWriteAuthority: sessionRegistry.bindWriteAuthority,
    verifyWriteAuthority: sessionRegistry.verifyWriteAuthority,
    registerInFlightRequest: inFlightRequests.register,
    cancelInFlightRequests: inFlightRequests.cancel,
    cancelSessionTurnRequests: (token: string, turnId: string) => {
      const session = sessionRegistry.verify(token);
      return session
        ? inFlightRequests.cancelTurn(session.sessionKey, turnId).settled
        : Promise.resolve();
    },
    retireSessionTurn: (token: string, turnId: string) => {
      const session = sessionRegistry.verify(token);
      if (!session) return Promise.resolve();
      sessionRegistry.retireWriteAuthority(token, turnId);
      return inFlightRequests.cancelTurn(session.sessionKey, turnId).settled;
    },
    revokeSessionToken: (token: string) => {
      const session = sessionRegistry.verify(token);
      sessionRegistry.revoke(token);
      if (session) inFlightRequests.revokeSession(session.sessionKey);
    },
    connectionForThread: (threadId: ThreadId) => {
      const issued = sessionRegistry.issue(threadId, "codex");
      return {
        url: "http://127.0.0.1:48123/mcp",
        bearerToken: issued.token,
      };
    },
  } as unknown as AgentGatewayCredentialsShape;
  const tokenAliases = new Map<string, string>();
  const sessionKeyAliases = new Map<string, string>();
  const leases = new Map<string, AgentGatewaySessionLease>();
  const startRuntime = (threadId: string, tokenAlias: string): AgentGatewaySessionLease => {
    const lease = acquireAgentGatewaySessionLease(
      credentials,
      ThreadId.makeUnsafe(threadId),
      "codex",
    );
    if (!lease) throw new Error("Expected gateway session lease");
    tokenAliases.set(tokenAlias, lease.connection.bearerToken);
    const session = sessionRegistry.verify(lease.connection.bearerToken);
    if (!session) throw new Error("Expected registered gateway session");
    sessionKeyAliases.set(`session-${leases.size + 1}`, session.sessionKey);
    leases.set(threadId, lease);
    return lease;
  };
  input.threads.forEach((thread, index) => {
    startRuntime(String(thread.id), `token-${index + 1}`);
  });
  const snapshotQuery = {
    getThreadShellById: (threadId: ThreadId) =>
      Effect.succeed(Option.fromNullishOr(threads.get(String(threadId)))),
  } as unknown as ProjectionSnapshotQueryShape;

  const transport = makeAgentGatewayMcpTransport({
    credentials,
    snapshotQuery,
    tools: [input.tool, ...(input.extraTools ?? [])],
    dynamicTools: input.dynamicTools,
    instructions: "test",
    requireThreadShell: (threadId) => {
      const thread = threads.get(threadId);
      return thread ? Effect.succeed(thread) : Effect.fail(new Error("missing thread"));
    },
  });
  return Object.assign(transport, {
    resolveToken: (token: string) => tokenAliases.get(token) ?? token,
    cancelTurn: (sessionKey: string, turnId: string) =>
      inFlightRequests.cancelTurn(sessionKeyAliases.get(sessionKey) ?? sessionKey, turnId),
    setThreadTurnState: (
      threadId: string,
      state: "running" | "completed" | "error" | "interrupted",
    ) => {
      const thread = threads.get(threadId);
      if (!thread?.latestTurn) return;
      threads.set(threadId, {
        ...thread,
        latestTurn: {
          ...thread.latestTurn,
          state,
          completedAt: state === "running" ? null : NOW,
        },
      });
    },
    completeTurnAndRestartRuntime: async (
      threadId: string,
      completedTurnId: string,
      replacementTokenAlias: string,
    ) => {
      const outgoing = leases.get(threadId);
      if (!outgoing) throw new Error("Expected outgoing gateway session lease");
      await outgoing.retireTurn(completedTurnId);
      outgoing.release();
      startRuntime(threadId, replacementTokenAlias);
    },
    setThreadTurn: (threadId: string, turnId: string) => {
      const thread = threads.get(threadId);
      if (!thread?.latestTurn) return;
      threads.set(threadId, {
        ...thread,
        latestTurn: {
          ...thread.latestTurn,
          turnId: TurnId.makeUnsafe(turnId),
          state: "running",
          completedAt: null,
        },
      });
    },
  });
}

const post = (transport: ReturnType<typeof makeTransport>, token: string, body: unknown) =>
  transport({ authorizationHeader: `Bearer ${transport.resolveToken(token)}`, body });

describe("makeAgentGatewayMcpTransport cancellation", () => {
  it.effect(
    "rejects turn A's credential after production completion and restart admit turn B",
    () =>
      Effect.gen(function* () {
        let handlerCalls = 0;
        const transport = makeTransport({
          threads: [makeThread("thread-rotated")],
          tool: {
            definition: {
              name: "browser_click",
              description: "test",
              inputSchema: { type: "object" },
            },
            requiredCapability: "browser:control",
            requiresActiveTurn: true,
            handler: () => {
              handlerCalls += 1;
              return Effect.succeed({ content: [{ type: "text" as const, text: "ok" }] });
            },
          },
        });
        yield* Effect.promise(() =>
          transport.completeTurnAndRestartRuntime(
            "thread-rotated",
            "turn-thread-rotated",
            "token-b",
          ),
        );
        transport.setThreadTurn("thread-rotated", "turn-b");
        const body = {
          jsonrpc: "2.0",
          id: "browser-click",
          method: "tools/call",
          params: { name: "browser_click", arguments: {} },
        };

        const lateA = yield* post(transport, "token-1", body);
        assert.equal(lateA.status, 401);
        const turnB = yield* post(transport, "token-b", body);
        assert.equal(turnB.status, 200);
        assert.equal(handlerCalls, 1);
      }),
  );

  it.effect(
    "cancels a detached MCP call by gateway session and turn without a client notification",
    () =>
      Effect.gen(function* () {
        const hostStarted = yield* Deferred.make<void>();
        const hostAbortObserved = yield* Deferred.make<void>();
        let hostCalls = 0;
        const browserRun = makeAgentGatewayBrowserTools({
          available: true,
          execute: () => {
            hostCalls += 1;
            return Effect.tryPromise({
              try: (signal) => {
                return new Promise<never>((_resolve, reject) => {
                  signal.addEventListener(
                    "abort",
                    () => {
                      Deferred.doneUnsafe(hostAbortObserved, Effect.void);
                      reject(new Error("browser host request aborted"));
                    },
                    { once: true },
                  );
                  // Wake the Stop path before tryPromise returns, reproducing
                  // the re-entrant window where a direct interrupt would miss
                  // Effect's not-yet-installed AbortController finalizer.
                  Deferred.doneUnsafe(hostStarted, Effect.void);
                });
              },
              catch: (error) => new BrowserHostRpcError("transport", String(error)),
            });
          },
        }).find((tool) => tool.definition.name === "browser_run");
        assert.isDefined(browserRun);
        const transport = makeTransport({
          threads: [makeThread("thread-detached")],
          tool: browserRun!,
        });
        const body = {
          jsonrpc: "2.0",
          id: "detached-browser-wait",
          method: "tools/call",
          params: {
            name: "browser_run",
            arguments: {
              tabId: "53756993-1de8-47a5-82c9-e00766199802",
              code: 'await page.getByText("STOP_SENTINEL_NEVER_APPEARS").waitFor(); return true;',
              timeoutMs: 30_000,
            },
          },
        };

        const request = yield* post(transport, "token-1", body).pipe(Effect.forkChild);
        yield* Deferred.await(hostStarted);

        const cancellation = transport.cancelTurn("session-1", "turn-thread-detached");
        assert.equal(cancellation.count, 1);
        yield* Effect.promise(() => cancellation.settled);
        yield* Deferred.await(hostAbortObserved);
        assert.deepEqual(yield* Fiber.join(request), { status: 202 });

        // A detached cell can race and issue the request after Stop. The turn
        // tombstone must reject it before the handler starts.
        assert.deepEqual(yield* post(transport, "token-1", { ...body, id: "late-request" }), {
          status: 202,
        });
        transport.setThreadTurnState("thread-detached", "interrupted");
        const afterProjectionSettled = yield* post(transport, "token-1", {
          ...body,
          id: "after-turn-terminal",
        });
        assert.equal(afterProjectionSettled.status, 200);
        assert.equal(hostCalls, 1);
      }).pipe(Effect.timeout("2 seconds")),
  );

  it.effect("cleans a completed request before the same JSON-RPC id is reused", () =>
    Effect.gen(function* () {
      const transport = makeTransport({
        threads: [makeThread("thread-reuse")],
        tool: {
          definition: {
            name: "unused",
            description: "unused",
            inputSchema: { type: "object" },
          },
          requiredCapability: "thread:read",
          handler: () => Effect.never,
        },
      });
      const ping = { jsonrpc: "2.0", id: "reusable", method: "ping" };

      for (let iteration = 0; iteration < 25; iteration += 1) {
        const response = yield* post(transport, "token-1", ping);
        assert.deepEqual(response, {
          status: 200,
          body: { jsonrpc: "2.0", id: "reusable", result: {} },
        });
      }
    }).pipe(Effect.timeout("2 seconds")),
  );

  it.effect(
    "interrupts only the matching session request and keeps a following ping responsive",
    () =>
      Effect.gen(function* () {
        const startedOne = yield* Deferred.make<void>();
        const startedTwo = yield* Deferred.make<void>();
        const interruptedOne = yield* Deferred.make<void>();
        const interruptedTwo = yield* Deferred.make<void>();
        const releaseFirstCleanup = yield* Deferred.make<void>();
        const tool: ToolEntry = {
          definition: {
            name: "slow",
            description: "Wait until cancelled",
            inputSchema: { type: "object" },
          },
          requiredCapability: "thread:read",
          handler: (_args, context) => {
            const first = context.callerSessionKey.endsWith(":session-1");
            return Deferred.succeed(first ? startedOne : startedTwo, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(first ? interruptedOne : interruptedTwo, undefined);
                  if (first) yield* Deferred.await(releaseFirstCleanup);
                }),
              ),
            );
          },
        };
        const transport = makeTransport({
          tool,
          threads: [makeThread("thread-one"), makeThread("thread-two")],
        });
        const slowBody = {
          jsonrpc: "2.0",
          id: "shared-id",
          method: "tools/call",
          params: { name: "slow", arguments: {} },
        };
        const requestOne = yield* post(transport, "token-1", slowBody).pipe(Effect.forkChild);
        const requestTwo = yield* post(transport, "token-2", slowBody).pipe(Effect.forkChild);
        yield* Deferred.await(startedOne);
        yield* Deferred.await(startedTwo);

        const cancellation = yield* post(transport, "token-1", {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: "shared-id", reason: "test" },
        });
        assert.deepEqual(cancellation, { status: 202 });
        yield* Deferred.await(interruptedOne);
        assert.isUndefined(yield* Deferred.poll(interruptedTwo));

        const ping = yield* post(transport, "token-1", {
          jsonrpc: "2.0",
          id: "ping-after-cancel",
          method: "ping",
        });
        assert.equal(ping.status, 200);
        assert.deepEqual(ping.body, {
          jsonrpc: "2.0",
          id: "ping-after-cancel",
          result: {},
        });
        assert.isUndefined(requestOne.pollUnsafe());
        yield* Deferred.succeed(releaseFirstCleanup, undefined);

        yield* post(transport, "token-2", {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: "shared-id" },
        });
        yield* Deferred.await(interruptedTwo);
        assert.deepEqual(yield* Fiber.join(requestOne), { status: 202 });
        assert.deepEqual(yield* Fiber.join(requestTwo), { status: 202 });
      }).pipe(Effect.timeout("2 seconds")),
  );

  it.effect(
    "runs batch requests concurrently and applies cancellation without head-of-line blocking",
    () =>
      Effect.gen(function* () {
        const interrupted = yield* Deferred.make<void>();
        const transport = makeTransport({
          threads: [makeThread("thread-batch")],
          tool: {
            definition: {
              name: "slow",
              description: "Wait until cancelled",
              inputSchema: { type: "object" },
            },
            requiredCapability: "thread:read",
            handler: () =>
              Effect.never.pipe(
                Effect.onInterrupt(() =>
                  Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid),
                ),
              ),
          },
        });

        const response = yield* post(transport, "token-1", [
          {
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: "slow-batch" },
          },
          {
            jsonrpc: "2.0",
            id: "slow-batch",
            method: "tools/call",
            params: { name: "slow", arguments: {} },
          },
          { jsonrpc: "2.0", id: "fast-batch", method: "ping" },
        ]);

        yield* Deferred.await(interrupted);
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, [{ jsonrpc: "2.0", id: "fast-batch", result: {} }]);
      }).pipe(Effect.timeout("2 seconds")),
  );
});

const findToolOrThrow = (tools: ReadonlyArray<unknown>, name: string): Record<string, unknown> => {
  const found = tools.find((candidate) => isJsonRecord(candidate) && candidate.name === name);
  if (!isJsonRecord(found)) {
    throw new Error(`Expected tools/list to serve ${name}.`);
  }
  return found;
};

describe("makeAgentGatewayMcpTransport dynamic plugin tools", () => {
  it.effect("loads and invokes the Review Queue plugin tool through a thread credential", () =>
    Effect.gen(function* () {
      const values = new Map<string, JsonValue>();
      const registry = createPluginRegistry({
        host: {} as never,
        storage: {
          get: (key) => Promise.resolve(values.get(key)),
          set: (key, value) => {
            values.set(key, value);
            return Promise.resolve();
          },
          delete: (key) => {
            values.delete(key);
            return Promise.resolve();
          },
          update: async (key, updateValue) => {
            const next = await updateValue(values.get(key));
            if (next === undefined) values.delete(key);
            else values.set(key, next);
            return next;
          },
        },
      });
      const generation = yield* Effect.promise(() =>
        registry.activate(reviewQueueManifest, reviewQueuePlugin),
      );
      const registeredTool = registry.listAgentTools()[0];
      if (!registeredTool) throw new Error("Expected Review Queue to register an agent tool.");
      const toolName = pluginAgentToolName(registeredTool);
      const transport = makeTransport({
        threads: [makeThread("thread-review-queue")],
        tool: {
          definition: {
            name: "built_in",
            description: "built in",
            inputSchema: { type: "object" },
          },
          requiredCapability: "thread:read",
          handler: () => Effect.succeed({ content: [{ type: "text" as const, text: "built in" }] }),
        },
        dynamicTools: () =>
          Effect.succeed(
            makePluginAgentToolEntries(registry.listAgentTools(), (input, _context, signal) =>
              Effect.tryPromise(() => registry.callAgentTool({ ...input, signal })),
            ),
          ),
      });

      const listed = yield* post(transport, "token-1", {
        jsonrpc: "2.0",
        id: "list-review-queue",
        method: "tools/list",
      });
      if (!isJsonRecord(listed.body) || !isJsonRecord(listed.body.result)) {
        throw new Error("Expected Review Queue tools/list result.");
      }
      findToolOrThrow(listed.body.result.tools as ReadonlyArray<unknown>, toolName);

      const invalid = yield* post(transport, "token-1", {
        jsonrpc: "2.0",
        id: "invalid-review",
        method: "tools/call",
        params: { name: toolName, arguments: { title: 42 } },
      });
      if (!isJsonRecord(invalid.body) || !isJsonRecord(invalid.body.result)) {
        throw new Error("Expected invalid Review Queue call result.");
      }
      assert.equal(invalid.body.result.isError, true);
      assert.equal(values.has("items"), false);

      const called = yield* post(transport, "token-1", {
        jsonrpc: "2.0",
        id: "add-review",
        method: "tools/call",
        params: {
          name: toolName,
          arguments: {
            projectId: "project-review",
            title: "Proof review",
            prompt: "Review the plugin tool path.",
          },
        },
      });
      assert.equal(called.status, 200);

      const queue = yield* Effect.promise(() =>
        registry.call({
          pluginId: reviewQueueManifest.id,
          generation,
          method: "list",
          input: {},
        }),
      );
      const parsedQueue = reviewQueueContract.list.output.parse(queue);
      assert.equal(parsedQueue.items.length, 1);
      assert.equal(parsedQueue.items[0]?.title, "Proof review");
      assert.equal(parsedQueue.items[0]?.status, "queued");
    }),
  );

  it.effect("resolves dynamic tools for each list and call request", () =>
    Effect.gen(function* () {
      let dynamicTools: ReadonlyArray<ToolEntry> = [];
      let dynamicLoads = 0;
      let calls = 0;
      const transport = makeTransport({
        threads: [makeThread("thread-dynamic")],
        tool: {
          definition: {
            name: "built_in",
            description: "built in",
            inputSchema: { type: "object" },
          },
          requiredCapability: "thread:read",
          handler: () => Effect.succeed({ content: [{ type: "text" as const, text: "built in" }] }),
        },
        dynamicTools: () => {
          dynamicLoads += 1;
          return Effect.succeed(dynamicTools);
        },
      });

      const first = yield* post(transport, "token-1", {
        jsonrpc: "2.0",
        id: "list-before",
        method: "tools/list",
      });
      if (!isJsonRecord(first.body) || !isJsonRecord(first.body.result)) {
        throw new Error("Expected the first tools/list result.");
      }
      assert.deepEqual(
        (first.body.result.tools as ReadonlyArray<Record<string, unknown>>).map(
          (tool) => tool.name,
        ),
        ["built_in"],
      );

      dynamicTools = [
        {
          definition: {
            name: "plugin_acme_echo",
            description: "dynamic",
            inputSchema: { type: "object" },
          },
          requiredCapability: "thread:write",
          requiresActiveTurn: true,
          handler: () => {
            calls += 1;
            return Effect.succeed({ content: [{ type: "text" as const, text: "dynamic" }] });
          },
        },
      ];

      const second = yield* post(transport, "token-1", {
        jsonrpc: "2.0",
        id: "list-after",
        method: "tools/list",
      });
      if (!isJsonRecord(second.body) || !isJsonRecord(second.body.result)) {
        throw new Error("Expected the second tools/list result.");
      }
      assert.deepEqual(
        (second.body.result.tools as ReadonlyArray<Record<string, unknown>>).map(
          (tool) => tool.name,
        ),
        ["built_in", "plugin_acme_echo"],
      );

      const called = yield* post(transport, "token-1", {
        jsonrpc: "2.0",
        id: "call-dynamic",
        method: "tools/call",
        params: { name: "plugin_acme_echo", arguments: {} },
      });
      assert.equal(called.status, 200);
      assert.equal(calls, 1);

      const builtIn = yield* post(transport, "token-1", {
        jsonrpc: "2.0",
        id: "call-built-in",
        method: "tools/call",
        params: { name: "built_in", arguments: {} },
      });
      assert.equal(builtIn.status, 200);
      assert.equal(dynamicLoads, 3);
    }),
  );

  it.effect("keeps built-in and last-known plugin tools when catalog refresh fails", () =>
    Effect.gen(function* () {
      const pluginTool: ToolEntry = {
        definition: {
          name: "plugin_acme_echo",
          description: "dynamic",
          inputSchema: { type: "object" },
        },
        requiredCapability: "thread:read",
        handler: () => Effect.succeed({ content: [{ type: "text" as const, text: "dynamic" }] }),
      };
      let shouldFail = false;
      const transport = makeTransport({
        threads: [makeThread("thread-dynamic-failure")],
        tool: {
          definition: {
            name: "built_in",
            description: "built in",
            inputSchema: { type: "object" },
          },
          requiredCapability: "thread:read",
          handler: () => Effect.succeed({ content: [{ type: "text" as const, text: "built in" }] }),
        },
        dynamicTools: () =>
          shouldFail ? Effect.fail(new Error("catalog unavailable")) : Effect.succeed([pluginTool]),
      });

      yield* post(transport, "token-1", {
        jsonrpc: "2.0",
        id: "prime-catalog",
        method: "tools/list",
      });
      shouldFail = true;
      const response = yield* post(transport, "token-1", {
        jsonrpc: "2.0",
        id: "failed-refresh",
        method: "tools/list",
      });
      if (!isJsonRecord(response.body) || !isJsonRecord(response.body.result)) {
        throw new Error("Expected cached tools/list result.");
      }
      assert.deepEqual(
        (response.body.result.tools as ReadonlyArray<Record<string, unknown>>).map(
          (tool) => tool.name,
        ),
        ["built_in", "plugin_acme_echo"],
      );
    }),
  );
});

describe("makeAgentGatewayMcpTransport tools/list schema sanitization", () => {
  it.effect("serves sanitized schemas while keeping stored definitions dirty", () =>
    Effect.gen(function* () {
      const recursiveTool: ToolEntry = {
        definition: {
          name: "synara_recursive",
          description: "tool with a cyclic schema",
          inputSchema: {
            type: "object",
            properties: { payload: { $ref: "#/$defs/JsonValue" } },
            $defs: {
              JsonValue: {
                anyOf: [
                  { type: "string" },
                  { type: "array", items: { $ref: "#/$defs/JsonValue" } },
                ],
              },
            },
          },
        },
        requiredCapability: "thread:read",
        handler: () => Effect.succeed({ content: [{ type: "text" as const, text: "ok" }] }),
      };
      const transport = makeTransport({
        threads: [makeThread("thread-schema")],
        tool: recursiveTool,
      });
      const response = yield* post(transport, "token-1", {
        jsonrpc: "2.0",
        id: "list-schemas",
        method: "tools/list",
      });
      assert.equal(response.status, 200);
      if (!isJsonRecord(response.body) || !isJsonRecord(response.body.result)) {
        throw new Error("Expected tools/list to answer with a result object.");
      }
      if (!Array.isArray(response.body.result.tools)) {
        throw new Error("Expected tools/list to answer with a tools array.");
      }
      const listed = findToolOrThrow(response.body.result.tools, "synara_recursive");
      assert.deepEqual(listed.inputSchema, {
        type: "object",
        properties: {
          payload: {
            type: "object",
            description: FALLBACK_OBJECT_DESCRIPTION,
          },
        },
      });
      assert.isAbove(countSchemaKeyOccurrences(recursiveTool.definition.inputSchema, "$ref"), 0);
    }),
  );
});
