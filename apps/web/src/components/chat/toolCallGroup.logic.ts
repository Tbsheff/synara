// FILE: toolCallGroup.logic.ts
// Purpose: Summarizes a settled run of tool-call work entries into one compact
//          collapsed tool-group disclosure in the transcript.
// Layer: Web chat presentation helpers

import { isFileChangeWorkLogEntry, type WorkLogEntry } from "../../session-logic";
import { deriveReadableCommandDisplay } from "../../lib/toolCallLabel";
import { isReasoningUpdateWorkEntry } from "./agentActivity.logic";

// A single tool row collapses into nothing useful; only runs of 2+ rows fold.
export const MIN_COLLAPSIBLE_TOOL_GROUP_SIZE = 2;

// Rows an entry occupies when listed: a file-change call renders one
// "Edited <file>" row per changed file, so one patch can be a whole column.
// Fold thresholds count these rows, not calls.
export function workEntryRowCount(entry: WorkLogEntry): number {
  return isFileChangeWorkLogEntry(entry) ? Math.max(1, entry.changedFiles?.length ?? 0) : 1;
}

// One-line label for a call that would list several edited-file rows.
export function multiFileEditLabel(entry: WorkLogEntry): string | null {
  const rowCount = workEntryRowCount(entry);
  return rowCount > 1 ? summaryPartLabel("edit", rowCount) : null;
}

export type ToolCallSummaryCategory =
  | "command"
  | "edit"
  | "read"
  | "search"
  | "web"
  | "agent"
  | "tool"
  | "other";

export interface ToolCallGroupSummaryPart {
  category: ToolCallSummaryCategory;
  count: number;
  label: string;
}

export interface ToolCallGroupSummary {
  label: string;
  parts: ReadonlyArray<ToolCallGroupSummaryPart>;
  entryCount: number;
  // A group with in-flight work must never present itself as settled.
  hasRunningEntry: boolean;
  // First summarized entry: the collapsed row borrows its icon so the summary
  // keeps the same leading glyph as the first tool row it folds away.
  iconEntry: WorkLogEntry;
}

// Rich rows (subagent strips, automation cards, thread-creation recaps) and
// non-tool tones (errors, approvals, info) must stay individually visible, so
// they never fold into a summary group.
export function isSummarizableToolCallEntry(entry: WorkLogEntry): boolean {
  return (
    entry.tone === "tool" &&
    !(entry.toolCallId && isReasoningUpdateWorkEntry(entry)) &&
    !entry.synaraThreadCreation &&
    !entry.automation &&
    !entry.subagentAction &&
    (entry.subagents?.length ?? 0) === 0
  );
}

const READ_VERBS = new Set(["Read", "Reading"]);
const SEARCH_VERBS = new Set(["Searched", "Searching", "Found", "Finding"]);

function classifyCommandVerb(verb: string): ToolCallSummaryCategory {
  if (READ_VERBS.has(verb)) return "read";
  if (SEARCH_VERBS.has(verb)) return "search";
  return "command";
}

export function classifyToolCallSummaryCategory(entry: WorkLogEntry): ToolCallSummaryCategory {
  if (isFileChangeWorkLogEntry(entry)) {
    return "edit";
  }
  if (entry.requestKind === "file-read") {
    return "read";
  }
  if (entry.requestKind === "tool") {
    return "tool";
  }
  if (entry.itemType === "web_search") {
    return "web";
  }
  const command = entry.command ?? entry.rawCommand;
  if (entry.itemType === "command_execution" || entry.requestKind === "command" || command) {
    if (command) {
      return classifyCommandVerb(deriveReadableCommandDisplay(command).verb);
    }
    // Structured command actions (e.g. Codex read/search) carry the verb as the
    // derived tool title without any shell command string.
    const titleVerb = entry.toolTitle?.trim().split(/\s+/, 1)[0] ?? "";
    return classifyCommandVerb(titleVerb);
  }
  if (entry.itemType === "collab_agent_tool_call") {
    return "agent";
  }
  if (entry.itemType === "mcp_tool_call" || entry.itemType === "dynamic_tool_call") {
    return "tool";
  }
  if (entry.toolName) {
    return "tool";
  }
  return "other";
}

// Distinct-file identity for an edit/read entry. Entries with no file info
// count as one unit each so the total never under-reports work.
function entryFileKeys(entry: WorkLogEntry): ReadonlyArray<string> {
  if (entry.changedFiles && entry.changedFiles.length > 0) {
    return entry.changedFiles;
  }
  const detailFiles = entry.toolDetails?.files;
  if (detailFiles && detailFiles.length > 0) {
    return detailFiles;
  }
  const command = entry.command ?? entry.rawCommand;
  if (command) {
    const target = deriveReadableCommandDisplay(command).target.trim();
    if (target.length > 0) {
      return [target];
    }
  }
  if (entry.preview?.trim()) {
    return [entry.preview.trim()];
  }
  return [];
}

const CATEGORY_ORDER: ReadonlyArray<ToolCallSummaryCategory> = [
  "tool",
  "other",
  "edit",
  "read",
  "search",
  "command",
  "web",
  "agent",
];

const SUMMARY_PART_PHRASES: Record<
  ToolCallSummaryCategory,
  { readonly one: string; readonly many: string }
> = {
  tool: { one: "Called a tool", many: "Called tools" },
  other: { one: "Called a tool", many: "Called tools" },
  edit: { one: "Edited a file", many: "Edited files" },
  read: { one: "Read a file", many: "Read files" },
  search: { one: "Searched files", many: "Searched files" },
  command: { one: "Ran a command", many: "Ran commands" },
  web: { one: "Searched the web", many: "Searched the web" },
  agent: { one: "Ran an agent task", many: "Ran agent tasks" },
};

const EMPTY_TOOL_GROUP_LABEL = "Worked";

function summaryPartLabel(category: ToolCallSummaryCategory, count: number): string {
  const phrases = SUMMARY_PART_PHRASES[category];
  return count === 1 ? phrases.one : phrases.many;
}

function lowercaseLeadingLetter(value: string): string {
  return `${value.charAt(0).toLowerCase()}${value.slice(1)}`;
}

export function formatToolCallGroupLabel(
  parts: ReadonlyArray<Pick<ToolCallGroupSummaryPart, "label">>,
): string {
  const labels = [...new Set(parts.map((part) => part.label))];
  if (labels.length === 0) return EMPTY_TOOL_GROUP_LABEL;
  return labels
    .map((label, index) => (index === 0 ? label : lowercaseLeadingLetter(label)))
    .join(", ");
}

export function summarizeToolCallGroup(
  entries: ReadonlyArray<WorkLogEntry>,
): ToolCallGroupSummary | null {
  const summarizable = entries.filter(isSummarizableToolCallEntry);
  const rowCount = summarizable.reduce((total, entry) => total + workEntryRowCount(entry), 0);
  if (rowCount < MIN_COLLAPSIBLE_TOOL_GROUP_SIZE) {
    return null;
  }

  const countByCategory = new Map<ToolCallSummaryCategory, number>();
  const distinctFilesByCategory = new Map<ToolCallSummaryCategory, Set<string>>();
  let hasRunningEntry = false;

  for (const entry of summarizable) {
    if (entry.toolStatus === "running") {
      hasRunningEntry = true;
    }
    const category = classifyToolCallSummaryCategory(entry);
    if (category === "edit" || category === "read") {
      const fileKeys = entryFileKeys(entry);
      if (fileKeys.length === 0) {
        countByCategory.set(category, (countByCategory.get(category) ?? 0) + 1);
        continue;
      }
      const distinctFiles =
        distinctFilesByCategory.get(category) ??
        distinctFilesByCategory.set(category, new Set()).get(category)!;
      for (const fileKey of fileKeys) {
        distinctFiles.add(fileKey);
      }
      continue;
    }
    countByCategory.set(category, (countByCategory.get(category) ?? 0) + 1);
  }

  for (const [category, distinctFiles] of distinctFilesByCategory) {
    countByCategory.set(category, (countByCategory.get(category) ?? 0) + distinctFiles.size);
  }

  const populated = CATEGORY_ORDER.filter((category) => (countByCategory.get(category) ?? 0) > 0);
  const toolCallCount = (countByCategory.get("tool") ?? 0) + (countByCategory.get("other") ?? 0);
  const parts = populated.map((category) => {
    const count = countByCategory.get(category)!;
    const labelCount = category === "tool" || category === "other" ? toolCallCount : count;
    return {
      category,
      count,
      label: summaryPartLabel(category, labelCount),
    };
  });

  return {
    label: formatToolCallGroupLabel(parts),
    parts,
    entryCount: summarizable.length,
    hasRunningEntry,
    iconEntry: summarizable[0]!,
  };
}
