import { describe, expect, it } from "vitest";

import { createPluginRegistry, type JsonValue } from "@synara/plugin-sdk";

import { puckManifest } from "./manifest";
import puckPlugin from "./server";

describe("puck plugin", () => {
  it("starts an orb as a worktree thread and lists orbs separately from local threads", async () => {
    const data = new Map<string, JsonValue>();
    const starts: unknown[] = [];
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
        update: async (key, updateValue) => {
          const next = await updateValue(data.get(key));
          if (next === undefined) data.delete(key);
          else data.set(key, next);
          return next;
        },
      },
      host: {
        threads: {
          start: (input) => {
            starts.push(input);
            return Promise.resolve({ threadId: "thread-orb" });
          },
          list: () =>
            Promise.resolve({
              threads: [
                {
                  threadId: "thread-local",
                  title: "Local checkout",
                  envMode: "local",
                  status: "idle",
                  createdAt: "2026-09-17T00:00:00.000Z",
                },
                {
                  threadId: "thread-orb",
                  title: "Fix flaky test",
                  envMode: "worktree",
                  status: "running",
                  createdAt: "2026-09-17T00:00:01.000Z",
                },
              ],
            }),
        },
      },
    });
    const generation = await registry.activate(puckManifest, puckPlugin);
    expect(registry.listAgentTools().map(({ id }) => id)).toEqual([
      "list-threads",
      "list-orbs",
      "start-orb",
    ]);

    const started = (await registry.call({
      pluginId: puckManifest.id,
      generation,
      method: "start-orb",
      input: {
        projectId: "project-1",
        title: "Fix flaky test",
        prompt: "Fix the flaky test in isolation.",
        parentThreadId: "thread-parent",
      },
    })) as { thread: { threadId: string; envMode: string } };
    expect(started.thread).toMatchObject({ threadId: "thread-orb", envMode: "worktree" });
    expect(starts).toEqual([
      {
        projectId: "project-1",
        title: "Fix flaky test",
        prompt: "Fix the flaky test in isolation.",
        idempotencyKey: expect.any(String),
        createdAt: expect.any(String),
        environment: "worktree",
        parentThreadId: "thread-parent",
      },
    ]);

    expect(
      await registry.callAgentTool({
        pluginId: puckManifest.id,
        generation,
        toolId: "list-orbs",
        input: { projectId: "project-1" },
      }),
    ).toMatchObject({
      threads: [{ threadId: "thread-orb", envMode: "worktree" }],
    });
    expect(
      await registry.callAgentTool({
        pluginId: puckManifest.id,
        generation,
        toolId: "list-threads",
        input: { projectId: "project-1" },
      }),
    ).toMatchObject({
      threads: [{ threadId: "thread-local" }, { threadId: "thread-orb" }],
    });
  });
});
