import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import type { ToolContext } from "./toolRuntime";
import { makePluginAgentToolEntries, pluginAgentToolName } from "./pluginTools";

const tool = {
  pluginId: "@synara/plugin-review-queue",
  generation: 3,
  id: "add-review",
  title: "Add review",
  description: "Add an item to the review queue.",
  inputSchema: { type: "object" },
  access: "write" as const,
};

describe("plugin agent tools", () => {
  it("creates a stable namespaced MCP name", () => {
    expect(pluginAgentToolName(tool)).toMatch(
      /^plugin_synara_plugin_review_queue_84e9a0b4_add_review_[a-f0-9]{8}$/,
    );
  });

  it("does not collide after normalization or truncation", () => {
    expect(pluginAgentToolName({ ...tool, id: "a-b" })).not.toBe(
      pluginAgentToolName({ ...tool, id: "a_b" }),
    );
    expect(pluginAgentToolName({ ...tool, id: `same-${"a".repeat(58)}` })).not.toBe(
      pluginAgentToolName({ ...tool, id: `same-${"a".repeat(57)}b` }),
    );
  });

  it("keeps generation, context, and cancellation authority in the tool handler", async () => {
    const calls: unknown[] = [];
    const context = {} as ToolContext;
    const [entry] = makePluginAgentToolEntries([tool], (input, receivedContext, signal) => {
      calls.push({ input, receivedContext, aborted: signal.aborted });
      return Effect.succeed({ itemId: "review-1" });
    });
    expect(entry?.requiredCapability).toBe("thread:write");
    expect(entry?.requiresActiveTurn).toBe(true);

    const result = await Effect.runPromise(entry!.handler({ title: "Check it" }, context));
    expect(calls).toEqual([
      {
        input: {
          pluginId: tool.pluginId,
          generation: 3,
          toolId: "add-review",
          input: { title: "Check it" },
        },
        receivedContext: context,
        aborted: false,
      },
    ]);
    expect(result.content[0]).toEqual({
      type: "text",
      text: JSON.stringify({ itemId: "review-1" }, null, 2),
    });
  });

  it("does not expose plugin error details", async () => {
    const [entry] = makePluginAgentToolEntries([tool], () =>
      Effect.fail(new Error("private path: /Users/example/secret")),
    );
    const result = await Effect.runPromise(entry!.handler({}, {} as ToolContext));
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({
      type: "text",
      text: `Plugin tool failed: ${pluginAgentToolName(tool)}.`,
    });
  });
});
