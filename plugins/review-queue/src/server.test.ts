import { describe, expect, it } from "vitest";

import { createPluginRegistry, type JsonValue } from "@synara/plugin-sdk";

import { reviewQueueManifest } from "./manifest";
import reviewQueuePlugin from "./server";

describe("review queue plugin", () => {
  it("stores work and starts one normal Synara thread on retry", async () => {
    const data = new Map<string, JsonValue>();
    const starts: unknown[] = [];
    let pendingUpdate = Promise.resolve();
    const update = (
      key: string,
      updateValue: (
        current: JsonValue | undefined,
      ) => JsonValue | undefined | Promise<JsonValue | undefined>,
    ) => {
      let result: JsonValue | undefined;
      const operation = pendingUpdate.then(async () => {
        result = await updateValue(data.get(key));
        if (result === undefined) data.delete(key);
        else data.set(key, result);
      });
      pendingUpdate = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation.then(() => result);
    };
    const registry = createPluginRegistry({
      storage: {
        get: (key) => Promise.resolve(data.get(key)),
        set: (key, value) => {
          data.set(key, value);
          return Promise.resolve();
        },
        delete: (key) => {
          data.delete(key);
          return Promise.resolve();
        },
        update,
      },
      host: {
        threads: {
          start: (input) => {
            starts.push(input);
            return Promise.resolve({ threadId: "thread-review" });
          },
          list: () => Promise.resolve({ threads: [] }),
        },
      },
    });
    const generation = await registry.activate(reviewQueueManifest, reviewQueuePlugin);
    expect(registry.listAgentTools().map(({ id }) => id)).toEqual([
      "list-reviews",
      "add-review",
      "start-review",
      "remove-review",
    ]);
    const added = (await registry.call({
      pluginId: reviewQueueManifest.id,
      generation,
      method: "add",
      input: { projectId: "project-1", title: "Review PR", prompt: "Review this branch." },
    })) as { item: { id: string } };

    const call = () =>
      registry.call({
        pluginId: reviewQueueManifest.id,
        generation,
        method: "start",
        input: { itemId: added.item.id },
      });
    await Promise.all([call(), call()]);

    expect(starts).toHaveLength(1);
    expect(
      await registry.callAgentTool({
        pluginId: reviewQueueManifest.id,
        generation,
        toolId: "list-reviews",
        input: {},
      }),
    ).toMatchObject({ items: [{ id: added.item.id, status: "started" }] });
    await registry.callAgentTool({
      pluginId: reviewQueueManifest.id,
      generation,
      toolId: "remove-review",
      input: { itemId: added.item.id },
    });
    expect(
      await registry.callAgentTool({
        pluginId: reviewQueueManifest.id,
        generation,
        toolId: "list-reviews",
        input: {},
      }),
    ).toEqual({ items: [] });
  });
});
