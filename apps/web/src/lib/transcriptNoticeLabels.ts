import type {
  TranscriptNotice,
  TranscriptNoticeKind,
  TranscriptNoticeSeverity,
  TranscriptNoticeStatus,
} from "@synara/contracts";

import {
  BellIcon,
  BotIcon,
  BrainIcon,
  ClockIcon,
  ContextCompactionIcon,
  EyeIcon,
  FileIcon,
  HistoryIcon,
  InfoIcon,
  type LucideIcon,
  McpIcon,
  MessageCircleIcon,
  OctagonAlertIcon,
  PluginIcon,
  RefreshCwIcon,
  SettingsIcon,
  SkillCubeIcon,
  TerminalIcon,
  TriangleAlertIcon,
  WorkflowIcon,
} from "~/lib/icons";

export type TranscriptNoticeTone = "info" | "warning" | "error";

export interface TranscriptNoticePresentation {
  readonly icon: LucideIcon;
  readonly label: string;
}

const NOTICE_PRESENTATION: Record<TranscriptNoticeKind, TranscriptNoticePresentation> = {
  hook: { icon: WorkflowIcon, label: "Hook" },
  "hook-blocked": { icon: OctagonAlertIcon, label: "Hook blocked" },
  "hook-prompt": { icon: MessageCircleIcon, label: "Hook feedback" },
  "skills-changed": { icon: SkillCubeIcon, label: "Skills updated" },
  "mcp-server-status": { icon: McpIcon, label: "MCP servers" },
  "mcp-oauth": { icon: McpIcon, label: "MCP sign-in" },
  "mcp-elicitation": { icon: McpIcon, label: "MCP request" },
  "config-warning": { icon: SettingsIcon, label: "Configuration warning" },
  deprecation: { icon: TriangleAlertIcon, label: "Deprecation notice" },
  "provider-warning": { icon: TriangleAlertIcon, label: "Provider warning" },
  "guardian-warning": { icon: OctagonAlertIcon, label: "Safety warning" },
  "review-mode": { icon: EyeIcon, label: "Review" },
  "auto-approval-review": { icon: EyeIcon, label: "Automatic review" },
  refusal: { icon: OctagonAlertIcon, label: "Request declined" },
  "local-command-output": { icon: TerminalIcon, label: "Command output" },
  notification: { icon: BellIcon, label: "Notification" },
  informational: { icon: InfoIcon, label: "Information" },
  "permission-denied": { icon: OctagonAlertIcon, label: "Permission denied" },
  "memory-recall": { icon: BrainIcon, label: "Recalled from memory" },
  "plugin-install": { icon: PluginIcon, label: "Plugin install" },
  "files-persisted": { icon: FileIcon, label: "Files saved" },
  "thread-reverted": { icon: HistoryIcon, label: "Reverted to an earlier turn" },
  "thread-goal": { icon: InfoIcon, label: "Thread goal" },
  "model-verification": { icon: InfoIcon, label: "Model verification" },
  moderation: { icon: OctagonAlertIcon, label: "Response flagged by moderation" },
  "safety-buffering": { icon: ClockIcon, label: "Running safety checks" },
  "auth-recovery": { icon: RefreshCwIcon, label: "Reconnecting" },
  "compaction-failed": { icon: ContextCompactionIcon, label: "Compaction failed" },
  "subagent-activity": { icon: BotIcon, label: "Subagent activity" },
  sleep: { icon: ClockIcon, label: "Waited" },
  "user-message-injected": { icon: MessageCircleIcon, label: "Message added outside Synara" },
};

export function transcriptNoticePresentation(
  kind: TranscriptNoticeKind,
): TranscriptNoticePresentation {
  return NOTICE_PRESENTATION[kind] ?? { icon: InfoIcon, label: "Notice" };
}

export function transcriptNoticeTone(
  severity: TranscriptNoticeSeverity,
  status?: TranscriptNoticeStatus,
): TranscriptNoticeTone {
  if (severity === "error") return "error";
  if (severity === "warning" || status === "failed" || status === "blocked") return "warning";
  return "info";
}

export const TRANSCRIPT_NOTICE_TONE_ICON_CLASS_NAME: Record<TranscriptNoticeTone, string> = {
  info: "",
  warning: "text-warning",
  error: "text-destructive",
};

export const TRANSCRIPT_NOTICE_TONE_TEXT_CLASS_NAME: Record<TranscriptNoticeTone, string> = {
  info: "",
  warning: "text-warning/90",
  error: "text-destructive/85",
};

const NOTICE_STATUS_LABELS: Partial<Record<TranscriptNoticeStatus, string>> = {
  failed: "Failed",
  blocked: "Blocked",
  cancelled: "Cancelled",
};

export function transcriptNoticeStatusLabel(status: TranscriptNoticeStatus | undefined) {
  return status ? (NOTICE_STATUS_LABELS[status] ?? null) : null;
}

export function transcriptNoticeIsRunning(notice: Pick<TranscriptNotice, "status">): boolean {
  return notice.status === "started" || notice.status === "running";
}

export function isMcpAuthenticationNotice(notice: TranscriptNotice): boolean {
  if (
    notice.noticeKind !== "mcp-server-status" ||
    notice.status === "completed" ||
    /^MCP servers ready\b/i.test(notice.title)
  ) {
    return false;
  }
  if (
    /\b(?:needs authentication|auth(?:entication)?[-_ ]required|needs[-_]auth)[.!]?\s*$/i.test(
      notice.title,
    )
  ) {
    return true;
  }
  return [notice.detail, notice.body].some(
    (text) =>
      text !== undefined &&
      /\b(?:needs authentication|auth(?:entication)?[-_ ]required|needs[-_]auth)\b/i.test(text),
  );
}

interface GroupedHookData {
  readonly count: number;
  readonly hookEvents: ReadonlyArray<string>;
}

export function readGroupedHookNoticeData(notice: TranscriptNotice): GroupedHookData | null {
  if (notice.noticeKind !== "hook") return null;
  const data = notice.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.grouped !== true) return null;
  const hookIds = Array.isArray(record.hookIds) ? record.hookIds : [];
  const count =
    typeof record.count === "number" && Number.isFinite(record.count) && record.count > 0
      ? Math.floor(record.count)
      : hookIds.length;
  if (count <= 0) return null;
  const hookEvents = Array.isArray(record.hookEvents)
    ? [
        ...new Set(
          record.hookEvents.filter(
            (value): value is string => typeof value === "string" && value.trim().length > 0,
          ),
        ),
      ]
    : [];
  return { count, hookEvents };
}

function noticeDataText(notice: TranscriptNotice, key: string): string | null {
  const data = notice.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const GENERIC_HOOK_TITLE_PATTERN = /\blifecycle hook\b/iu;

function hookNoticeTitle(notice: TranscriptNotice): string | null {
  if (notice.noticeKind !== "hook") return null;
  const subject = noticeDataText(notice, "hookEvent") ?? noticeDataText(notice, "hookName");
  if (subject) {
    return transcriptNoticeIsRunning(notice) ? `Running ${subject} hook` : `Ran ${subject} hook`;
  }
  if (!GENERIC_HOOK_TITLE_PATTERN.test(notice.title)) return null;
  return transcriptNoticeIsRunning(notice) ? "Running hook" : "Ran hook";
}

const READY_WORDING_PATTERN = /\bready\b/iu;

function failedMcpServerTitle(notice: TranscriptNotice): string | null {
  if (notice.noticeKind !== "mcp-server-status" || notice.status !== "failed") return null;
  return READY_WORDING_PATTERN.test(notice.title) || notice.title.trim().length === 0
    ? "MCP server unavailable"
    : null;
}

export function transcriptNoticeTitle(notice: TranscriptNotice): string {
  const grouped = readGroupedHookNoticeData(notice);
  if (grouped) {
    return grouped.count === 1 ? "1 hook ran" : `${grouped.count} hooks ran`;
  }
  const derived = hookNoticeTitle(notice) ?? failedMcpServerTitle(notice);
  if (derived) return derived;
  const title = notice.title.trim();
  return title.length > 0 ? title : transcriptNoticePresentation(notice.noticeKind).label;
}

const COMPLETED_CONTEXT_COMPACTION_LABELS: ReadonlySet<string> = new Set([
  "context compacted",
  "context compacted manually",
]);

export function contextCompactionTitle(entry: {
  readonly activityKind?: string | undefined;
  readonly label: string;
  readonly compactionTrigger?: "automatic" | "manual" | undefined;
}): string | null {
  if (entry.activityKind !== "context-compaction" || !entry.compactionTrigger) return null;
  if (!COMPLETED_CONTEXT_COMPACTION_LABELS.has(entry.label.trim().toLowerCase())) return null;
  return entry.compactionTrigger === "automatic"
    ? "Automatically compacted context"
    : "Compacted context";
}
