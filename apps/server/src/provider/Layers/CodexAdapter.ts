/**
 * CodexAdapterLive - Scoped live implementation for the Codex provider adapter.
 *
 * Wraps `CodexAppServerManager` behind the `CodexAdapter` service contract and
 * maps manager failures into the shared `ProviderAdapterError` algebra.
 *
 * @module CodexAdapterLive
 */
import {
  AsyncUserInputQuestions,
  type ChatAttachment,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ModelSelection,
  type ProviderComposerCapabilities,
  type ProviderEvent,
  type ProviderListModelsResult,
  type ProviderListPluginsResult,
  type ProviderReadPluginResult,
  type ProviderSendTurnInput,
  type ProviderListSkillsResult,
  type ProviderRuntimeEvent,
  type ProviderInstanceId,
  type ServerVoiceTranscriptionResult,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  type AssistantMessagePhase,
  type CommandExecutionDetails,
  type CommandParsedAction,
  type FileChangeDetails,
  type FileChangeEntry,
  type FileChangeKind,
  type ItemLifecyclePayload,
  type ReasoningDetails,
  type ToolCallDetails,
  type TranscriptImageRef,
  type TranscriptNotice,
  type TranscriptResultBlockRef,
  type TurnOrigin,
  type WebSearchAction,
  type WebSearchDetails,
  type WebSearchResult,
  EventId,
  RuntimeItemId,
  TRANSCRIPT_FILE_CHANGES_MAX_ENTRIES,
  TRANSCRIPT_FILE_DIFF_MAX_CHARS,
  TRANSCRIPT_NOTICE_BODY_MAX_CHARS,
  TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS,
  TRANSCRIPT_REASONING_MAX_CHARS,
  TRANSCRIPT_TOOL_ARGUMENTS_MAX_CHARS,
  TRANSCRIPT_TOOL_RESULT_MAX_CHARS,
  RuntimeRequestId,
  RuntimeTaskId,
  ProviderApprovalDecision,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Cause, Effect, Layer, Option, Queue, Schema, ServiceMap, Stream } from "effect";
import { splitsSurrogatePair, unicodeSafeEndOffset } from "@synara/shared/text";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { CodexAdapter, type CodexAdapterShape } from "../Services/CodexAdapter.ts";
import {
  PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
  type ProviderThreadActivity,
} from "../Services/ProviderAdapter.ts";
import {
  CodexAppServerManager,
  CodexSessionAuthInvalidatedError,
  CODEX_TURN_ORIGIN_PAYLOAD_KEY,
  classifyCodexMcpTransportLine,
  parseCodexUserInputQuestions,
  type CodexAppServerSendTurnInput,
  type CodexAppServerStartSessionInput,
  type CodexSessionExitPayload,
  type CodexSessionInspection,
} from "../../codexAppServerManager.ts";
import {
  evaluateAcpTurnIdleTick,
  resolveAcpTurnIdleTimeoutMs,
} from "../acp/AcpTurnIdleWatchdog.ts";
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import {
  acquireAgentGatewaySessionLease,
  AGENT_GATEWAY_NO_CAPABILITIES,
  captureAgentGatewayCapabilityInput,
} from "../../agentGateway/sessionLease.ts";
import { filterProviderPromptImageAttachments } from "../promptAttachments.ts";
import { resolveProviderAttachmentPath } from "../providerAttachmentPaths.ts";
import {
  codexGeneratedImageArtifact,
  type CodexGeneratedImageHomeCandidate,
  type CodexGeneratedImageHomeContext,
  extractCodexGeneratedImageReference,
  firstStringValue,
  isCodexGeneratedImageItemType,
  sanitizeNestedCodexGeneratedImagePayloads,
} from "../../codexGeneratedImages.ts";
import {
  CodexSessionStartError,
  isNonFatalCodexErrorMessage,
} from "../../codexErrorClassification.ts";
import { ServerConfig } from "../../config.ts";
import { resolveCodexServiceTier } from "../../codexServiceTier.ts";
import { makeRuntimeTaskListItem } from "../runtimeTaskList.ts";
import { extractProposedPlanMarkdown } from "../planMode.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { synaraSkillsDir } from "../skillsCatalog.ts";
import { makeBoundedCallbackIngress } from "../boundedCallbackIngress.ts";
import { assignDerivedProviderRuntimeEventIds } from "../providerRuntimeEventIdentity.ts";
import {
  compactProviderRuntimeEventForIngress,
  isTerminalProviderRuntimeEvent,
  PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES,
  PROVIDER_RUNTIME_CALLBACK_TERMINAL_RESERVE,
  PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES,
} from "../providerRuntimeEventIngress.ts";
import {
  makeUnmappedProviderEventGate,
  sanitizeUnmappedProviderData,
  sanitizeUnmappedProviderDetail,
  sanitizeUnmappedProviderEvent,
  sanitizeUnmappedProviderNativeType,
} from "../unmappedProviderEvents.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  type CodexItemType,
  codexItemTypeDisposition,
  codexNotificationDisposition,
  codexRequestDisposition,
  isIgnoredCodexDisposition,
  resolveCodexItemType,
} from "../codexMethodDispositions.ts";

const PROVIDER = "codex" as const;

// Backstop for an alive-but-silent codex app-server: if a turn produces no
// activity at all for this long, abort it instead of showing "Working" forever.
// Every turn-scoped event (reasoning, tool output, deltas) resets the clock and
// a pending question/approval pauses it, so only a wedged child trips this.
// Generous by design; override with SYNARA_CODEX_TURN_IDLE_TIMEOUT_MS.
const CODEX_TURN_IDLE_TIMEOUT_MS = resolveAcpTurnIdleTimeoutMs({
  envVar: "SYNARA_CODEX_TURN_IDLE_TIMEOUT_MS",
  defaultMs: 900_000,
});
const CODEX_TURN_WATCHDOG_INTERVAL_MS = 15_000;

interface CodexTurnWatchdogEntry {
  readonly turnId: TurnId;
  lastActivityAt: number;
}

const stampEvent = (event: ProviderEvent, instanceId: string | undefined): ProviderEvent =>
  event.providerInstanceId === undefined && instanceId
    ? { ...event, providerInstanceId: instanceId }
    : event;

type CodexRuntimeIngressItem = {
  readonly nativeEvent: ProviderEvent;
  readonly inspect: () => Promise<CodexSessionInspection | undefined>;
  readonly isAuthRejected: () => boolean;
  readonly validationKey: object | undefined;
  readonly rejectInspection: () => void;
  readonly trustedClose: boolean;
  readonly runtimeEvents: ReadonlyArray<ProviderRuntimeEvent>;
  readonly bytes: number;
};

function compactCodexNativeEventForIngress(event: ProviderEvent): {
  readonly event: ProviderEvent;
  readonly bytes: number;
} {
  let originalBytes: number;
  try {
    originalBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
  } catch {
    originalBytes = PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES + 1;
  }
  if (originalBytes <= PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES) {
    return { event, bytes: originalBytes };
  }
  const compactedEvent: ProviderEvent = {
    ...event,
    payload: {
      synaraTruncated: true,
      reason: "Codex native event exceeded the callback ingress size limit",
      originalBytes,
    },
  };
  let compactedBytes: number;
  try {
    compactedBytes = Buffer.byteLength(JSON.stringify(compactedEvent), "utf8");
  } catch {
    compactedBytes = PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES;
  }
  return { event: compactedEvent, bytes: compactedBytes };
}

export interface CodexAdapterLiveOptions {
  readonly manager?: CodexAppServerManager;
  readonly makeManager?: (services?: ServiceMap.ServiceMap<never>) => CodexAppServerManager;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return sanitizeUserFacingErrorMessage(cause.message, fallback);
  }
  return fallback;
}

function sanitizeUserFacingErrorMessage(message: string, fallback: string): string {
  const normalized = message.trim();
  if (normalized.length === 0) {
    return fallback;
  }

  const firstLine = normalized.split("\n")[0]?.trim() ?? "";
  const withoutInlineStack = firstLine.replace(/\s+at file:\/\/.*$/s, "").trim();
  return withoutInlineStack.length > 0 ? withoutInlineStack : fallback;
}

function composeCodexInputWithFileAttachments(input: {
  readonly input: string | undefined;
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly attachmentsDir: string;
}): string | undefined {
  return appendFileAttachmentsPromptBlock({
    text: input.input,
    attachments: input.attachments,
    attachmentsDir: input.attachmentsDir,
    include: "all-files",
  });
}

function codexModelSelectionOverrides(
  modelSelection: ModelSelection | undefined,
): Pick<CodexAppServerSendTurnInput, "model" | "effort"> &
  Pick<CodexAppServerStartSessionInput, "serviceTier"> {
  if (modelSelection?.provider !== PROVIDER) {
    return {};
  }

  const serviceTier = resolveCodexServiceTier(modelSelection);
  return {
    model: modelSelection.model,
    ...(modelSelection.options?.reasoningEffort !== undefined
      ? { effort: modelSelection.options.reasoningEffort }
      : {}),
    ...(serviceTier !== undefined ? { serviceTier } : {}),
  };
}

function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("unknown provider session")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  // A closed stdin is the transport-level signature of a dead app-server
  // process; treat it as a closed session so callers recover via resume
  // instead of surfacing a raw request failure.
  if (normalized.includes("session is closed") || normalized.includes("stdin closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  const stringValue = asString(value)?.trim();
  return stringValue ? stringValue : undefined;
}

function codexErrorCode(value: unknown): string | undefined {
  const error = asObject(value);
  const code = asTrimmedString(error?.codexErrorInfo) ?? asTrimmedString(error?.codex_error_info);
  return code === "serverOverloaded" ? "server_overloaded" : code;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readCodexSessionExit(
  payload: Record<string, unknown> | undefined,
): CodexSessionExitPayload | undefined {
  const exitKind = payload?.exitKind;
  if (exitKind !== "graceful" && exitKind !== "error") return undefined;
  const turnId = asString(payload?.turnId);
  const signal = asString(payload?.signal);
  return {
    exitCode: asNumber(payload?.exitCode) ?? null,
    signal: (signal as NodeJS.Signals | undefined) ?? null,
    exitKind,
    ...(turnId ? { turnId: TurnId.makeUnsafe(turnId) } : {}),
    ...(payload?.causeAlreadyReported === true ? { causeAlreadyReported: true } : {}),
  };
}

// Keep manager-emitted stderr lines visible without escalating them into a fatal thread error.
function providerErrorMapsToWarning(event: ProviderEvent): boolean {
  return (
    event.kind === "error" &&
    (event.method === "process/stderr" ||
      (event.method === "error" &&
        typeof event.message === "string" &&
        isNonFatalCodexErrorMessage(event.message)))
  );
}

function normalizeCodexTokenUsage(value: unknown): ThreadTokenUsageSnapshot | undefined {
  const usage = asObject(value);
  const totalUsage = asObject(usage?.total_token_usage ?? usage?.total);
  const lastUsage = asObject(usage?.last_token_usage ?? usage?.last);

  const totalProcessedTokens =
    asNumber(totalUsage?.total_tokens) ?? asNumber(totalUsage?.totalTokens);
  const usedTokens =
    asNumber(lastUsage?.total_tokens) ?? asNumber(lastUsage?.totalTokens) ?? totalProcessedTokens;
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  const maxTokens = asNumber(usage?.model_context_window) ?? asNumber(usage?.modelContextWindow);
  const inputTokens = asNumber(lastUsage?.input_tokens) ?? asNumber(lastUsage?.inputTokens);
  const cachedInputTokens =
    asNumber(lastUsage?.cached_input_tokens) ?? asNumber(lastUsage?.cachedInputTokens);
  const outputTokens = asNumber(lastUsage?.output_tokens) ?? asNumber(lastUsage?.outputTokens);
  const reasoningOutputTokens =
    asNumber(lastUsage?.reasoning_output_tokens) ?? asNumber(lastUsage?.reasoningOutputTokens);

  const totalInput = asNumber(totalUsage?.input_tokens) ?? asNumber(totalUsage?.inputTokens);
  const totalOutput = asNumber(totalUsage?.output_tokens) ?? asNumber(totalUsage?.outputTokens);
  const totalCached =
    asNumber(totalUsage?.cached_input_tokens) ?? asNumber(totalUsage?.cachedInputTokens);
  const totalWrites =
    asNumber(totalUsage?.cacheWriteInputTokens) ?? asNumber(totalUsage?.cache_write_input_tokens);
  return {
    usedTokens,
    ...(totalInput !== undefined && totalOutput !== undefined
      ? {
          cumulativeUsage: {
            inputTokens: totalInput,
            outputTokens: totalOutput,
            ...(totalCached !== undefined ? { cachedInputTokens: totalCached } : {}),
            ...(totalWrites !== undefined ? { cacheCreationInputTokens: totalWrites } : {}),
          },
        }
      : {}),
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
      ? { totalProcessedTokens }
      : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(usedTokens !== undefined ? { lastUsedTokens: usedTokens } : {}),
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
    compactsAutomatically: true,
  };
}

function toTurnId(value: string | undefined): TurnId | undefined {
  return value?.trim() ? TurnId.makeUnsafe(value) : undefined;
}

function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return value?.trim() ? ProviderItemId.makeUnsafe(value) : undefined;
}

function toTurnStatus(value: unknown): "completed" | "failed" | "cancelled" | "interrupted" {
  switch (value) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      return "completed";
  }
}

function toCanonicalItemType(raw: unknown): CanonicalItemType {
  if (isCodexGeneratedImageItemType(raw)) return "image_generation";
  return codexItemTypeDisposition(raw)?.itemType ?? "unknown";
}

function toolItemTitle(item: Record<string, unknown> | undefined): string | undefined {
  if (!item) return undefined;
  const appContext = asObject(item.appContext);
  const action =
    asTrimmedString(appContext?.actionName) ??
    asTrimmedString(item.title) ??
    asTrimmedString(item.tool) ??
    asTrimmedString(item.name);
  if (!action) return undefined;

  const appName = asTrimmedString(appContext?.appName);
  if (!appName || action.toLowerCase().includes(appName.toLowerCase())) {
    return action;
  }
  return `${action} in ${appName}`;
}

function itemTitle(
  itemType: CanonicalItemType,
  item?: Record<string, unknown>,
): string | undefined {
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "user_message":
      return "User message";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command_execution":
      return "Ran command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return toolItemTitle(item) ?? "MCP tool call";
    case "dynamic_tool_call":
      return toolItemTitle(item) ?? "Tool call";
    case "web_search":
      return "Web search";
    case "image_generation":
      return "Generated image";
    case "image_view":
      return "Image view";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

function joinedTextParts(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const object = asObject(entry);
      return asString(object?.text) ?? asString(object?.summary);
    })
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function reasoningSummaryDetail(item: Record<string, unknown>): string | undefined {
  return asString(item.summary)?.trim() || joinedTextParts(item.summary);
}

function itemDetail(
  item: Record<string, unknown>,
  payload: Record<string, unknown>,
): string | undefined {
  const nestedResult = asObject(item.result);
  const candidates = [
    asString(item.command),
    asString(item.title),
    asString(item.summary),
    joinedTextParts(item.summary),
    joinedTextParts(item.content),
    asString(item.review),
    asString(item.text),
    asString(item.saved_path),
    asString(item.savedPath),
    asString(item.path),
    asString(item.file_path),
    asString(item.prompt),
    asString(nestedResult?.command),
    asString(payload.command),
    asString(payload.message),
    asString(payload.prompt),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    return trimmed;
  }
  return undefined;
}

function itemStatus(
  lifecycle: "item.started" | "item.updated" | "item.completed",
  rawStatus: unknown,
): "inProgress" | "completed" | "failed" | "declined" | undefined {
  if (lifecycle === "item.started") {
    return "inProgress";
  }
  if (lifecycle === "item.updated") {
    return undefined;
  }
  return rawStatus === "failed" || rawStatus === "declined" ? rawStatus : "completed";
}

function toRequestTypeFromMethod(method: string): CanonicalRequestType {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command_execution_approval";
    case "item/fileRead/requestApproval":
      return "file_read_approval";
    case "item/fileChange/requestApproval":
      return "file_change_approval";
    case "item/permissions/requestApproval":
      return "permissions_approval";
    case "mcpServer/elicitation/request":
      return "tool_approval";
    case "applyPatchApproval":
      return "apply_patch_approval";
    case "execCommandApproval":
      return "exec_command_approval";
    case "item/tool/requestUserInput":
      return "tool_user_input";
    case "item/tool/call":
      return "dynamic_tool_call";
    case "account/chatgptAuthTokens/refresh":
      return "auth_tokens_refresh";
    default:
      return "unknown";
  }
}

function toRequestTypeFromKind(kind: unknown): CanonicalRequestType {
  switch (kind) {
    case "command":
      return "command_execution_approval";
    case "file-read":
      return "file_read_approval";
    case "file-change":
      return "file_change_approval";
    case "permissions":
      return "permissions_approval";
    case "tool":
      return "tool_approval";
    default:
      return "unknown";
  }
}

function toRequestTypeFromResolvedPayload(
  payload: Record<string, unknown> | undefined,
): CanonicalRequestType {
  const request = asObject(payload?.request);
  const method = asString(request?.method) ?? asString(payload?.method);
  if (method) {
    return toRequestTypeFromMethod(method);
  }
  const requestKind = asString(request?.kind) ?? asString(payload?.requestKind);
  if (requestKind) {
    return toRequestTypeFromKind(requestKind);
  }
  return "unknown";
}

function toCanonicalUserInputAnswers(
  answers: ProviderUserInputAnswers | undefined,
): ProviderUserInputAnswers {
  if (!answers) {
    return {};
  }

  const result: Record<string, string | ReadonlyArray<string> | null> = {};
  for (const [questionId, value] of Object.entries(answers)) {
    if (typeof value === "string") {
      result[questionId] = value;
      continue;
    }

    if (Array.isArray(value)) {
      const normalized = value.filter((entry): entry is string => typeof entry === "string");
      result[questionId] = normalized.length === 1 ? normalized[0]! : normalized;
      continue;
    }

    const nestedAnswers = asArray(asObject(value)?.answers);
    if (nestedAnswers) {
      const normalized = nestedAnswers.filter(
        (entry): entry is string => typeof entry === "string",
      );
      result[questionId] = normalized.length === 1 ? normalized[0]! : normalized;
      continue;
    }
  }
  return result;
}

function toThreadState(
  value: unknown,
): "active" | "idle" | "archived" | "closed" | "compacted" | "error" {
  switch (value) {
    case "idle":
      return "idle";
    case "archived":
      return "archived";
    case "closed":
      return "closed";
    case "compacted":
      return "compacted";
    case "error":
    case "failed":
      return "error";
    default:
      return "active";
  }
}

function contentStreamKindFromMethod(
  method: string,
):
  | "assistant_text"
  | "reasoning_text"
  | "reasoning_summary_text"
  | "plan_text"
  | "command_output"
  | "file_change_output" {
  switch (method) {
    case "item/agentMessage/delta":
      return "assistant_text";
    case "item/reasoning/textDelta":
      return "reasoning_text";
    case "item/reasoning/summaryTextDelta":
      return "reasoning_summary_text";
    case "item/commandExecution/outputDelta":
      return "command_output";
    case "item/fileChange/outputDelta":
      return "file_change_output";
    default:
      return "assistant_text";
  }
}

function asRuntimeItemId(itemId: ProviderItemId): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(itemId);
}

function asRuntimeRequestId(requestId: string): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(requestId);
}

function asRuntimeTaskId(taskId: string): RuntimeTaskId {
  return RuntimeTaskId.makeUnsafe(taskId);
}

function codexEventMessage(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return asObject(payload?.msg);
}

function codexEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const payload = asObject(event.payload);
  const msg = codexEventMessage(payload);
  const turnId = event.turnId ?? toTurnId(asString(msg?.turn_id) ?? asString(msg?.turnId));
  const itemId = event.itemId ?? toProviderItemId(asString(msg?.item_id) ?? asString(msg?.itemId));
  const requestId = asString(msg?.request_id) ?? asString(msg?.requestId);
  const base = runtimeEventBase(event, canonicalThreadId);
  const providerRefs = base.providerRefs
    ? {
        ...base.providerRefs,
        ...(turnId ? { providerTurnId: turnId } : {}),
        ...(itemId ? { providerItemId: itemId } : {}),
        ...(requestId ? { providerRequestId: requestId } : {}),
      }
    : {
        ...(turnId ? { providerTurnId: turnId } : {}),
        ...(itemId ? { providerItemId: itemId } : {}),
        ...(requestId ? { providerRequestId: requestId } : {}),
      };

  return {
    ...base,
    ...(turnId ? { turnId } : {}),
    ...(itemId ? { itemId: asRuntimeItemId(itemId) } : {}),
    ...(requestId ? { requestId: asRuntimeRequestId(requestId) } : {}),
    ...(Object.keys(providerRefs).length > 0 ? { providerRefs } : {}),
  };
}

function codexGeneratedImageThreadId(
  event: ProviderEvent,
  payload: Record<string, unknown> | undefined,
): string | undefined {
  const msg = codexEventMessage(payload);
  const nestedEvent = asObject(payload?.event);
  return (
    firstStringValue(msg, ["thread_id", "threadId", "threadID", "thread"]) ??
    firstStringValue(nestedEvent, ["thread_id", "threadId", "threadID", "thread"]) ??
    firstStringValue(payload, ["thread_id", "threadId", "threadID", "thread"]) ??
    event.providerThreadId ??
    event.threadId
  );
}

function sanitizeGeneratedImagePayload(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  codexHome?: CodexGeneratedImageHomeContext,
): unknown {
  const payload = asObject(event.payload);
  return sanitizeNestedCodexGeneratedImagePayloads({
    value: event.payload ?? {},
    threadId: codexGeneratedImageThreadId(event, payload) ?? canonicalThreadId,
    ...(codexHome ? { codexHome } : {}),
  });
}

function withSanitizedGeneratedImageRaw(
  base: Omit<ProviderRuntimeEvent, "type" | "payload">,
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  codexHome?: CodexGeneratedImageHomeContext,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  return {
    ...base,
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: sanitizeGeneratedImagePayload(event, canonicalThreadId, codexHome),
    },
  };
}

function generatedImageEventCandidate(event: ProviderEvent): Record<string, unknown> | undefined {
  const payload = asObject(event.payload);
  const msg = codexEventMessage(payload);
  const item = asObject(payload?.item);
  const nestedEvent = asObject(payload?.event);
  if (item) {
    return item;
  }
  if (msg) {
    return {
      ...msg,
      type: asString(msg.type) ?? "image_generation_end",
    };
  }
  if (nestedEvent) {
    return {
      ...nestedEvent,
      type: asString(nestedEvent.type) ?? "image_generation_end",
    };
  }
  if (payload) {
    return {
      ...payload,
      type: asString(payload.type) ?? "image_generation_end",
    };
  }
  return undefined;
}

function mapGeneratedImageEndEvent(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  codexHome?: CodexGeneratedImageHomeContext,
): ProviderRuntimeEvent | undefined {
  if (
    event.method !== "codex/event/image_generation_end" &&
    event.method !== "image_generation_end"
  ) {
    return undefined;
  }
  const payload = asObject(event.payload);
  const candidate = generatedImageEventCandidate(event);
  const reference = extractCodexGeneratedImageReference({
    value: candidate,
    threadId: codexGeneratedImageThreadId(event, payload) ?? canonicalThreadId,
    ...(codexHome ? { codexHome } : {}),
  });
  if (!reference) {
    return undefined;
  }

  const turnId =
    event.turnId ??
    toTurnId(
      firstStringValue(candidate, ["turn_id", "turnId"]) ??
        firstStringValue(payload, ["turn_id", "turnId"]),
    );
  const itemId =
    event.itemId ??
    toProviderItemId(
      firstStringValue(candidate, ["item_id", "itemId", "call_id", "callId", "id"]) ??
        firstStringValue(payload, ["item_id", "itemId", "call_id", "callId", "id"]),
    );
  const base = withSanitizedGeneratedImageRaw(
    {
      ...runtimeEventBase(
        {
          ...event,
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
        },
        canonicalThreadId,
      ),
      ...(turnId ? { turnId } : {}),
      ...(itemId ? { itemId: asRuntimeItemId(itemId) } : {}),
    },
    event,
    canonicalThreadId,
    codexHome,
  );

  return {
    ...base,
    type: "item.completed",
    payload: {
      itemType: "image_generation",
      status: "completed",
      title: "Generated image",
      detail: reference.path,
      data: codexGeneratedImageArtifact(reference),
    },
  };
}

function eventRawSource(event: ProviderEvent): NonNullable<ProviderRuntimeEvent["raw"]>["source"] {
  return event.kind === "request" ? "codex.app-server.request" : "codex.app-server.notification";
}

function providerRefsFromEvent(
  event: ProviderEvent,
): ProviderRuntimeEvent["providerRefs"] | undefined {
  const refs: Record<string, string> = {};
  if (event.providerThreadId) refs.providerThreadId = event.providerThreadId;
  if (event.providerParentThreadId) refs.providerParentThreadId = event.providerParentThreadId;
  if (event.turnId) refs.providerTurnId = event.turnId;
  if (event.parentTurnId) refs.parentProviderTurnId = event.parentTurnId;
  if (event.itemId) refs.providerItemId = event.itemId;
  if (event.requestId) refs.providerRequestId = event.requestId;

  return Object.keys(refs).length > 0 ? (refs as ProviderRuntimeEvent["providerRefs"]) : undefined;
}

function runtimeEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const refs = providerRefsFromEvent(event);
  return {
    eventId: event.id,
    provider: event.provider,
    threadId: canonicalThreadId,
    createdAt: event.createdAt,
    ...(event.lifecycleGeneration !== undefined
      ? { lifecycleGeneration: event.lifecycleGeneration }
      : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.parentTurnId ? { parentTurnId: event.parentTurnId } : {}),
    ...(event.itemId ? { itemId: asRuntimeItemId(event.itemId) } : {}),
    ...(event.requestId ? { requestId: asRuntimeRequestId(event.requestId) } : {}),
    ...(event.providerInstanceId ? { providerInstanceId: event.providerInstanceId } : {}),
    ...(refs ? { providerRefs: refs } : {}),
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: event.payload ?? {},
    },
  };
}

function runtimeDeltaEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  return withMinimalRawPayload(runtimeEventBase(event, canonicalThreadId), event);
}

function codexDeltaEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  return withMinimalRawPayload(codexEventBase(event, canonicalThreadId), event);
}

function withMinimalRawPayload(
  base: Omit<ProviderRuntimeEvent, "type" | "payload">,
  event: ProviderEvent,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  return {
    ...base,
    raw: {
      source: base.raw?.source ?? eventRawSource(event),
      ...(base.raw?.method !== undefined ? { method: base.raw.method } : {}),
      ...(base.raw?.messageType !== undefined ? { messageType: base.raw.messageType } : {}),
      payload: {},
    },
  };
}

const NOTICE_TITLE_MAX_CHARS = 200;
const COMMAND_STDIN_MAX_CHARS = 1_000;
const COMMAND_PARSED_ACTIONS_MAX_ENTRIES = 20;
const WEB_SEARCH_RESULTS_MAX_ENTRIES = 50;
const CODEX_TOOL_IMAGE_OMITTED_REASON = "Tool result images are not stored in the transcript yet.";

type ItemLifecycle = "item.started" | "item.updated" | "item.completed";
type TypedItemFields = Pick<
  ItemLifecyclePayload,
  "phase" | "toolName" | "command" | "fileChanges" | "toolCall" | "webSearch" | "reasoning"
>;

function capHead(value: string, maxChars: number): { text: string; truncated: boolean } {
  return value.length > maxChars
    ? { text: value.slice(0, unicodeSafeEndOffset(value, maxChars)), truncated: true }
    : { text: value, truncated: false };
}

function capTail(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  const start = value.length - maxChars;
  return {
    text: value.slice(splitsSurrogatePair(value, start) ? start + 1 : start),
    truncated: true,
  };
}

function asNonNegativeFinite(value: unknown): number | undefined {
  const number = asNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function redactProviderText(
  value: string,
  maxChars: number,
): { readonly text: string; readonly truncated: boolean } {
  const capped = capHead(value, maxChars);
  const redacted = sanitizeUnmappedProviderData(capped.text);
  if (typeof redacted === "string") {
    return { text: redacted, truncated: capped.truncated };
  }
  return { text: sanitizeUnmappedProviderDetail(capped.text) ?? "", truncated: true };
}

function noticeTitle(value: string | undefined, fallback: string): string {
  const collapsed = value === undefined ? "" : value.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return fallback;
  const redacted = redactProviderText(collapsed, NOTICE_TITLE_MAX_CHARS * 2).text.trim();
  if (redacted.length === 0) return fallback;
  if (redacted.length <= NOTICE_TITLE_MAX_CHARS) return redacted;
  const capped = redacted.slice(0, NOTICE_TITLE_MAX_CHARS - 1).trimEnd();
  return capped.length > 0 ? `${capped}…` : fallback;
}

function noticeBody(
  value: string | undefined,
): Pick<TranscriptNotice, "body" | "bodyTruncated"> | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const redacted = redactProviderText(value, TRANSCRIPT_NOTICE_BODY_MAX_CHARS);
  return redacted.truncated
    ? { body: redacted.text, bodyTruncated: true }
    : { body: redacted.text };
}

function noticeDetail(value: string | undefined): Pick<TranscriptNotice, "detail"> | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  return { detail: redactProviderText(value.trim(), TRANSCRIPT_NOTICE_BODY_MAX_CHARS).text };
}

function stableTextKey(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function lifecycleGenerationKey(event: ProviderEvent): string {
  return event.lifecycleGeneration ?? "session";
}

function withSanitizedRaw(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  return {
    ...runtimeEventBase(event, canonicalThreadId),
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: { synaraSanitized: true },
    },
  };
}

function transcriptNoticeEvent(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  notice: TranscriptNotice,
): ProviderRuntimeEvent {
  return {
    ...withSanitizedRaw(event, canonicalThreadId),
    type: "transcript.notice",
    payload: { ...notice, nativeType: notice.nativeType ?? event.method },
  };
}

function codexParsedActions(value: unknown): CommandParsedAction[] | undefined {
  const actions = asArray(value);
  if (!actions) return undefined;
  const parsed = actions
    .slice(0, COMMAND_PARSED_ACTIONS_MAX_ENTRIES)
    .flatMap((entry): CommandParsedAction[] => {
      const action = asObject(entry);
      if (!action) return [];
      const command = asString(action.command);
      const path = asString(action.path);
      const base = command !== undefined ? { command } : {};
      switch (action.type) {
        case "read": {
          const name = asString(action.name);
          return [
            {
              type: "read" as const,
              ...base,
              ...(name !== undefined ? { name } : {}),
              ...(path !== undefined ? { path } : {}),
            },
          ];
        }
        case "listFiles":
        case "list_files":
          return [
            { type: "list_files" as const, ...base, ...(path !== undefined ? { path } : {}) },
          ];
        case "search": {
          const query = asString(action.query);
          return [
            {
              type: "search" as const,
              ...base,
              ...(query !== undefined ? { query } : {}),
              ...(path !== undefined ? { path } : {}),
            },
          ];
        }
        default:
          return [{ type: "unknown" as const, ...base }];
      }
    });
  return parsed.length > 0 ? parsed : undefined;
}

function codexCommandDetails(
  item: Record<string, unknown>,
  lifecycle: ItemLifecycle,
): CommandExecutionDetails | undefined {
  const command = asString(item.command);
  const cwd = asString(item.cwd);
  const parsedActions = codexParsedActions(item.commandActions);
  const settled = lifecycle === "item.completed";
  const exitCode =
    item.exitCode === null
      ? null
      : typeof item.exitCode === "number" && Number.isInteger(item.exitCode)
        ? item.exitCode
        : undefined;
  const durationMs = asNonNegativeFinite(item.durationMs);
  const output = asString(item.aggregatedOutput);
  const cappedOutput =
    output !== undefined ? capTail(output, TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS) : undefined;
  const details: CommandExecutionDetails = {
    ...(command !== undefined ? { command } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(settled && exitCode !== undefined ? { exitCode } : {}),
    ...(settled && durationMs !== undefined ? { durationMs } : {}),
    ...(cappedOutput !== undefined && output !== undefined
      ? {
          output: cappedOutput.text,
          outputTotalChars: output.length,
          ...(cappedOutput.truncated ? { outputTruncated: true } : {}),
        }
      : {}),
    ...(parsedActions ? { parsedActions } : {}),
  };
  return Object.keys(details).length > 0 ? details : undefined;
}

function looksLikeUnifiedDiff(value: string): boolean {
  return value.startsWith("@@") || value.startsWith("--- ") || value.startsWith("diff --git ");
}

function contentLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function synthesizeWholeFileDiff(kind: "add" | "delete", path: string, content: string): string {
  const lines = contentLines(content);
  if (kind === "add") {
    return [
      "--- /dev/null",
      `+++ b/${path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
    ].join("\n");
  }
  return [
    `--- a/${path}`,
    "+++ /dev/null",
    `@@ -1,${lines.length} +0,0 @@`,
    ...lines.map((line) => `-${line}`),
  ].join("\n");
}

function countUnifiedDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

function codexFileChangeKind(record: Record<string, unknown>):
  | {
      kind: FileChangeKind;
      movePath?: string;
    }
  | undefined {
  const kindRecord = asObject(record.kind);
  const kindType = asString(kindRecord?.type) ?? asString(record.kind);
  const movePath =
    asTrimmedString(kindRecord?.move_path) ??
    asTrimmedString(kindRecord?.movePath) ??
    asTrimmedString(record.move_path) ??
    asTrimmedString(record.movePath);
  switch (kindType) {
    case "add":
    case "delete":
      return { kind: kindType };
    case "update":
      return movePath ? { kind: "move", movePath } : { kind: "update" };
    case "move":
      return movePath ? { kind: "move", movePath } : { kind: "update" };
    default:
      return undefined;
  }
}

function codexFileChangeEntry(value: unknown): FileChangeEntry | undefined {
  const record = asObject(value);
  const path = asString(record?.path);
  if (!record || !path || path.trim().length === 0) return undefined;
  const kind = codexFileChangeKind(record);
  if (!kind) return undefined;
  const rawDiff = asString(record.diff);
  const unifiedDiff =
    rawDiff === undefined
      ? undefined
      : (kind.kind === "add" || kind.kind === "delete") && !looksLikeUnifiedDiff(rawDiff)
        ? synthesizeWholeFileDiff(kind.kind, path, rawDiff)
        : rawDiff;
  const counts = unifiedDiff !== undefined ? countUnifiedDiffLines(unifiedDiff) : undefined;
  const cappedDiff =
    unifiedDiff !== undefined ? capHead(unifiedDiff, TRANSCRIPT_FILE_DIFF_MAX_CHARS) : undefined;
  return {
    path,
    kind: kind.kind,
    ...(kind.movePath !== undefined ? { movePath: kind.movePath } : {}),
    ...(cappedDiff !== undefined
      ? {
          unifiedDiff: cappedDiff.text,
          ...(cappedDiff.truncated ? { diffTruncated: true } : {}),
        }
      : {}),
    ...(counts ? { additions: counts.additions, deletions: counts.deletions } : {}),
  };
}

function codexFileChangeDetails(value: unknown): FileChangeDetails | undefined {
  const entries = asArray(value);
  if (!entries) return undefined;
  const changes = entries.flatMap((entry) => {
    const change = codexFileChangeEntry(entry);
    return change ? [change] : [];
  });
  if (changes.length === 0) return undefined;
  return {
    changes: changes.slice(0, TRANSCRIPT_FILE_CHANGES_MAX_ENTRIES),
    totalFiles: changes.length,
    ...(changes.length > TRANSCRIPT_FILE_CHANGES_MAX_ENTRIES ? { changesTruncated: true } : {}),
  };
}

function cappedToolArguments(
  value: unknown,
): Pick<ToolCallDetails, "arguments" | "argumentsTruncated"> | undefined {
  if (value === undefined || value === null) return undefined;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined) return undefined;
  if (serialized.length <= TRANSCRIPT_TOOL_ARGUMENTS_MAX_CHARS) return { arguments: value };
  return {
    arguments: serialized.slice(0, TRANSCRIPT_TOOL_ARGUMENTS_MAX_CHARS),
    argumentsTruncated: true,
  };
}

function cappedStructuredContent(
  value: unknown,
): Pick<ToolCallDetails, "structuredContent" | "resultTruncated"> | undefined {
  if (value === undefined || value === null) return undefined;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined) return undefined;
  return serialized.length <= TRANSCRIPT_TOOL_RESULT_MAX_CHARS
    ? { structuredContent: value }
    : { resultTruncated: true };
}

function dataUrlMediaType(value: string | undefined): string | undefined {
  const match = value === undefined ? null : /^data:([^;,]+)[;,]/.exec(value);
  return match?.[1];
}

function base64ByteLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const base64 = value.startsWith("data:") ? value.slice(value.indexOf(",") + 1) : value;
  return Math.floor((base64.length * 3) / 4);
}

function omittedImage(
  mediaType: string | undefined,
  byteLength: number | undefined,
): TranscriptImageRef {
  return {
    source: "omitted",
    ...(mediaType !== undefined ? { mediaType } : {}),
    ...(byteLength !== undefined ? { byteLength } : {}),
    reason: CODEX_TOOL_IMAGE_OMITTED_REASON,
  };
}

interface ToolResultParts {
  readonly texts: string[];
  readonly images: TranscriptImageRef[];
  readonly otherBlocks: TranscriptResultBlockRef[];
}

function emptyToolResultParts(): ToolResultParts {
  return { texts: [], images: [], otherBlocks: [] };
}

function collectMcpContentBlock(parts: ToolResultParts, value: unknown): void {
  const block = asObject(value);
  if (!block) return;
  const type = asString(block.type);
  if (type === "text") {
    const text = asString(block.text);
    if (text !== undefined) parts.texts.push(text);
    return;
  }
  if (type === "image") {
    const mediaType = asString(block.mimeType) ?? asString(block.mime_type);
    parts.images.push(omittedImage(mediaType, base64ByteLength(asString(block.data))));
    return;
  }
  const resource = asObject(block.resource);
  const uri = asString(resource?.uri) ?? asString(block.uri);
  const title = asString(block.title) ?? asString(block.name) ?? asString(resource?.name);
  const mediaType =
    asString(resource?.mimeType) ?? asString(block.mimeType) ?? asString(block.mime_type);
  parts.otherBlocks.push({
    blockType: type ?? "unknown",
    ...(title !== undefined ? { title } : {}),
    ...(uri !== undefined ? { uri } : {}),
    ...(mediaType !== undefined ? { mediaType } : {}),
  });
}

function collectInputContentItem(parts: ToolResultParts, value: unknown): void {
  const entry = asObject(value);
  if (!entry) return;
  switch (entry.type) {
    case "inputText":
    case "input_text": {
      const text = asString(entry.text);
      if (text !== undefined) parts.texts.push(text);
      return;
    }
    case "inputImage":
    case "input_image": {
      const imageUrl = asString(entry.imageUrl) ?? asString(entry.image_url);
      const isDataUrl = imageUrl?.startsWith("data:") === true;
      parts.images.push(
        omittedImage(
          dataUrlMediaType(imageUrl),
          isDataUrl ? base64ByteLength(imageUrl) : undefined,
        ),
      );
      return;
    }
    case "inputAudio":
    case "input_audio":
      parts.otherBlocks.push({ blockType: "audio" });
      return;
    default:
      return;
  }
}

function toolResultFields(parts: ToolResultParts): Partial<ToolCallDetails> {
  const resultText = parts.texts.length > 0 ? parts.texts.join("\n\n") : undefined;
  const cappedText =
    resultText !== undefined ? capHead(resultText, TRANSCRIPT_TOOL_RESULT_MAX_CHARS) : undefined;
  return {
    ...(cappedText !== undefined
      ? { resultText: cappedText.text, ...(cappedText.truncated ? { resultTruncated: true } : {}) }
      : {}),
    ...(parts.images.length > 0 ? { images: parts.images } : {}),
    ...(parts.otherBlocks.length > 0 ? { otherBlocks: parts.otherBlocks } : {}),
  };
}

function codexMcpToolCallDetails(
  item: Record<string, unknown>,
  lifecycle: ItemLifecycle,
): ToolCallDetails {
  const toolName = asTrimmedString(item.tool);
  const server = asTrimmedString(item.server);
  const result = asObject(item.result);
  const parts = emptyToolResultParts();
  for (const block of asArray(result?.content) ?? []) collectMcpContentBlock(parts, block);
  const error = asTrimmedString(asObject(item.error)?.message) ?? asTrimmedString(item.error);
  const durationMs = asNonNegativeFinite(item.durationMs);
  const resultFields = toolResultFields(parts);
  const structured = cappedStructuredContent(result?.structuredContent);
  return {
    ...(toolName !== undefined ? { toolName } : {}),
    ...(server !== undefined ? { server } : {}),
    ...cappedToolArguments(item.arguments),
    ...resultFields,
    ...(structured?.structuredContent !== undefined
      ? { structuredContent: structured.structuredContent }
      : {}),
    ...(structured?.resultTruncated || resultFields.resultTruncated
      ? { resultTruncated: true }
      : {}),
    ...(error !== undefined ? { error } : {}),
    ...(lifecycle === "item.completed"
      ? { success: error === undefined && item.status !== "failed" }
      : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function codexDynamicToolCallDetails(item: Record<string, unknown>): ToolCallDetails {
  const toolName = asTrimmedString(item.tool);
  const namespace = asTrimmedString(item.namespace);
  const parts = emptyToolResultParts();
  for (const entry of asArray(item.contentItems) ?? []) collectInputContentItem(parts, entry);
  const durationMs = asNonNegativeFinite(item.durationMs);
  return {
    ...(toolName !== undefined ? { toolName } : {}),
    ...(namespace !== undefined ? { server: namespace } : {}),
    ...cappedToolArguments(item.arguments),
    ...toolResultFields(parts),
    ...(typeof item.success === "boolean" ? { success: item.success } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function codexFunctionCallOutputDetails(item: Record<string, unknown>): ToolCallDetails {
  const toolName = asTrimmedString(item.name);
  const namespace = asTrimmedString(item.namespace);
  const parts = emptyToolResultParts();
  const output = item.output;
  if (typeof output === "string") {
    parts.texts.push(output);
  } else {
    for (const entry of asArray(output) ?? []) collectInputContentItem(parts, entry);
  }
  return {
    ...(toolName !== undefined ? { toolName } : {}),
    ...(namespace !== undefined ? { server: namespace } : {}),
    ...toolResultFields(parts),
  };
}

function codexWebSearchAction(value: unknown): WebSearchAction | undefined {
  const action = asObject(value);
  if (!action) return undefined;
  const query = asTrimmedString(action.query);
  const url = asTrimmedString(action.url);
  const pattern = asTrimmedString(action.pattern);
  switch (action.type) {
    case "search":
      return { type: "search", ...(query !== undefined ? { query } : {}) };
    case "openPage":
    case "open_page":
      return { type: "open_page", ...(url !== undefined ? { url } : {}) };
    case "findInPage":
    case "find_in_page":
      return {
        type: "find_in_page",
        ...(url !== undefined ? { url } : {}),
        ...(pattern !== undefined ? { pattern } : {}),
      };
    case "other":
      return { type: "other" };
    default:
      return undefined;
  }
}

function codexWebSearchDetails(item: Record<string, unknown>): WebSearchDetails | undefined {
  const query = asTrimmedString(item.query);
  const actionRecord = asObject(item.action);
  const action = codexWebSearchAction(actionRecord);
  const queries = (asArray(actionRecord?.queries) ?? []).flatMap((entry) => {
    const value = asTrimmedString(entry);
    return value !== undefined ? [value] : [];
  });
  const results: WebSearchResult[] = (asArray(item.results) ?? []).flatMap((entry) => {
    const result = asObject(entry);
    const url = asTrimmedString(result?.url);
    if (!url) return [];
    const title = asTrimmedString(result?.title);
    return [{ url, ...(title !== undefined ? { title } : {}) }];
  });
  const details: WebSearchDetails = {
    ...(query !== undefined ? { query } : {}),
    ...(queries.length > 0 ? { queries } : {}),
    ...(action !== undefined ? { action } : {}),
    ...(results.length > 0 ? { results: results.slice(0, WEB_SEARCH_RESULTS_MAX_ENTRIES) } : {}),
    ...(results.length > WEB_SEARCH_RESULTS_MAX_ENTRIES ? { resultsTruncated: true } : {}),
  };
  return Object.keys(details).length > 0 ? details : undefined;
}

function codexReasoningDetails(item: Record<string, unknown>): ReasoningDetails | undefined {
  const summary = reasoningSummaryDetail(item);
  if (summary === undefined) return undefined;
  const capped = capHead(summary, TRANSCRIPT_REASONING_MAX_CHARS);
  return { summary: capped.text, ...(capped.truncated ? { summaryTruncated: true } : {}) };
}

function codexMessagePhase(value: unknown): AssistantMessagePhase | undefined {
  return value === "commentary" || value === "partial_answer" || value === "final_answer"
    ? value
    : undefined;
}

function codexItemTypedFields(
  nativeType: CodexItemType | undefined,
  item: Record<string, unknown>,
  lifecycle: ItemLifecycle,
): TypedItemFields {
  switch (nativeType) {
    case "agentMessage": {
      const phase = codexMessagePhase(item.phase);
      return phase ? { phase } : {};
    }
    case "commandExecution": {
      const command = codexCommandDetails(item, lifecycle);
      return command ? { command } : {};
    }
    case "fileChange": {
      const fileChanges = codexFileChangeDetails(item.changes);
      return fileChanges ? { fileChanges } : {};
    }
    case "mcpToolCall": {
      const toolCall = codexMcpToolCallDetails(item, lifecycle);
      return { ...(toolCall.toolName ? { toolName: toolCall.toolName } : {}), toolCall };
    }
    case "dynamicToolCall": {
      const toolCall = codexDynamicToolCallDetails(item);
      return { ...(toolCall.toolName ? { toolName: toolCall.toolName } : {}), toolCall };
    }
    case "webSearch": {
      const webSearch = codexWebSearchDetails(item);
      return webSearch ? { webSearch } : {};
    }
    case "imageView": {
      const path = asTrimmedString(item.path);
      return path ? { toolCall: { images: [{ source: "file", path }] } } : {};
    }
    case "reasoning": {
      if (lifecycle !== "item.completed") return {};
      const reasoning = codexReasoningDetails(item);
      return reasoning ? { reasoning } : {};
    }
    default:
      return {};
  }
}

function withoutKeys(
  record: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): Record<string, unknown> {
  const next = { ...record };
  for (const key of keys) delete next[key];
  return next;
}

function stripPromotedItemFields(
  nativeType: CodexItemType | undefined,
  item: Record<string, unknown>,
): Record<string, unknown> | undefined {
  switch (nativeType) {
    case "commandExecution":
      return withoutKeys(item, ["aggregatedOutput"]);
    case "fileChange":
      return {
        ...item,
        changes: (asArray(item.changes) ?? []).map((entry) => {
          const change = asObject(entry);
          return change ? withoutKeys(change, ["diff"]) : entry;
        }),
      };
    case "mcpToolCall":
      return withoutKeys(item, ["result"]);
    case "dynamicToolCall":
      return withoutKeys(item, ["contentItems"]);
    default:
      return undefined;
  }
}

function itemLifecycleData(event: ProviderEvent, nativeType: CodexItemType | undefined): unknown {
  const payload = asObject(event.payload);
  const item = asObject(payload?.item);
  const strippedItem = item ? stripPromotedItemFields(nativeType, item) : undefined;
  return strippedItem && payload ? { ...payload, item: strippedItem } : event.payload;
}

function mapItemLifecycle(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: ItemLifecycle,
  codexHome?: CodexGeneratedImageHomeContext,
): ProviderRuntimeEvent | undefined {
  const payload = asObject(event.payload);
  const item = asObject(payload?.item);
  const source = item ?? payload;
  if (!source) {
    return undefined;
  }

  const rawItemType = source.type ?? source.kind;
  const itemType = toCanonicalItemType(rawItemType);
  if (itemType === "unknown") {
    return undefined;
  }
  const nativeType = resolveCodexItemType(rawItemType);
  const generatedImageReference =
    itemType === "image_generation"
      ? extractCodexGeneratedImageReference({
          value: source,
          threadId: codexGeneratedImageThreadId(event, payload) ?? canonicalThreadId,
          ...(codexHome ? { codexHome } : {}),
        })
      : undefined;
  if (
    lifecycle === "item.completed" &&
    itemType === "image_generation" &&
    !generatedImageReference
  ) {
    return undefined;
  }

  const canonicalItemType =
    lifecycle === "item.completed" && itemType === "review_exited" ? "assistant_message" : itemType;

  const detail =
    itemType === "reasoning" ? reasoningSummaryDetail(source) : itemDetail(source, payload ?? {});
  const status = itemStatus(lifecycle, source.status);
  const title = itemTitle(canonicalItemType, source);
  const asyncQuestions =
    itemType === "assistant_message" && Array.isArray(source.questions)
      ? Schema.decodeUnknownOption(AsyncUserInputQuestions)(
          source.questions.map((value: unknown) => {
            const question = asObject(value);
            return question
              ? question.options == null
                ? { title: question.title }
                : { title: question.title, options: question.options }
              : value;
          }),
        )
      : Option.none();
  const typedFields = item ? codexItemTypedFields(nativeType, item, lifecycle) : {};
  const data = generatedImageReference
    ? codexGeneratedImageArtifact(generatedImageReference)
    : itemLifecycleData(event, nativeType);
  const base = generatedImageReference
    ? withSanitizedGeneratedImageRaw(
        runtimeEventBase(event, canonicalThreadId),
        event,
        canonicalThreadId,
        codexHome,
      )
    : data !== undefined
      ? withMinimalRawPayload(runtimeEventBase(event, canonicalThreadId), event)
      : runtimeEventBase(event, canonicalThreadId);

  return {
    ...base,
    type: lifecycle,
    payload: {
      itemType: canonicalItemType,
      ...(Option.isSome(asyncQuestions) ? { asyncQuestions: asyncQuestions.value } : {}),
      ...(status ? { status } : {}),
      ...(title ? { title } : {}),
      ...(generatedImageReference
        ? { detail: generatedImageReference.path }
        : detail
          ? { detail }
          : {}),
      ...typedFields,
      ...(data !== undefined ? { data } : {}),
    },
  };
}

type CodexHookRunStatus = "completed" | "failed" | "blocked" | "stopped";

function toCodexHookRunStatus(value: unknown): CodexHookRunStatus | undefined {
  return value === "completed" || value === "failed" || value === "blocked" || value === "stopped"
    ? value
    : undefined;
}

function toHookOutcome(status: CodexHookRunStatus | undefined): "success" | "error" | "cancelled" {
  if (status === "completed") return "success";
  if (status === "blocked" || status === "stopped") return "cancelled";
  return "error";
}

function hookRunOutput(run: Record<string, unknown>): string | undefined {
  if (!Array.isArray(run.entries)) {
    return undefined;
  }
  const output = run.entries
    .flatMap((entry) => {
      const record = asObject(entry);
      const text = asTrimmedString(record?.text);
      if (!text) return [];
      const kind = asTrimmedString(record?.kind);
      return [kind ? `${kind}: ${text}` : text];
    })
    .join("\n");
  return output ? sanitizeUnmappedProviderDetail(output) : undefined;
}

function mapCodexHookEvent(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ProviderRuntimeEvent | undefined {
  if (event.method !== "hook/started" && event.method !== "hook/completed") {
    return undefined;
  }
  const run = asObject(asObject(event.payload)?.run);
  const hookId = asTrimmedString(run?.id);
  const hookEvent = asTrimmedString(run?.eventName);
  if (!run || !hookId || !hookEvent) {
    return undefined;
  }
  const hookName = asTrimmedString(run.sourcePath) ?? asTrimmedString(run.handlerType) ?? hookEvent;
  const statusMessage = sanitizeUnmappedProviderDetail(asTrimmedString(run.statusMessage));
  const data = sanitizeUnmappedProviderData(run);
  const base = withSanitizedRaw(event, canonicalThreadId);

  if (event.method === "hook/started") {
    return {
      ...base,
      type: "hook.started",
      payload: {
        hookId,
        hookName,
        hookEvent,
        ...(statusMessage ? { statusMessage } : {}),
        data,
      },
    };
  }

  const status = toCodexHookRunStatus(run.status);
  const durationCandidate = asNumber(run.durationMs);
  const durationMs =
    durationCandidate !== undefined && Number.isInteger(durationCandidate) && durationCandidate >= 0
      ? durationCandidate
      : undefined;
  const output = hookRunOutput(run);
  return {
    ...base,
    type: "hook.completed",
    payload: {
      hookId,
      hookName,
      hookEvent,
      outcome: toHookOutcome(status),
      ...(status ? { status } : {}),
      ...(statusMessage ? { statusMessage } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(output ? { output } : {}),
      data,
    },
  };
}

const DIAGNOSTIC_ONLY_CODEX_METHODS = new Set([
  "session/threadOpenRequested",
  "session/threadOpenResolved",
]);

function mapCodexMcpTransportStderr(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  tracker: CodexTranscriptTracker,
): ProviderRuntimeEvent[] | undefined {
  if (event.method !== "process/stderr" || !event.message) return undefined;
  const transport = classifyCodexMcpTransportLine(event.message);
  if (!transport) return undefined;
  const target = transport.serverName ?? transport.host ?? "unknown";
  const generation = lifecycleGenerationKey(event);
  if (!tracker.firstInGeneration(canonicalThreadId, generation, `mcp-transport:${target}`)) {
    return [];
  }
  const title = transport.serverName
    ? `MCP server "${transport.serverName}" transport error`
    : transport.host
      ? `MCP server at ${transport.host} transport error`
      : "MCP server transport error";
  return [
    transcriptNoticeEvent(event, canonicalThreadId, {
      noticeKind: "mcp-server-status",
      severity: "warning",
      title: noticeTitle(title, "MCP server transport error"),
      detail: transport.reason,
      body: sanitizeUnmappedProviderDetail(transport.message) ?? transport.reason,
      status: "failed",
      dedupeKey: `mcp-transport:${generation}:${target}`,
      data: {
        ...(transport.serverName ? { server: transport.serverName } : {}),
        ...(transport.host ? { host: transport.host } : {}),
      },
    }),
  ];
}

function mapCodexSessionWarning(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ProviderRuntimeEvent[] | undefined {
  const title =
    event.method === "session/threadResumeFallback"
      ? "Could not resume the Codex thread; started a new thread"
      : event.method === "session/threadStartWithoutResume"
        ? "Started a new Codex thread without earlier context"
        : undefined;
  if (title === undefined) return undefined;
  const detail = sanitizeUnmappedProviderDetail(asTrimmedString(event.message));
  return [
    transcriptNoticeEvent(event, canonicalThreadId, {
      noticeKind: "provider-warning",
      severity: "warning",
      title,
      ...(detail ? { detail } : {}),
      status: "completed",
      dedupeKey: `${event.method}:${lifecycleGenerationKey(event)}`,
    }),
  ];
}

function mapUnmappedCodexEvent(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ProviderRuntimeEvent {
  const payload = asObject(event.payload);
  const msg = codexEventMessage(payload);
  const nativeType = sanitizeUnmappedProviderNativeType(event.method);
  const detail = sanitizeUnmappedProviderDetail(
    asTrimmedString(payload?.message) ??
      asTrimmedString(msg?.summary) ??
      asTrimmedString(payload?.reason) ??
      asTrimmedString(payload?.summary) ??
      asTrimmedString(msg?.status) ??
      asTrimmedString(payload?.detail) ??
      asTrimmedString(payload?.status),
  );
  return {
    ...runtimeEventBase(event, canonicalThreadId),
    raw: {
      source: eventRawSource(event),
      method: nativeType,
      payload: { synaraSanitized: true },
    },
    type: "event.unmapped",
    payload: {
      nativeType,
      ...(detail ? { detail } : {}),
      ...(event.payload !== undefined ? { data: sanitizeUnmappedProviderData(event.payload) } : {}),
    },
  };
}

const CODEX_TRANSCRIPT_TRACKER_MAX_ENTRIES = 512;

function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > CODEX_TRANSCRIPT_TRACKER_MAX_ENTRIES) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
}

function threadTurnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

export class CodexTranscriptTracker {
  private readonly finalAnswerItemByTurn = new Map<string, string>();
  private readonly originByTurn = new Map<string, TurnOrigin>();
  private readonly activeTurnByThread = new Map<string, string>();
  private readonly readyMcpServersByGeneration = new Map<string, ReadonlyArray<string>>();
  private readonly emittedOncePerGeneration = new Map<string, true>();
  private readonly openReviewKeyByThread = new Map<string, string>();

  turnStarted(threadId: string, turnId: string, origin: TurnOrigin | undefined): void {
    rememberBounded(this.activeTurnByThread, threadId, turnId);
    if (origin) rememberBounded(this.originByTurn, threadTurnKey(threadId, turnId), origin);
  }

  turnEnded(threadId: string, turnId: string | undefined): string | undefined {
    if (turnId === undefined || this.activeTurnByThread.get(threadId) === turnId) {
      this.activeTurnByThread.delete(threadId);
    }
    if (turnId === undefined) return undefined;
    const key = threadTurnKey(threadId, turnId);
    const finalAnswerItemId = this.finalAnswerItemByTurn.get(key);
    this.finalAnswerItemByTurn.delete(key);
    this.originByTurn.delete(key);
    return finalAnswerItemId;
  }

  hasActiveTurn(threadId: string): boolean {
    return this.activeTurnByThread.has(threadId);
  }

  turnOrigin(threadId: string, turnId: string): TurnOrigin | undefined {
    return this.originByTurn.get(threadTurnKey(threadId, turnId));
  }

  recordFinalAnswer(threadId: string, turnId: string, itemId: string): void {
    rememberBounded(this.finalAnswerItemByTurn, threadTurnKey(threadId, turnId), itemId);
  }

  markMcpServerReady(
    threadId: string,
    generation: string,
    serverName: string,
  ): ReadonlyArray<string> {
    const key = threadTurnKey(threadId, generation);
    const ready = this.readyMcpServersByGeneration.get(key) ?? [];
    const next = ready.includes(serverName) ? ready : [...ready, serverName];
    rememberBounded(this.readyMcpServersByGeneration, key, next);
    return next;
  }

  markMcpServerUnavailable(threadId: string, generation: string, serverName: string): void {
    const key = threadTurnKey(threadId, generation);
    const ready = this.readyMcpServersByGeneration.get(key);
    if (ready?.includes(serverName)) {
      rememberBounded(
        this.readyMcpServersByGeneration,
        key,
        ready.filter((name) => name !== serverName),
      );
    }
  }

  openReview(threadId: string, dedupeKey: string): void {
    rememberBounded(this.openReviewKeyByThread, threadId, dedupeKey);
  }

  closeReview(threadId: string): string | undefined {
    const dedupeKey = this.openReviewKeyByThread.get(threadId);
    this.openReviewKeyByThread.delete(threadId);
    return dedupeKey;
  }

  firstInGeneration(threadId: string, generation: string, key: string): boolean {
    const entryKey = threadTurnKey(threadId, `${generation}\u0000${key}`);
    if (this.emittedOncePerGeneration.has(entryKey)) return false;
    rememberBounded(this.emittedOncePerGeneration, entryKey, true);
    return true;
  }

  forgetThread(threadId: string): void {
    const prefix = `${threadId}\u0000`;
    this.activeTurnByThread.delete(threadId);
    this.openReviewKeyByThread.delete(threadId);
    for (const map of [
      this.finalAnswerItemByTurn,
      this.originByTurn,
      this.readyMcpServersByGeneration,
      this.emittedOncePerGeneration,
    ] as ReadonlyArray<Map<string, unknown>>) {
      for (const key of map.keys()) {
        if (key.startsWith(prefix)) map.delete(key);
      }
    }
  }
}

function isChildConversationEvent(event: ProviderEvent): boolean {
  return event.providerParentThreadId !== undefined;
}

function codexTurnOrigin(payload: Record<string, unknown> | undefined): TurnOrigin | undefined {
  const origin = payload?.[CODEX_TURN_ORIGIN_PAYLOAD_KEY];
  return origin === "user" || origin === "provider" ? origin : undefined;
}

function formatWaitDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined) return undefined;
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function userMessageText(item: Record<string, unknown>): string | undefined {
  const texts = (asArray(item.content) ?? []).flatMap((entry) => {
    const input = asObject(entry);
    const text = input?.type === "text" ? asString(input.text) : undefined;
    return text !== undefined && text.trim().length > 0 ? [text] : [];
  });
  return texts.length > 0 ? texts.join("\n\n") : undefined;
}

function subAgentLabel(agentPath: string | undefined): string {
  const segment = agentPath
    ?.split("/")
    .map((part) => part.trim())
    .findLast((part) => part.length > 0);
  return segment ?? "Subagent";
}

function subAgentActivityNotice(item: Record<string, unknown>, turnKey: string): TranscriptNotice {
  const agentPath = asTrimmedString(item.agentPath);
  const agent = subAgentLabel(agentPath);
  const kind = asString(item.kind);
  const presentation =
    kind === "started"
      ? { title: `${agent} started working`, status: "running" as const }
      : kind === "interacted"
        ? { title: `${agent} received a message`, status: "running" as const }
        : kind === "interrupted"
          ? { title: `${agent} was interrupted`, status: "cancelled" as const }
          : { title: `${agent} finished`, status: "completed" as const };
  const model = asTrimmedString(item.model);
  return {
    noticeKind: "subagent-activity",
    severity: "info",
    title: noticeTitle(presentation.title, "Subagent activity"),
    status: presentation.status,
    ...noticeDetail(model),
    dedupeKey: `subagent:${turnKey}:${agentPath ?? asTrimmedString(item.id) ?? "unknown"}`,
  };
}

function mapCodexItemNotices(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.completed",
  nativeType: CodexItemType | undefined,
  item: Record<string, unknown>,
  tracker: CodexTranscriptTracker,
): ProviderRuntimeEvent[] {
  const itemId = asTrimmedString(item.id) ?? event.itemId ?? event.id;
  const turnKey = event.turnId ?? lifecycleGenerationKey(event);
  const notice = (value: TranscriptNotice) => [
    transcriptNoticeEvent(event, canonicalThreadId, value),
  ];
  switch (nativeType) {
    case "hookPrompt": {
      if (lifecycle !== "item.completed") return [];
      const fragments = (asArray(item.fragments) ?? []).flatMap((entry) => {
        const text = asString(asObject(entry)?.text);
        return text !== undefined && text.trim().length > 0 ? [text] : [];
      });
      return notice({
        noticeKind: "hook-prompt",
        severity: "info",
        title: "Hook feedback",
        status: "completed",
        ...noticeBody(fragments.join("\n\n")),
        dedupeKey: `hook-prompt:${itemId}`,
      });
    }
    case "sleep": {
      const duration = formatWaitDuration(asNonNegativeFinite(item.durationMs));
      const settled = lifecycle === "item.completed";
      return notice({
        noticeKind: "sleep",
        severity: "info",
        title: duration
          ? `${settled ? "Waited" : "Waiting"} ${duration}`
          : settled
            ? "Finished waiting"
            : "Waiting",
        status: settled ? "completed" : "running",
        dedupeKey: `sleep:${itemId}`,
      });
    }
    case "subAgentActivity":
      return lifecycle === "item.completed" ? notice(subAgentActivityNotice(item, turnKey)) : [];
    case "enteredReviewMode": {
      if (lifecycle !== "item.completed") return [];
      const target = asTrimmedString(item.review);
      const dedupeKey = `review:${itemId}`;
      tracker.openReview(canonicalThreadId, dedupeKey);
      return notice({
        noticeKind: "review-mode",
        severity: "info",
        title: noticeTitle(target ? `Started review: ${target}` : undefined, "Started review"),
        status: "running",
        dedupeKey,
      });
    }
    case "exitedReviewMode":
      return lifecycle === "item.completed"
        ? notice({
            noticeKind: "review-mode",
            severity: "info",
            title: "Review finished",
            status: "completed",
            dedupeKey: tracker.closeReview(canonicalThreadId) ?? `review:${itemId}`,
          })
        : [];
    case "userMessage": {
      if (
        lifecycle !== "item.completed" ||
        isChildConversationEvent(event) ||
        event.turnId === undefined ||
        tracker.turnOrigin(canonicalThreadId, event.turnId) !== "provider"
      ) {
        return [];
      }
      return notice({
        noticeKind: "user-message-injected",
        severity: "info",
        title: "Message added outside Synara",
        ...noticeBody(userMessageText(item)),
        dedupeKey: `user-message:${itemId}`,
      });
    }
    default:
      return [];
  }
}

function mapFunctionCallOutputItem(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  item: Record<string, unknown>,
): ProviderRuntimeEvent {
  const toolCall = codexFunctionCallOutputDetails(item);
  const itemId = asTrimmedString(item.id);
  return {
    ...withSanitizedRaw(event, canonicalThreadId),
    ...(itemId ? { itemId: RuntimeItemId.makeUnsafe(itemId) } : {}),
    type: "item.completed",
    payload: {
      itemType: "dynamic_tool_call",
      status: "completed",
      ...(toolCall.toolName ? { title: toolCall.toolName, toolName: toolCall.toolName } : {}),
      toolCall,
    },
  };
}

function autoApprovalReviewTarget(action: Record<string, unknown> | undefined): string | undefined {
  switch (action?.type) {
    case "command":
      return asTrimmedString(action.command);
    case "execve":
      return asTrimmedString(action.program);
    case "writeStdin":
      return "input to a running command";
    case "applyPatch": {
      const files = asArray(action.files)?.length ?? 0;
      return files === 1 ? "a change to 1 file" : `changes to ${files} files`;
    }
    case "networkAccess":
      return asTrimmedString(action.host) ?? asTrimmedString(action.target);
    case "mcpToolCall":
      return asTrimmedString(action.toolTitle) ?? asTrimmedString(action.toolName);
    case "requestPermissions":
      return "a permission request";
    default:
      return undefined;
  }
}

function autoApprovalReviewNotice(
  event: ProviderEvent,
  payload: Record<string, unknown> | undefined,
): TranscriptNotice {
  const review = asObject(payload?.review);
  const target = autoApprovalReviewTarget(asObject(payload?.action));
  const reviewKey =
    asTrimmedString(payload?.reviewId) ??
    asTrimmedString(payload?.targetItemId) ??
    event.itemId ??
    event.id;
  const dedupeKey = `auto-approval-review:${reviewKey}`;
  const rationale = asTrimmedString(review?.rationale);
  if (event.method === "item/autoApprovalReview/started") {
    return {
      noticeKind: "auto-approval-review",
      severity: "info",
      title: noticeTitle(target ? `Reviewing ${target}` : undefined, "Reviewing an action"),
      status: "running",
      dedupeKey,
    };
  }
  const status = asString(review?.status);
  const outcome =
    status === "approved"
      ? { label: "Approved", severity: "info" as const, status: "completed" as const }
      : status === "denied"
        ? { label: "Denied", severity: "warning" as const, status: "blocked" as const }
        : status === "timedOut"
          ? {
              label: "Review timed out for",
              severity: "warning" as const,
              status: "failed" as const,
            }
          : status === "aborted"
            ? {
                label: "Review stopped for",
                severity: "warning" as const,
                status: "cancelled" as const,
              }
            : { label: "Reviewed", severity: "info" as const, status: "completed" as const };
  return {
    noticeKind: "auto-approval-review",
    severity: outcome.severity,
    title: noticeTitle(
      target ? `${outcome.label} ${target}` : undefined,
      `Automatic review: ${status ?? "completed"}`,
    ),
    status: outcome.status,
    ...noticeDetail(rationale),
    dedupeKey,
  };
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
}

function moderationMetadataIsFlagged(metadata: unknown): boolean {
  const record = asObject(metadata);
  return record?.flagged === true || record?.blocked === true;
}

function mcpStartupStatusEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  payload: Record<string, unknown> | undefined,
  tracker: CodexTranscriptTracker,
): ProviderRuntimeEvent[] {
  const name = asTrimmedString(payload?.name);
  const status = asString(payload?.status);
  if (!name) return [];
  const generation = lifecycleGenerationKey(event);
  if (status === "ready") {
    const ready = tracker.markMcpServerReady(canonicalThreadId, generation, name);
    const list = ready.join(", ");
    return [
      transcriptNoticeEvent(event, canonicalThreadId, {
        noticeKind: "mcp-server-status",
        severity: "info",
        title: noticeTitle(`MCP servers ready: ${list}`, "MCP servers ready"),
        status: "completed",
        ...(list.length > NOTICE_TITLE_MAX_CHARS ? noticeDetail(list) : {}),
        dedupeKey: `mcp:${generation}`,
      }),
    ];
  }
  if (status === "failed") {
    tracker.markMcpServerUnavailable(canonicalThreadId, generation, name);
    const reason = asTrimmedString(payload?.error) ?? asTrimmedString(payload?.failureReason);
    return [
      transcriptNoticeEvent(event, canonicalThreadId, {
        noticeKind: "mcp-server-status",
        severity: "warning",
        title: noticeTitle(`MCP server ${name} failed to start`, "MCP server failed to start"),
        status: "failed",
        ...noticeDetail(reason),
        dedupeKey: `mcp:${generation}:${name}`,
      }),
    ];
  }
  return [];
}

function codexRetryProgress(
  message: string,
): { retryAttempt: number; retryMaxAttempts: number } | undefined {
  const match = /(?:re-?connecting|retrying)\D*?(\d+)\s*\/\s*(\d+)/i.exec(message);
  if (!match) return undefined;
  const retryAttempt = Number(match[1]);
  const retryMaxAttempts = Number(match[2]);
  return Number.isSafeInteger(retryAttempt) && Number.isSafeInteger(retryMaxAttempts)
    ? { retryAttempt, retryMaxAttempts }
    : undefined;
}

function activeTurnSessionStateEvent(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  tracker: CodexTranscriptTracker,
  reason: string | undefined,
): ProviderRuntimeEvent[] {
  if (!tracker.hasActiveTurn(canonicalThreadId)) return [];
  return [
    {
      ...withSanitizedRaw(event, canonicalThreadId),
      type: "session.state.changed",
      payload: {
        state: "running",
        ...(reason ? { reason } : {}),
      },
    },
  ];
}

function mapCodexNoticeNotification(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  payload: Record<string, unknown> | undefined,
  tracker: CodexTranscriptTracker,
): ProviderRuntimeEvent[] | undefined {
  const turnKey = event.turnId ?? lifecycleGenerationKey(event);
  const notice = (value: TranscriptNotice) => [
    transcriptNoticeEvent(event, canonicalThreadId, value),
  ];
  switch (event.method) {
    case "thread/reverted":
      return notice({
        noticeKind: "thread-reverted",
        severity: "info",
        title: "Reverted to an earlier turn",
        status: "completed",
      });
    case "skills/changed":
      if (!tracker.firstInGeneration(canonicalThreadId, lifecycleGenerationKey(event), "skills")) {
        return [];
      }
      return notice({
        noticeKind: "skills-changed",
        severity: "info",
        title: "Skills updated",
        status: "completed",
        dedupeKey: `skills-changed:${lifecycleGenerationKey(event)}`,
      });
    case "item/autoApprovalReview/started":
    case "item/autoApprovalReview/completed":
      return notice(autoApprovalReviewNotice(event, payload));
    case "autoApprovalReview/strictReviewRequired":
      return notice({
        noticeKind: "auto-approval-review",
        severity: "warning",
        title: "This request requires additional safety checks",
        dedupeKey: `auto-approval-review-strict:${turnKey}:${asNumber(payload?.startedAtMs) ?? event.id}`,
      });
    case "mcpServer/startupStatus/updated":
      return mcpStartupStatusEvents(event, canonicalThreadId, payload, tracker);
    case "mcpServer/elicitation/request/unrenderable": {
      const server = asTrimmedString(payload?.serverName);
      return notice({
        noticeKind: "mcp-elicitation",
        severity: "warning",
        title: noticeTitle(
          server ? `${server} requested information (not supported)` : undefined,
          "An MCP server requested information (not supported)",
        ),
        status: "cancelled",
        ...noticeDetail(asString(payload?.message)),
      });
    }
    case "model/verification": {
      const verifications = (asArray(payload?.verifications) ?? []).flatMap((entry) => {
        const value = asTrimmedString(entry);
        return value ? [humanizeIdentifier(value)] : [];
      });
      return notice({
        noticeKind: "model-verification",
        severity: "info",
        title: noticeTitle(
          verifications.length > 0 ? `Model verification: ${verifications.join(", ")}` : undefined,
          "Model verification",
        ),
        dedupeKey: `model-verification:${turnKey}`,
      });
    }
    case "modelProvider/authRecoveryStarted":
    case "modelProvider/authRecoveryCompleted": {
      const provider = asTrimmedString(payload?.provider);
      const started = event.method === "modelProvider/authRecoveryStarted";
      return notice({
        noticeKind: "auth-recovery",
        severity: "info",
        title: noticeTitle(
          provider
            ? started
              ? `Reconnecting to ${provider}`
              : `Finished reconnecting to ${provider}`
            : undefined,
          started ? "Reconnecting to the model provider" : "Finished reconnecting",
        ),
        status: started ? "running" : "completed",
        ...noticeDetail(asString(payload?.message)),
        dedupeKey: `auth-recovery:${turnKey}:${provider ?? "provider"}`,
      });
    }
    case "turn/moderationMetadata":
      return moderationMetadataIsFlagged(payload?.metadata)
        ? notice({
            noticeKind: "moderation",
            severity: "warning",
            title: "Response flagged by moderation",
            dedupeKey: `moderation:${turnKey}`,
          })
        : [];
    case "warning":
    case "guardianWarning": {
      const message = asTrimmedString(payload?.message) ?? event.message;
      const guardian = event.method === "guardianWarning";
      return notice({
        noticeKind: guardian ? "guardian-warning" : "provider-warning",
        severity: "warning",
        title: noticeTitle(message, guardian ? "Guardian warning" : "Codex warning"),
        ...(message !== undefined && message.length > NOTICE_TITLE_MAX_CHARS
          ? noticeBody(message)
          : {}),
        dedupeKey: `${guardian ? "guardian-warning" : "warning"}:${turnKey}:${stableTextKey(message ?? "")}`,
      });
    }
    case "thread/environment/connected":
      return activeTurnSessionStateEvent(event, canonicalThreadId, tracker, undefined);
    case "thread/environment/disconnected":
      return activeTurnSessionStateEvent(
        event,
        canonicalThreadId,
        tracker,
        "Environment disconnected",
      );
    case "model/safetyBuffering/updated":
      return activeTurnSessionStateEvent(
        event,
        canonicalThreadId,
        tracker,
        payload?.showBufferingUi === true ? "Running safety checks" : undefined,
      );
    case "item/commandExecution/terminalInteraction": {
      const stdin = asString(payload?.stdin);
      return [
        {
          ...withSanitizedRaw(event, canonicalThreadId),
          type: "item.updated",
          payload: {
            itemType: "command_execution",
            ...(stdin !== undefined
              ? { command: { lastStdin: redactProviderText(stdin, COMMAND_STDIN_MAX_CHARS).text } }
              : {}),
          },
        },
      ];
    }
    case "item/fileChange/patchUpdated": {
      const fileChanges = codexFileChangeDetails(payload?.changes);
      return [
        {
          ...withMinimalRawPayload(runtimeEventBase(event, canonicalThreadId), event),
          type: "item.updated",
          payload: {
            itemType: "file_change",
            status: "inProgress",
            ...(fileChanges ? { fileChanges } : {}),
          },
        },
      ];
    }
    default:
      return undefined;
  }
}

export type CodexRuntimeEventMapper = (
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  codexHome?: CodexGeneratedImageHomeContext,
) => ReadonlyArray<ProviderRuntimeEvent>;

export function makeCodexRuntimeEventMapper(
  tracker: CodexTranscriptTracker = new CodexTranscriptTracker(),
): CodexRuntimeEventMapper {
  return (event, canonicalThreadId, codexHome) =>
    mapToRuntimeEvents(event, canonicalThreadId, tracker, codexHome);
}

function isKnownCodexMethod(event: ProviderEvent): boolean {
  if (event.kind === "notification") {
    return (
      codexNotificationDisposition(event.method) !== undefined ||
      event.method === "item/started" ||
      event.method === "item/completed"
    );
  }
  return event.kind === "request" && codexRequestDisposition(event.method) !== undefined;
}

function isIgnoredCodexEvent(event: ProviderEvent): boolean {
  if (event.kind === "notification") {
    return isIgnoredCodexDisposition(codexNotificationDisposition(event.method));
  }
  if (event.kind === "request") {
    return isIgnoredCodexDisposition(codexRequestDisposition(event.method));
  }
  return false;
}

function mapCodexItemEvent(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.completed",
  tracker: CodexTranscriptTracker,
  codexHome?: CodexGeneratedImageHomeContext,
): ProviderRuntimeEvent[] {
  const payload = asObject(event.payload);
  const item = asObject(payload?.item);
  const source = item ?? payload;
  if (!source) {
    return [];
  }
  const nativeType = resolveCodexItemType(source.type ?? source.kind);
  if (
    nativeType === "agentMessage" &&
    codexMessagePhase(source.phase) === "final_answer" &&
    event.turnId !== undefined &&
    !isChildConversationEvent(event)
  ) {
    const itemId = event.itemId ?? asTrimmedString(source.id);
    if (itemId) tracker.recordFinalAnswer(canonicalThreadId, event.turnId, itemId);
  }
  if (nativeType === "functionCallOutput") {
    return lifecycle === "item.completed"
      ? [mapFunctionCallOutputItem(event, canonicalThreadId, source)]
      : [];
  }
  const notices = mapCodexItemNotices(
    event,
    canonicalThreadId,
    lifecycle,
    nativeType,
    source,
    tracker,
  );
  if (
    lifecycle === "item.completed" &&
    toCanonicalItemType(source.type ?? source.kind) === "plan"
  ) {
    const detail = itemDetail(source, payload ?? {});
    return detail
      ? [
          {
            ...runtimeEventBase(event, canonicalThreadId),
            type: "turn.proposed.completed",
            payload: {
              planMarkdown: detail,
            },
          },
        ]
      : [];
  }
  const lifecycleEvent = mapItemLifecycle(event, canonicalThreadId, lifecycle, codexHome);
  return lifecycleEvent ? [lifecycleEvent, ...notices] : notices;
}

function mapToRuntimeEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  tracker: CodexTranscriptTracker,
  codexHome?: CodexGeneratedImageHomeContext,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const turn = asObject(payload?.turn);
  if (isIgnoredCodexEvent(event)) {
    return [];
  }
  if (event.kind === "notification") {
    const noticeEvents = mapCodexNoticeNotification(event, canonicalThreadId, payload, tracker);
    if (noticeEvents) {
      return noticeEvents;
    }
  }
  const generatedImageEndEvent = mapGeneratedImageEndEvent(event, canonicalThreadId, codexHome);
  if (generatedImageEndEvent) {
    return [generatedImageEndEvent];
  }
  if (event.method === "hook/started" || event.method === "hook/completed") {
    const hookEvent = mapCodexHookEvent(event, canonicalThreadId);
    return hookEvent ? [hookEvent] : [];
  }

  if (event.kind === "error") {
    if (!event.message) {
      return [];
    }
    const mcpTransportEvents = mapCodexMcpTransportStderr(event, canonicalThreadId, tracker);
    if (mcpTransportEvents) {
      return mcpTransportEvents;
    }
    const treatAsWarning = providerErrorMapsToWarning(event);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: treatAsWarning ? "runtime.warning" : "runtime.error",
        payload: {
          message: event.message,
          ...(!treatAsWarning ? { class: "provider_error" as const } : {}),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.kind === "request") {
    if (event.method === "item/tool/requestUserInput") {
      // The manager refuses (and answers) unrenderable requests, so reaching
      // this branch with no questions means nothing is parked on the reply.
      const questions = parseCodexUserInputQuestions(payload);
      if (!questions) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "user-input.requested",
          payload: {
            questions,
          },
        },
      ];
    }

    const detail =
      asString(payload?.command) ??
      asString(payload?.reason) ??
      asString(payload?.prompt) ??
      asString(payload?.message);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.opened",
        payload: {
          requestType: toRequestTypeFromMethod(event.method),
          ...(detail ? { detail } : {}),
          ...(event.payload !== undefined ? { args: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/requestApproval/decision" && event.requestId) {
    const decision = Schema.decodeUnknownSync(ProviderApprovalDecision)(payload?.decision);
    const requestType =
      event.requestKind !== undefined
        ? toRequestTypeFromKind(event.requestKind)
        : toRequestTypeFromMethod(event.method);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(decision ? { decision } : {}),
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (DIAGNOSTIC_ONLY_CODEX_METHODS.has(event.method)) {
    return [];
  }

  const sessionWarningEvents = mapCodexSessionWarning(event, canonicalThreadId);
  if (sessionWarningEvents) {
    return sessionWarningEvents;
  }

  if (event.method === "session/connecting") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "starting",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/ready") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "ready",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/started") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.started",
        payload: {
          ...(event.message ? { message: event.message } : {}),
          ...(event.payload !== undefined ? { resume: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/exited" || event.method === "session/closed") {
    tracker.forgetThread(canonicalThreadId);
    const exit = event.method === "session/exited" ? readCodexSessionExit(payload) : undefined;
    const exitKind = event.method === "session/closed" ? "graceful" : exit?.exitKind;
    const crashError: ReadonlyArray<ProviderRuntimeEvent> =
      exit?.exitKind === "error" && exit.causeAlreadyReported !== true
        ? [
            {
              ...runtimeEventBase(event, canonicalThreadId),
              ...(exit.turnId ? { turnId: exit.turnId } : {}),
              type: "runtime.error",
              payload: {
                message: event.message ?? "Codex app-server exited unexpectedly.",
                class: "transport_error",
                detail: { exitCode: exit.exitCode, signal: exit.signal },
              },
            },
          ]
        : [];
    return [
      ...crashError,
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.exited",
        payload: {
          ...(event.message ? { reason: event.message } : {}),
          ...(exitKind ? { exitKind } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/started") {
    const payloadThreadId = asString(asObject(payload?.thread)?.id);
    const providerThreadId = payloadThreadId ?? asString(payload?.threadId);
    if (!providerThreadId) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "thread.started",
        payload: {
          providerThreadId,
        },
      },
    ];
  }

  if (event.method === "thread/compacting") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.updated",
        payload: {
          itemType: "context_compaction",
          status: "inProgress",
          title: "Context compaction",
          detail: event.message ?? "Compacting context",
          ...(event.payload !== undefined ? { data: event.payload } : {}),
        },
      },
    ];
  }

  if (
    event.method === "thread/status/changed" ||
    event.method === "thread/archived" ||
    event.method === "thread/unarchived" ||
    event.method === "thread/closed" ||
    event.method === "thread/compacted"
  ) {
    return [
      {
        type: "thread.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state:
            event.method === "thread/archived"
              ? "archived"
              : event.method === "thread/closed"
                ? "closed"
                : event.method === "thread/compacted"
                  ? "compacted"
                  : toThreadState(asObject(payload?.thread)?.state ?? payload?.state),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/name/updated") {
    return [
      {
        type: "thread.metadata.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          ...(asString(payload?.threadName) ? { name: asString(payload?.threadName) } : {}),
          ...(event.payload !== undefined ? { metadata: asObject(event.payload) } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/tokenUsage/updated") {
    const tokenUsage = asObject(payload?.tokenUsage);
    const normalizedUsage = normalizeCodexTokenUsage(tokenUsage ?? event.payload);
    if (!normalizedUsage) {
      return [];
    }
    return [
      {
        type: "thread.token-usage.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          usage: normalizedUsage,
        },
      },
    ];
  }

  if (event.method === "turn/started") {
    const turnId = event.turnId;
    if (!turnId) {
      return [];
    }
    const origin = codexTurnOrigin(payload);
    if (!isChildConversationEvent(event)) {
      tracker.turnStarted(canonicalThreadId, turnId, origin);
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        turnId,
        type: "turn.started",
        payload: {
          ...(asString(turn?.model) ? { model: asString(turn?.model) } : {}),
          ...(asString(turn?.effort) ? { effort: asString(turn?.effort) } : {}),
          ...(origin ? { origin } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/completed") {
    const errorMessage = asString(asObject(turn?.error)?.message);
    const errorCode = codexErrorCode(turn?.error);
    const finalAssistantItemId = isChildConversationEvent(event)
      ? undefined
      : tracker.turnEnded(canonicalThreadId, event.turnId);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.completed",
        payload: {
          state: toTurnStatus(turn?.status),
          ...(asString(turn?.stopReason) ? { stopReason: asString(turn?.stopReason) } : {}),
          ...(turn?.usage !== undefined ? { usage: turn.usage } : {}),
          ...(asObject(turn?.modelUsage) ? { modelUsage: asObject(turn?.modelUsage) } : {}),
          ...(asNumber(turn?.totalCostUsd) !== undefined
            ? { totalCostUsd: asNumber(turn?.totalCostUsd) }
            : {}),
          ...(errorMessage ? { errorMessage } : {}),
          ...(errorCode ? { errorCode } : {}),
          ...(finalAssistantItemId
            ? { finalAssistantItemId: RuntimeItemId.makeUnsafe(finalAssistantItemId) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "turn/aborted") {
    if (!isChildConversationEvent(event)) {
      tracker.turnEnded(canonicalThreadId, event.turnId);
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.aborted",
        payload: {
          reason: event.message ?? "Turn aborted",
        },
      },
    ];
  }

  if (event.method === "turn/plan/updated") {
    const steps = Array.isArray(payload?.plan) ? payload.plan : [];
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.tasks.updated",
        payload: {
          ...(asString(payload?.explanation)
            ? { explanation: asString(payload?.explanation) }
            : {}),
          tasks: steps.flatMap((entry) => {
            const taskEntry = asObject(entry);
            if (!taskEntry) {
              return [];
            }
            const item = makeRuntimeTaskListItem(
              asString(taskEntry.step) ?? "task",
              taskEntry.status,
            );
            return item ? [item] : [];
          }),
        },
      },
    ];
  }

  if (event.method === "turn/diff/updated") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.diff.updated",
        payload: {
          unifiedDiff:
            asString(payload?.unifiedDiff) ??
            asString(payload?.diff) ??
            asString(payload?.patch) ??
            "",
        },
      },
    ];
  }

  if (event.method === "item/started" || event.method === "item/completed") {
    return mapCodexItemEvent(
      event,
      canonicalThreadId,
      event.method === "item/started" ? "item.started" : "item.completed",
      tracker,
      codexHome,
    );
  }

  if (event.method === "item/plan/delta") {
    const delta =
      event.textDelta ??
      asString(payload?.delta) ??
      asString(payload?.text) ??
      asString(asObject(payload?.content)?.text);
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeDeltaEventBase(event, canonicalThreadId),
        type: "turn.proposed.delta",
        payload: {
          delta,
        },
      },
    ];
  }

  if (
    event.method === "item/agentMessage/delta" ||
    event.method === "item/commandExecution/outputDelta" ||
    event.method === "item/fileChange/outputDelta" ||
    event.method === "item/reasoning/summaryTextDelta" ||
    event.method === "item/reasoning/textDelta"
  ) {
    const delta =
      event.textDelta ??
      asString(payload?.delta) ??
      asString(payload?.text) ??
      asString(asObject(payload?.content)?.text);
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeDeltaEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: contentStreamKindFromMethod(event.method),
          delta,
          ...(typeof payload?.contentIndex === "number"
            ? { contentIndex: payload.contentIndex }
            : {}),
          ...(typeof payload?.summaryIndex === "number"
            ? { summaryIndex: payload.summaryIndex }
            : {}),
        },
      },
    ];
  }

  if (event.method === "item/mcpToolCall/progress") {
    const toolUseId = asString(payload?.toolUseId) ?? asString(payload?.itemId);
    const summary = asString(payload?.summary) ?? asString(payload?.message);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "tool.progress",
        payload: {
          ...(toolUseId ? { toolUseId } : {}),
          ...(asString(payload?.toolName) ? { toolName: asString(payload?.toolName) } : {}),
          ...(summary ? { summary } : {}),
          ...(asNumber(payload?.elapsedSeconds) !== undefined
            ? { elapsedSeconds: asNumber(payload?.elapsedSeconds) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "serverRequest/resolved") {
    const requestType =
      toRequestTypeFromResolvedPayload(payload) !== "unknown"
        ? toRequestTypeFromResolvedPayload(payload)
        : event.requestId && event.requestKind !== undefined
          ? toRequestTypeFromKind(event.requestKind)
          : "unknown";
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/tool/requestUserInput/answered") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "user-input.resolved",
        payload: {
          answers: toCanonicalUserInputAnswers(
            asObject(event.payload)?.answers as ProviderUserInputAnswers | undefined,
          ),
        },
      },
    ];
  }

  if (event.method === "codex/event/task_started") {
    const msg = codexEventMessage(payload);
    const taskId = asString(payload?.id) ?? asString(msg?.turn_id);
    if (!taskId) {
      return [];
    }
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.started",
        payload: {
          taskId: asRuntimeTaskId(taskId),
          ...(asString(msg?.collaboration_mode_kind)
            ? { taskType: asString(msg?.collaboration_mode_kind) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "codex/event/task_complete") {
    const msg = codexEventMessage(payload);
    const taskId = asString(payload?.id) ?? asString(msg?.turn_id);
    const proposedPlanMarkdown = extractProposedPlanMarkdown(asString(msg?.last_agent_message));
    if (!taskId) {
      if (!proposedPlanMarkdown) {
        return [];
      }
      return [
        {
          ...codexEventBase(event, canonicalThreadId),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: proposedPlanMarkdown,
          },
        },
      ];
    }
    const events: ProviderRuntimeEvent[] = [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.completed",
        payload: {
          taskId: asRuntimeTaskId(taskId),
          status: "completed",
          ...(asString(msg?.last_agent_message)
            ? { summary: asString(msg?.last_agent_message) }
            : {}),
        },
      },
    ];
    if (proposedPlanMarkdown) {
      events.push({
        ...codexEventBase(event, canonicalThreadId),
        type: "turn.proposed.completed",
        payload: {
          planMarkdown: proposedPlanMarkdown,
        },
      });
    }
    return events;
  }

  if (event.method === "codex/event/agent_reasoning") {
    const msg = codexEventMessage(payload);
    const taskId = asString(payload?.id);
    const description = asString(msg?.text);
    if (!taskId || !description) {
      return [];
    }
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.progress",
        payload: {
          taskId: asRuntimeTaskId(taskId),
          description,
        },
      },
    ];
  }

  if (event.method === "codex/event/reasoning_content_delta") {
    const msg = codexEventMessage(payload);
    const delta = asString(msg?.delta);
    if (!delta) {
      return [];
    }
    return [
      {
        ...codexDeltaEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind:
            asNumber(msg?.summary_index) !== undefined
              ? "reasoning_summary_text"
              : "reasoning_text",
          delta,
          ...(asNumber(msg?.summary_index) !== undefined
            ? { summaryIndex: asNumber(msg?.summary_index) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "model/rerouted") {
    return [
      {
        type: "model.rerouted",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          fromModel: asString(payload?.fromModel) ?? "unknown",
          toModel: asString(payload?.toModel) ?? "unknown",
          reason: asString(payload?.reason) ?? "unknown",
        },
      },
    ];
  }

  if (event.method === "deprecationNotice") {
    const details = asTrimmedString(payload?.details);
    return [
      {
        type: "deprecation.notice",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: asTrimmedString(payload?.summary) ?? "Deprecation notice",
          ...(details ? { details } : {}),
        },
      },
    ];
  }

  if (event.method === "configWarning") {
    const details = asTrimmedString(payload?.details);
    const path = asTrimmedString(payload?.path);
    return [
      {
        type: "config.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: asTrimmedString(payload?.summary) ?? "Configuration warning",
          ...(details ? { details } : {}),
          ...(path ? { path } : {}),
          ...(payload?.range !== undefined ? { range: payload.range } : {}),
        },
      },
    ];
  }

  if (event.method === "account/updated") {
    return [
      {
        type: "account.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          account: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "account/rateLimits/updated") {
    return [
      {
        type: "account.rate-limits.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          rateLimits: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "mcpServer/oauthLogin/completed") {
    return [
      {
        type: "mcp.oauth.completed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          success: payload?.success === true,
          ...(asString(payload?.name) ? { name: asString(payload?.name) } : {}),
          ...(asString(payload?.error) ? { error: asString(payload?.error) } : {}),
        },
      },
    ];
  }

  if (event.method === "error") {
    const message =
      asString(asObject(payload?.error)?.message) ?? event.message ?? "Provider runtime error";
    const willRetry = payload?.willRetry === true;
    const errorCode = codexErrorCode(payload?.error);
    const treatAsWarning = willRetry || isNonFatalCodexErrorMessage(message);
    const retryProgress = willRetry ? codexRetryProgress(message) : undefined;
    return [
      {
        type: treatAsWarning ? "runtime.warning" : "runtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
          ...(!treatAsWarning ? { class: "provider_error" as const } : {}),
          ...(!treatAsWarning && errorCode ? { errorCode } : {}),
          ...(willRetry ? { willRetry: true } : {}),
          ...retryProgress,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "windows/worldWritableWarning") {
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message: event.message ?? "Windows world-writable warning",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "windowsSandbox/setupCompleted") {
    const payloadRecord = asObject(event.payload);
    const success = payloadRecord?.success;
    const successMessage = event.message ?? "Windows sandbox setup completed";
    const failureMessage = event.message ?? "Windows sandbox setup failed";

    return [
      {
        type: "session.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state: success === false ? "error" : "ready",
          reason: success === false ? failureMessage : successMessage,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
      ...(success === false
        ? [
            {
              type: "runtime.warning" as const,
              ...runtimeEventBase(event, canonicalThreadId),
              payload: {
                message: failureMessage,
                ...(event.payload !== undefined ? { detail: event.payload } : {}),
              },
            },
          ]
        : []),
    ];
  }

  if (isKnownCodexMethod(event)) {
    return [];
  }
  return [mapUnmappedCodexEvent(event, canonicalThreadId)];
}

const makeCodexAdapter = (options?: CodexAdapterLiveOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* Effect.service(ServerConfig);
    // Optional so adapter tests can run without the gateway layer; when
    // present, every session gets the synara_* MCP tools.
    const agentGatewayCredentials = Option.getOrUndefined(
      yield* Effect.serviceOption(AgentGatewayCredentials),
    );
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);

    const manager = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        if (options?.manager) {
          return options.manager;
        }
        const services = yield* Effect.services<never>();
        return (
          options?.makeManager?.(services) ??
          new CodexAppServerManager(services, {
            synaraSkillsDir: synaraSkillsDir(serverConfig.baseDir),
            ...(agentGatewayCredentials
              ? {
                  agentGatewayMcp: {
                    endpointUrl: () => agentGatewayCredentials.mcpEndpointUrl,
                    // Codex leases inside the app-server manager, which owns
                    // session restarts. The manager carries the start input's
                    // capability facts; review runtimes request none.
                    acquireSessionLease: (threadId, capabilityInput) =>
                      acquireAgentGatewaySessionLease(
                        agentGatewayCredentials,
                        threadId,
                        PROVIDER,
                        capabilityInput ?? AGENT_GATEWAY_NO_CAPABILITIES,
                      )!,
                  },
                }
              : {}),
          })
        );
      }),
      (manager) => Effect.promise(() => manager.stopAll()),
    );

    const runtimeEventQueue = yield* Queue.bounded<ProviderRuntimeEvent>(
      PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
    );
    const shouldSurfaceUnmappedEvent = makeUnmappedProviderEventGate();
    const mapCodexRuntimeEvents = makeCodexRuntimeEventMapper();

    // Idle-progress backstop for codex turns. Same semantics as
    // AcpTurnIdleWatchdog (any inbound activity resets it, a pending human
    // decision pauses it), driven by one shared ticker because codex activity
    // arrives on a single manager event stream instead of per-session fibers.
    const turnWatchdogs = new Map<ThreadId, CodexTurnWatchdogEntry>();

    const armTurnWatchdog = (threadId: ThreadId, turnId: TurnId): void => {
      turnWatchdogs.set(threadId, { turnId, lastActivityAt: Date.now() });
    };

    const trackTurnWatchdogActivity = (
      threadId: ThreadId,
      runtimeEvents: ReadonlyArray<ProviderRuntimeEvent>,
    ): void => {
      const entry = turnWatchdogs.get(threadId);
      if (entry) {
        entry.lastActivityAt = Date.now();
      }
      for (const runtimeEvent of runtimeEvents) {
        if (runtimeEvent.type === "turn.started" && runtimeEvent.turnId) {
          armTurnWatchdog(threadId, runtimeEvent.turnId);
        }
      }
    };

    const abandonStalledTurn = (threadId: ThreadId, turnId: TurnId, idleMs: number): void => {
      const idleSeconds = Math.round(idleMs / 1000);
      void manager
        .abandonTurn(
          threadId,
          turnId,
          `Codex stopped responding (no activity for ${idleSeconds}s); the turn was aborted.`,
        )
        .catch((cause: unknown) => {
          void Effect.runPromise(
            Effect.logError("Codex idle turn abandon failed", {
              threadId,
              turnId,
              idleMs,
              cause,
            }),
          );
        });
    };

    const evaluateTurnWatchdogs = (): void => {
      const now = Date.now();
      for (const [threadId, entry] of turnWatchdogs) {
        const idleMs = now - entry.lastActivityAt;
        const decision = evaluateAcpTurnIdleTick({
          isTurnActive: manager.isTurnActive(threadId, entry.turnId),
          isAwaitingHuman: manager.isAwaitingHumanResponse(threadId),
          idleMs,
          idleTimeoutMs: CODEX_TURN_IDLE_TIMEOUT_MS,
        });
        if (decision === "continue") {
          continue;
        }
        if (decision === "touch") {
          // Blocked on a human, not hung: keep the clock fresh so the turn
          // cannot trip the watchdog the instant it resumes.
          entry.lastActivityAt = now;
          continue;
        }
        // Both "stop" (the turn already settled) and "timeout" disarm; a timeout
        // disarms first so a slow interrupt cannot let the next tick re-fire.
        turnWatchdogs.delete(threadId);
        if (decision === "timeout") {
          abandonStalledTurn(threadId, entry.turnId, idleMs);
        }
      }
    };

    const prepareCodexManagerTurnInput = (
      input: ProviderSendTurnInput,
      method: "turn/start" | "turn/steer",
    ): Effect.Effect<CodexAppServerSendTurnInput, ProviderAdapterRequestError> =>
      Effect.gen(function* () {
        const nativeCodexAttachments = yield* Effect.forEach(
          filterProviderPromptImageAttachments(input.attachments),
          (attachment) => {
            const attachmentPath = resolveProviderAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              const cause = new Error(`Invalid attachment id '${attachment.id}'.`);
              return Effect.fail(
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method,
                  detail: cause.message,
                  cause,
                }),
              );
            }
            return Effect.succeed({ type: "localImage" as const, path: attachmentPath });
          },
          { concurrency: 1 },
        );
        const composedInput = composeCodexInputWithFileAttachments({
          input: input.input,
          attachments: input.attachments,
          attachmentsDir: serverConfig.attachmentsDir,
        });

        return {
          threadId: input.threadId,
          ...(composedInput !== undefined ? { input: composedInput } : {}),
          ...(input.skills !== undefined ? { skills: input.skills } : {}),
          ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
          ...codexModelSelectionOverrides(input.modelSelection),
          ...(input.interactionMode !== undefined
            ? { interactionMode: input.interactionMode }
            : {}),
          ...(nativeCodexAttachments.length > 0 ? { attachments: nativeCodexAttachments } : {}),
        } satisfies CodexAppServerSendTurnInput;
      });

    const startSession: CodexAdapterShape["startSession"] = (input) => {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          }),
        );
      }

      const managerInput: CodexAppServerStartSessionInput = {
        threadId: input.threadId,
        provider: "codex",
        ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
        ...(input.lifecycleGeneration !== undefined
          ? { lifecycleGeneration: input.lifecycleGeneration }
          : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        ...(input.expectedCodexContinuationGeneration
          ? { expectedCodexContinuationGeneration: input.expectedCodexContinuationGeneration }
          : {}),
        ...(input.forkSourceResumeCursor !== undefined
          ? { forkSourceResumeCursor: input.forkSourceResumeCursor }
          : {}),
        ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
        ...(input.additionalDirectories !== undefined
          ? { additionalDirectories: input.additionalDirectories }
          : {}),
        agentGatewayCapabilityInput: captureAgentGatewayCapabilityInput(input),
        ...(input.autoApproveSynaraTools !== undefined
          ? { autoApproveSynaraTools: input.autoApproveSynaraTools }
          : {}),
        runtimeMode: input.runtimeMode,
        ...codexModelSelectionOverrides(input.modelSelection),
      };

      return Effect.tryPromise({
        try: () => manager.startSession(managerInput),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to start Codex adapter session."),
            ...(cause instanceof CodexSessionStartError
              ? { reason: "startup-failed" as const }
              : {}),
            cause,
          }),
      });
    };

    const sendTurn: CodexAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const managerInput = yield* prepareCodexManagerTurnInput(input, "turn/start");

        return yield* Effect.tryPromise({
          try: () => manager.sendTurn(managerInput),
          catch: (cause) => toRequestError(input.threadId, "turn/start", cause),
        }).pipe(
          // Armed here as well as on `turn.started`, so a child that goes silent
          // before its first notification is still covered.
          Effect.tap((result) => Effect.sync(() => armTurnWatchdog(input.threadId, result.turnId))),
          Effect.map((result) => ({
            ...result,
            threadId: input.threadId,
          })),
        );
      });

    const steerTurn: CodexAdapterShape["steerTurn"] = (input) =>
      Effect.gen(function* () {
        const managerInput = yield* prepareCodexManagerTurnInput(input, "turn/steer");

        return yield* Effect.tryPromise({
          try: () => manager.steerTurn(managerInput),
          catch: (cause) => toRequestError(input.threadId, "turn/steer", cause),
        }).pipe(
          Effect.tap((result) => Effect.sync(() => armTurnWatchdog(input.threadId, result.turnId))),
          // The `turn/steer` response carries no runtime event and the model
          // only consumes injected input at its next turn boundary, so without
          // this a landed steer is indistinguishable from a dropped one.
          Effect.tap((result) => {
            const message = input.input?.trim();
            if (!message) {
              return Effect.void;
            }
            return Queue.offer(runtimeEventQueue, {
              type: "turn.steered",
              eventId: EventId.makeUnsafe(crypto.randomUUID()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: result.turnId,
              createdAt: new Date().toISOString(),
              payload: { message, target: "turn" },
            });
          }),
          Effect.map((result) => ({
            ...result,
            threadId: input.threadId,
          })),
        );
      });

    const startReview: CodexAdapterShape["startReview"] = (input) =>
      Effect.tryPromise({
        try: () => manager.startReview(input),
        catch: (cause) => toRequestError(input.threadId, "review/start", cause),
      }).pipe(
        Effect.tap((result) => Effect.sync(() => armTurnWatchdog(input.threadId, result.turnId))),
        Effect.map((result) => ({
          ...result,
          threadId: input.threadId,
        })),
      );

    const interruptTurn: CodexAdapterShape["interruptTurn"] = (
      threadId,
      turnId,
      providerThreadId,
    ) =>
      Effect.tryPromise({
        try: () => manager.interruptTurn(threadId, turnId, providerThreadId),
        catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
      });

    const readThread: CodexAdapterShape["readThread"] = (threadId) =>
      Effect.tryPromise({
        try: () => manager.readThread(threadId),
        catch: (cause) => toRequestError(threadId, "thread/read", cause),
      }).pipe(
        Effect.map((snapshot) => ({
          threadId,
          turns: snapshot.turns,
          cwd: snapshot.cwd ?? null,
        })),
      );

    const CODEX_THREAD_ACTIVITY_PROBE_TIMEOUT_MS = 5_000;
    const readThreadActivity: NonNullable<CodexAdapterShape["readThreadActivity"]> = (threadId) =>
      Effect.tryPromise({
        try: () => manager.readThreadStatus(threadId, CODEX_THREAD_ACTIVITY_PROBE_TIMEOUT_MS),
        catch: (cause) => toRequestError(threadId, "thread/read", cause),
      }).pipe(
        Effect.map((status): ProviderThreadActivity => {
          switch (status) {
            case "active":
              return "active";
            case "idle":
              return "idle";
            case "notLoaded":
              return "not-loaded";
            case "systemError":
              return "error";
          }
        }),
      );

    const readExternalThread: NonNullable<CodexAdapterShape["readExternalThread"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.readExternalThread({
            externalThreadId: input.externalThreadId,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.providerOptions?.codex ? { codexOptions: input.providerOptions.codex } : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "thread/read",
            detail: toMessage(cause, "Failed to read external Codex thread."),
            cause,
          }),
      }).pipe(
        Effect.map((snapshot) => ({
          threadId: ThreadId.makeUnsafe(snapshot.threadId),
          turns: snapshot.turns,
          cwd: snapshot.cwd ?? null,
        })),
      );

    const readExternalThreadPage: NonNullable<CodexAdapterShape["readExternalThreadPage"]> = (
      input,
    ) =>
      Effect.tryPromise({
        try: () =>
          manager.readExternalThreadPage({
            externalThreadId: input.externalThreadId,
            ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.providerOptions?.codex ? { codexOptions: input.providerOptions.codex } : {}),
          }),
        catch: (cause) =>
          toRequestError(ThreadId.makeUnsafe(input.externalThreadId), "thread/turns/list", cause),
      }).pipe(Effect.map((page) => ({ ...page, threadId: ThreadId.makeUnsafe(page.threadId) })));

    const rollbackThread: CodexAdapterShape["rollbackThread"] = (threadId, numTurns) => {
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          }),
        );
      }

      return Effect.tryPromise({
        try: () => manager.rollbackThread(threadId, numTurns),
        catch: (cause) => toRequestError(threadId, "thread/revert", cause),
      }).pipe(
        Effect.map((snapshot) => ({
          threadId,
          turns: snapshot.turns,
        })),
      );
    };

    const compactThread: NonNullable<CodexAdapterShape["compactThread"]> = (threadId) =>
      Effect.tryPromise({
        try: () => manager.compactThread(threadId),
        catch: (cause) => toRequestError(threadId, "thread/compact/start", cause),
      });

    const forkThread: CodexAdapterShape["forkThread"] = (input) =>
      Effect.tryPromise({
        try: (signal) => manager.forkThread(input, signal),
        catch: (cause) => toRequestError(input.sourceThreadId, "thread/fork", cause),
      });

    const respondToRequest: CodexAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.tryPromise({
        try: () => manager.respondToRequest(threadId, requestId, decision),
        catch: (cause) => toRequestError(threadId, "item/requestApproval/decision", cause),
      });

    const respondToUserInput: CodexAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.tryPromise({
        try: () => manager.respondToUserInput(threadId, requestId, answers),
        catch: (cause) => toRequestError(threadId, "item/tool/requestUserInput", cause),
      });

    const stopSession: CodexAdapterShape["stopSession"] = (threadId) =>
      Effect.tryPromise({
        try: () => manager.stopSession(threadId),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: toMessage(cause, "Failed to stop Codex adapter session."),
            cause,
          }),
      });

    const listSessions: CodexAdapterShape["listSessions"] = () =>
      Effect.sync(() => manager.listSessions());

    const listGeneratedImageHomePaths: NonNullable<
      CodexAdapterShape["listGeneratedImageHomePaths"]
    > = (input) =>
      Effect.sync(() => {
        const homePaths = new Map<string, CodexGeneratedImageHomeCandidate>();
        for (const { session, codexOptions } of manager.inspectSessions()) {
          const instanceId = session.providerInstanceId ?? (PROVIDER as ProviderInstanceId);
          if (
            input?.enabledProviderInstanceIds &&
            !input.enabledProviderInstanceIds.has(instanceId)
          ) {
            continue;
          }
          if (!codexOptions) {
            continue;
          }
          const candidateKey =
            typeof codexOptions === "string"
              ? `path:${codexOptions}`
              : JSON.stringify(codexOptions);
          homePaths.set(candidateKey, codexOptions);
        }
        return [...homePaths.values()];
      });

    const hasSession: CodexAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => manager.hasSession(threadId));

    const stopAll: CodexAdapterShape["stopAll"] = () =>
      Effect.tryPromise({
        try: () => manager.stopAll(),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: ThreadId.makeUnsafe("codex:all"),
            detail: toMessage(cause, "Failed to stop all Codex app-server processes."),
            cause,
          }),
      });

    const getComposerCapabilities: NonNullable<CodexAdapterShape["getComposerCapabilities"]> = () =>
      Effect.succeed(manager.getComposerCapabilities() satisfies ProviderComposerCapabilities);

    const listSkills: NonNullable<CodexAdapterShape["listSkills"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.listSkills({
            cwd: input.cwd,
            ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            codexOptions: {
              ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
              ...(input.homePath ? { homePath: input.homePath } : {}),
              ...(input.shadowHomePath ? { shadowHomePath: input.shadowHomePath } : {}),
              ...(input.accountId ? { accountId: input.accountId } : {}),
              ...(input.environment ? { environment: input.environment } : {}),
            },
            ...(input.forceReload !== undefined ? { forceReload: input.forceReload } : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "skills/list",
            detail: toMessage(cause, "skills/list failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderListSkillsResult));

    const listPlugins: NonNullable<CodexAdapterShape["listPlugins"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.listPlugins({
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            codexOptions: {
              ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
              ...(input.homePath ? { homePath: input.homePath } : {}),
              ...(input.shadowHomePath ? { shadowHomePath: input.shadowHomePath } : {}),
              ...(input.accountId ? { accountId: input.accountId } : {}),
              ...(input.environment ? { environment: input.environment } : {}),
            },
            ...(input.forceRemoteSync !== undefined
              ? { forceRemoteSync: input.forceRemoteSync }
              : {}),
            ...(input.forceReload !== undefined ? { forceReload: input.forceReload } : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "plugin/list",
            detail: toMessage(cause, "plugin/list failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderListPluginsResult));

    const readPlugin: NonNullable<CodexAdapterShape["readPlugin"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.readPlugin({
            marketplacePath: input.marketplacePath,
            pluginName: input.pluginName,
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            codexOptions: {
              ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
              ...(input.homePath ? { homePath: input.homePath } : {}),
              ...(input.shadowHomePath ? { shadowHomePath: input.shadowHomePath } : {}),
              ...(input.accountId ? { accountId: input.accountId } : {}),
              ...(input.environment ? { environment: input.environment } : {}),
            },
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "plugin/read",
            detail: toMessage(cause, "plugin/read failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderReadPluginResult));

    const listModels: NonNullable<CodexAdapterShape["listModels"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.listModels({
            ...(input.cwd ? { cwd: input.cwd } : {}),
            codexOptions: {
              ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
              ...(input.homePath ? { homePath: input.homePath } : {}),
              ...(input.shadowHomePath ? { shadowHomePath: input.shadowHomePath } : {}),
              ...(input.accountId ? { accountId: input.accountId } : {}),
              ...(input.environment ? { environment: input.environment } : {}),
            },
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "model/list",
            detail: toMessage(cause, "model/list failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderListModelsResult));

    const transcribeVoice: NonNullable<CodexAdapterShape["transcribeVoice"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.transcribeVoice({
            ...input,
            ...(input.providerOptions?.codex ? { codexOptions: input.providerOptions.codex } : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "voice/transcribe",
            detail: toMessage(cause, "voice/transcribe failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ServerVoiceTranscriptionResult));

    const prewarmVoice: NonNullable<CodexAdapterShape["prewarmVoice"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.prewarmVoice({
            cwd: input.cwd,
            ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            ...(input.providerOptions?.codex ? { codexOptions: input.providerOptions.codex } : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "voice/prewarm",
            detail: toMessage(cause, "voice/prewarm failed"),
            cause,
          }),
      });

    yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const writeNativeEvent = (event: ProviderEvent) =>
          Effect.gen(function* () {
            if (!nativeEventLogger) {
              return;
            }
            yield* nativeEventLogger.write(event, event.threadId);
          });
        const filterRuntimeEvents = (
          event: ProviderEvent,
          events: ReadonlyArray<ProviderRuntimeEvent>,
        ) =>
          events.filter(
            (runtimeEvent) =>
              runtimeEvent.type !== "event.unmapped" ||
              (!DIAGNOSTIC_ONLY_CODEX_METHODS.has(event.method) &&
                shouldSurfaceUnmappedEvent(event)),
          );

        const ingress = yield* makeBoundedCallbackIngress<
          CodexRuntimeIngressItem,
          never,
          never,
          CodexSessionInspection | null | undefined
        >(
          (item, inspection) =>
            Effect.gen(function* () {
              if (!item.trustedClose && (inspection === null || item.isAuthRejected())) return;
              yield* writeNativeEvent(item.nativeEvent).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Codex native event logging failed", {
                    threadId: item.nativeEvent.threadId,
                    method: item.nativeEvent.method,
                    cause: Cause.pretty(cause),
                  }),
                ),
              );
              const runtimeEvents = item.runtimeEvents;
              if (runtimeEvents.length === 0) {
                yield* Effect.logDebug("ignoring unhandled Codex provider event", {
                  method: item.nativeEvent.method,
                  threadId: item.nativeEvent.threadId,
                  turnId: item.nativeEvent.turnId,
                  itemId: item.nativeEvent.itemId,
                });
                return;
              }
              if (item.trustedClose || !item.isAuthRejected())
                yield* Queue.offerAll(runtimeEventQueue, runtimeEvents);
            }),
          {
            prepareConcurrency: 8,
            prepareKey: (item) => (item.trustedClose ? undefined : item.validationKey),
            laneKey: (item) => item.nativeEvent.threadId,
            prepare: ({
              inspect,
              trustedClose,
              isAuthRejected,
              rejectInspection,
              nativeEvent: { threadId },
            }) => {
              if (trustedClose) return Promise.resolve(undefined);
              if (isAuthRejected()) return Promise.resolve(null);
              return Promise.resolve()
                .then(inspect)
                .catch((error: unknown) => {
                  if (error instanceof CodexSessionAuthInvalidatedError) return null;
                  rejectInspection();
                  void Effect.runPromise(
                    Effect.logError("Codex callback auth inspection failed; origin rejected", {
                      threadId,
                    }),
                  );
                  return null;
                });
            },
            capacity: PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
            maxBufferedBytes: PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES,
            terminalReserve: PROVIDER_RUNTIME_CALLBACK_TERMINAL_RESERVE,
            isTerminal: (item) => item.runtimeEvents.some(isTerminalProviderRuntimeEvent),
            sizeOf: (item) => item.bytes,
          },
        );
        let nextDroppedWarning = 1;
        const listener = (event: ProviderEvent) => {
          const origin = manager.getSessionEventOrigin(event.threadId, event.lifecycleGeneration);
          const stampedEvent = stampEvent(event, origin.providerInstanceId);
          const mappedRuntimeEvents = assignDerivedProviderRuntimeEventIds(
            mapCodexRuntimeEvents(stampedEvent, stampedEvent.threadId, origin.codexOptions),
          );
          const hasUnmappedEvent = mappedRuntimeEvents.some(
            (runtimeEvent) => runtimeEvent.type === "event.unmapped",
          );
          const sizedRuntimeEvents = filterRuntimeEvents(stampedEvent, mappedRuntimeEvents).map(
            compactProviderRuntimeEventForIngress,
          );
          const runtimeEvents = sizedRuntimeEvents.map((item) => item.event);
          trackTurnWatchdogActivity(stampedEvent.threadId, runtimeEvents);
          const nativeEvent = compactCodexNativeEventForIngress(
            hasUnmappedEvent ? sanitizeUnmappedProviderEvent(stampedEvent) : stampedEvent,
          );
          const result = ingress.offer({
            nativeEvent: nativeEvent.event,
            inspect: origin.inspect,
            isAuthRejected: origin.isAuthRejected,
            validationKey: origin.validationKey,
            rejectInspection: origin.rejectInspection,
            // This notice is authored by the manager, not by provider stdout.
            // Stale auth must suppress provider output but still durably close its session.
            trustedClose: event.kind === "session" && event.method === "session/closed",
            runtimeEvents,
            bytes:
              nativeEvent.bytes + sizedRuntimeEvents.reduce((total, item) => total + item.bytes, 0),
          });
          if (result === "dropped" || result === "evicted-for-terminal") {
            const status = ingress.status();
            // Report the first loss and exponentially spaced totals, not one warning per delta.
            if (status.dropped >= nextDroppedWarning) {
              while (nextDroppedWarning <= status.dropped) nextDroppedWarning *= 2;
              void Effect.runPromise(
                Effect.logWarning("Codex callback ingress dropped provider events", {
                  threadId: stampedEvent.threadId,
                  method: stampedEvent.method,
                  status,
                }),
              );
            }
          }
          if (result === "terminal-overflow") {
            // This means the reserved terminal budget itself was exhausted.
            // The runtime reconciler remains the final recovery fence.
            void Effect.runPromise(
              Effect.logError("Codex callback ingress exhausted terminal reserve", {
                threadId: stampedEvent.threadId,
                method: stampedEvent.method,
                status: ingress.status(),
              }),
            );
          }
        };
        manager.on("event", listener);
        const watchdogTicker = setInterval(evaluateTurnWatchdogs, CODEX_TURN_WATCHDOG_INTERVAL_MS);
        watchdogTicker.unref();
        return { ingress, listener, watchdogTicker };
      }),
      ({ ingress, listener, watchdogTicker }) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            clearInterval(watchdogTicker);
            turnWatchdogs.clear();
            manager.off("event", listener);
          });
          yield* ingress.abort;
          yield* Queue.shutdown(runtimeEventQueue);
        }),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsSkillMentions: true,
        supportsSkillDiscovery: true,
        supportsNativeSlashCommandDiscovery: false,
        supportsPluginMentions: true,
        supportsPluginDiscovery: true,
        supportsRuntimeModelList: true,
        supportsTurnSteering: true,
        supportsLiveTurnDiffPatch: true,
      },
      startSession,
      sendTurn,
      steerTurn,
      startReview,
      interruptTurn,
      readThread,
      readExternalThread,
      readThreadActivity,
      readExternalThreadPage,
      rollbackThread,
      compactThread,
      forkThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      renewAgentGatewayCredential: (threadId) =>
        Effect.tryPromise({
          try: () => manager.renewAgentGatewayCredential(threadId),
          catch: (cause) => toRequestError(threadId, "thread/resume", cause),
        }),
      listSessions,
      listGeneratedImageHomePaths,
      hasSession,
      stopAll,
      getComposerCapabilities,
      listSkills,
      listPlugins,
      readPlugin,
      listModels,
      prewarmVoice,
      transcribeVoice,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies CodexAdapterShape;
  });

export const CodexAdapterLive = Layer.effect(CodexAdapter, makeCodexAdapter());

export function makeCodexAdapterLive(options?: CodexAdapterLiveOptions) {
  return Layer.effect(CodexAdapter, makeCodexAdapter(options));
}
