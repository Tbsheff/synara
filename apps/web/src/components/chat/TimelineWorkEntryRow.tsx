// FILE: TimelineWorkEntryRow.tsx
// Purpose: Renders transcript work/tool rows and their inline details.
// Layer: Web chat presentation component
// Exports: TimelineWorkEntryRow, EditedFileRowContent, prefersCompactWorkEntryRow

import type { FileChangeEntry, ModelSelection, ThreadId, TurnId } from "@synara/contracts";
import { PROVIDER_DESCRIPTORS } from "@synara/shared/providerMetadata";
import {
  createElement,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import { basenameOfPath } from "~/file-icons";
import type { TimestampFormat } from "../../appSettings";
import {
  ArrowUpCircleIcon,
  BackgroundTrayIcon,
  BookOpenIcon,
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleQuestionIcon,
  ContextCompactionIcon,
  ComputerUseIcon,
  EyeIcon,
  GitHubIcon,
  GlobeIcon,
  HammerIcon,
  HandoffIcon,
  HistoryIcon,
  type LucideIcon,
  McpIcon,
  PencilIcon,
  SearchIcon,
  SkillCubeIcon,
  TerminalIcon,
  WebSearchIcon,
  ZapIcon,
} from "~/lib/icons";
import { describeLinkChip } from "~/lib/linkChips";
import { computerToolName, describeComputerToolCall } from "~/lib/computerToolPresentation";
import { cn } from "~/lib/utils";
import { formatThreadModelSummaryLabel, resolveThreadModelSummary } from "~/lib/threadModelSummary";

import { isFileChangeWorkLogEntry, type WorkLogEntry } from "../../session-logic";
import {
  formatAgentActivityEntryPreview,
  isAgentActivityWorkEntry,
  isCodexActivityStatusWorkEntry,
  isPlainRuntimeNoticeWorkEntry,
  isReasoningUpdateWorkEntry,
} from "./agentActivity.logic";
import { AutomationCreatedCard } from "./AutomationCreatedCard";
import { ConnectedComputerSetupRequiredCard } from "./ComputerSetupRequiredCard";
import { ComputerControlDeniedCard } from "./ComputerControlDeniedCard";
import ChatMarkdown from "../ChatMarkdown";
import { ChatFindRenderProvider, FindAwareMarkdownText } from "../ChatMarkdownFind";
import { resolveWorkEntryFindText, type ThreadFindHighlight } from "./threadFind.logic";
import { DiffStat } from "../ui/diff-stat";
import { type ExpandedImagePreview } from "./ExpandedImagePreview";
import { LinkChipIcon } from "../LinkChipIcon";
import { normalizeCompactToolLabel } from "./MessagesTimeline.logic";
import { SynaraLogo } from "../SynaraLogo";
import { ToolCallDetailsContent } from "./ToolCallDetailsDialog";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { DISCLOSURE_CLEANUP_BUFFER_MS, DISCLOSURE_TRANSITION_MS } from "~/lib/disclosureMotion";
import {
  buildTypedCommandView,
  buildTypedToolCallView,
  buildTypedWebSearchView,
  effectiveFileChangeKind,
  effectiveFileChangeMovePath,
  fileChangeDisplayPath,
  resolveFileChangeStat,
  type TypedToolRowStatus,
} from "../../lib/toolCallDetails";
import {
  contextCompactionTitle,
  readGroupedHookNoticeData,
  TRANSCRIPT_NOTICE_TONE_ICON_CLASS_NAME,
  TRANSCRIPT_NOTICE_TONE_TEXT_CLASS_NAME,
  transcriptNoticePresentation,
  transcriptNoticeStatusLabel,
  transcriptNoticeTitle,
  transcriptNoticeTone,
} from "../../lib/transcriptNoticeLabels";
import { legacyUnmappedMethodTitle } from "../../lib/legacyUnmappedEventLabels";
import {
  FileChangeDiffDetails,
  ReasoningSummaryDetails,
  SubagentLaunchDetails,
  type SubagentLaunchView,
  TranscriptNoticeDetails,
  TypedCommandDetails,
  TypedToolCallDetails,
  TypedWebSearchDetails,
} from "./ToolCallDetailsDialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { fileDiffStatsByPath, resolveFileDiffStatByChangedPath } from "~/lib/diffRendering";
import {
  extractToolArgumentField,
  isPrefixedToolArgumentSummary,
} from "../../lib/toolArgumentSummary";
import {
  deriveCommandRowLabel,
  deriveFriendlyCommandTarget,
  deriveReasoningRowLabel,
  deriveSynaraMcpToolTitle,
  deriveToolCallRowLabel,
  deriveWebSearchRowLabel,
  fileChangeRowVerb,
  toolRowLabelText,
  type ToolRowLabel,
  extractWebFetchUrl,
  isFailedCommandOutcome,
  isGenericToolTitle,
  isSynaraBrowserToolCall,
  normalizeToolTextForComparison,
  resolveCommandVisualKind,
  sanitizeSynaraMcpToolPreview,
  type SynaraMcpToolStatus,
} from "../../lib/toolCallLabel";
import {
  formatLiveActivityMeta,
  formatSettledActivityOutcome,
  isLiveActivityInProgress,
  useLiveActivityNow,
} from "../../lib/liveActivityPresentation";
import { openWorkspaceFileReference, useWorkspaceFileOpener } from "../../lib/workspaceFileOpener";
import { MUTED_LABEL_TEXT_CLASS_NAME, MUTED_LABEL_TEXT_COLOR } from "~/surfaceStyles";
import { useTheme } from "~/hooks/useTheme";
import { InlineMentionChip } from "./InlineMentionChip";

// Rest tone is the shared quiet-label gray (same one the composer pickers use for
// their effort/thinking labels) so a tool row and the picker below it read as one
// muted tone; hover still lifts the whole row to full foreground.
const WORK_ROW_MUTED_HOVER_TONE: Record<"tool-row" | "file-row", string> = {
  "tool-row": `${MUTED_LABEL_TEXT_CLASS_NAME} transition-colors group-hover/tool-row:text-foreground group-focus-visible/tool-row:text-foreground`,
  "file-row": `${MUTED_LABEL_TEXT_CLASS_NAME} transition-colors group-hover/file-row:text-foreground group-focus-visible/file-row:text-foreground`,
};
const EMPTY_FILE_DIFF_STATS: ReadonlyMap<string, { additions: number; deletions: number }> =
  new Map();

type TimelineWorkEntry = WorkLogEntry;

const AgentTaskIcon: LucideIcon = (props) => <BotIcon {...props} />;

const SynaraToolIcon: LucideIcon = ({ className, ...props }) => (
  <SynaraLogo {...props} className={cn("text-current", className)} />
);

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  icon: LucideIcon;
  className: string;
} {
  if (tone === "error") {
    return {
      icon: CircleAlertIcon,
      className: "text-muted-foreground/50",
    };
  }
  if (tone === "thinking") {
    return {
      icon: BotIcon,
      className: "text-muted-foreground/40",
    };
  }
  if (tone === "info") {
    return {
      icon: CheckIcon,
      className: "text-muted-foreground/50",
    };
  }
  // Generic tool calls with no recognizable kind read as "consulted something".
  return {
    icon: BookOpenIcon,
    className: "text-muted-foreground/45",
  };
}

/**
 * Try to extract a clean file path from a detail string that may contain JSON.
 * Handles patterns like:
 *   Read {"file_path":"/Users/foo/bar.ts","offset":10}
 *   {"file_path":"/path/to/file.ts"}
 */
function extractFilePathFromDetail(detail: string): string | null {
  const plainPathMatch = /^(.+?\.[A-Za-z0-9][A-Za-z0-9._-]*)(?::\d+)?(?::\d+)?$/u.exec(
    detail.trim(),
  );
  if (plainPathMatch?.[1]?.includes("/")) {
    return plainPathMatch[1].trim();
  }
  // "path" is generic enough that a nested match (e.g. inside a config object)
  // may not be the file the tool acted on — only regex-scan truncated JSON.
  return extractToolArgumentField(detail, ["file_path", "filePath", "path", "filename"], {
    fallbackScan: "whenUnparsed",
  });
}

function workEntryPreview(workEntry: TimelineWorkEntry): string | null {
  if (isReasoningUpdateWorkEntry(workEntry)) {
    return formatAgentActivityEntryPreview(workEntry);
  }
  const isFileRelated =
    workEntry.requestKind === "file-read" ||
    workEntry.requestKind === "file-change" ||
    workEntry.itemType === "file_change";

  if (workEntry.itemType === "command_execution" || workEntry.command || workEntry.rawCommand) {
    const command = workEntry.command ?? workEntry.rawCommand;
    // Running and settled command rows share one target so the row text only
    // swaps tense ("Searching for foo in src" → "Searched for foo in src").
    if (command) return deriveFriendlyCommandTarget(command);
  }

  if (workEntry.preview) return workEntry.preview;

  // Prefer clean basenames from changedFiles
  if (workEntry.changedFiles && workEntry.changedFiles.length > 0) {
    const names = workEntry.changedFiles.map((p) => basenameOfPath(p));
    if (names.length === 1) return names[0]!;
    return `${names.length} files`;
  }

  if (workEntry.itemType === "collab_agent_tool_call") {
    return workEntry.detail ?? workEntry.subagentAction?.prompt ?? null;
  }

  // For detail, try to extract a clean file path first
  if (workEntry.detail) {
    const filePath = extractFilePathFromDetail(workEntry.detail);
    if (filePath) return basenameOfPath(filePath);

    // For file-related entries, the heading alone is enough — don't show raw JSON
    if (isFileRelated) return null;

    // For other entries, if the detail looks like raw JSON, skip it
    const trimmedDetail = workEntry.detail.trim();
    if (trimmedDetail.startsWith("{") || trimmedDetail.startsWith("[")) return null;

    // Dynamic/MCP tool calls surface their arguments as `ToolName: {json}` —
    // transport detail, not a human summary. The raw call stays in toolDetails.
    // Failed calls keep their detail inline: it may carry the error text (e.g.
    // an MCP error serialized as `McpError: {json}`), and on a failure more
    // information beats a tidy row.
    if (toolWorkEntryStatus(workEntry) !== "failed" && isPrefixedToolArgumentSummary(trimmedDetail))
      return null;

    const readLinesMatch = /^Read\s+(\d+\s+lines?)$/i.exec(trimmedDetail);
    if (readLinesMatch?.[1]) return readLinesMatch[1];

    // Clean, non-JSON detail — show it
    return trimmedDetail;
  }

  return null;
}

// Provider read tools (e.g. Claude's `Read`) arrive as generic dynamic tool calls
// without a `file-read` requestKind, so match their tool name to surface the search icon
// instead of the generic tool/wrench fallback.
function isFileReadToolEntry(workEntry: TimelineWorkEntry): boolean {
  const name = (workEntry.toolName ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return name === "read" || name === "readfile" || name === "viewfile";
}

// Command rows reuse toolCallLabel's wrapper-aware classifier so wrapped git/gh
// commands get the GitHub mark while ordinary commands keep the terminal icon.
function commandWorkEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  const command = workEntry.command ?? workEntry.rawCommand;
  switch (command ? resolveCommandVisualKind(command) : "terminal") {
    case "inspect":
      return SearchIcon;
    case "git":
    case "github":
      return GitHubIcon;
    case "terminal":
      return TerminalIcon;
  }
}

function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  // User-input rows read as a question (awaiting an answer) and an upload
  // (answer submitted) rather than the generic "info" checkmark.
  if (workEntry.activityKind === "user-input.requested") return CircleQuestionIcon;
  if (workEntry.activityKind === "user-input.resolved") return ArrowUpCircleIcon;
  if (workEntry.activityKind === "context-compaction") return ContextCompactionIcon;
  if (workEntry.activityKind === "checkpoint.baseline.skipped") return CircleAlertIcon;
  // "Moved to background" notices read as a tray drop, not a warning check.
  if (workEntry.nativeEventType === "background_tasks_changed") return BackgroundTrayIcon;
  if (workEntry.backgroundTaskCompletion) {
    return workEntry.backgroundTaskCompletion.taskType === "local_agent"
      ? AgentTaskIcon
      : BackgroundTrayIcon;
  }
  if (workEntry.providerHandoff) {
    return workEntry.providerHandoff.status === "failed" ? CircleAlertIcon : HandoffIcon;
  }
  if (workEntry.providerContextLifecycle) {
    return workEntry.providerContextLifecycle.nativeHistory === "unavailable"
      ? CircleAlertIcon
      : HistoryIcon;
  }

  if (workEntry.requestKind === "command") return commandWorkEntryIcon(workEntry);
  if (workEntry.requestKind === "file-read") return SearchIcon;
  if (workEntry.requestKind === "file-change") return PencilIcon;
  if (workEntry.requestKind === "tool") return McpIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return commandWorkEntryIcon(workEntry);
  }
  if (workEntry.itemType === "file_change") {
    return PencilIcon;
  }
  if (workEntry.itemType === "web_search") return WebSearchIcon;
  if (workEntry.itemType === "image_generation") return ZapIcon;
  if (workEntry.itemType === "image_view") return EyeIcon;
  if (isFileReadToolEntry(workEntry)) return SearchIcon;

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return SkillCubeIcon;
    case "dynamic_tool_call":
      return HammerIcon;
    case "collab_agent_tool_call":
      return AgentTaskIcon;
  }

  return workToneIcon(workEntry.tone).icon;
}

// Dynamic icon selection is data, not a component declaration. Keeping the
// createElement call in this module helper avoids presenting a render-local
// component binding to React Compiler.
export function renderWorkEntryIcon(Icon: LucideIcon, className: string): ReactElement {
  return createElement(Icon, { className });
}

// The leading glyph for a tool row: recognizable product and surface icons win
// over the kind-derived entry icon. Shared with the collapsed tool-group summary
// row, which borrows its first entry's icon.
export function workEntryLeftIcon(workEntry: TimelineWorkEntry): LucideIcon {
  if (workEntry.notice) return transcriptNoticePresentation(workEntry.notice.noticeKind).icon;
  if (isComputerWorkEntry(workEntry)) return ComputerUseIcon;
  if (isGitHubMcpToolCall(workEntry)) return GitHubIcon;
  if (isSynaraBrowserWorkEntry(workEntry)) return GlobeIcon;
  if (isSynaraToolCall(workEntry)) return SynaraToolIcon;
  if (workEntry.itemType === "mcp_tool_call") return McpIcon;
  return workEntryIcon(workEntry);
}

function isComputerWorkEntry(workEntry: TimelineWorkEntry): boolean {
  return (
    computerToolName(workEntry.toolName) !== null ||
    /^Computer Use:/i.test(workEntry.toolTitle ?? "")
  );
}

function isGitHubMcpToolCall(workEntry: TimelineWorkEntry): boolean {
  const toolName = workEntry.toolName?.trim().toLowerCase();
  return Boolean(toolName?.startsWith("mcp__codex_apps__github"));
}

// Synara's own agent-gateway tools (synara_list_threads, synara_create_thread,
// ...) get the Synara mark instead of the generic MCP glyph. Providers report
// the call differently: Claude prefixes the MCP server (mcp__synara__*), ACP
// agents surface the bare tool name (synara_*), and Codex reports server/tool
// pairs that the label humanizer renders as "Synara: ...".
function toolWorkEntryStatus(workEntry: TimelineWorkEntry): SynaraMcpToolStatus {
  if (workEntry.toolStatus) return workEntry.toolStatus;
  return workEntry.activityKind !== undefined && workEntry.activityKind !== "tool.completed"
    ? "running"
    : "completed";
}

function isSynaraBrowserWorkEntry(workEntry: TimelineWorkEntry): boolean {
  return isSynaraBrowserToolCall({
    toolName: workEntry.toolName,
    title: workEntry.toolTitle,
    fallbackLabel: workEntry.label,
    status: toolWorkEntryStatus(workEntry),
  });
}

function isSynaraToolCall(workEntry: TimelineWorkEntry): boolean {
  return (
    deriveSynaraMcpToolTitle({
      toolName: workEntry.toolName,
      title: workEntry.toolTitle,
      fallbackLabel: workEntry.label,
      status: toolWorkEntryStatus(workEntry),
    }) !== null
  );
}

// Render command, agent-task, file-change, and file-read rows at the tighter
// compact density so every tool-call line shares one height regardless of whether
// it carries a disclosure chevron.
export function prefersCompactWorkEntryRow(workEntry: TimelineWorkEntry): boolean {
  if (isCodexActivityStatusWorkEntry(workEntry)) {
    return true;
  }
  // Commands stay compact even when surfaced with a non-terminal icon (read-only
  // inspections like `cat` now use the file-read search icon).
  if (workEntry.itemType === "command_execution" || workEntry.command || workEntry.rawCommand) {
    return true;
  }
  const EntryIcon = workEntryIcon(workEntry);
  return (
    EntryIcon === TerminalIcon ||
    EntryIcon === HammerIcon ||
    EntryIcon === AgentTaskIcon ||
    EntryIcon === PencilIcon ||
    EntryIcon === SkillCubeIcon ||
    // File-read / inspect rows (e.g. `Read …`) surface the search icon and have no
    // disclosure chevron; keep them at the same compact height as command rows.
    EntryIcon === SearchIcon
  );
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  if (computerToolName(workEntry.toolName)) {
    // Work-log projection already resolves the action and target. The generic
    // MCP presentation would replace that with "Synara clicked the desktop".
    const title = normalizeCompactToolLabel(workEntry.toolTitle ?? "");
    if (title && !isGenericToolTitle(title) && !computerToolName(title))
      return capitalizePhrase(title);
    return describeComputerToolCall({ toolName: workEntry.toolName, args: undefined })!.summary;
  }
  // Task progress is semantic copy, not a tool lifecycle status. Preserve the
  // trailing "completed" instead of passing it through the compact tool-label
  // normalizer, which intentionally strips lifecycle suffixes.
  if (workEntry.activityKind === "turn.tasks.updated") {
    return capitalizePhrase(workEntry.label);
  }
  const synaraTitle = deriveSynaraMcpToolTitle({
    toolName: workEntry.toolName,
    title: workEntry.toolTitle,
    fallbackLabel: workEntry.label,
    status: toolWorkEntryStatus(workEntry),
  });
  if (synaraTitle) {
    return synaraTitle;
  }
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

function hasOwnToolPresentation(workEntry: TimelineWorkEntry): boolean {
  return (
    isComputerWorkEntry(workEntry) ||
    isSynaraBrowserWorkEntry(workEntry) ||
    isSynaraToolCall(workEntry) ||
    workEntry.itemType === "collab_agent_tool_call"
  );
}

function typedReadFilePath(workEntry: TimelineWorkEntry): string | null {
  const args = workEntry.toolCall?.arguments;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  const path = record.file_path ?? record.filePath ?? record.path;
  return typeof path === "string" && path.trim().length > 0 ? path.trim() : null;
}

function typedToolRowStatus(workEntry: TimelineWorkEntry): TypedToolRowStatus {
  const status = toolWorkEntryStatus(workEntry);
  const settledState = workEntry.liveActivity?.state;
  if (status === "completed" && (settledState === "failed" || settledState === "cancelled")) {
    return settledState;
  }
  return status;
}

function workEntryOutcomeMeta(workEntry: TimelineWorkEntry, nowMs: number): string | null {
  const commandExecution = typedCommandExecution(workEntry);
  const rowStatus = typedToolRowStatus(workEntry);
  const status =
    commandExecution &&
    rowStatus === "completed" &&
    isFailedCommandOutcome({ status: rowStatus, exitCode: commandExecution.exitCode })
      ? "failed"
      : rowStatus;
  const labelSaysStopped =
    commandExecution !== undefined &&
    (status === "cancelled" || commandExecution.interrupted === true);
  if (labelSaysStopped) return null;
  const meta = workEntry.liveActivity
    ? formatLiveActivityMeta(workEntry.liveActivity, nowMs, {
        subagent: workEntry.itemType === "collab_agent_tool_call",
        settledDurationMs: commandExecution?.durationMs,
        lastOutputAt: workEntry.liveOutput?.updatedAt,
      })
    : null;
  if (meta || !commandExecution || status !== "failed") return meta;
  return formatSettledActivityOutcome("failed", commandExecution.durationMs ?? null);
}

const SUBAGENT_STATUS_LABELS: Record<TypedToolRowStatus, string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
};

function subagentLaunchView(workEntry: TimelineWorkEntry): SubagentLaunchView | null {
  if (workEntry.itemType !== "collab_agent_tool_call") return null;
  const action = workEntry.subagentAction;
  const subagent = workEntry.subagents?.[0];
  return {
    status: SUBAGENT_STATUS_LABELS[typedToolRowStatus(workEntry)],
    model: action?.model ?? subagent?.model ?? null,
    prompt: action?.prompt ?? subagent?.prompt ?? null,
    agents: workEntry.subagents,
  };
}

const EMPTY_COMMAND_EXECUTION: NonNullable<TimelineWorkEntry["commandExecution"]> = {};

function typedCommandExecution(workEntry: TimelineWorkEntry) {
  if (isFileChangeWorkEntry(workEntry)) return undefined;
  if (workEntry.commandExecution) return workEntry.commandExecution;
  const commandLike =
    workEntry.itemType === "command_execution" ||
    Boolean(workEntry.command ?? workEntry.rawCommand);
  return workEntry.liveOutput && commandLike ? EMPTY_COMMAND_EXECUTION : undefined;
}

function imageViewLabel(workEntry: TimelineWorkEntry): ToolRowLabel | null {
  if (workEntry.itemType !== "image_view") return null;
  const count = workEntry.toolCall?.images?.length ?? 1;
  return {
    action: count > 1 ? `Viewed ${count} images` : "Viewed an image",
    detail: null,
    suffix: null,
  };
}

function typedWorkEntryLabel(workEntry: TimelineWorkEntry): ToolRowLabel | null {
  if (workEntry.notice) {
    return { action: transcriptNoticeTitle(workEntry.notice), detail: null, suffix: null };
  }
  if (workEntry.unmappedMethod) {
    const title = legacyUnmappedMethodTitle(workEntry.unmappedMethod);
    const preview = workEntryPreview(workEntry);
    const message =
      preview && preview !== workEntry.unmappedMethod && preview !== title ? preview : null;
    return message
      ? { action: `${title}:`, detail: message, suffix: null }
      : { action: title, detail: null, suffix: null };
  }
  const compactionTitle = contextCompactionTitle(workEntry);
  if (compactionTitle) {
    return { action: compactionTitle, detail: null, suffix: null };
  }
  if (workEntry.steeredMessage) {
    return { action: capitalizePhrase(workEntry.label), detail: null, suffix: null };
  }
  const status = typedToolRowStatus(workEntry);
  const running = status === "running";
  if (workEntry.reasoning) {
    return deriveReasoningRowLabel(workEntry.reasoning, running);
  }
  if (hasOwnToolPresentation(workEntry)) {
    return null;
  }
  const imageView = imageViewLabel(workEntry);
  if (imageView) {
    return imageView;
  }
  const commandExecution = typedCommandExecution(workEntry);
  if (commandExecution) {
    return deriveCommandRowLabel({
      command: commandExecution.command ?? workEntry.rawCommand ?? workEntry.command,
      description: commandExecution.description,
      exitCode: commandExecution.exitCode,
      status,
      durationMs: commandExecution.durationMs,
      interrupted: commandExecution.interrupted,
      background: commandExecution.background,
      parsedActions: commandExecution.parsedActions,
    });
  }
  if (workEntry.webSearch) {
    return deriveWebSearchRowLabel(workEntry.webSearch, running);
  }
  if (workEntry.toolCall) {
    return deriveToolCallRowLabel({
      toolName: workEntry.toolCall.toolName ?? workEntry.toolName,
      server: workEntry.toolCall.server,
      serverToolKind: workEntry.toolCall.serverToolKind,
      arguments: workEntry.toolCall.arguments,
      status,
    });
  }
  return null;
}

function hasTypedWorkEntryDetails(workEntry: TimelineWorkEntry): boolean {
  const notice = workEntry.notice;
  if (notice) {
    return Boolean(
      notice.body?.trim() ||
      notice.detail?.trim() ||
      (readGroupedHookNoticeData(notice)?.hookEvents.length ?? 0) > 0,
    );
  }
  if (workEntry.reasoning) {
    return Boolean(workEntry.reasoning.summary?.trim());
  }
  if (hasOwnToolPresentation(workEntry)) {
    return false;
  }
  if (typedCommandExecution(workEntry)) return true;
  if (workEntry.webSearch) return !buildTypedWebSearchView(workEntry.webSearch).isEmpty;
  return Boolean(workEntry.toolCall);
}

function TypedWorkEntryDetails(props: {
  workEntry: TimelineWorkEntry;
  markdownCwd: string | undefined;
  onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const { workEntry } = props;
  const status = typedToolRowStatus(workEntry);
  const running = status === "running";
  if (workEntry.notice) {
    return <TranscriptNoticeDetails notice={workEntry.notice} />;
  }
  if (workEntry.reasoning?.summary) {
    return (
      <ReasoningSummaryDetails
        summary={workEntry.reasoning.summary}
        truncated={workEntry.reasoning.summaryTruncated === true}
      />
    );
  }
  const commandExecution = typedCommandExecution(workEntry);
  if (commandExecution) {
    return (
      <TypedCommandDetails
        running={running}
        view={buildTypedCommandView({
          command: commandExecution,
          status,
          fallbackCommand: workEntry.rawCommand ?? workEntry.command,
          fallbackOutput: workEntry.toolDetails?.output,
          liveOutput: workEntry.liveOutput,
        })}
      />
    );
  }
  if (workEntry.webSearch) {
    return <TypedWebSearchDetails view={buildTypedWebSearchView(workEntry.webSearch)} />;
  }
  if (workEntry.toolCall) {
    return (
      <TypedToolCallDetails
        view={buildTypedToolCallView(workEntry.toolCall)}
        running={running}
        markdownCwd={props.markdownCwd}
        onImageExpand={props.onImageExpand}
      />
    );
  }
  return null;
}

function combineWorkEntryDisplayText(heading: string, preview: string | null): string {
  if (!preview) {
    return heading;
  }
  return normalizeToolTextForComparison(heading) === normalizeToolTextForComparison(preview)
    ? heading
    : `${heading} ${preview}`;
}

// One sentence per row, live or settled: the tool's own verb plus what it acted
// on ("Searched for foo in src"). Lifecycle state is never spelled out here —
// the verb already carries the tense and `liveActivityMetaText` covers the rest.
// Shared with the live tool-group line, which wears its newest call's sentence.
function workEntryDisplayParts(workEntry: TimelineWorkEntry): {
  heading: string;
  preview: string | null;
  displayText: string;
} {
  const typedLabel = typedWorkEntryLabel(workEntry);
  if (typedLabel) {
    const typedPreview = [typedLabel.detail, typedLabel.suffix?.trim()].filter(Boolean).join(" ");
    return {
      heading: typedLabel.action,
      preview: typedPreview.length > 0 ? typedPreview : null,
      displayText: toolRowLabelText(typedLabel),
    };
  }
  const webFetchUrl = extractWebFetchUrl(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const rawPreview = workEntryPreview(workEntry);
  const preview =
    !isGitHubMcpToolCall(workEntry) &&
    (isSynaraBrowserWorkEntry(workEntry) || isSynaraToolCall(workEntry))
      ? sanitizeSynaraMcpToolPreview({
          preview: rawPreview,
          heading,
          status: toolWorkEntryStatus(workEntry),
        })
      : rawPreview;
  const displayText = webFetchUrl
    ? describeLinkChip(webFetchUrl).label
    : (isReasoningUpdateWorkEntry(workEntry) || workEntry.activityKind === "tool.summary") &&
        preview
      ? preview
      : combineWorkEntryDisplayText(heading, preview);
  return { heading, preview, displayText };
}

export function workEntryDisplayText(workEntry: TimelineWorkEntry): string {
  return workEntryDisplayParts(workEntry).displayText;
}

function isFileChangeWorkEntry(workEntry: TimelineWorkEntry): boolean {
  return isFileChangeWorkLogEntry(workEntry);
}

function commandTooltipContent(command: string, displayText: string) {
  return (
    <div className="max-w-96 whitespace-pre-wrap leading-tight">
      <div className="space-y-2">
        <div className="space-y-0.5">
          <div className="text-muted-foreground/70">Summary</div>
          <div>{displayText}</div>
        </div>
        <div className="space-y-0.5">
          <div className="text-muted-foreground/70">Raw call</div>
          <code className="block whitespace-pre-wrap break-words font-chat-code text-chat-code text-foreground/92">
            {command}
          </code>
        </div>
      </div>
    </div>
  );
}

// Hover content for a tool-call row: the rich command card when a raw command is
// present, otherwise the plain label (used to reveal truncated text / file paths).
// Returns null when there's nothing worth showing so the row renders untouched.
function toolRowTooltipContent(
  rawCommand: string | null | undefined,
  displayText: string,
  fallback: string | undefined,
): ReactNode {
  if (rawCommand) {
    return commandTooltipContent(rawCommand, displayText);
  }
  return fallback ? <span className="whitespace-pre-wrap">{fallback}</span> : null;
}

// Frosted hover tooltip for tool-call rows — the same surface (via the `default`
// variant) as the sidebar thread/project hover cards, so the rows read as one
// system. Replaces the native `title` tooltip; renders the trigger untouched when
// there's no content to show.
function ToolRowTooltip(props: { content: ReactNode; children: ReactElement }) {
  if (!props.content) {
    return props.children;
  }
  return (
    <Tooltip>
      <TooltipTrigger render={props.children} />
      <TooltipPopup side="top" align="start" className="max-w-96 whitespace-normal">
        {props.content}
      </TooltipPopup>
    </Tooltip>
  );
}

const LIVE_DURATION_PATTERN = /\b(?:\d+[dhms](?: \d+[hms])?|now)\b/g;

function reserveLiveDurationWidth(duration: string): string {
  if (duration.includes("d")) return "00d 00h";
  if (duration.includes("h")) return "00h 00m";
  return "00m 00s";
}

export function liveActivityMetaWidthTemplate(text: string): string {
  return text.replace(LIVE_DURATION_PATTERN, (duration) =>
    duration === "now" ? "00m 00s ago" : reserveLiveDurationWidth(duration),
  );
}

function LiveActivityMeta({ text, ticking }: { text: string; ticking: boolean }) {
  if (!ticking) {
    return (
      <span className="tabular-nums" data-live-activity-meta="true">
        {" · "}
        {text}
      </span>
    );
  }
  return (
    <span
      className="inline-grid tabular-nums before:invisible before:col-start-1 before:row-start-1 before:whitespace-pre before:content-[attr(data-width-template)]"
      data-width-template={` · ${liveActivityMetaWidthTemplate(text)}`}
    >
      <span className="col-start-1 row-start-1 whitespace-pre" data-live-activity-meta="true">
        {" · "}
        {text}
      </span>
    </span>
  );
}

export const TimelineWorkEntryRow = memo(function TimelineWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  findHighlight?: ThreadFindHighlight | null;
  chatMetaFontSizePx: number;
  textFontSizePx?: number;
  density?: "default" | "compact";
  fileDiffStatByPath?: ReadonlyMap<string, { additions: number; deletions: number }>;
  markdownCwd: string | undefined;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  turnId?: TurnId;
  onOpenTurnDiff?: (turnId: TurnId, filePath?: string) => void;
  onOpenAgentActivity?: (activityId: string) => void;
  onOpenThread?: (threadId: ThreadId) => void;
  onOpenAutomation?: (automationId: string) => void;
  computerControlEnabled?: boolean;
  onEnableComputerControl?: () => void;
  timestampFormat: TimestampFormat;
}) {
  // Defaults are applied in the body (not in the destructuring pattern): a default
  // value inside a destructuring pattern makes React Compiler bail out on the whole
  // component, silently dropping memoization for every tool-call row.
  const {
    workEntry,
    chatMetaFontSizePx,
    textFontSizePx: textFontSizePxProp,
    density: densityProp,
    fileDiffStatByPath,
    markdownCwd,
    onImageExpand,
    turnId,
    onOpenTurnDiff,
    onOpenAgentActivity,
    onOpenAutomation,
    computerControlEnabled,
    onEnableComputerControl,
    timestampFormat,
  } = props;
  const activeFindMatch = props.findHighlight?.activeMatch;
  const workFindActive = activeFindMatch?.workEntryId === workEntry.id;
  const findText = workFindActive ? resolveWorkEntryFindText(workEntry) : "";
  const findStart = workFindActive ? Math.max(0, activeFindMatch.startOffset - 160) : 0;
  const workFindPreview =
    workFindActive && props.findHighlight ? (
      <div data-chat-find-document-id={`work:${workEntry.id}`} className="px-5 py-1">
        <p className="text-ui-xs text-muted-foreground">Search match</p>
        <ChatFindRenderProvider
          query={props.findHighlight.query}
          sourceText={findText}
          activeRange={activeFindMatch}
        >
          <pre className="whitespace-pre-wrap break-words text-chat-code">
            <FindAwareMarkdownText
              text={findText.slice(findStart, activeFindMatch.endOffset + 160)}
              sourceOffset={findStart}
            />
          </pre>
        </ChatFindRenderProvider>
      </div>
    ) : null;
  const textFontSizePx = textFontSizePxProp ?? chatMetaFontSizePx;
  const density = densityProp ?? "default";
  const compact = density === "compact";
  const isCodexStatusRow = isCodexActivityStatusWorkEntry(workEntry);
  const isPlainRuntimeNoticeRow = isPlainRuntimeNoticeWorkEntry(workEntry);
  const EntryIcon = workEntryIcon(workEntry);
  // Web-fetch tool calls surface the target site (favicon + URL) instead of the raw
  // `WebFetch: {json}` arguments, reusing the same link-chip icon/label path as
  // composer and markdown links so every site reference looks identical.
  const webFetchUrl = extractWebFetchUrl(workEntry);
  // Standard tool rows keep one discoverable left glyph. Codex status rows
  // deliberately skip it and reuse only the shared tool-label typography.
  const isGitHubToolRow = isGitHubMcpToolCall(workEntry);
  const isComputerToolRow = isComputerWorkEntry(workEntry);
  const isSynaraBrowserToolRow = !isGitHubToolRow && isSynaraBrowserWorkEntry(workEntry);
  const isSynaraToolRow =
    !isGitHubToolRow && !isSynaraBrowserToolRow && isSynaraToolCall(workEntry);
  const isMcpToolRow =
    workEntry.itemType === "mcp_tool_call" &&
    !isGitHubToolRow &&
    !isSynaraBrowserToolRow &&
    !isSynaraToolRow;
  const LeftIcon = workEntryLeftIcon(workEntry);
  const leftIconKind = webFetchUrl
    ? "web-fetch"
    : isComputerToolRow
      ? "computer"
      : isGitHubToolRow || EntryIcon === GitHubIcon
        ? "github"
        : isSynaraBrowserToolRow
          ? "browser"
          : isSynaraToolRow
            ? "synara"
            : isMcpToolRow
              ? "mcp"
              : undefined;
  const { heading, preview, displayText } = workEntryDisplayParts(workEntry);
  const showInlineAgentTaskPreview =
    workEntry.itemType === "collab_agent_tool_call" &&
    Boolean(preview) &&
    normalizeToolTextForComparison(heading) !== normalizeToolTextForComparison(preview ?? "");
  const rawCommand = workEntry.rawCommand ?? workEntry.command;
  const hoverText =
    rawCommand ?? (showInlineAgentTaskPreview ? heading : (webFetchUrl ?? displayText));
  const changedFiles = workEntry.changedFiles ?? [];
  const typedFileChanges = workEntry.fileChanges?.changes ?? [];
  const showTypedFileRows = typedFileChanges.length > 0;
  const showEditedRows =
    !showTypedFileRows && isFileChangeWorkEntry(workEntry) && changedFiles.length > 0;
  const notice = workEntry.notice;
  const noticeTone = notice ? transcriptNoticeTone(notice.severity, notice.status) : null;
  const noticeStatusLabel = notice ? transcriptNoticeStatusLabel(notice.status) : null;
  const hasTypedDetails = hasTypedWorkEntryDetails(workEntry);
  const subagentLaunch = subagentLaunchView(workEntry);
  const canOpenAgentActivity =
    Boolean(onOpenAgentActivity) && isAgentActivityWorkEntry(workEntry) && !subagentLaunch;
  const openAgentActivity = canOpenAgentActivity
    ? () => onOpenAgentActivity?.(workEntry.id)
    : undefined;
  const hasToolDetails = Boolean(workEntry.toolDetails);
  const providerContextLifecycle = workEntry.providerContextLifecycle;
  const providerHandoff = workEntry.providerHandoff;
  // File-read rows open the referenced file in the in-app viewer when the
  // hosting surface provides an opener (right-dock file pane / editor pane).
  const opener = useWorkspaceFileOpener();
  // Per-file +N/-M parsed from this tool call's own patch, used as a fallback when
  // the turn-diff summary isn't in scope (e.g. standalone work rows) so every
  // "Edited <file>" row can still show diff stats.
  const toolDiffStatsByPath = useMemo(
    () =>
      isFileChangeWorkEntry(workEntry)
        ? fileDiffStatsByPath(workEntry.toolDetails?.diff)
        : EMPTY_FILE_DIFF_STATS,
    [workEntry],
  );
  const liveActivityNowMs = useLiveActivityNow(workEntry.liveActivity);
  const liveActivityMetaText = workEntryOutcomeMeta(workEntry, liveActivityNowMs);
  const liveActivityTicking =
    workEntry.liveActivity !== undefined && isLiveActivityInProgress(workEntry.liveActivity);
  const { resolvedTheme } = useTheme();

  // A computer-control denial renders as an actionable card (enable + retry)
  // instead of a buried tool-error line. Kept after the hooks above so the
  // early return never changes hook order.
  if (workEntry.computerSetupRequired) {
    return (
      <ConnectedComputerSetupRequiredCard
        {...workEntry.computerSetupRequired}
        textFontSizePx={textFontSizePx}
        metaFontSizePx={chatMetaFontSizePx}
      />
    );
  }

  const computerControlDenied = workEntry.computerControlDenied;
  if (computerControlDenied) {
    return (
      <div className={cn(compact ? "py-0.5" : "py-1")}>
        <ComputerControlDeniedCard
          {...(computerControlEnabled !== undefined ? { computerControlEnabled } : {})}
          textFontSizePx={textFontSizePx}
          metaFontSizePx={chatMetaFontSizePx}
          {...(onEnableComputerControl ? { onEnable: onEnableComputerControl } : {})}
        />
      </div>
    );
  }

  // A created-automation row renders as its own card instead of a tool-call line.
  // Kept after the hooks above so the early return never changes hook order.
  if (workEntry.modelReroute) {
    return <ModelRerouteDivider reroute={workEntry.modelReroute} fallbackLabel={displayText} />;
  }

  const automation = workEntry.automation;
  if (automation) {
    return (
      <div className={cn(compact ? "py-0.5" : "py-1")}>
        <AutomationCreatedCard
          automationId={automation.id}
          name={automation.name}
          cadenceLabel={automation.cadenceLabel}
          {...(automation.proposalState ? { proposalState: automation.proposalState } : {})}
          textFontSizePx={textFontSizePx}
          metaFontSizePx={chatMetaFontSizePx}
          {...(onOpenAutomation ? { onOpen: () => onOpenAutomation(automation.id) } : {})}
        />
      </div>
    );
  }

  const readFileSource =
    workEntry.requestKind === "file-read" || isFileReadToolEntry(workEntry)
      ? (typedReadFilePath(workEntry) ?? workEntry.detail)
      : undefined;
  const readFilePath =
    opener !== null && !canOpenAgentActivity && readFileSource
      ? extractFilePathFromDetail(readFileSource)
      : null;
  const canOpenReadFile = readFilePath !== null;
  const canOpenToolDetails =
    !canOpenAgentActivity &&
    Boolean(
      subagentLaunch ||
      providerContextLifecycle ||
      providerHandoff ||
      hasTypedDetails ||
      workEntry.toolDetails ||
      (workEntry.liveActivity && !canOpenReadFile),
    );
  const openReadFile = readFilePath
    ? () => openWorkspaceFileReference(opener, readFilePath)
    : undefined;
  const prefetchReadFile =
    readFilePath && opener?.prefetchFile ? () => opener.prefetchFile?.(readFilePath) : undefined;

  // Use the text font size (matching the UI settings) for tool call rows
  const rowFontSizePx = textFontSizePx;

  return (
    <div className={cn(compact ? "py-0.5" : "rounded-lg py-1")} data-work-entry-id={workEntry.id}>
      {workFindPreview}
      {showTypedFileRows ? (
        <TypedFileChangeRows
          workEntryId={workEntry.id}
          changes={typedFileChanges}
          cwd={markdownCwd}
          status={toolWorkEntryStatus(workEntry)}
          hiddenCount={Math.max(
            0,
            (workEntry.fileChanges?.totalFiles ?? typedFileChanges.length) -
              typedFileChanges.length,
          )}
          compact={compact}
          fontSizePx={rowFontSizePx}
          fileDiffStatByPath={fileDiffStatByPath}
          {...(turnId && onOpenTurnDiff
            ? { onOpenTurnDiff: (filePath: string) => onOpenTurnDiff(turnId, filePath) }
            : {})}
          timestampFormat={timestampFormat}
        />
      ) : showEditedRows ? (
        <div className="space-y-0.5">
          {changedFiles.map((changedFilePath) => {
            // Prefer the turn-diff summary's per-file stat; fall back to the stat
            // parsed from this tool call's own patch so the +N/-M shows even when
            // no summary is in scope (standalone work rows) or it lacks the file.
            const summaryStat = fileDiffStatByPath?.get(changedFilePath);
            const changedFileStat =
              summaryStat && summaryStat.additions + summaryStat.deletions > 0
                ? summaryStat
                : (resolveFileDiffStatByChangedPath(
                    toolDiffStatsByPath,
                    changedFilePath,
                    changedFiles.length,
                  ) ?? summaryStat);
            const canOpenEditedDiff = Boolean(turnId && onOpenTurnDiff);
            const canOpenEditedRow = canOpenToolDetails || canOpenEditedDiff;
            const editedRowClassName = cn(
              "group/file-row flex w-full max-w-full items-center text-left transition-colors duration-150",
              compact ? "gap-1.5" : "gap-2",
              canOpenEditedRow ? "cursor-pointer focus-visible:outline-none" : "cursor-default",
            );
            const editedRowChildren = (
              <EditedFileRowContent
                filePath={changedFilePath}
                additions={changedFileStat?.additions}
                deletions={changedFileStat?.deletions}
                fontSizePx={rowFontSizePx}
                compact={compact}
              />
            );
            if (hasToolDetails || (canOpenToolDetails && !canOpenEditedDiff)) {
              return (
                <ToolDetailsDisclosure
                  key={`${workEntry.id}:${changedFilePath}`}
                  details={workEntry.toolDetails}
                  activity={workEntry.liveActivity}
                  compact={compact}
                  tooltip={<span className="whitespace-pre-wrap">{changedFilePath}</span>}
                  summaryClassName={editedRowClassName}
                  dataFileChangeRow
                  timestampFormat={timestampFormat}
                  footer={
                    canOpenEditedDiff ? (
                      <OpenTurnDiffButton
                        onOpen={() => onOpenTurnDiff?.(turnId!, changedFilePath)}
                      />
                    ) : undefined
                  }
                >
                  {editedRowChildren}
                </ToolDetailsDisclosure>
              );
            }
            return (
              <button
                key={`${workEntry.id}:${changedFilePath}`}
                type="button"
                data-file-change-row="true"
                className={editedRowClassName}
                title={changedFilePath}
                disabled={!canOpenEditedRow}
                onClick={() => {
                  if (!turnId || !onOpenTurnDiff) {
                    return;
                  }
                  onOpenTurnDiff(turnId, changedFilePath);
                }}
              >
                {editedRowChildren}
              </button>
            );
          })}
        </div>
      ) : (
        (() => {
          const rowContentChildren = (
            <>
              {!isCodexStatusRow && !isPlainRuntimeNoticeRow ? (
                <span
                  className={cn(
                    "flex shrink-0 items-center justify-center",
                    WORK_ROW_MUTED_HOVER_TONE["tool-row"],
                    compact ? "size-4" : "size-5",
                  )}
                  data-tool-icon={leftIconKind}
                  data-work-entry-icon="true"
                >
                  {webFetchUrl ? (
                    <LinkChipIcon url={webFetchUrl} className={compact ? "size-3.5" : "size-4"} />
                  ) : (
                    renderWorkEntryIcon(
                      LeftIcon,
                      cn(
                        compact ? "size-3.5" : "size-4",
                        noticeTone && TRANSCRIPT_NOTICE_TONE_ICON_CLASS_NAME[noticeTone],
                      ),
                    )
                  )}
                </span>
              ) : null}
              <div
                className={cn(
                  "min-w-0 overflow-hidden",
                  // Single-line tool labels size to their content so the disclosure
                  // chevron can sit right after the name; the multi-line markdown
                  // preview still needs the full row width.
                  showInlineAgentTaskPreview && "flex-1",
                )}
              >
                {showInlineAgentTaskPreview ? (
                  <div className={cn(compact ? "space-y-[1px]" : "space-y-0.5")}>
                    <p
                      className={cn("truncate font-medium leading-5", MUTED_LABEL_TEXT_CLASS_NAME)}
                      style={{ fontSize: `${rowFontSizePx}px` }}
                    >
                      <span data-work-entry-display-text="true">{heading}</span>
                      {liveActivityMetaText ? (
                        <LiveActivityMeta
                          text={liveActivityMetaText}
                          ticking={liveActivityTicking}
                        />
                      ) : null}
                    </p>
                    <ChatMarkdown
                      text={preview ?? ""}
                      cwd={markdownCwd}
                      isStreaming={false}
                      className="leading-relaxed"
                      style={{
                        color: MUTED_LABEL_TEXT_COLOR,
                        fontSize: `${Math.max(11, rowFontSizePx - 1)}px`,
                        lineHeight: compact ? "18px" : "19px",
                      }}
                      onImageExpand={onImageExpand}
                    />
                  </div>
                ) : (
                  <p
                    className={cn(
                      compact ? "truncate leading-5" : "truncate leading-6",
                      // Match the leading icon's tone so the row reads as one muted unit, and
                      // brighten the whole row to foreground on hover/focus instead of a fill.
                      WORK_ROW_MUTED_HOVER_TONE["tool-row"],
                      isPlainRuntimeNoticeRow && "italic",
                      noticeTone && TRANSCRIPT_NOTICE_TONE_TEXT_CLASS_NAME[noticeTone],
                    )}
                    data-runtime-notice-row={isPlainRuntimeNoticeRow ? "true" : undefined}
                    data-transcript-notice-kind={notice?.noticeKind}
                    data-transcript-notice-tone={noticeTone ?? undefined}
                    data-codex-status-row={isCodexStatusRow ? "true" : undefined}
                    style={{ fontSize: `${rowFontSizePx}px` }}
                  >
                    <span data-work-entry-display-text="true">{displayText}</span>
                    {noticeStatusLabel ? (
                      <span data-transcript-notice-status="true"> · {noticeStatusLabel}</span>
                    ) : null}
                    {liveActivityMetaText ? (
                      <LiveActivityMeta text={liveActivityMetaText} ticking={liveActivityTicking} />
                    ) : null}
                  </p>
                )}
                {workEntry.steeredMessage ? (
                  <p
                    className={cn(
                      "line-clamp-3 whitespace-pre-wrap break-words",
                      MUTED_LABEL_TEXT_CLASS_NAME,
                    )}
                    style={{ fontSize: `${rowFontSizePx}px` }}
                    data-steered-message="true"
                  >
                    {workEntry.steeredMessage}
                  </p>
                ) : null}
              </div>
            </>
          );
          if (canOpenToolDetails) {
            return (
              <ToolDetailsDisclosure
                forceOpen={workFindActive}
                details={workEntry.toolDetails}
                activity={workEntry.liveActivity}
                detailContent={
                  subagentLaunch ? (
                    <SubagentLaunchDetails
                      view={subagentLaunch}
                      onOpenThread={props.onOpenThread}
                    />
                  ) : providerContextLifecycle ? (
                    <ProviderContextLifecycleDetails info={providerContextLifecycle} />
                  ) : providerHandoff ? (
                    <ProviderHandoffDetails info={providerHandoff} />
                  ) : hasTypedDetails ? (
                    <TypedWorkEntryDetails
                      workEntry={workEntry}
                      markdownCwd={markdownCwd}
                      onImageExpand={onImageExpand}
                    />
                  ) : undefined
                }
                compact={compact}
                timestampFormat={timestampFormat}
                tooltip={toolRowTooltipContent(rawCommand, displayText, displayText)}
                footer={
                  subagentLaunch && onOpenAgentActivity ? (
                    <DetailFooterLinkButton
                      dataAttr="data-open-agent-activity"
                      onClick={() => onOpenAgentActivity(workEntry.id)}
                    >
                      Open activity
                    </DetailFooterLinkButton>
                  ) : openReadFile ? (
                    <DetailFooterLinkButton dataAttr="data-open-read-file" onClick={openReadFile}>
                      Open file
                    </DetailFooterLinkButton>
                  ) : undefined
                }
              >
                {rowContentChildren}
              </ToolDetailsDisclosure>
            );
          }

          const rowContent = (
            <AgentActivityOpenSurface
              canOpen={canOpenAgentActivity || canOpenReadFile}
              compact={compact}
              onOpen={openAgentActivity ?? openReadFile}
              onHover={prefetchReadFile}
              tooltip={toolRowTooltipContent(
                rawCommand,
                displayText,
                canOpenReadFile ? (readFilePath ?? hoverText) : hoverText,
              )}
            >
              {rowContentChildren}
            </AgentActivityOpenSurface>
          );

          return rowContent;
        })()
      )}
      {workEntry.outputFile ? (
        <p
          className={cn("flex min-w-0 items-center gap-1.5", compact ? "pl-5" : "pl-7")}
          style={{ fontSize: `${rowFontSizePx}px` }}
          data-task-output-file="true"
        >
          <span className={MUTED_LABEL_TEXT_CLASS_NAME}>Output</span>
          <InlineMentionChip
            path={workEntry.outputFile}
            theme={resolvedTheme === "dark" ? "dark" : "light"}
            href={workEntry.outputFile}
            onActivate={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openWorkspaceFileReference(
                event.metaKey || event.ctrlKey ? null : opener,
                workEntry.outputFile!,
              );
            }}
          />
        </p>
      ) : null}
    </div>
  );
});

function modelRerouteNotes(reroute: NonNullable<TimelineWorkEntry["modelReroute"]>): string[] {
  const refusal = [reroute.refusalCategory, reroute.refusalExplanation].filter(Boolean).join(": ");
  const retracted = reroute.retractedMessageCount;
  return [
    reroute.reason,
    refusal ? `Refusal: ${refusal}` : undefined,
    retracted
      ? `${retracted === 1 ? "1 earlier reply was" : `${retracted} earlier replies were`} withdrawn`
      : undefined,
  ].filter((note): note is string => Boolean(note));
}

function ModelRerouteDivider(props: {
  reroute: NonNullable<TimelineWorkEntry["modelReroute"]>;
  fallbackLabel: string;
}) {
  const { fromModel, toModel } = props.reroute;
  const label =
    fromModel && toModel
      ? `Switched from ${fromModel} to ${toModel}`
      : toModel
        ? `Switched to ${toModel}`
        : props.fallbackLabel;
  const notes = modelRerouteNotes(props.reroute);
  return (
    <div data-model-reroute-divider="true" className="w-full py-3 font-system-ui">
      <div className="flex w-full items-center gap-4">
        <span aria-hidden className="h-px min-w-0 flex-1 bg-[color:var(--color-border-light)]" />
        <span className="inline-flex min-w-0 shrink items-center gap-2 text-ui-sm text-muted-foreground">
          <HistoryIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{label}</span>
        </span>
        <span aria-hidden className="h-px min-w-0 flex-1 bg-[color:var(--color-border-light)]" />
      </div>
      {notes.length > 0 ? (
        <div className="mt-1.5 space-y-0.5 text-center text-ui-xs text-muted-foreground/72">
          {notes.map((note) => (
            <p
              key={note}
              className="whitespace-pre-wrap break-words"
              data-model-reroute-note="true"
            >
              {note}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DetailFooterLinkButton(props: {
  dataAttr: "data-open-turn-diff" | "data-open-agent-activity" | "data-open-read-file";
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      className="text-ui-sm text-muted-foreground/72 underline-offset-2 hover:text-foreground hover:underline"
      {...{ [props.dataAttr]: "true" }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

// Inner content for an "Edited <file> +n/-m" row. Mirrors the tool-call row treatment
// (muted leading icon + label that brightens to foreground on hover/focus, same font
// size) so edited rows read as the same visual unit. Callers own the interactive wrapper
// (`group/file-row` button or disclosure summary) and pass the diff stat when available.
export function EditedFileRowContent(props: {
  filePath: string;
  additions: number | undefined;
  deletions: number | undefined;
  fontSizePx: number;
  compact: boolean;
  verb?: string;
}) {
  const { filePath, additions, deletions, fontSizePx, compact } = props;
  const verb = props.verb ?? "Edited";
  const hasStat = (additions ?? 0) + (deletions ?? 0) > 0;
  return (
    <>
      <span
        className={cn(
          "flex shrink-0 items-center justify-center",
          WORK_ROW_MUTED_HOVER_TONE["file-row"],
          compact ? "size-4" : "size-5",
        )}
        data-tool-icon="edit"
      >
        <PencilIcon className={compact ? "size-3.5" : "size-4"} />
      </span>
      <span
        className={cn("font-system-ui shrink-0", WORK_ROW_MUTED_HOVER_TONE["file-row"])}
        style={{ fontSize: `${fontSizePx}px` }}
        data-file-change-verb="true"
      >
        {verb}
      </span>
      <span
        className={cn(
          "font-system-ui max-w-[28rem] truncate underline-offset-2",
          WORK_ROW_MUTED_HOVER_TONE["file-row"],
          // Filename doubles as a link affordance: underline on the same row hover/focus.
          "group-hover/file-row:underline group-focus-visible/file-row:underline",
        )}
        style={{ fontSize: `${fontSizePx}px` }}
      >
        {basenameOfPath(filePath)}
      </span>
      {hasStat ? (
        <span
          className="font-system-ui shrink-0 tabular-nums whitespace-nowrap"
          style={{ fontSize: `${fontSizePx}px` }}
        >
          <DiffStat insertions={additions ?? 0} deletions={deletions ?? 0} />
        </span>
      ) : null}
    </>
  );
}

function AgentActivityOpenSurface(props: {
  canOpen: boolean;
  children: ReactNode;
  compact: boolean;
  /** Warm-up hook fired on hover/focus so opening feels instant. */
  onHover?: (() => void) | undefined;
  onOpen?: (() => void) | undefined;
  title?: string | undefined;
  /** Styled frosted hover tooltip (preferred over the native `title`). */
  tooltip?: ReactNode;
  dataToolDetailTrigger?: boolean | undefined;
}) {
  const className = cn(
    "group/tool-row flex w-full items-center text-left transition-[opacity,translate] duration-200",
    props.compact ? "gap-1.5" : "gap-2",
    props.canOpen ? "cursor-pointer focus-visible:outline-none" : "cursor-default",
  );

  // Wrap the real DOM element (not this component) so Base UI's tooltip trigger
  // can attach its hover handlers and compose with our own onClick/onPointerEnter.
  const surface = props.canOpen ? (
    <button
      type="button"
      className={className}
      title={props.title}
      onClick={props.onOpen}
      data-tool-detail-trigger={props.dataToolDetailTrigger ? "true" : undefined}
      {...(props.onHover ? { onPointerEnter: props.onHover, onFocus: props.onHover } : {})}
    >
      {props.children}
    </button>
  ) : (
    <div className={className} title={props.title}>
      {props.children}
    </div>
  );

  return <ToolRowTooltip content={props.tooltip}>{surface}</ToolRowTooltip>;
}

function providerContextLifecycleReasonLabel(
  reason: NonNullable<TimelineWorkEntry["providerContextLifecycle"]>["restartReason"],
): string {
  switch (reason) {
    case "conversation-rebuilt":
      return "Conversation rebuilt from a summary";
    case "fresh-session":
      return "New session started";
    case "interrupt-escalation":
      return "Turn stop escalated to a session restart";
    case "native-history-unavailable":
      return "Previous history unavailable";
    case "native-resume-failed":
      return "Could not resume the previous session";
  }
}

function ProviderContextLifecycleDetails(props: {
  info: NonNullable<TimelineWorkEntry["providerContextLifecycle"]>;
}) {
  const { info } = props;
  const provider =
    PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.kind === info.provider)?.displayName ??
    info.provider;
  return (
    <div className="space-y-3" data-provider-context-lifecycle-details="true">
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg border border-border/45 bg-background/60 px-3 py-2.5 text-ui-sm">
        <dt className="text-muted-foreground/56">Provider</dt>
        <dd className="text-foreground/84">{provider}</dd>
        <dt className="text-muted-foreground/56">Previous history</dt>
        <dd className="text-foreground/84">
          {info.nativeHistory === "available" ? "Available" : "Lost"}
        </dd>
        <dt className="text-muted-foreground/56">Session restarted</dt>
        <dd className="text-foreground/84">{info.sessionRestarted ? "Yes" : "No"}</dd>
        <dt className="text-muted-foreground/56">Why</dt>
        <dd className="text-foreground/84">
          {providerContextLifecycleReasonLabel(info.restartReason)}
        </dd>
        <dt className="text-muted-foreground/56">Summary included</dt>
        <dd className="text-foreground/84">
          {info.recapInjected ? `${info.recapCharacters.toLocaleString()} characters` : "No"}
        </dd>
      </dl>
      {info.recapPreview ? (
        <section className="space-y-2">
          <h3 className="text-ui-sm font-medium text-muted-foreground/56">Summary preview</h3>
          <pre
            className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/45 bg-background/60 px-3 py-2.5 font-chat-code text-chat-code leading-relaxed text-foreground/84"
            data-session-context-recap-preview="true"
          >
            {info.recapPreview}
          </pre>
          {info.recapPreviewTruncated ? (
            <p className="text-ui-xs text-muted-foreground/56">
              Showing a short preview of the summary sent with your message.
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function providerModelLabel(selection: ModelSelection): string {
  const displayName =
    PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.kind === selection.provider)
      ?.displayName ?? selection.provider;
  const summary = resolveThreadModelSummary(selection);
  const modelLabel = summary
    ? `${formatThreadModelSummaryLabel(summary)}${summary.fastMode ? " · Fast" : ""}`
    : selection.model;
  return `${displayName} · ${modelLabel}`;
}

export function ProviderHandoffDetails(props: {
  info: NonNullable<TimelineWorkEntry["providerHandoff"]>;
}) {
  const { info } = props;
  return (
    <div className="space-y-3" data-provider-handoff-details="true">
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg border border-border/45 bg-background/60 px-3 py-2.5 text-ui-sm">
        <dt className="text-muted-foreground/56">From</dt>
        <dd className="text-foreground/84">{providerModelLabel(info.sourceModelSelection)}</dd>
        <dt className="text-muted-foreground/56">To</dt>
        <dd className="text-foreground/84">{providerModelLabel(info.targetModelSelection)}</dd>
        {info.status === "failed" ? (
          <>
            <dt className="text-muted-foreground/56">Error</dt>
            <dd className="text-foreground/84">
              {info.failureDetail ?? "The session did not start."}
            </dd>
          </>
        ) : (
          <>
            <dt className="text-muted-foreground/56">Context</dt>
            <dd className="text-foreground/84">
              {info.contextText ? `${info.contextText.length.toLocaleString()} characters` : "None"}
            </dd>
          </>
        )}
      </dl>
      {info.status === "completed" && info.contextText ? (
        <section className="space-y-2">
          <h3 className="text-ui-sm font-medium text-muted-foreground/56">Transferred context</h3>
          <pre
            className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/45 bg-background/60 px-3 py-2.5 font-chat-code text-chat-code leading-relaxed text-foreground/84"
            data-provider-handoff-context="true"
          >
            {info.contextText}
          </pre>
          <p className="text-ui-xs text-muted-foreground/56">
            Sent ahead of your next message so the new model can continue this thread.
          </p>
        </section>
      ) : null}
    </div>
  );
}

function ToolDetailsDisclosure(props: {
  children: ReactNode;
  compact: boolean;
  dataFileChangeRow?: boolean | undefined;
  details?: TimelineWorkEntry["toolDetails"] | undefined;
  activity?: TimelineWorkEntry["liveActivity"] | undefined;
  detailContent?: ReactNode;
  summaryClassName?: string | undefined;
  timestampFormat: TimestampFormat;
  tooltip?: ReactNode;
  footer?: ReactNode;
  forceOpen?: boolean;
}) {
  const summaryClassName =
    props.summaryClassName ??
    cn(
      "group/tool-row flex w-full items-center text-left transition-[opacity,translate] duration-200",
      props.compact ? "gap-1.5" : "gap-2",
      "cursor-pointer focus-visible:outline-none",
    );
  const [open, setOpen] = useState(props.forceOpen ?? false);
  const [renderDetails, setRenderDetails] = useState(props.forceOpen ?? false);
  const [motionOpen, setMotionOpen] = useState(props.forceOpen ?? false);
  const openFrameRef = useRef<number | null>(null);
  const cleanupTimeoutRef = useRef<number | null>(null);

  const clearMotionTimers = useCallback(() => {
    if (openFrameRef.current !== null) {
      window.cancelAnimationFrame(openFrameRef.current);
      openFrameRef.current = null;
    }
    if (cleanupTimeoutRef.current !== null) {
      window.clearTimeout(cleanupTimeoutRef.current);
      cleanupTimeoutRef.current = null;
    }
  }, []);

  const setDetailsOpen = useCallback(
    (nextOpen: boolean) => {
      clearMotionTimers();
      setOpen(nextOpen);

      if (nextOpen) {
        setRenderDetails(true);
        setMotionOpen(false);
        openFrameRef.current = window.requestAnimationFrame(() => {
          openFrameRef.current = null;
          setMotionOpen(true);
        });
        return;
      }

      setMotionOpen(false);
      cleanupTimeoutRef.current = window.setTimeout(() => {
        cleanupTimeoutRef.current = null;
        setRenderDetails(false);
      }, DISCLOSURE_TRANSITION_MS + DISCLOSURE_CLEANUP_BUFFER_MS);
    },
    [clearMotionTimers],
  );

  useEffect(() => () => clearMotionTimers(), [clearMotionTimers]);
  useEffect(() => {
    if (props.forceOpen) setDetailsOpen(true);
  }, [props.forceOpen, setDetailsOpen]);

  const summaryButton = (
    <button
      type="button"
      className={summaryClassName}
      aria-expanded={open}
      data-file-change-row={props.dataFileChangeRow ? "true" : undefined}
      data-tool-detail-trigger="true"
      onClick={() => {
        setDetailsOpen(!open);
      }}
    >
      {props.children}
      <DisclosureChevron
        open={open}
        className="text-muted-foreground/70 group-hover/tool-row:text-foreground group-hover/file-row:text-foreground group-focus-visible/tool-row:text-foreground group-focus-visible/file-row:text-foreground"
      />
    </button>
  );

  return (
    <div className="group/tool-details min-w-0">
      <ToolRowTooltip content={props.tooltip}>{summaryButton}</ToolRowTooltip>
      {renderDetails ? (
        <DisclosureRegion
          open={motionOpen}
          contentClassName={cn("min-w-0 pt-2", props.compact ? "ml-5" : "ml-7")}
        >
          <div data-tool-details-inline="true">
            {props.detailContent ?? (
              <ToolCallDetailsContent
                details={props.details}
                activity={props.activity}
                timestampFormat={props.timestampFormat}
              />
            )}
            {props.footer ? <div className="pt-2">{props.footer}</div> : null}
          </div>
        </DisclosureRegion>
      ) : null}
    </div>
  );
}

function OpenTurnDiffButton(props: { onOpen: () => void }) {
  return (
    <DetailFooterLinkButton dataAttr="data-open-turn-diff" onClick={props.onOpen}>
      Open in turn diff
    </DetailFooterLinkButton>
  );
}

function TypedFileChangeRows(props: {
  workEntryId: string;
  changes: ReadonlyArray<FileChangeEntry>;
  cwd: string | undefined;
  status: TypedToolRowStatus;
  hiddenCount: number;
  compact: boolean;
  fontSizePx: number;
  fileDiffStatByPath?: ReadonlyMap<string, { additions: number; deletions: number }> | undefined;
  onOpenTurnDiff?: ((filePath: string) => void) | undefined;
  timestampFormat: TimestampFormat;
}) {
  const { compact, onOpenTurnDiff } = props;
  return (
    <div className="space-y-0.5" data-typed-file-change-rows="true">
      {props.changes.map((change, index) => {
        const displayPath = fileChangeDisplayPath(change, props.cwd);
        const movePath = effectiveFileChangeMovePath(change, props.cwd);
        const stat = resolveFileChangeStat(change) ??
          props.fileDiffStatByPath?.get(displayPath) ??
          props.fileDiffStatByPath?.get(change.path) ?? { additions: 0, deletions: 0 };
        const hasDiff = Boolean(change.unifiedDiff?.trim());
        const openDiff = onOpenTurnDiff ? () => onOpenTurnDiff(displayPath) : undefined;
        const rowClassName = cn(
          "group/file-row flex w-full max-w-full items-center text-left transition-colors duration-150",
          compact ? "gap-1.5" : "gap-2",
          hasDiff || openDiff ? "cursor-pointer focus-visible:outline-none" : "cursor-default",
        );
        const tooltipText = movePath ? `${change.path} → ${movePath}` : displayPath;
        const rowChildren = (
          <EditedFileRowContent
            filePath={displayPath}
            additions={stat.additions}
            deletions={stat.deletions}
            fontSizePx={props.fontSizePx}
            compact={compact}
            verb={fileChangeRowVerb(effectiveFileChangeKind(change, props.cwd), props.status)}
          />
        );
        const key = `${props.workEntryId}:${index}:${change.path}`;
        if (hasDiff) {
          return (
            <ToolDetailsDisclosure
              key={key}
              compact={compact}
              tooltip={<span className="whitespace-pre-wrap">{tooltipText}</span>}
              summaryClassName={rowClassName}
              dataFileChangeRow
              timestampFormat={props.timestampFormat}
              detailContent={
                <FileChangeDiffDetails change={change} cwd={props.cwd} onOpenTurnDiff={openDiff} />
              }
            >
              {rowChildren}
            </ToolDetailsDisclosure>
          );
        }
        return (
          <button
            key={key}
            type="button"
            data-file-change-row="true"
            className={rowClassName}
            title={tooltipText}
            disabled={!openDiff}
            onClick={openDiff}
          >
            {rowChildren}
          </button>
        );
      })}
      {props.hiddenCount > 0 ? (
        <p
          className={cn(MUTED_LABEL_TEXT_CLASS_NAME, compact ? "pl-5" : "pl-7")}
          style={{ fontSize: `${props.fontSizePx}px` }}
        >
          {props.hiddenCount === 1 ? "1 more file" : `${props.hiddenCount} more files`}
        </p>
      ) : null}
    </div>
  );
}
