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

  it("drains the active generation before replacing it", async () => {
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
    await expect(call).resolves.toEqual({ value: "old" });
    await activation;
    expect(registry.list()[0]?.generation).toBe(2);
  });
});
