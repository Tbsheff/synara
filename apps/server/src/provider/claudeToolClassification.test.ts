import { describe, expect, it } from "vitest";

import {
  CLAUDE_SDK_TOOL_TABLE,
  classifyClaudeTool,
  classifyClaudeToolItemType,
  claudeToolProgressItemType,
  splitClaudeMcpToolName,
} from "./claudeToolClassification.ts";

describe("classifyClaudeTool", () => {
  it.each([
    ["Agent", "collab_agent_tool_call"],
    ["Task", "collab_agent_tool_call"],
    ["Bash", "command_execution"],
    ["Edit", "file_change"],
    ["Write", "file_change"],
    ["MultiEdit", "file_change"],
    ["NotebookEdit", "file_change"],
    ["WebSearch", "web_search"],
    ["TodoWrite", "plan"],
    ["TaskCreate", "plan"],
    ["TaskUpdate", "plan"],
    ["TaskGet", "plan"],
    ["TaskList", "plan"],
    ["Read", "dynamic_tool_call"],
    ["Glob", "dynamic_tool_call"],
    ["Grep", "dynamic_tool_call"],
    ["WebFetch", "dynamic_tool_call"],
    ["ListMcpResourcesTool", "mcp_tool_call"],
    ["ReadMcpResourceTool", "mcp_tool_call"],
    ["ReadMcpResourceDirTool", "mcp_tool_call"],
    ["RefreshMcpTools", "mcp_tool_call"],
  ])("maps %s to %s", (name, itemType) => {
    expect(classifyClaudeToolItemType(name)).toBe(itemType);
  });

  it.each([
    ["ListAgents", "dynamic_tool_call"],
    ["CronCreate", "dynamic_tool_call"],
    ["CronDelete", "dynamic_tool_call"],
    ["SlashCommand", "dynamic_tool_call"],
    ["Monitor", "dynamic_tool_call"],
    ["EnterWorktree", "dynamic_tool_call"],
    ["ExitWorktree", "dynamic_tool_call"],
  ])("fixes the observed substring misclassification of %s", (name, itemType) => {
    expect(classifyClaudeToolItemType(name)).toBe(itemType);
  });

  it.each([
    ["PowerShell", "command"],
    ["BashOutput", "shell-output"],
    ["KillShell", "shell-stop"],
  ])("types the %s shell tool as a command execution like Bash", (name, labelKey) => {
    expect(classifyClaudeTool({ name })).toEqual({ itemType: "command_execution", labelKey });
    expect(classifyClaudeToolItemType(name)).toBe(classifyClaudeToolItemType("Bash"));
  });

  it("classifies every table entry by exact name only", () => {
    for (const [name, expected] of CLAUDE_SDK_TOOL_TABLE) {
      expect(classifyClaudeTool({ name }).itemType).toBe(expected.itemType);
      expect(classifyClaudeTool({ name: name.toLowerCase() }).itemType).toBe(
        name.toLowerCase() === name ? expected.itemType : "dynamic_tool_call",
      );
    }
  });

  it("routes mcp__ names to mcp_tool_call with the server and tool split", () => {
    expect(classifyClaudeTool({ name: "mcp__github__create_issue" })).toEqual({
      itemType: "mcp_tool_call",
      labelKey: "mcp-tool",
      mcpServer: "github",
      mcpTool: "create_issue",
    });
    expect(
      classifyClaudeTool({ name: "mcp__plugin_context-mode_context-mode__ctx_execute_file" }),
    ).toMatchObject({
      itemType: "mcp_tool_call",
      mcpServer: "plugin_context-mode_context-mode",
      mcpTool: "ctx_execute_file",
    });
  });

  it("classifies unknown names as dynamic tool calls", () => {
    expect(classifyClaudeTool({ name: "FileEditorAgentShell" })).toEqual({
      itemType: "dynamic_tool_call",
      labelKey: "generic",
    });
  });

  it("types server tool blocks from the block-type table", () => {
    expect(classifyClaudeTool({ blockType: "server_tool_use", name: "advisor" })).toEqual({
      itemType: "dynamic_tool_call",
      labelKey: "advisor",
      serverToolKind: "advisor",
    });
    expect(classifyClaudeTool({ blockType: "server_tool_use", name: "web_search" }).itemType).toBe(
      "web_search",
    );
    expect(
      classifyClaudeTool({ blockType: "server_tool_use", name: "bash_code_execution" }),
    ).toMatchObject({ itemType: "command_execution", serverToolKind: "bash_code_execution" });
    expect(
      classifyClaudeTool({ blockType: "server_tool_use", name: "text_editor_code_execution" })
        .itemType,
    ).toBe("dynamic_tool_call");
    expect(
      classifyClaudeTool({ blockType: "server_tool_use", name: "tool_search_tool_bm25" })
        .serverToolKind,
    ).toBe("tool_search");
    expect(classifyClaudeTool({ blockType: "server_tool_use", name: "future_tool" })).toEqual({
      itemType: "dynamic_tool_call",
      labelKey: "generic",
      serverToolKind: "other",
    });
  });

  it("types mcp_tool_use blocks from the block type and server_name", () => {
    expect(
      classifyClaudeTool({ blockType: "mcp_tool_use", name: "create_file", serverName: "drive" }),
    ).toEqual({
      itemType: "mcp_tool_call",
      labelKey: "mcp-tool",
      serverToolKind: "mcp",
      mcpServer: "drive",
      mcpTool: "create_file",
    });
  });
});

describe("splitClaudeMcpToolName", () => {
  it("rejects names without a server and tool", () => {
    expect(splitClaudeMcpToolName("mcp__")).toBeUndefined();
    expect(splitClaudeMcpToolName("mcp__server")).toBeUndefined();
    expect(splitClaudeMcpToolName("mcp__server__")).toBeUndefined();
    expect(splitClaudeMcpToolName("Bash")).toBeUndefined();
  });
});

describe("claudeToolProgressItemType", () => {
  it("keeps lifecycle item types and drops plan", () => {
    expect(claudeToolProgressItemType("command_execution")).toBe("command_execution");
    expect(claudeToolProgressItemType("collab_agent_tool_call")).toBe("collab_agent_tool_call");
    expect(claudeToolProgressItemType("plan")).toBeUndefined();
    expect(claudeToolProgressItemType(undefined)).toBeUndefined();
  });
});
