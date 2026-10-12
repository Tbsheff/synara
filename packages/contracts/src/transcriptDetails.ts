import { Schema } from "effect";
import {
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  RuntimeItemId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";

export const TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS = 20_000;
export const TRANSCRIPT_FILE_DIFF_MAX_CHARS = 20_000;
export const TRANSCRIPT_FILE_CHANGES_MAX_ENTRIES = 50;
export const TRANSCRIPT_TOOL_RESULT_MAX_CHARS = 20_000;
export const TRANSCRIPT_TOOL_ARGUMENTS_MAX_CHARS = 8_000;
export const TRANSCRIPT_NOTICE_BODY_MAX_CHARS = 8_000;
export const TRANSCRIPT_REASONING_MAX_CHARS = 8_000;
export const TRANSCRIPT_LIVE_OUTPUT_MIN_INTERVAL_MS = 250;

const ProviderText = Schema.String;

export const AssistantMessagePhase = Schema.Literals([
  "commentary",
  "partial_answer",
  "final_answer",
]);
export type AssistantMessagePhase = typeof AssistantMessagePhase.Type;

export const TurnOrigin = Schema.Literals(["user", "provider"]);
export type TurnOrigin = typeof TurnOrigin.Type;

export const TurnCompletedActivityHints = Schema.Struct({
  finalAssistantMessageId: Schema.optional(MessageId),
  origin: Schema.optional(TurnOrigin),
});
export type TurnCompletedActivityHints = typeof TurnCompletedActivityHints.Type;

export const TranscriptImageFileRef = Schema.Struct({
  source: Schema.Literal("file"),
  path: ProviderText,
  mediaType: Schema.optional(ProviderText),
  byteLength: Schema.optional(NonNegativeInt),
  width: Schema.optional(NonNegativeInt),
  height: Schema.optional(NonNegativeInt),
  alt: Schema.optional(ProviderText),
});
export type TranscriptImageFileRef = typeof TranscriptImageFileRef.Type;

export const TranscriptImageOmittedRef = Schema.Struct({
  source: Schema.Literal("omitted"),
  mediaType: Schema.optional(ProviderText),
  byteLength: Schema.optional(NonNegativeInt),
  reason: ProviderText,
});
export type TranscriptImageOmittedRef = typeof TranscriptImageOmittedRef.Type;

export const TranscriptImageRef = Schema.Union([TranscriptImageFileRef, TranscriptImageOmittedRef]);
export type TranscriptImageRef = typeof TranscriptImageRef.Type;

export const TranscriptResultBlockRef = Schema.Struct({
  blockType: ProviderText,
  title: Schema.optional(ProviderText),
  uri: Schema.optional(ProviderText),
  mediaType: Schema.optional(ProviderText),
});
export type TranscriptResultBlockRef = typeof TranscriptResultBlockRef.Type;

export const CommandParsedAction = Schema.Struct({
  type: Schema.Literals(["read", "search", "list_files", "unknown"]),
  command: Schema.optional(ProviderText),
  name: Schema.optional(ProviderText),
  path: Schema.optional(ProviderText),
  query: Schema.optional(ProviderText),
});
export type CommandParsedAction = typeof CommandParsedAction.Type;

export const CommandExecutionDetails = Schema.Struct({
  command: Schema.optional(ProviderText),
  cwd: Schema.optional(ProviderText),
  exitCode: Schema.optional(Schema.NullOr(Schema.Int)),
  durationMs: Schema.optional(Schema.Finite),
  interrupted: Schema.optional(Schema.Boolean),
  background: Schema.optional(Schema.Boolean),
  description: Schema.optional(ProviderText),
  output: Schema.optional(ProviderText),
  stdout: Schema.optional(ProviderText),
  stderr: Schema.optional(ProviderText),
  outputTruncated: Schema.optional(Schema.Boolean),
  outputTotalChars: Schema.optional(NonNegativeInt),
  parsedActions: Schema.optional(Schema.Array(CommandParsedAction)),
  lastStdin: Schema.optional(ProviderText),
});
export type CommandExecutionDetails = typeof CommandExecutionDetails.Type;

export const FileChangeKind = Schema.Literals(["add", "update", "delete", "move"]);
export type FileChangeKind = typeof FileChangeKind.Type;

export const FileChangeEntry = Schema.Struct({
  path: ProviderText,
  kind: FileChangeKind,
  movePath: Schema.optional(ProviderText),
  unifiedDiff: Schema.optional(ProviderText),
  diffTruncated: Schema.optional(Schema.Boolean),
  additions: Schema.optional(NonNegativeInt),
  deletions: Schema.optional(NonNegativeInt),
});
export type FileChangeEntry = typeof FileChangeEntry.Type;

export const FileChangeDetails = Schema.Struct({
  changes: Schema.Array(FileChangeEntry),
  changesTruncated: Schema.optional(Schema.Boolean),
  totalFiles: Schema.optional(NonNegativeInt),
});
export type FileChangeDetails = typeof FileChangeDetails.Type;

export const ServerToolKind = Schema.Literals([
  "advisor",
  "web_search",
  "web_fetch",
  "code_execution",
  "bash_code_execution",
  "text_editor_code_execution",
  "tool_search",
  "mcp",
  "other",
]);
export type ServerToolKind = typeof ServerToolKind.Type;

export const ToolCallDetails = Schema.Struct({
  toolName: Schema.optional(ProviderText),
  server: Schema.optional(ProviderText),
  serverToolKind: Schema.optional(ServerToolKind),
  arguments: Schema.optional(Schema.Unknown),
  argumentsTruncated: Schema.optional(Schema.Boolean),
  resultText: Schema.optional(ProviderText),
  resultTruncated: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown),
  error: Schema.optional(ProviderText),
  success: Schema.optional(Schema.Boolean),
  durationMs: Schema.optional(Schema.Finite),
  images: Schema.optional(Schema.Array(TranscriptImageRef)),
  otherBlocks: Schema.optional(Schema.Array(TranscriptResultBlockRef)),
});
export type ToolCallDetails = typeof ToolCallDetails.Type;

export const WebSearchAction = Schema.Struct({
  type: Schema.Literals(["search", "open_page", "find_in_page", "other"]),
  query: Schema.optional(ProviderText),
  url: Schema.optional(ProviderText),
  pattern: Schema.optional(ProviderText),
});
export type WebSearchAction = typeof WebSearchAction.Type;

export const WebSearchResult = Schema.Struct({
  url: ProviderText,
  title: Schema.optional(ProviderText),
});
export type WebSearchResult = typeof WebSearchResult.Type;

export const WebSearchDetails = Schema.Struct({
  query: Schema.optional(ProviderText),
  queries: Schema.optional(Schema.Array(ProviderText)),
  action: Schema.optional(WebSearchAction),
  allowedDomains: Schema.optional(Schema.Array(ProviderText)),
  blockedDomains: Schema.optional(Schema.Array(ProviderText)),
  results: Schema.optional(Schema.Array(WebSearchResult)),
  resultsTruncated: Schema.optional(Schema.Boolean),
  error: Schema.optional(ProviderText),
});
export type WebSearchDetails = typeof WebSearchDetails.Type;

export const ReasoningDetails = Schema.Struct({
  summary: Schema.optional(ProviderText),
  summaryTruncated: Schema.optional(Schema.Boolean),
  heading: Schema.optional(ProviderText),
  redacted: Schema.optional(Schema.Boolean),
  durationMs: Schema.optional(Schema.Finite),
});
export type ReasoningDetails = typeof ReasoningDetails.Type;

export const TranscriptNoticeKind = Schema.Literals([
  "hook",
  "hook-blocked",
  "hook-prompt",
  "skills-changed",
  "mcp-server-status",
  "mcp-oauth",
  "mcp-elicitation",
  "config-warning",
  "deprecation",
  "provider-warning",
  "guardian-warning",
  "review-mode",
  "auto-approval-review",
  "refusal",
  "local-command-output",
  "notification",
  "informational",
  "permission-denied",
  "memory-recall",
  "plugin-install",
  "files-persisted",
  "thread-reverted",
  "thread-goal",
  "model-verification",
  "moderation",
  "safety-buffering",
  "auth-recovery",
  "compaction-failed",
  "subagent-activity",
  "sleep",
  "user-message-injected",
]);
export type TranscriptNoticeKind = typeof TranscriptNoticeKind.Type;

export const TranscriptNoticeSeverity = Schema.Literals(["info", "warning", "error"]);
export type TranscriptNoticeSeverity = typeof TranscriptNoticeSeverity.Type;

export const TranscriptNoticeStatus = Schema.Literals([
  "started",
  "running",
  "completed",
  "failed",
  "blocked",
  "cancelled",
]);
export type TranscriptNoticeStatus = typeof TranscriptNoticeStatus.Type;

export const TranscriptNotice = Schema.Struct({
  noticeKind: TranscriptNoticeKind,
  severity: TranscriptNoticeSeverity,
  title: TrimmedNonEmptyString,
  detail: Schema.optional(ProviderText),
  body: Schema.optional(ProviderText),
  bodyTruncated: Schema.optional(Schema.Boolean),
  status: Schema.optional(TranscriptNoticeStatus),
  dedupeKey: Schema.optional(ProviderText),
  toolUseId: Schema.optional(ProviderText),
  nativeType: Schema.optional(ProviderText),
  data: Schema.optional(Schema.Unknown),
});
export type TranscriptNotice = typeof TranscriptNotice.Type;

export const TRANSCRIPT_NOTICE_ACTIVITY_KIND = "transcript.notice" as const;

export const ToolActivityPayload = Schema.Struct({
  itemType: Schema.optional(ProviderText),
  status: Schema.optional(ProviderText),
  title: Schema.optional(ProviderText),
  detail: Schema.optional(ProviderText),
  toolName: Schema.optional(ProviderText),
  command: Schema.optional(CommandExecutionDetails),
  fileChanges: Schema.optional(FileChangeDetails),
  toolCall: Schema.optional(ToolCallDetails),
  webSearch: Schema.optional(WebSearchDetails),
  reasoning: Schema.optional(ReasoningDetails),
  data: Schema.optional(Schema.Unknown),
});
export type ToolActivityPayload = typeof ToolActivityPayload.Type;

export const ThreadLiveToolOutput = Schema.Struct({
  kind: Schema.Literal("tool-output"),
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  itemId: RuntimeItemId,
  activityId: Schema.optional(EventId),
  streamKind: Schema.Literals(["command_output", "file_change_output"]),
  tail: ProviderText,
  truncated: Schema.Boolean,
  totalChars: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type ThreadLiveToolOutput = typeof ThreadLiveToolOutput.Type;

export const ThreadLiveToolOutputCleared = Schema.Struct({
  kind: Schema.Literal("tool-output-cleared"),
  threadId: ThreadId,
  itemId: RuntimeItemId,
  updatedAt: IsoDateTime,
});
export type ThreadLiveToolOutputCleared = typeof ThreadLiveToolOutputCleared.Type;

export const ThreadLiveUpdate = Schema.Union([ThreadLiveToolOutput, ThreadLiveToolOutputCleared]);
export type ThreadLiveUpdate = typeof ThreadLiveUpdate.Type;
