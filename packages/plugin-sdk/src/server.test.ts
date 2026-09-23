import { describe, expect, it } from "vitest";

import { createPluginRegistry, definePlugin, object, string } from "./index";

const echo = {
  input: object({ value: string() }),
  output: object({ value: string() }),
};

describe("plugin registry", () => {
  it("validates calls and namespaces methods by plugin generation", async () => {
    const registry = createPluginRegistry({ host: {} as never, storage: {} as never });
    await registry.activate(
      { id: "acme.echo", displayName: "Echo", apiVersion: 1, version: "1.0.0" },
      definePlugin((plugin) => {
        plugin.rpc.register("echo", echo, ({ value }) => Promise.resolve({ value }));
      }),
    );

    await expect(
      registry.call({ pluginId: "acme.echo", generation: 1, method: "echo", input: { value: 4 } }),
    ).rejects.toThrow("value");
    await expect(
      registry.call({
        pluginId: "acme.echo",
        generation: 1,
        method: "echo",
        input: { value: "ok" },
      }),
    ).resolves.toEqual({ value: "ok" });
  });

  it("rejects duplicate methods and stale generations", async () => {
    const registry = createPluginRegistry({ host: {} as never, storage: {} as never });
    const plugin = definePlugin((api) => {
      api.rpc.register("echo", echo, ({ value }) => Promise.resolve({ value }));
    });
    await registry.activate(
      { id: "acme.echo", displayName: "Echo", apiVersion: 1, version: "1.0.0" },
      plugin,
    );
    await expect(
      registry.activate(
        { id: "acme.echo", displayName: "Echo", apiVersion: 1, version: "1.0.1" },
        definePlugin((api) => {
          api.rpc.register("echo", echo, ({ value }) => Promise.resolve({ value }));
          api.rpc.register("echo", echo, ({ value }) => Promise.resolve({ value }));
        }),
      ),
    ).rejects.toThrow("Duplicate");
    await expect(
      registry.call({
        pluginId: "acme.echo",
        generation: 1,
        method: "echo",
        input: { value: "still active" },
      }),
    ).resolves.toEqual({ value: "still active" });

    await registry.activate(
      { id: "acme.echo", displayName: "Echo", apiVersion: 1, version: "1.0.1" },
      plugin,
    );
    await expect(
      registry.call({
        pluginId: "acme.echo",
        generation: 1,
        method: "echo",
        input: { value: "old" },
      }),
    ).rejects.toThrow("generation");
  });

  it("cancels and drains the active generation before replacing it", async () => {
    const registry = createPluginRegistry({ host: {} as never, storage: {} as never });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await registry.activate(
      { id: "acme.echo", displayName: "Echo", apiVersion: 1, version: "1.0.0" },
      definePlugin((api) => {
        api.rpc.register("echo", echo, async ({ value }) => {
          await pending;
          return { value };
        });
      }),
    );
    const call = registry.call({
      pluginId: "acme.echo",
      generation: 1,
      method: "echo",
      input: { value: "old" },
    });
    await Promise.resolve();
    let activated = false;
    const activation = registry
      .activate(
        { id: "acme.echo", displayName: "Echo", apiVersion: 1, version: "1.0.1" },
        definePlugin((api) => {
          api.rpc.register("echo", echo, ({ value }) => Promise.resolve({ value }));
        }),
      )
      .then(() => {
        activated = true;
      });
    await Promise.resolve();
    expect(activated).toBe(false);
    await expect(
      registry.call({
        pluginId: "acme.echo",
        generation: 1,
        method: "echo",
        input: { value: "late" },
      }),
    ).rejects.toThrow("generation");
    release();
    await expect(call).rejects.toThrow("retired");
    await activation;
    expect(registry.list()[0]?.generation).toBe(2);
  });

  it("registers, validates, and retires agent tools with their plugin generation", async () => {
    const registry = createPluginRegistry({ host: {} as never, storage: {} as never });
    await registry.activate(
      { id: "acme.echo", displayName: "Echo", apiVersion: 2, version: "1.0.0" },
      definePlugin((api) => {
        api.agents.registerTool({
          id: "echo",
          description: "Echo a value.",
          access: "write",
          contract: echo,
          execute: ({ value }) => Promise.resolve({ value }),
        });
      }),
    );

    expect(registry.listAgentTools()).toMatchObject([
      {
        pluginId: "acme.echo",
        generation: 1,
        id: "echo",
        description: "Echo a value.",
        access: "write",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
    ]);
    await expect(
      registry.callAgentTool({
        pluginId: "acme.echo",
        generation: 1,
        toolId: "echo",
        input: { value: 4 },
      }),
    ).rejects.toThrow("value");
    await expect(
      registry.callAgentTool({
        pluginId: "acme.echo",
        generation: 1,
        toolId: "echo",
        input: { value: "ok" },
      }),
    ).resolves.toEqual({ value: "ok" });

    await registry.activate(
      { id: "acme.echo", displayName: "Echo", apiVersion: 1, version: "1.0.1" },
      definePlugin(() => undefined),
    );
    await expect(
      registry.callAgentTool({
        pluginId: "acme.echo",
        generation: 1,
        toolId: "echo",
        input: { value: "old" },
      }),
    ).rejects.toThrow("generation");
    expect(registry.listAgentTools()).toEqual([]);
  });

  it("requires API version 2 for agent tools", async () => {
    const registry = createPluginRegistry({ host: {} as never, storage: {} as never });
    await expect(
      registry.activate(
        { id: "acme.echo", displayName: "Echo", apiVersion: 1, version: "1.0.0" },
        definePlugin((api) => {
          api.agents.registerTool({
            id: "echo",
            description: "Echo a value.",
            access: "read",
            contract: echo,
            execute: ({ value }) => Promise.resolve({ value }),
          });
        }),
      ),
    ).rejects.toThrow("API version 2");
  });

  it("rejects a tool schema that cannot be serialized", async () => {
    const registry = createPluginRegistry({ host: {} as never, storage: {} as never });
    const jsonSchema: Record<string, unknown> = { type: "object" };
    jsonSchema.self = jsonSchema;
    await expect(
      registry.activate(
        { id: "acme.echo", displayName: "Echo", apiVersion: 2, version: "1.0.0" },
        definePlugin((api) => {
          api.agents.registerTool({
            id: "echo",
            description: "Echo a value.",
            access: "read",
            contract: {
              input: { ...echo.input, jsonSchema: jsonSchema as never },
              output: echo.output,
            },
            execute: ({ value }) => Promise.resolve({ value }),
          });
        }),
      ),
    ).rejects.toThrow("input schema is invalid");
  });

  it("passes cancellation to an active plugin tool", async () => {
    const registry = createPluginRegistry({ host: {} as never, storage: {} as never });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await registry.activate(
      { id: "acme.echo", displayName: "Echo", apiVersion: 2, version: "1.0.0" },
      definePlugin((api) => {
        api.agents.registerTool({
          id: "echo",
          description: "Echo a value.",
          access: "read",
          contract: echo,
          execute: async ({ value }, call) => {
            await pending;
            call.signal.throwIfAborted();
            return { value };
          },
        });
      }),
    );
    const controller = new AbortController();
    const call = registry.callAgentTool({
      pluginId: "acme.echo",
      generation: 1,
      toolId: "echo",
      input: { value: "old" },
      signal: controller.signal,
    });
    controller.abort();
    release();
    await expect(call).rejects.toThrow();
  });

  it("bounds generation drain when a handler never settles", async () => {
    const registry = createPluginRegistry({
      host: {} as never,
      storage: {} as never,
      drainTimeoutMs: 10,
    });
    await registry.activate(
      { id: "acme.echo", displayName: "Echo", apiVersion: 1, version: "1.0.0" },
      definePlugin((api) => {
        api.rpc.register("echo", echo, () => new Promise(() => undefined));
      }),
    );
    void registry.call({
      pluginId: "acme.echo",
      generation: 1,
      method: "echo",
      input: { value: "never" },
    });
    await Promise.resolve();
    await registry.activate(
      { id: "acme.echo", displayName: "Echo", apiVersion: 1, version: "1.0.1" },
      definePlugin((api) => {
        api.rpc.register("echo", echo, ({ value }) => Promise.resolve({ value }));
      }),
    );
    expect(registry.list()[0]?.generation).toBe(2);
  });

  it("blocks storage writes from a retired generation after the drain timeout", async () => {
    const values = new Map<string, unknown>();
    const registry = createPluginRegistry({
      host: {
        threads: {
          start: () => Promise.resolve({ threadId: "thread" }),
          list: () => Promise.resolve({ threads: [] }),
        },
      },
      storage: {
        get: (key) => Promise.resolve(values.get(key) as never),
        set: (key, value) => {
          values.set(key, value);
          return Promise.resolve();
        },
        delete: (key) => {
          values.delete(key);
          return Promise.resolve();
        },
        update: async (key, updateValue) => {
          const next = await updateValue(values.get(key) as never);
          if (next === undefined) values.delete(key);
          else values.set(key, next);
          return next;
        },
      },
      drainTimeoutMs: 5,
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await registry.activate(
      { id: "acme.echo", displayName: "Echo", apiVersion: 1, version: "1.0.0" },
      definePlugin((api) => {
        api.rpc.register("echo", echo, async ({ value }) => {
          await pending;
          await api.storage.set("late", value);
          return { value };
        });
      }),
    );
    const call = registry.call({
      pluginId: "acme.echo",
      generation: 1,
      method: "echo",
      input: { value: "old" },
    });
    await Promise.resolve();
    await registry.activate(
      { id: "acme.echo", displayName: "Echo", apiVersion: 1, version: "1.0.1" },
      definePlugin(() => undefined),
    );
    release();
    await expect(call).rejects.toThrow("retired");
    expect(values.has("late")).toBe(false);
  });

  it("rejects object fields that are not declared by the schema", () => {
    expect(() => echo.input.parse({ value: "ok", extra: true })).toThrow("extra is not allowed");
  });

  it("forwards worktree thread starts and project thread lists through the host", async () => {
    const starts: unknown[] = [];
    const lists: unknown[] = [];
    const start = {
      input: object({ projectId: string() }),
      output: object({ threadId: string() }),
    };
    const list = {
      input: object({ projectId: string() }),
      output: object({ count: string() }),
    };
    const registry = createPluginRegistry({
      storage: {} as never,
      host: {
        threads: {
          start: (input) => {
            starts.push(input);
            return Promise.resolve({ threadId: "orb-1" });
          },
          list: (input) => {
            lists.push(input);
            return Promise.resolve({
              threads: [
                {
                  threadId: "orb-1",
                  title: "Fix flaky test",
                  envMode: "worktree",
                  status: "running",
                  createdAt: "2026-09-17T00:00:00.000Z",
                },
              ],
            });
          },
        },
      },
    });
    await registry.activate(
      { id: "acme.orbs", displayName: "Orbs", apiVersion: 2, version: "1.0.0" },
      definePlugin((api) => {
        api.rpc.register("start", start, async ({ projectId }, call) =>
          call.host.threads.start({
            projectId,
            title: "Fix flaky test",
            prompt: "Fix the flaky test.",
            idempotencyKey: "orb-1",
            createdAt: "2026-09-17T00:00:00.000Z",
            environment: "worktree",
            parentThreadId: "thread-parent",
          }),
        );
        api.rpc.register("list", list, async ({ projectId }, call) => {
          const result = await call.host.threads.list({ projectId });
          return { count: String(result.threads.length) };
        });
      }),
    );

    await expect(
      registry.call({
        pluginId: "acme.orbs",
        generation: 1,
        method: "start",
        input: { projectId: "project-1" },
      }),
    ).resolves.toEqual({ threadId: "orb-1" });
    await expect(
      registry.call({
        pluginId: "acme.orbs",
        generation: 1,
        method: "list",
        input: { projectId: "project-1" },
      }),
    ).resolves.toEqual({ count: "1" });
    expect(starts).toEqual([
      {
        projectId: "project-1",
        title: "Fix flaky test",
        prompt: "Fix the flaky test.",
        idempotencyKey: "orb-1",
        createdAt: "2026-09-17T00:00:00.000Z",
        environment: "worktree",
        parentThreadId: "thread-parent",
      },
    ]);
    expect(lists).toEqual([{ projectId: "project-1" }]);
  });
});
