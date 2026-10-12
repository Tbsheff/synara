import type { CanonicalItemType, ServerToolKind, ToolLifecycleItemType } from "@synara/contracts";
import { isToolLifecycleItemType } from "@synara/contracts";

export type ClaudeToolItemType = Extract<CanonicalItemType, ToolLifecycleItemType | "plan">;

export type ClaudeToolLabelKey =
  | "subagent"
  | "list-agents"
  | "command"
  | "task-output"
  | "task-stop"
  | "plan-exit"
  | "plan-enter"
  | "file-edit"
  | "file-write"
  | "file-multi-edit"
  | "notebook-edit"
  | "file-read"
  | "file-glob"
  | "file-grep"
  | "web-fetch"
  | "web-search"
  | "todo"
  | "task-list"
  | "user-question"
  | "mcp-resources"
  | "mcp-resource-read"
  | "mcp-refresh"
  | "mcp-tool"
  | "workflow"
  | "monitor"
  | "cron-create"
  | "cron-delete"
  | "cron-list"
  | "schedule-wakeup"
  | "remote-trigger"
  | "push-notification"
  | "repl"
  | "artifact"
  | "projects"
  | "design"
  | "feedback"
  | "findings"
  | "propose-skills"
  | "propose-goal"
  | "notifications"
  | "onboarding"
  | "worktree-enter"
  | "worktree-exit"
  | "skill"
  | "tool-search"
  | "send-message"
  | "lsp"
  | "shell-stop"
  | "shell-output"
  | "slash-command"
  | "advisor"
  | "code-execution"
  | "text-editor"
  | "container-upload"
  | "generic";

export interface ClaudeToolClassification {
  readonly itemType: ClaudeToolItemType;
  readonly labelKey: ClaudeToolLabelKey;
  readonly mcpServer?: string;
  readonly mcpTool?: string;
  readonly serverToolKind?: ServerToolKind;
}

export interface ClaudeToolBlockIdentity {
  readonly blockType?: string | undefined;
  readonly name: string;
  readonly serverName?: string | undefined;
}

interface ClaudeToolTableEntry {
  readonly itemType: ClaudeToolItemType;
  readonly labelKey: ClaudeToolLabelKey;
}

const entry = (
  itemType: ClaudeToolItemType,
  labelKey: ClaudeToolLabelKey,
): ClaudeToolTableEntry => ({
  itemType,
  labelKey,
});

export const CLAUDE_SDK_TOOL_TABLE: ReadonlyMap<string, ClaudeToolTableEntry> = new Map([
  ["Agent", entry("collab_agent_tool_call", "subagent")],
  ["Task", entry("collab_agent_tool_call", "subagent")],
  ["ListAgents", entry("dynamic_tool_call", "list-agents")],
  ["Bash", entry("command_execution", "command")],
  ["PowerShell", entry("command_execution", "command")],
  ["TaskOutput", entry("dynamic_tool_call", "task-output")],
  ["TaskStop", entry("dynamic_tool_call", "task-stop")],
  ["ExitPlanMode", entry("dynamic_tool_call", "plan-exit")],
  ["EnterPlanMode", entry("dynamic_tool_call", "plan-enter")],
  ["Edit", entry("file_change", "file-edit")],
  ["Write", entry("file_change", "file-write")],
  ["MultiEdit", entry("file_change", "file-multi-edit")],
  ["NotebookEdit", entry("file_change", "notebook-edit")],
  ["Read", entry("dynamic_tool_call", "file-read")],
  ["Glob", entry("dynamic_tool_call", "file-glob")],
  ["Grep", entry("dynamic_tool_call", "file-grep")],
  ["WebFetch", entry("dynamic_tool_call", "web-fetch")],
  ["WebSearch", entry("web_search", "web-search")],
  ["TodoWrite", entry("plan", "todo")],
  ["TaskCreate", entry("plan", "task-list")],
  ["TaskUpdate", entry("plan", "task-list")],
  ["TaskGet", entry("plan", "task-list")],
  ["TaskList", entry("plan", "task-list")],
  ["AskUserQuestion", entry("dynamic_tool_call", "user-question")],
  ["ListMcpResourcesTool", entry("mcp_tool_call", "mcp-resources")],
  ["ReadMcpResourceTool", entry("mcp_tool_call", "mcp-resource-read")],
  ["ReadMcpResourceDirTool", entry("mcp_tool_call", "mcp-resources")],
  ["ReadMcpResourceDir", entry("mcp_tool_call", "mcp-resources")],
  ["RefreshMcpTools", entry("mcp_tool_call", "mcp-refresh")],
  ["Workflow", entry("dynamic_tool_call", "workflow")],
  ["Monitor", entry("dynamic_tool_call", "monitor")],
  ["CronCreate", entry("dynamic_tool_call", "cron-create")],
  ["CronDelete", entry("dynamic_tool_call", "cron-delete")],
  ["CronList", entry("dynamic_tool_call", "cron-list")],
  ["ScheduleWakeup", entry("dynamic_tool_call", "schedule-wakeup")],
  ["RemoteTrigger", entry("dynamic_tool_call", "remote-trigger")],
  ["PushNotification", entry("dynamic_tool_call", "push-notification")],
  ["REPL", entry("dynamic_tool_call", "repl")],
  ["Artifact", entry("dynamic_tool_call", "artifact")],
  ["Projects", entry("dynamic_tool_call", "projects")],
  ["ClaudeDesign", entry("dynamic_tool_call", "design")],
  ["DesignSync", entry("dynamic_tool_call", "design")],
  ["SendFeedback", entry("dynamic_tool_call", "feedback")],
  ["ReportFindings", entry("dynamic_tool_call", "findings")],
  ["ProposeSkills", entry("dynamic_tool_call", "propose-skills")],
  ["ProposeGoal", entry("dynamic_tool_call", "propose-goal")],
  ["ReadNotifications", entry("dynamic_tool_call", "notifications")],
  ["ShowOnboardingRolePicker", entry("dynamic_tool_call", "onboarding")],
  ["EnterWorktree", entry("dynamic_tool_call", "worktree-enter")],
  ["ExitWorktree", entry("dynamic_tool_call", "worktree-exit")],
  ["Skill", entry("dynamic_tool_call", "skill")],
  ["ToolSearch", entry("dynamic_tool_call", "tool-search")],
  ["SendMessage", entry("dynamic_tool_call", "send-message")],
  ["LSP", entry("dynamic_tool_call", "lsp")],
  ["KillShell", entry("command_execution", "shell-stop")],
  ["BashOutput", entry("command_execution", "shell-output")],
  ["SlashCommand", entry("dynamic_tool_call", "slash-command")],
]);

interface ClaudeServerToolTableEntry extends ClaudeToolTableEntry {
  readonly serverToolKind: ServerToolKind;
}

const serverEntry = (
  itemType: ClaudeToolItemType,
  labelKey: ClaudeToolLabelKey,
  serverToolKind: ServerToolKind,
): ClaudeServerToolTableEntry => ({ itemType, labelKey, serverToolKind });

export const CLAUDE_SERVER_TOOL_TABLE: ReadonlyMap<string, ClaudeServerToolTableEntry> = new Map([
  ["advisor", serverEntry("dynamic_tool_call", "advisor", "advisor")],
  ["web_search", serverEntry("web_search", "web-search", "web_search")],
  ["web_fetch", serverEntry("dynamic_tool_call", "web-fetch", "web_fetch")],
  ["code_execution", serverEntry("command_execution", "code-execution", "code_execution")],
  [
    "bash_code_execution",
    serverEntry("command_execution", "code-execution", "bash_code_execution"),
  ],
  [
    "text_editor_code_execution",
    serverEntry("dynamic_tool_call", "text-editor", "text_editor_code_execution"),
  ],
  ["tool_search_tool_regex", serverEntry("dynamic_tool_call", "tool-search", "tool_search")],
  ["tool_search_tool_bm25", serverEntry("dynamic_tool_call", "tool-search", "tool_search")],
]);

export const CLAUDE_SERVER_TOOL_RESULT_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "web_search_tool_result",
  "web_fetch_tool_result",
  "advisor_tool_result",
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  "tool_search_tool_result",
  "mcp_tool_result",
]);

export const CLAUDE_TOOL_USE_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "tool_use",
  "server_tool_use",
  "mcp_tool_use",
]);

const MCP_TOOL_PREFIX = "mcp__";

export function splitClaudeMcpToolName(
  name: string,
): { readonly server: string; readonly tool: string } | undefined {
  if (!name.startsWith(MCP_TOOL_PREFIX)) {
    return undefined;
  }
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const separator = rest.indexOf("__");
  if (separator <= 0 || separator + 2 >= rest.length) {
    return undefined;
  }
  return { server: rest.slice(0, separator), tool: rest.slice(separator + 2) };
}

export function classifyClaudeTool(identity: ClaudeToolBlockIdentity): ClaudeToolClassification {
  if (identity.blockType === "server_tool_use") {
    const serverTool = CLAUDE_SERVER_TOOL_TABLE.get(identity.name);
    return serverTool
      ? {
          itemType: serverTool.itemType,
          labelKey: serverTool.labelKey,
          serverToolKind: serverTool.serverToolKind,
        }
      : { itemType: "dynamic_tool_call", labelKey: "generic", serverToolKind: "other" };
  }
  if (identity.blockType === "mcp_tool_use") {
    return {
      itemType: "mcp_tool_call",
      labelKey: "mcp-tool",
      serverToolKind: "mcp",
      ...(identity.serverName ? { mcpServer: identity.serverName } : {}),
      mcpTool: identity.name,
    };
  }
  const known = CLAUDE_SDK_TOOL_TABLE.get(identity.name);
  if (known) {
    return { itemType: known.itemType, labelKey: known.labelKey };
  }
  if (identity.name.startsWith(MCP_TOOL_PREFIX)) {
    const split = splitClaudeMcpToolName(identity.name);
    return {
      itemType: "mcp_tool_call",
      labelKey: "mcp-tool",
      ...(split ? { mcpServer: split.server, mcpTool: split.tool } : {}),
    };
  }
  return { itemType: "dynamic_tool_call", labelKey: "generic" };
}

export function classifyClaudeToolItemType(toolName: string): ClaudeToolItemType {
  return classifyClaudeTool({ name: toolName }).itemType;
}

export function claudeToolProgressItemType(
  itemType: CanonicalItemType | undefined,
): ToolLifecycleItemType | undefined {
  return itemType !== undefined && isToolLifecycleItemType(itemType) ? itemType : undefined;
}
