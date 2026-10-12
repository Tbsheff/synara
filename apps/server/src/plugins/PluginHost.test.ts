import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS, type OrchestrationCommand } from "@synara/contracts";
import type { createPluginRegistry } from "@synara/plugin-sdk";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerConfig } from "../config";
import { GitCore } from "../git/Services/GitCore";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import * as NodeSqlite from "../persistence/NodeSqliteClient";
import { ServerSettingsService } from "../serverSettings";
import { PluginHostLive, PluginHostService } from "./PluginHost";
import { pluginBuildOutputRoot } from "./build";
import { writePluginControl } from "./control";
import { pluginAssetKey } from "./manifest";
import { runWithPluginInvocationAuthority } from "./invocationAuthority";

const capture = vi.hoisted(() => ({
  options: undefined as Parameters<typeof createPluginRegistry>[0] | undefined,
  changed: undefined as (() => void) | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    watch: (_path: string, _options: unknown, callback: (event: string, file: string) => void) => {
      capture.changed = () => callback("change", "plugins.json");
      return { on: () => undefined, close: () => undefined };
    },
  };
});
vi.mock("@synara/plugin-sdk", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@synara/plugin-sdk")>();
  return {
    ...sdk,
    createPluginRegistry: (options: Parameters<typeof createPluginRegistry>[0]) => {
      capture.options = options;
      return sdk.createPluginRegistry(options);
    },
  };
});

describe("PluginHost", () => {
  const roots: string[] = [];
  const runtimes: Array<ManagedRuntime.ManagedRuntime<PluginHostService, unknown>> = [];
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.dispose();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function makeHost(withApp = false) {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "synara-plugin-host-")));
    roots.push(root);
    const sourceRoot = path.join(root, "plugin");
    const pluginId = "@acme/host-test";
    const publish = (version: string) => {
      const output = pluginBuildOutputRoot(sourceRoot, version);
      mkdirSync(output, { recursive: true });
      writeFileSync(path.join(output, "server.js"), "export default () => {};\n");
      writeFileSync(path.join(output, "app.js"), version);
      writeFileSync(path.join(output, "app.css"), version);
      writePluginControl(root, {
        plugins: { [pluginId]: { enabled: true, reloadToken: version, sourceRoot } },
      });
      capture.changed?.();
    };
    if (withApp) {
      mkdirSync(sourceRoot);
      writeFileSync(
        path.join(sourceRoot, "package.json"),
        JSON.stringify({
          name: pluginId,
          version: "1.0.0",
          type: "module",
          synara: { displayName: "Test", apiVersion: 1, server: "server.js", app: "app.js" },
        }),
      );
      writeFileSync(path.join(sourceRoot, "server.js"), "");
      writeFileSync(path.join(sourceRoot, "app.js"), "");
      publish("first");
    }
    const commands: OrchestrationCommand[] = [];
    let thread: unknown;
    const dispatch = vi.fn((command: OrchestrationCommand) =>
      Effect.sync(() => {
        commands.push(command);
        if (command.type === "thread.create") thread = { ...command, id: command.threadId };
        return { sequence: commands.length } as never;
      }),
    );
    const createWorktree = vi.fn(() =>
      Effect.succeed({
        worktree: { path: "/isolated/worktree", branch: "synara/test-12345678", ref: "abc" },
      }),
    );
    const removeWorktree = vi.fn(() => Effect.void);
    const sqlite = NodeSqlite.layer({ filename: ":memory:" });
    const schema = Layer.effectDiscard(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE plugin_storage (plugin_id TEXT, key TEXT, value_json TEXT, updated_at TEXT, PRIMARY KEY (plugin_id, key))`;
      }),
    ).pipe(Layer.provideMerge(sqlite));
    const config = ServerConfig.layerTest(sourceRoot, root, { homeDir: root }).pipe(
      Layer.provide(NodeServices.layer),
    );
    const dependencies = Layer.mergeAll(
      schema,
      config,
      Layer.succeed(OrchestrationEngineService, { dispatch } as never),
      Layer.succeed(ProjectionSnapshotQuery, {
        getProjectShellById: () =>
          Effect.succeed(
            Option.some({
              id: "project",
              workspaceRoot: root,
              scripts: [],
              defaultModelSelection: null,
            }),
          ),
        getThreadShellById: () => Effect.succeed(thread ? Option.some(thread) : Option.none()),
      } as never),
      Layer.succeed(ServerSettingsService, {
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      } as never),
      Layer.succeed(GitCore, {
        createDetachedWorktree: createWorktree,
        recordWorktreeOwnership: () =>
          Effect.succeed({
            token: "test",
            gitDir: "/isolated/git",
            branch: "synara/test-12345678",
            head: "abc",
          }),
        verifyWorktreeOwnership: () => Effect.succeed({ verified: true, reason: null }),
        removeWorktree,
        withMutation: (_cwd: string, effect: Effect.Effect<unknown>) => effect,
      } as never),
    );
    const runtime = ManagedRuntime.make(PluginHostLive.pipe(Layer.provide(dependencies)));
    runtimes.push(runtime);
    const host = await runtime.runPromise(Effect.service(PluginHostService));
    const options = capture.options!;
    const storage =
      typeof options.storage === "function" ? options.storage(pluginId) : options.storage;
    const api = typeof options.host === "function" ? options.host(pluginId) : options.host;
    return {
      host,
      storage,
      api,
      commands,
      dispatch,
      createWorktree,
      removeWorktree,
      publish,
      sourceRoot,
      pluginId,
      runtime,
    };
  }

  it.each(["set", "delete"] as const)(
    "serializes storage %s behind an update of the same key",
    async (operation) => {
      const { storage } = await makeHost();
      await storage.set("key", "old");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const updating = storage.update("key", async () => {
        entered.resolve();
        await release.promise;
        return "updated";
      });
      await entered.promise;
      const writing = operation === "set" ? storage.set("key", "new") : storage.delete("key");
      await storage.set("other", "independent");
      release.resolve();
      await Promise.all([updating, writing]);
      expect(await storage.get("key")).toBe(operation === "set" ? "new" : undefined);
    },
  );

  it("rejects asset versions from a different generation", async () => {
    const { host, runtime, publish, sourceRoot, pluginId } = await makeHost(true);
    const assetKey = pluginAssetKey(pluginId);
    publish("second");
    await runtime.runPromise(host.list());
    for (const file of ["app.js", "app.css"]) {
      expect(
        await runtime.runPromise(host.resolveAppAsset(assetKey, file, "first")),
      ).toBeUndefined();
      expect(
        await runtime.runPromise(host.resolveAppAsset(assetKey, file, "unknown")),
      ).toBeUndefined();
      expect(await runtime.runPromise(host.resolveAppAsset(assetKey, file, null))).toBeUndefined();
      expect(
        await runtime.runPromise(host.resolveAppAsset(assetKey, file, "second")),
      ).toMatchObject({ path: path.join(pluginBuildOutputRoot(sourceRoot, "second"), file) });
    }
  });

  it("rechecks write authority after a queued storage write acquires its lock", async () => {
    const { storage } = await makeHost();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const updating = storage.update("key", async () => {
      entered.resolve();
      await release.promise;
      return "updated";
    });
    await entered.promise;
    const controller = new AbortController();
    const writing = runWithPluginInvocationAuthority(
      {
        access: "write",
        signal: controller.signal,
        assertWriteAuthorized: () => Promise.resolve(),
        assertThreadStartAuthorized: () => Promise.resolve(),
      },
      () => storage.set("key", "canceled"),
    );
    const rejected = expect(writing).rejects.toThrow();
    controller.abort(new Error("canceled"));
    release.resolve();
    await Promise.all([updating, rejected]);
    expect(await storage.get("key")).toBe("updated");
  });

  it("creates a worktree before queuing the turn and reuses it on retry", async () => {
    const { api, commands, createWorktree } = await makeHost();
    const input = {
      projectId: "project",
      title: "Task",
      prompt: "Run task",
      idempotencyKey: "request",
      createdAt: "2026-10-12T00:00:00.000Z",
      environment: "worktree" as const,
    };
    await api.threads.start(input);
    expect(commands[0]).toMatchObject({
      type: "thread.create",
      envMode: "worktree",
      branch: "synara/test-12345678",
      worktreePath: "/isolated/worktree",
    });
    expect(commands[1]?.type).toBe("thread.turn.start");
    await api.threads.start(input);
    expect(createWorktree).toHaveBeenCalledOnce();
  });

  it("does not create a thread or queue a turn when worktree creation fails", async () => {
    const { api, commands, createWorktree } = await makeHost();
    createWorktree.mockReturnValueOnce(Effect.fail(new Error("worktree failed")) as never);
    await expect(
      api.threads.start({
        projectId: "project",
        title: "Task",
        prompt: "Run task",
        idempotencyKey: "failed",
        createdAt: "2026-10-12T00:00:00.000Z",
        environment: "worktree",
      }),
    ).rejects.toThrow("worktree failed");
    expect(commands).toEqual([]);
  });

  it("removes an owned worktree when thread creation fails", async () => {
    const { api, commands, dispatch, removeWorktree } = await makeHost();
    dispatch.mockReturnValueOnce(Effect.fail(new Error("create failed")) as never);
    await expect(
      api.threads.start({
        projectId: "project",
        title: "Task",
        prompt: "Run task",
        idempotencyKey: "dispatch-failed",
        createdAt: "2026-10-12T00:00:00.000Z",
        environment: "worktree",
      }),
    ).rejects.toThrow("create failed");
    expect(removeWorktree).toHaveBeenCalledWith({
      cwd: expect.any(String),
      path: "/isolated/worktree",
      force: true,
      reclaimTemporaryBranch: true,
    });
    expect(commands).toEqual([]);
  });

  it("keeps cancellation authority while a thread start waits for its lock", async () => {
    const { api, commands, createWorktree } = await makeHost();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    createWorktree.mockImplementationOnce(() =>
      Effect.promise(async () => {
        entered.resolve();
        await release.promise;
        return {
          worktree: { path: "/isolated/worktree", branch: "synara/test-12345678", ref: "abc" },
        };
      }),
    );
    const input = {
      projectId: "project",
      title: "Task",
      prompt: "Run task",
      idempotencyKey: "queued",
      createdAt: "2026-10-12T00:00:00.000Z",
      environment: "worktree" as const,
    };
    const starting = api.threads.start(input);
    await entered.promise;
    const checked = Promise.withResolvers<void>();
    const controller = new AbortController();
    const queued = runWithPluginInvocationAuthority(
      {
        access: "write",
        signal: controller.signal,
        assertWriteAuthorized: () => Promise.resolve(),
        assertThreadStartAuthorized: () => {
          checked.resolve();
          return Promise.resolve();
        },
      },
      () => api.threads.start(input),
    );
    const rejected = expect(queued).rejects.toThrow();
    void rejected.catch(() => undefined);
    await checked.promise;
    await Promise.resolve();
    await Promise.resolve();
    controller.abort(new Error("canceled"));
    release.resolve();
    await Promise.all([starting, rejected]);
    expect(commands.map(({ type }) => type)).toEqual(["thread.create", "thread.turn.start"]);
  });
});
