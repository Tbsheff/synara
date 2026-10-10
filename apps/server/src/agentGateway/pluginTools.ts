import type {
  JsonValue,
  PluginAgentToolAccess,
  PluginRegistry,
  RegisteredPluginAgentTool,
} from "@synara/plugin-sdk";
import { Effect } from "effect";

import { pluginAssetKey } from "../plugins/manifest.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  type ToolContext,
  type ToolEntry,
} from "./toolRuntime.ts";

export type PluginAgentToolCallInput = Pick<
  Parameters<PluginRegistry["callAgentTool"]>[0],
  "pluginId" | "generation" | "toolId" | "input"
>;

const TOOL_ACCESS_POLICY = {
  read: {
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    requiredCapability: "thread:read",
    requiresActiveTurn: false,
  },
  write: {
    annotations: WRITE_TOOL_ANNOTATIONS,
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
  },
} as const satisfies Record<
  PluginAgentToolAccess,
  {
    readonly annotations: typeof READ_ONLY_TOOL_ANNOTATIONS | typeof WRITE_TOOL_ANNOTATIONS;
    readonly requiredCapability: "thread:read" | "thread:write";
    readonly requiresActiveTurn: boolean;
  }
>;

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36);
}

export function pluginAgentToolName(tool: RegisteredPluginAgentTool): string {
  const pluginHash = pluginAssetKey(tool.pluginId).slice(0, 8);
  const toolHash = pluginAssetKey(`${tool.pluginId}\0${tool.id}`).slice(0, 8);
  return `plugin_${slug(tool.pluginId)}_${pluginHash}_${slug(tool.id)}_${toolHash}`;
}

export function makePluginAgentToolEntries(
  tools: ReadonlyArray<RegisteredPluginAgentTool>,
  call: (
    input: PluginAgentToolCallInput,
    context: ToolContext,
    signal: AbortSignal,
  ) => Effect.Effect<JsonValue, Error>,
): ReadonlyArray<ToolEntry> {
  return tools.map((tool) => {
    const policy = TOOL_ACCESS_POLICY[tool.access];
    const name = pluginAgentToolName(tool);
    return {
      definition: {
        name,
        description: tool.description,
        inputSchema: { ...tool.inputSchema },
        annotations: {
          title: tool.title ?? tool.description,
          ...policy.annotations,
        },
      },
      requiredCapability: policy.requiredCapability,
      requiresActiveTurn: policy.requiresActiveTurn,
      handler: (args, context) =>
        Effect.tryPromise({
          try: (signal) =>
            Effect.runPromise(
              call(
                {
                  pluginId: tool.pluginId,
                  generation: tool.generation,
                  toolId: tool.id,
                  input: args,
                },
                context,
                signal,
              ),
            ),
          catch: (cause) =>
            cause instanceof Error ? cause : new Error("Plugin agent tool failed", { cause }),
        }).pipe(
          Effect.match({
            onFailure: () => mcpToolResultError(`Plugin tool failed: ${name}.`),
            onSuccess: mcpToolResultJson,
          }),
        ),
    };
  });
}
