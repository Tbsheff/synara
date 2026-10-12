import type { CanonicalItemType } from "@synara/contracts";

export type CodexMethodDisposition = "mapped" | "ignored-gated" | "ignored-state";

export const CODEX_NOTIFICATION_DISPOSITIONS = {
  error: "mapped",
  "thread/started": "mapped",
  "thread/status/changed": "mapped",
  "thread/archived": "mapped",
  "thread/deleted": "ignored-state",
  "thread/unarchived": "mapped",
  "thread/closed": "mapped",
  "thread/reverted": "mapped",
  "skills/changed": "mapped",
  "thread/name/updated": "mapped",
  "thread/attachment/updated": "ignored-state",
  "thread/goal/updated": "ignored-state",
  "thread/prediction/updated": "ignored-state",
  "thread/goal/cleared": "ignored-state",
  "thread/queue/changed": "ignored-state",
  "project/changed": "ignored-state",
  "thread/project/updated": "ignored-state",
  "thread/environment/connected": "mapped",
  "thread/environment/disconnected": "mapped",
  "thread/settings/updated": "ignored-state",
  "thread/tokenUsage/updated": "mapped",
  "turn/started": "mapped",
  "hook/started": "mapped",
  "turn/completed": "mapped",
  "hook/completed": "mapped",
  "turn/diff/updated": "mapped",
  "turn/plan/updated": "mapped",
  "item/autoApprovalReview/started": "mapped",
  "item/autoApprovalReview/completed": "mapped",
  "autoApprovalReview/strictReviewRequired": "mapped",
  "rawResponseItem/completed": "ignored-gated",
  "rawResponse/completed": "ignored-gated",
  "item/agentMessage/delta": "mapped",
  "item/plan/delta": "mapped",
  "command/exec/outputDelta": "ignored-gated",
  "process/outputDelta": "ignored-gated",
  "process/exited": "ignored-gated",
  "item/commandExecution/outputDelta": "mapped",
  "item/commandExecution/terminalInteraction": "mapped",
  "item/fileChange/outputDelta": "mapped",
  "item/fileChange/patchUpdated": "mapped",
  "serverRequest/resolved": "mapped",
  "item/mcpToolCall/progress": "mapped",
  "mcpServer/oauthLogin/completed": "mapped",
  "mcpServer/startupStatus/updated": "mapped",
  "mcpServer/event/stream/notification": "ignored-state",
  "account/updated": "mapped",
  "account/gatewayOAuth/changed": "ignored-state",
  "account/rateLimits/updated": "mapped",
  "app/list/updated": "ignored-state",
  "remoteControl/status/changed": "ignored-state",
  "externalAgentConfig/import/progress": "ignored-gated",
  "externalAgentConfig/import/completed": "ignored-gated",
  "fs/changed": "ignored-gated",
  "item/reasoning/summaryTextDelta": "mapped",
  "item/reasoning/summaryPartAdded": "ignored-state",
  "item/reasoning/textDelta": "mapped",
  "thread/compacted": "mapped",
  "model/rerouted": "mapped",
  "model/verification": "mapped",
  "modelProvider/authRecoveryStarted": "mapped",
  "modelProvider/authRecoveryCompleted": "mapped",
  "turn/moderationMetadata": "mapped",
  "model/safetyBuffering/updated": "mapped",
  warning: "mapped",
  guardianWarning: "mapped",
  deprecationNotice: "mapped",
  configWarning: "mapped",
  "fuzzyFileSearch/sessionUpdated": "ignored-gated",
  "fuzzyFileSearch/sessionCompleted": "ignored-gated",
  "thread/realtime/started": "ignored-gated",
  "thread/realtime/itemAdded": "ignored-gated",
  "thread/realtime/item/started": "ignored-gated",
  "thread/realtime/item/transcript/delta": "ignored-gated",
  "thread/realtime/item/completed": "ignored-gated",
  "thread/realtime/transcript/delta": "ignored-gated",
  "thread/realtime/transcript/done": "ignored-gated",
  "thread/realtime/outputAudio/delta": "ignored-gated",
  "thread/realtime/sdp": "ignored-gated",
  "thread/realtime/error": "ignored-gated",
  "thread/realtime/closed": "ignored-gated",
  "windows/worldWritableWarning": "mapped",
  "windowsSandbox/setupCompleted": "mapped",
  "account/login/completed": "ignored-gated",
} as const satisfies Record<string, CodexMethodDisposition>;

export type CodexNotificationMethod = keyof typeof CODEX_NOTIFICATION_DISPOSITIONS;

export const CODEX_ITEM_LIFECYCLE_METHODS = ["item/started", "item/completed"] as const;

export const CODEX_REQUEST_DISPOSITIONS = {
  "item/commandExecution/requestApproval": "mapped",
  "item/fileChange/requestApproval": "mapped",
  "item/tool/requestUserInput": "mapped",
  "mcpServer/elicitation/request": "mapped",
  "item/permissions/requestApproval": "mapped",
  "item/tool/call": "ignored-gated",
  "account/chatgptAuthTokens/refresh": "ignored-gated",
  "attestation/generate": "ignored-gated",
  applyPatchApproval: "ignored-gated",
  execCommandApproval: "ignored-gated",
} as const satisfies Record<string, CodexMethodDisposition>;

export type CodexRequestMethod = keyof typeof CODEX_REQUEST_DISPOSITIONS;

export type CodexItemPresentation = "item" | "notice" | "item-and-notice" | "merge-into-tool";

export interface CodexItemTypeDisposition {
  readonly disposition: CodexMethodDisposition;
  readonly itemType: CanonicalItemType;
  readonly presentation: CodexItemPresentation;
}

export const CODEX_ITEM_TYPE_DISPOSITIONS = {
  userMessage: { disposition: "mapped", itemType: "user_message", presentation: "item-and-notice" },
  hookPrompt: { disposition: "mapped", itemType: "unknown", presentation: "notice" },
  agentMessage: { disposition: "mapped", itemType: "assistant_message", presentation: "item" },
  functionCallOutput: {
    disposition: "mapped",
    itemType: "dynamic_tool_call",
    presentation: "merge-into-tool",
  },
  plan: { disposition: "mapped", itemType: "plan", presentation: "item" },
  reasoning: { disposition: "mapped", itemType: "reasoning", presentation: "item" },
  commandExecution: {
    disposition: "mapped",
    itemType: "command_execution",
    presentation: "item",
  },
  fileChange: { disposition: "mapped", itemType: "file_change", presentation: "item" },
  mcpToolCall: { disposition: "mapped", itemType: "mcp_tool_call", presentation: "item" },
  dynamicToolCall: { disposition: "mapped", itemType: "dynamic_tool_call", presentation: "item" },
  collabAgentToolCall: {
    disposition: "mapped",
    itemType: "collab_agent_tool_call",
    presentation: "item",
  },
  subAgentActivity: { disposition: "mapped", itemType: "unknown", presentation: "notice" },
  webSearch: { disposition: "mapped", itemType: "web_search", presentation: "item" },
  imageView: { disposition: "mapped", itemType: "image_view", presentation: "item" },
  sleep: { disposition: "mapped", itemType: "unknown", presentation: "notice" },
  imageGeneration: { disposition: "mapped", itemType: "image_generation", presentation: "item" },
  enteredReviewMode: {
    disposition: "mapped",
    itemType: "review_entered",
    presentation: "item-and-notice",
  },
  exitedReviewMode: {
    disposition: "mapped",
    itemType: "review_exited",
    presentation: "item-and-notice",
  },
  contextCompaction: {
    disposition: "mapped",
    itemType: "context_compaction",
    presentation: "item",
  },
} as const satisfies Record<string, CodexItemTypeDisposition>;

export type CodexItemType = keyof typeof CODEX_ITEM_TYPE_DISPOSITIONS;

const LEGACY_CODEX_ITEM_TYPE_ALIASES: Readonly<Record<string, CodexItemType>> = {
  usermessage: "userMessage",
  agentmessage: "agentMessage",
  assistantmessage: "agentMessage",
  reasoning: "reasoning",
  plan: "plan",
  commandexecution: "commandExecution",
  filechange: "fileChange",
  mcptoolcall: "mcpToolCall",
  dynamictoolcall: "dynamicToolCall",
  collabagenttoolcall: "collabAgentToolCall",
  collabtoolcall: "collabAgentToolCall",
  websearch: "webSearch",
  imageview: "imageView",
  imagegeneration: "imageGeneration",
  enteredreviewmode: "enteredReviewMode",
  exitedreviewmode: "exitedReviewMode",
  contextcompaction: "contextCompaction",
  hookprompt: "hookPrompt",
  functioncalloutput: "functionCallOutput",
  subagentactivity: "subAgentActivity",
  sleep: "sleep",
};

function hasOwn<T extends object>(record: T, key: string): key is Extract<keyof T, string> {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function codexNotificationDisposition(method: string): CodexMethodDisposition | undefined {
  return hasOwn(CODEX_NOTIFICATION_DISPOSITIONS, method)
    ? CODEX_NOTIFICATION_DISPOSITIONS[method]
    : undefined;
}

export function codexRequestDisposition(method: string): CodexMethodDisposition | undefined {
  return hasOwn(CODEX_REQUEST_DISPOSITIONS, method)
    ? CODEX_REQUEST_DISPOSITIONS[method]
    : undefined;
}

export function resolveCodexItemType(raw: unknown): CodexItemType | undefined {
  if (typeof raw !== "string") return undefined;
  if (hasOwn(CODEX_ITEM_TYPE_DISPOSITIONS, raw)) return raw;
  return LEGACY_CODEX_ITEM_TYPE_ALIASES[raw.replace(/[\s_-]/g, "").toLowerCase()];
}

export function codexItemTypeDisposition(raw: unknown): CodexItemTypeDisposition | undefined {
  const itemType = resolveCodexItemType(raw);
  return itemType ? CODEX_ITEM_TYPE_DISPOSITIONS[itemType] : undefined;
}

export function isIgnoredCodexDisposition(
  disposition: CodexMethodDisposition | undefined,
): boolean {
  return disposition === "ignored-gated" || disposition === "ignored-state";
}
