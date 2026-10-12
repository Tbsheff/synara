import { createHash } from "node:crypto";

import {
  ApprovalRequestId,
  ProviderApprovalRule,
  type CommandExecutionDetails,
  type CommandParsedAction,
  EventId,
  FileChangeDetails,
  isToolLifecycleItemType,
  type MessageId,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
  type ReasoningDetails,
  ThreadId,
  type ToolCallDetails,
  TRANSCRIPT_FILE_CHANGES_MAX_ENTRIES,
  TRANSCRIPT_FILE_DIFF_MAX_CHARS,
  TRANSCRIPT_NOTICE_ACTIVITY_KIND,
  TRANSCRIPT_NOTICE_BODY_MAX_CHARS,
  TRANSCRIPT_REASONING_MAX_CHARS,
  TRANSCRIPT_TOOL_ARGUMENTS_MAX_CHARS,
  TRANSCRIPT_TOOL_RESULT_MAX_CHARS,
  type TranscriptNotice,
  TurnId,
  type TurnOrigin,
  type WebSearchDetails,
} from "@synara/contracts";
import { nonEmptyTrimmed, splitsSurrogatePair, unicodeSafeEndOffset } from "@synara/shared/text";
import { Option, Schema } from "effect";

import { deriveReasoningHeading } from "./reasoningHeading.ts";
import {
  OUTPUT_TRUNCATION_PREFIX,
  outputTailFromText,
  renderOutputTail,
} from "./liveToolOutput.ts";

import {
  isSensitiveKey,
  REDACTED_SENSITIVE_VALUE,
  redactSensitiveJsonFields,
} from "../sensitiveKeys.ts";
import {
  sanitizeUnmappedProviderData,
  sanitizeUnmappedProviderDetail,
} from "../provider/unmappedProviderEvents.ts";

const MAX_ACTIVITY_DATA_JSON_CHARS = 16_000;
const MAX_ACTIVITY_DATA_STRING_CHARS = 2_000;
const MAX_REASONING_DETAIL_CHARS = TRANSCRIPT_REASONING_MAX_CHARS;
export const MAX_ACTIVITY_PAYLOAD_JSON_CHARS = 64_000;
const MAX_TYPED_SHORT_TEXT_CHARS = 2_000;
const MAX_TYPED_LIST_ENTRIES = 50;
const MAX_NOTICE_TITLE_CHARS = 200;
const MAX_NOTICE_DEDUPE_KEY_CHARS = 160;
const MAX_ACTIVITY_DATA_ARRAY_ITEMS = 24;
const MAX_ACTIVITY_DATA_OBJECT_KEYS = 64;
const ACTIVITY_DATA_TRUNCATION_MARKER = "__synaraTruncated";

type ActivityPayload = OrchestrationThreadActivity["payload"];

/**
 * Project a value onto exactly what `Schema.Json` admits: `null`, finite numbers,
 * booleans, strings, arrays and records of the same.
 *
 * Activity payloads splice in raw provider values - `Schema.Unknown` payload
 * fields, rate-limit blobs, usage records, workflow snapshots - that are built in
 * adapter code and never decoded. Those can carry explicitly-present `undefined`
 * members, bigints, functions, symbols, non-finite numbers or cycles, and any one
 * of them makes the enclosing `thread.activity.append` command fail its own schema.
 *
 * Primitive, array and object-member semantics match `JSON.stringify`
 * (undefined/function/symbol members dropped from objects and nulled inside
 * arrays, non-finite numbers nulled), Dates keep their JSON timestamp, and bigint
 * plus cycle handling matches {@link stringifyJsonLike}. Already-safe values are
 * returned by reference: a payload built from literals is walked but never copied.
 */
function jsonSafeValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value !== "object") {
    // undefined, function, symbol: no JSON representation at all.
    return undefined;
  }
  if (ancestors.has(value)) {
    return "[Circular]";
  }
  ancestors.add(value);
  try {
    if (value instanceof Date) {
      return value.toJSON();
    }
    if (Array.isArray(value)) {
      let changed = false;
      const retained: unknown[] = new Array<unknown>(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const entry = value[index];
        // Array positions are meaningful: an unrepresentable entry becomes null
        // rather than shifting everything after it.
        const safe = jsonSafeValue(entry, ancestors) ?? null;
        changed ||= !Object.is(safe, entry);
        retained[index] = safe;
      }
      return changed ? retained : value;
    }
    const prototype = Object.getPrototypeOf(value);
    const canReuseObject = prototype === Object.prototype || prototype === null;
    let changed = false;
    const retained: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const safe = jsonSafeValue(entry, ancestors);
      if (safe === undefined) {
        changed = true;
        continue;
      }
      changed ||= !Object.is(safe, entry);
      retained[key] = safe;
    }
    // Class instances, Dates, Maps, typed arrays, and other exotic objects are
    // not Schema.Json even when their enumerable entries happen to be safe.
    return changed || !canReuseObject ? retained : value;
  } finally {
    ancestors.delete(value);
  }
}

function toActivityPayload(payload: unknown): ActivityPayload {
  return (jsonSafeValue(payload, new Set<object>()) ?? null) as ActivityPayload;
}

function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  // A blank runtime turn id means "no turn", not a turn named "". Trimming here
  // is not cosmetic: `TurnId.makeUnsafe` throws on both blank and untrimmed input.
  const trimmed = value === undefined ? undefined : nonEmptyTrimmed(String(value));
  return trimmed === undefined ? undefined : TurnId.makeUnsafe(trimmed);
}

function truncateDetail(value: string, limit = 180): string {
  return value.length > limit
    ? `${value.slice(0, unicodeSafeEndOffset(value, limit - 3))}...`
    : value;
}

function isPlainJsonTree(value: unknown, seen: Set<object>): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isPlainJsonTree(entry, seen));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  return Object.values(value).every((entry) => isPlainJsonTree(entry, seen));
}

function stringifyJsonLikeFallback(value: unknown): string {
  const seen = new WeakSet<object>();
  return (
    JSON.stringify(value, (_key, entry) => {
      if (typeof entry === "bigint") {
        return entry.toString();
      }
      if (typeof entry === "function" || typeof entry === "symbol") {
        return undefined;
      }
      if (entry && typeof entry === "object") {
        if (seen.has(entry)) {
          return "[Circular]";
        }
        seen.add(entry);
      }
      return entry;
    }) ?? "null"
  );
}

function serializeJsonLike(value: unknown): {
  readonly text: string;
  readonly plain: boolean;
} {
  const plain = isPlainJsonTree(value, new Set<object>());
  return {
    text: plain ? (JSON.stringify(value) ?? "null") : stringifyJsonLikeFallback(value),
    plain,
  };
}

function stringifyJsonLike(value: unknown): string {
  return serializeJsonLike(value).text;
}

function truncateJsonString(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, Math.max(0, limit - 15))}... [truncated]` : value;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function activityPayloadKeyRank(key: string): number {
  const ranks: Record<string, number> = {
    itemType: 0,
    status: 1,
    title: 2,
    detail: 3,
    toolName: 4,
    tool: 5,
    toolCallId: 6,
    callID: 7,
    callId: 8,
    command: 9,
    cmd: 10,
    input: 11,
    rawInput: 12,
    arguments: 13,
    args: 14,
    params: 15,
    item: 16,
    result: 17,
    rawOutput: 18,
    output: 19,
    data: 20,
    commandActions: 21,
    files: 22,
    changes: 23,
    path: 24,
    file: 25,
    filePath: 26,
    stdout: 27,
    stderr: 28,
    content: 29,
    totalFiles: 30,
    truncated: 31,
  };
  return ranks[key] ?? 100;
}

function truncateJsonValue(
  value: unknown,
  options: {
    readonly stringLimit: number;
    readonly arrayItems: number;
    readonly objectKeys: number;
    readonly depth: number;
    readonly seen?: WeakSet<object>;
  },
): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return truncateJsonString(value, options.stringLimit);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "function" || typeof value === "symbol" || value === undefined) {
    return null;
  }
  const seen = options.seen ?? new WeakSet<object>();
  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
  }
  if (options.depth <= 0) {
    return isJsonObject(value) || Array.isArray(value)
      ? {
          [ACTIVITY_DATA_TRUNCATION_MARKER]: true,
        }
      : String(value);
  }
  if (Array.isArray(value)) {
    const retained = value
      .slice(0, options.arrayItems)
      .map((entry) => truncateJsonValue(entry, { ...options, depth: options.depth - 1 }));
    if (value.length > options.arrayItems) {
      retained.push({
        [ACTIVITY_DATA_TRUNCATION_MARKER]: true,
        omittedItems: value.length - options.arrayItems,
      });
    }
    return retained;
  }
  if (!isJsonObject(value)) {
    return String(value);
  }

  const entries = Object.entries(value).filter(
    ([, entry]) => entry !== undefined && typeof entry !== "function" && typeof entry !== "symbol",
  );
  const retainedEntries = selectLeadingActivityPayloadEntries(entries, options.objectKeys);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of retainedEntries) {
    result[key] = truncateJsonValue(entry, { ...options, depth: options.depth - 1 });
  }
  if (entries.length > options.objectKeys) {
    result[ACTIVITY_DATA_TRUNCATION_MARKER] = true;
    result.omittedKeys = entries.length - options.objectKeys;
  }
  return result;
}

function boundActivityData(value: unknown): unknown {
  const serialization = serializeJsonLike(value);
  const serialized = serialization.text;
  if (serialized.length <= MAX_ACTIVITY_DATA_JSON_CHARS) {
    return serialization.plain ? value : JSON.parse(serialized);
  }

  const withTruncationMetadata = (bounded: unknown): Record<string, unknown> => {
    const metadata = {
      [ACTIVITY_DATA_TRUNCATION_MARKER]: true,
      originalJsonChars: serialized.length,
    };
    return isJsonObject(bounded) ? { ...bounded, ...metadata } : { ...metadata, value: bounded };
  };
  const hardFallback = (): Record<string, unknown> => ({
    [ACTIVITY_DATA_TRUNCATION_MARKER]: true,
    originalJsonChars: serialized.length,
    preview: truncateJsonString(serialized, MAX_ACTIVITY_DATA_STRING_CHARS),
  });

  const compact = truncateJsonValue(value, {
    stringLimit: MAX_ACTIVITY_DATA_STRING_CHARS,
    arrayItems: MAX_ACTIVITY_DATA_ARRAY_ITEMS,
    objectKeys: MAX_ACTIVITY_DATA_OBJECT_KEYS,
    depth: 6,
  });
  const compactWithMetadata = withTruncationMetadata(compact);
  if (stringifyJsonLike(compactWithMetadata).length <= MAX_ACTIVITY_DATA_JSON_CHARS) {
    return compactWithMetadata;
  }

  const bounded = withTruncationMetadata(
    truncateJsonValue(value, {
      stringLimit: 800,
      arrayItems: 12,
      objectKeys: 32,
      depth: 4,
    }),
  );
  return stringifyJsonLike(bounded).length <= MAX_ACTIVITY_DATA_JSON_CHARS
    ? bounded
    : hardFallback();
}

// Tool payloads power the timeline, but they must stay small enough for snapshots.
function activityDataField(data: unknown): { readonly data?: unknown } {
  return data === undefined ? {} : { data: boundActivityData(data) };
}

// Keep MCP progress payloads available to the web timeline so it can render the specific tool call.
function buildToolProgressActivityPayload(
  event: Extract<ProviderRuntimeEvent, { type: "tool.progress" }>,
  itemType: string | undefined,
): ActivityPayload {
  const toolName = nonEmptyTrimmed(event.payload.toolName);
  return toActivityPayload({
    ...(itemType !== undefined ? { itemType } : {}),
    title: itemType === "mcp_tool_call" ? "MCP tool call" : (toolName ?? "Tool call"),
    ...(event.payload.summary
      ? { detail: truncateDetail(event.payload.summary, MAX_ACTIVITY_DATA_STRING_CHARS) }
      : {}),
    data: {
      ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
      ...(event.payload.toolName ? { toolName: event.payload.toolName } : {}),
      ...(event.payload.summary ? { summary: event.payload.summary } : {}),
      ...(event.payload.elapsedSeconds !== undefined
        ? { elapsedSeconds: event.payload.elapsedSeconds }
        : {}),
    },
  });
}

export function readableReasoningDetail(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed?.replace(/<!--[\s\S]*?-->/gu, "").trim() ? trimmed : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return isJsonObject(value) ? value : undefined;
}

const MAX_RUNTIME_ERROR_DETAIL_ENTRIES = 10;
const MAX_RUNTIME_ERROR_DETAIL_CHARS = 500;

function projectRuntimeErrorDetail(detail: unknown): Record<string, unknown> | undefined {
  const record = asObject(detail);
  if (!record) return undefined;
  const errors = Array.isArray(record.errors)
    ? record.errors.flatMap((error) => {
        const text = typeof error === "string" ? error.trim() : "";
        return text.length > 0 ? [truncateDetail(text, MAX_RUNTIME_ERROR_DETAIL_CHARS)] : [];
      })
    : [];
  const permissionDenials =
    typeof record.permissionDenials === "number" &&
    Number.isInteger(record.permissionDenials) &&
    record.permissionDenials > 0
      ? record.permissionDenials
      : undefined;
  const terminalReason = nonEmptyTrimmed(asString(record.terminalReason) ?? "");
  const projected = withDefined({
    errors: errors.length > 0 ? errors.slice(0, MAX_RUNTIME_ERROR_DETAIL_ENTRIES) : undefined,
    errorsTruncated: errors.length > MAX_RUNTIME_ERROR_DETAIL_ENTRIES ? true : undefined,
    permissionDenials,
    terminalReason: terminalReason === undefined ? undefined : truncateDetail(terminalReason, 200),
  });
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function buildContextWindowActivityPayload(
  event: ProviderRuntimeEvent,
): ActivityPayload | undefined {
  if (event.type !== "thread.token-usage.updated") {
    return undefined;
  }
  const usage = event.payload.usage;
  const hasTokenUsage = usage.usedTokens > 0;
  const hasPercentUsage =
    typeof usage.usedPercent === "number" && Number.isFinite(usage.usedPercent);
  const hasKnownWindow = typeof usage.maxTokens === "number" && Number.isFinite(usage.maxTokens);
  const hasProcessedTokens =
    typeof usage.totalProcessedTokens === "number" &&
    Number.isFinite(usage.totalProcessedTokens) &&
    usage.totalProcessedTokens > 0;
  if (!hasTokenUsage && !hasPercentUsage && !hasKnownWindow && !hasProcessedTokens) {
    return undefined;
  }
  // Stamp the emitting provider so token stats can attribute usage to the
  // provider that actually processed the turn, not the thread's persisted
  // model selection (which can drift, e.g. across future per-turn providers).
  return toActivityPayload({
    ...usage,
    provider: event.provider,
    ...(event.providerRefs?.providerThreadId
      ? {
          usageSessionId: `${event.providerRefs.providerThreadId}${event.lifecycleGeneration ? `:${event.lifecycleGeneration}` : ""}`,
        }
      : {}),
  });
}

function asPositiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

interface CompactModelUsage {
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

// Claude's SDK reports a per-model token breakdown on the turn result (subagent
// models included). Persist a compact copy on the turn.completed activity so
// token stats can attribute multi-model turns exactly; cache reads/writes fold
// into inputTokens, matching how the adapters build context-window snapshots.
function compactTurnModelUsage(
  modelUsage: Record<string, unknown> | undefined,
): Record<string, CompactModelUsage> | undefined {
  if (!modelUsage) {
    return undefined;
  }
  const compact: Record<string, CompactModelUsage> = {};
  for (const [model, value] of Object.entries(modelUsage)) {
    const usage = asObject(value);
    if (!usage) {
      continue;
    }
    const inputTokens =
      (asPositiveFiniteNumber(usage.inputTokens) ?? 0) +
      (asPositiveFiniteNumber(usage.cacheReadInputTokens) ?? 0) +
      (asPositiveFiniteNumber(usage.cacheCreationInputTokens) ?? 0);
    const outputTokens = asPositiveFiniteNumber(usage.outputTokens) ?? 0;
    const totalTokens = inputTokens + outputTokens;
    if (totalTokens <= 0) {
      continue;
    }
    // Preserve reported zeroes; missing cache counters must remain unknown.
    const cacheReadInputTokens = usage.cacheReadInputTokens;
    const cacheCreationInputTokens = usage.cacheCreationInputTokens;
    compact[model] = {
      inputTokens,
      outputTokens,
      totalTokens,
      ...(typeof cacheReadInputTokens === "number" &&
      Number.isFinite(cacheReadInputTokens) &&
      cacheReadInputTokens >= 0
        ? { cacheReadInputTokens }
        : {}),
      ...(typeof cacheCreationInputTokens === "number" &&
      Number.isFinite(cacheCreationInputTokens) &&
      cacheCreationInputTokens >= 0
        ? { cacheCreationInputTokens }
        : {}),
    };
  }
  return Object.keys(compact).length > 0 ? compact : undefined;
}

// Convert session-configured Claude window labels into the max-token shape the web meter uses.
function buildConfiguredContextWindowPayload(
  event: ProviderRuntimeEvent,
): ActivityPayload | undefined {
  if (event.type !== "session.configured") {
    return undefined;
  }
  const config = asObject(event.payload.config);
  const autoCompactWindow = config?.autoCompactWindow;
  const legacyContextWindow = config?.contextWindow;
  const configuredWindowValue = autoCompactWindow ?? legacyContextWindow;
  const configuredWindow = asString(configuredWindowValue)?.trim().toLowerCase();
  const maxTokens =
    asPositiveFiniteNumber(configuredWindowValue) ??
    (configuredWindow === "1m" ? 1_000_000 : configuredWindow === "200k" ? 200_000 : undefined);
  if (maxTokens === undefined) {
    const explicitlyCleared =
      (autoCompactWindow === null &&
        (legacyContextWindow === undefined || legacyContextWindow === null)) ||
      (autoCompactWindow === undefined && legacyContextWindow === null);
    return explicitlyCleared ? toActivityPayload({ cleared: true }) : undefined;
  }
  return toActivityPayload({
    maxTokens,
    ...(configuredWindow ? { contextWindow: configuredWindow } : {}),
  });
}

export function runtimePayloadRecord(
  event: ProviderRuntimeEvent,
): Record<string, unknown> | undefined {
  const payload = (event as { payload?: unknown }).payload;
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
}

export function runtimeTurnState(
  event: ProviderRuntimeEvent,
): "completed" | "failed" | "interrupted" | "cancelled" {
  const state = asString(runtimePayloadRecord(event)?.state);
  return state === "failed" || state === "interrupted" || state === "cancelled"
    ? state
    : "completed";
}

function requestKindFromCanonicalRequestType(
  requestType: string | undefined,
): "command" | "file-read" | "file-change" | "permissions" | "tool" | undefined {
  if (requestType === "command_execution_approval" || requestType === "exec_command_approval")
    return "command";
  if (requestType === "file_read_approval") return "file-read";
  if (requestType === "permissions_approval") return "permissions";
  if (requestType === "tool_approval") return "tool";
  // Legacy Claude classification: generic/MCP tool approvals were labelled with the
  // item type instead of the canonical "tool_approval". Kept so persisted events
  // still resolve to a renderable kind.
  if (requestType === "dynamic_tool_call") return "tool";
  return requestType === "file_change_approval" || requestType === "apply_patch_approval"
    ? "file-change"
    : undefined;
}

function requestedPermissionProfile(
  event: Extract<ProviderRuntimeEvent, { type: "request.opened" }>,
): Record<string, unknown> | undefined {
  if (event.payload.requestType !== "permissions_approval") {
    return undefined;
  }
  const args = asObject(event.payload.args);
  const permissions = asObject(args?.permissions);
  return permissions && Object.keys(permissions).length > 0
    ? (boundActivityData(permissions) as Record<string, unknown>)
    : undefined;
}

function sessionApprovalAvailable(
  event: Extract<ProviderRuntimeEvent, { type: "request.opened" }>,
): boolean | undefined {
  const args = asObject(event.payload.args);
  return typeof args?.sessionApprovalAvailable === "boolean"
    ? args.sessionApprovalAvailable
    : undefined;
}

// Approval cards render `toolParamsDisplay` entries as name/value rows, so a raw
// tool-input object has to be flattened into that shape.
function toolParamsDisplayFromToolInput(
  input: Record<string, unknown> | undefined,
): ReadonlyArray<{ readonly name: string; readonly value: unknown }> | undefined {
  if (!input) {
    return undefined;
  }
  const entries = Object.entries(input).map(([name, value]) => ({ name, value }));
  return entries.length > 0 ? entries : undefined;
}

// Values are stringified rather than passed through as nested JSON: the card
// prints one compact line per parameter, and pre-formatting keeps the persisted
// payload small. Approval cards are persisted and replayed, so a credential-named
// parameter, or a credential nested inside one, is redacted before it gets there.
function toolParamDisplayValue(names: ReadonlyArray<string | undefined>, value: unknown): string {
  if (names.some((name) => name !== undefined && isSensitiveKey(name))) {
    return REDACTED_SENSITIVE_VALUE;
  }
  if (typeof value === "string") {
    return redactStructuredToolParamString(value);
  }
  // No unredacted fallback serializer: a value JSON cannot encode is shown as
  // its string form instead.
  return safeStringifyToolParamValue(value) ?? String(value);
}

// Codex can supply already-formatted parameter strings. Inspect a complete JSON
// object or array, but leave ordinary strings and JSON without secrets unchanged.
function redactStructuredToolParamString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object") {
      return value;
    }
    let redacted = false;
    const serialized = JSON.stringify(parsed, (key, entry: unknown) => {
      if (isSensitiveKey(key)) {
        redacted = true;
      }
      return redactSensitiveJsonFields(key, entry);
    });
    return redacted ? serialized : value;
  } catch {
    return value;
  }
}

function safeStringifyToolParamValue(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, redactSensitiveJsonFields);
  } catch {
    return undefined;
  }
}

function requestedMcpToolCallPresentation(
  event: Extract<ProviderRuntimeEvent, { type: "request.opened" }>,
): { title?: string; toolName?: string; toolParamsDisplay?: unknown } {
  // "dynamic_tool_call" is the legacy Claude request type for the same approval.
  if (
    event.payload.requestType !== "tool_approval" &&
    event.payload.requestType !== "dynamic_tool_call"
  ) {
    return {};
  }
  const args = asObject(event.payload.args);
  // Codex ships presentation through MCP elicitation `_meta`; Claude's canUseTool
  // request carries the tool name and the raw tool input instead.
  const metadata = asObject(args?._meta);
  const title = asString(metadata?.tool_title);
  const toolName = asString(metadata?.tool_name) ?? asString(args?.toolName);
  const rawParams = Array.isArray(metadata?.tool_params_display)
    ? metadata.tool_params_display
    : toolParamsDisplayFromToolInput(asObject(args?.input));
  // Preserve the array shape consumed by approval cards even for large inputs.
  const toolParamsDisplay = rawParams?.slice(0, 12).map((entry) => {
    const row = asObject(entry);
    const name = asString(row?.name);
    const displayName = asString(row?.display_name);
    return {
      ...(displayName ? { display_name: truncateJsonString(displayName, 128) } : {}),
      name: truncateJsonString(name ?? "argument", 128),
      value: truncateJsonString(toolParamDisplayValue([name, displayName], row?.value), 900),
    };
  });
  return {
    ...(title ? { title: truncateJsonString(title, 128) } : {}),
    ...(toolName ? { toolName } : {}),
    ...(toolParamsDisplay !== undefined ? { toolParamsDisplay } : {}),
  };
}

const APPROVAL_PROMPT_TEXT_FIELDS = [
  "description",
  "displayName",
  "blockedPath",
  "decisionReason",
  "reason",
  "cwd",
] as const;

const PROVIDER_PARSED_ACTION_TYPES = new Map<string, CommandParsedAction["type"]>([
  ["read", "read"],
  ["search", "search"],
  ["listFiles", "list_files"],
  ["list_files", "list_files"],
]);

const decodeApprovalFileChanges = Schema.decodeUnknownOption(FileChangeDetails);

function approvalText(value: unknown, limit = MAX_TYPED_SHORT_TEXT_CHARS): string | undefined {
  return capOptionalText(nonEmptyTrimmed(asString(value)), limit);
}

function parsedActionFromProviderAction(value: unknown): CommandParsedAction | undefined {
  const action = asObject(value);
  if (!action) return undefined;
  const type =
    (typeof action.type === "string" ? PROVIDER_PARSED_ACTION_TYPES.get(action.type) : undefined) ??
    "unknown";
  return withDefined({
    type,
    command: asString(action.command),
    name: asString(action.name),
    path: asString(action.path),
    query: asString(action.query),
  });
}

function approvalParsedActions(value: unknown): ReadonlyArray<CommandParsedAction> | undefined {
  if (!Array.isArray(value)) return undefined;
  const actions = value.flatMap((entry) => {
    const action = parsedActionFromProviderAction(entry);
    return action ? [action] : [];
  });
  return actions.length > 0 ? capParsedActions(actions) : undefined;
}

function approvalFileChanges(value: unknown): FileChangeDetails | undefined {
  const decoded = decodeApprovalFileChanges(value);
  return decoded._tag === "Some" && decoded.value.changes.length > 0
    ? capFileChangeDetails(decoded.value)
    : undefined;
}

function requestedApprovalPromptFields(
  event: Extract<ProviderRuntimeEvent, { type: "request.opened" }>,
): Record<string, unknown> {
  const args = asObject(event.payload.args);
  if (!args) return {};
  const textFields = Object.fromEntries(
    APPROVAL_PROMPT_TEXT_FIELDS.flatMap((key) => {
      const value = approvalText(args[key]);
      return value === undefined ? [] : [[key, value]];
    }),
  );
  return withDefined({
    promptTitle: event.provider === "claudeAgent" ? approvalText(args.title, 512) : undefined,
    ...textFields,
    itemId: approvalText(args.itemId ?? args.toolUseId, 256),
    parsedActions: approvalParsedActions(args.commandActions),
    fileChanges: approvalFileChanges(args.fileChanges),
  });
}

function boundActivityDataOrUndefined(value: unknown): unknown {
  return value === undefined ? undefined : boundActivityData(value);
}

export interface ProviderActivityProjectionContext {
  readonly threadId?: ThreadId;
  readonly startedItemType?: string;
  readonly finalAssistantMessageId?: MessageId;
  readonly turnOrigin?: TurnOrigin;
}

function capHead(
  value: string,
  limit: number,
): { readonly text: string; readonly truncated: boolean } {
  return value.length > limit
    ? { text: value.slice(0, unicodeSafeEndOffset(value, limit)), truncated: true }
    : { text: value, truncated: false };
}

function capOptionalText(value: string | undefined, limit = MAX_TYPED_SHORT_TEXT_CHARS) {
  return value === undefined ? undefined : capHead(value, limit).text;
}

function withDefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function capOutputTail(value: string | undefined): {
  readonly text?: string;
  readonly truncated: boolean;
  readonly totalChars: number;
} {
  if (value === undefined) return { truncated: false, totalChars: 0 };
  const tail = outputTailFromText(value);
  const text =
    tail.truncated && splitsSurrogatePair(value, value.length - tail.text.length)
      ? tail.text.slice(1)
      : tail.text;
  return {
    text: renderOutputTail({ ...tail, text }),
    truncated: tail.truncated,
    totalChars: value.length,
  };
}

function capParsedActions(
  actions: ReadonlyArray<CommandParsedAction>,
): ReadonlyArray<CommandParsedAction> {
  return actions.slice(0, MAX_TYPED_LIST_ENTRIES).map((action) =>
    withDefined({
      ...action,
      command: capOptionalText(action.command),
      name: capOptionalText(action.name),
      path: capOptionalText(action.path),
      query: capOptionalText(action.query),
    }),
  );
}

function capCommandDetails(command: CommandExecutionDetails): CommandExecutionDetails {
  const output = capOutputTail(command.output);
  const stdout = capOutputTail(command.stdout);
  const stderr = capOutputTail(command.stderr);
  const truncated =
    command.outputTruncated === true || output.truncated || stdout.truncated || stderr.truncated;
  const observedChars = Math.max(output.totalChars, stdout.totalChars + stderr.totalChars);
  return withDefined({
    ...command,
    command: capOptionalText(command.command, TRANSCRIPT_TOOL_ARGUMENTS_MAX_CHARS),
    cwd: capOptionalText(command.cwd),
    description: capOptionalText(command.description),
    output: output.text,
    stdout: stdout.text,
    stderr: stderr.text,
    lastStdin: capOptionalText(command.lastStdin),
    parsedActions:
      command.parsedActions === undefined ? undefined : capParsedActions(command.parsedActions),
    outputTruncated: truncated ? true : command.outputTruncated,
    outputTotalChars:
      truncated || command.outputTotalChars !== undefined
        ? Math.max(command.outputTotalChars ?? 0, observedChars)
        : undefined,
  });
}

function capFileChangeDetails(details: FileChangeDetails): FileChangeDetails {
  const changesTruncated =
    details.changesTruncated === true ||
    details.changes.length > TRANSCRIPT_FILE_CHANGES_MAX_ENTRIES;
  return withDefined({
    changes: details.changes.slice(0, TRANSCRIPT_FILE_CHANGES_MAX_ENTRIES).map((change) => {
      const diff =
        change.unifiedDiff === undefined
          ? undefined
          : capHead(change.unifiedDiff, TRANSCRIPT_FILE_DIFF_MAX_CHARS);
      return withDefined({
        ...change,
        unifiedDiff: diff?.text,
        diffTruncated: change.diffTruncated === true || diff?.truncated === true ? true : undefined,
      });
    }),
    changesTruncated: changesTruncated ? true : undefined,
    totalFiles: details.totalFiles ?? (changesTruncated ? details.changes.length : undefined),
  });
}

function capToolArguments(value: unknown): {
  readonly value: unknown;
  readonly truncated: boolean;
} {
  const serialized = serializeJsonLike(value);
  if (serialized.text.length <= TRANSCRIPT_TOOL_ARGUMENTS_MAX_CHARS) {
    return { value: serialized.plain ? value : JSON.parse(serialized.text), truncated: false };
  }
  const compact = truncateJsonValue(value, {
    stringLimit: 1_000,
    arrayItems: 12,
    objectKeys: 32,
    depth: 4,
  });
  return stringifyJsonLike(compact).length <= TRANSCRIPT_TOOL_ARGUMENTS_MAX_CHARS
    ? { value: compact, truncated: true }
    : {
        value: truncateJsonString(serialized.text, TRANSCRIPT_TOOL_ARGUMENTS_MAX_CHARS),
        truncated: true,
      };
}

function capToolCallDetails(details: ToolCallDetails): ToolCallDetails {
  const args = details.arguments === undefined ? undefined : capToolArguments(details.arguments);
  const result =
    details.resultText === undefined
      ? undefined
      : capHead(details.resultText, TRANSCRIPT_TOOL_RESULT_MAX_CHARS);
  return withDefined({
    ...details,
    toolName: capOptionalText(details.toolName, 256),
    server: capOptionalText(details.server, 256),
    arguments: args?.value,
    argumentsTruncated:
      details.argumentsTruncated === true || args?.truncated === true ? true : undefined,
    resultText: result?.text,
    resultTruncated:
      details.resultTruncated === true || result?.truncated === true ? true : undefined,
    structuredContent:
      details.structuredContent === undefined
        ? undefined
        : boundActivityData(details.structuredContent),
    error: capOptionalText(details.error, TRANSCRIPT_TOOL_RESULT_MAX_CHARS),
    images: details.images?.slice(0, MAX_TYPED_LIST_ENTRIES),
    otherBlocks: details.otherBlocks?.slice(0, MAX_TYPED_LIST_ENTRIES),
  });
}

function capWebSearchDetails(details: WebSearchDetails): WebSearchDetails {
  const resultsTruncated =
    details.resultsTruncated === true || (details.results?.length ?? 0) > MAX_TYPED_LIST_ENTRIES;
  return withDefined({
    ...details,
    query: capOptionalText(details.query),
    queries: details.queries
      ?.slice(0, MAX_TYPED_LIST_ENTRIES)
      .map((query) => capHead(query, MAX_TYPED_SHORT_TEXT_CHARS).text),
    error: capOptionalText(details.error),
    results: details.results?.slice(0, MAX_TYPED_LIST_ENTRIES),
    resultsTruncated: resultsTruncated ? true : undefined,
  });
}

function capReasoningDetails(details: ReasoningDetails): ReasoningDetails {
  const summary =
    details.summary === undefined
      ? undefined
      : capHead(details.summary, TRANSCRIPT_REASONING_MAX_CHARS);
  return withDefined({
    ...details,
    summary: summary?.text,
    summaryTruncated:
      details.summaryTruncated === true || summary?.truncated === true ? true : undefined,
    heading: capOptionalText(details.heading, 256),
  });
}

type ItemLifecycleEvent = Extract<
  ProviderRuntimeEvent,
  { type: "item.started" | "item.updated" | "item.completed" }
>;

function typedToolActivityFields(payload: ItemLifecycleEvent["payload"]): Record<string, unknown> {
  const toolName = nonEmptyTrimmed(payload.toolName);
  return withDefined({
    toolName: toolName === undefined ? undefined : capHead(toolName, 256).text,
    command: payload.command === undefined ? undefined : capCommandDetails(payload.command),
    fileChanges:
      payload.fileChanges === undefined ? undefined : capFileChangeDetails(payload.fileChanges),
    toolCall: payload.toolCall === undefined ? undefined : capToolCallDetails(payload.toolCall),
    webSearch: payload.webSearch === undefined ? undefined : capWebSearchDetails(payload.webSearch),
    reasoning: payload.reasoning === undefined ? undefined : capReasoningDetails(payload.reasoning),
  });
}

function payloadJsonChars(payload: Record<string, unknown>): number {
  return stringifyJsonLike(payload).length;
}

const OUTPUT_HEAD_SHRINK_MARGIN = 32;

function shrinkOutputHead(command: Record<string, unknown>, over: () => number): void {
  command.outputTruncated = true;
  for (const key of ["output", "stdout", "stderr"] as const) {
    const value = command[key];
    const excess = over();
    if (excess <= 0 || typeof value !== "string" || value.length === 0) continue;
    const body = value.startsWith(OUTPUT_TRUNCATION_PREFIX)
      ? value.slice(OUTPUT_TRUNCATION_PREFIX.length)
      : value;
    const keep = Math.max(0, body.length - excess - OUTPUT_HEAD_SHRINK_MARGIN);
    const start = body.length - keep;
    command[key] =
      `${OUTPUT_TRUNCATION_PREFIX}${body.slice(splitsSurrogatePair(body, start) ? start + 1 : start)}`;
  }
}

function shrinkResultText(toolCall: Record<string, unknown>, over: () => number): void {
  const value = toolCall.resultText;
  if (typeof value !== "string" || value.length === 0) return;
  toolCall.resultTruncated = true;
  const keep = Math.max(0, value.length - over() - OUTPUT_HEAD_SHRINK_MARGIN);
  toolCall.resultText = value.slice(0, unicodeSafeEndOffset(value, keep));
}

function shrinkToolError(toolCall: Record<string, unknown>, over: () => number): void {
  const value = toolCall.error;
  if (typeof value !== "string" || value.length === 0) return;
  const keep = Math.max(0, value.length - over() - OUTPUT_HEAD_SHRINK_MARGIN);
  toolCall.error = value.slice(0, unicodeSafeEndOffset(value, keep));
}

function shrinkFileDiffs(fileChanges: Record<string, unknown>, over: () => number): void {
  const changes = Array.isArray(fileChanges.changes)
    ? (fileChanges.changes as Array<Record<string, unknown>>)
    : [];
  const byLength = changes
    .filter((change) => typeof change.unifiedDiff === "string")
    .toSorted(
      (left, right) => (right.unifiedDiff as string).length - (left.unifiedDiff as string).length,
    );
  for (const change of byLength) {
    if (over() <= 0) break;
    change.diffTruncated = true;
    const diff = change.unifiedDiff as string;
    const keep = Math.max(0, diff.length - over() - OUTPUT_HEAD_SHRINK_MARGIN);
    change.unifiedDiff = diff.slice(0, keep);
  }
}

export function boundActivityPayloadTotal(
  payload: Record<string, unknown>,
  maxChars: number = MAX_ACTIVITY_PAYLOAD_JSON_CHARS,
): Record<string, unknown> {
  const originalChars = payloadJsonChars(payload);
  if (originalChars <= maxChars) return payload;
  const next: Record<string, unknown> = structuredClone(
    toActivityPayload(payload) as Record<string, unknown>,
  );
  const over = () => payloadJsonChars(next) - maxChars;
  if (next.data !== undefined) {
    next.data = { [ACTIVITY_DATA_TRUNCATION_MARKER]: true, originalJsonChars: originalChars };
  }
  const toolCall = asObject(next.toolCall);
  if (over() > 0 && toolCall && toolCall.arguments !== undefined) {
    delete toolCall.arguments;
    toolCall.argumentsTruncated = true;
  }
  if (over() > 0 && toolCall && toolCall.structuredContent !== undefined) {
    delete toolCall.structuredContent;
  }
  const command = asObject(next.command);
  if (over() > 0 && command) shrinkOutputHead(command, over);
  if (over() > 0 && toolCall) shrinkResultText(toolCall, over);
  if (over() > 0 && toolCall) shrinkToolError(toolCall, over);
  const fileChanges = asObject(next.fileChanges);
  if (over() > 0 && fileChanges) shrinkFileDiffs(fileChanges, over);
  const webSearch = asObject(next.webSearch);
  if (over() > 0 && webSearch && webSearch.results !== undefined) {
    delete webSearch.results;
    webSearch.resultsTruncated = true;
  }
  const reasoning = asObject(next.reasoning);
  if (over() > 0 && reasoning && typeof reasoning.summary === "string") {
    reasoning.summaryTruncated = true;
    reasoning.summary = reasoning.summary.slice(
      0,
      Math.max(0, reasoning.summary.length - over() - OUTPUT_HEAD_SHRINK_MARGIN),
    );
  }
  if (over() > 0) {
    for (const key of ["command", "fileChanges", "toolCall", "webSearch", "reasoning"] as const) {
      delete next[key];
    }
    next[ACTIVITY_DATA_TRUNCATION_MARKER] = true;
    next.originalJsonChars = originalChars;
  }
  return next;
}

function noticeIdKey(dedupeKey: string): string {
  return dedupeKey.length <= MAX_NOTICE_DEDUPE_KEY_CHARS
    ? dedupeKey
    : `sha256:${createHash("sha256").update(dedupeKey).digest("hex")}`;
}

export function transcriptNoticeActivityId(threadId: ThreadId, dedupeKey: string): EventId {
  return EventId.makeUnsafe(`transcript-notice:${threadId}:${noticeIdKey(dedupeKey)}`);
}

export function providerRetryActivityId(threadId: ThreadId, turnId: TurnId): EventId {
  return EventId.makeUnsafe(`provider-retry:${threadId}:${turnId}`);
}

function composeNoticeTitle(value: string | undefined, fallback: string): string {
  const trimmed = nonEmptyTrimmed(value);
  if (trimmed === undefined) return fallback;
  return trimmed.length > MAX_NOTICE_TITLE_CHARS
    ? `${trimmed.slice(0, MAX_NOTICE_TITLE_CHARS - 3).trimEnd()}...`
    : trimmed;
}

function boundNoticeBody(body: string | undefined): { body?: string; bodyTruncated?: true } {
  if (body === undefined || body.length === 0) return {};
  const capped = capHead(body, TRANSCRIPT_NOTICE_BODY_MAX_CHARS);
  return capped.truncated ? { body: capped.text, bodyTruncated: true } : { body: capped.text };
}

function transcriptNoticeActivity(
  event: ProviderRuntimeEvent,
  notice: TranscriptNotice,
  threadId: ThreadId,
  maybeSequence: { readonly sequence?: number },
): OrchestrationThreadActivity {
  const title = composeNoticeTitle(notice.title, "Provider notice");
  const bounded = boundNoticeBody(notice.body);
  return {
    id:
      notice.dedupeKey !== undefined && notice.dedupeKey.length > 0
        ? transcriptNoticeActivityId(threadId, notice.dedupeKey)
        : event.eventId,
    createdAt: event.createdAt,
    tone: notice.severity === "error" ? "error" : "info",
    kind: TRANSCRIPT_NOTICE_ACTIVITY_KIND,
    summary: title,
    payload: toActivityPayload(
      withDefined({
        noticeKind: notice.noticeKind,
        severity: notice.severity,
        title,
        detail:
          notice.detail === undefined
            ? undefined
            : capHead(notice.detail, MAX_ACTIVITY_DATA_STRING_CHARS).text,
        ...bounded,
        bodyTruncated: notice.bodyTruncated === true || bounded.bodyTruncated ? true : undefined,
        status: notice.status,
        dedupeKey: notice.dedupeKey,
        toolUseId: notice.toolUseId,
        nativeType: notice.nativeType,
        data: notice.data === undefined ? undefined : boundActivityData(notice.data),
      }),
    ),
    turnId: toTurnId(event.turnId) ?? null,
    ...maybeSequence,
  };
}

type HookOutputPayload = {
  readonly output?: string | undefined;
  readonly stdout?: string | undefined;
  readonly stderr?: string | undefined;
};

type ReadableHookOutput = {
  readonly text: string | undefined;
  readonly userFacing: boolean;
};

const HOOK_JSON_SCALAR_LABELS: Readonly<Record<string, string>> = {
  systemMessage: "Message",
  decision: "Decision",
  reason: "Reason",
  stopReason: "Stop reason",
  permissionDecision: "Permission",
  permissionDecisionReason: "Permission reason",
  additionalContext: "Added context",
};

const HOOK_JSON_SILENT_KEYS = new Set(["hookEventName", "suppressOutput", "continue"]);

function hookJsonScalar(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim().length > 0 ? value.trim() : undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function isUserFacingHookJsonField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  switch (key) {
    case "systemMessage":
    case "stopReason":
      return true;
    case "decision":
      return value === "block";
    case "reason":
      return record.decision === "block";
    case "permissionDecision":
      return value === "deny" || value === "ask";
    case "permissionDecisionReason":
      return record.permissionDecision === "deny" || record.permissionDecision === "ask";
    default:
      return false;
  }
}

function describeHookJsonRecord(record: Record<string, unknown>, lines: string[]): boolean {
  let userFacing = record.continue === false;
  if (record.continue === false) lines.push("Continue: no");
  for (const [key, value] of Object.entries(record)) {
    if (HOOK_JSON_SILENT_KEYS.has(key)) continue;
    const nested = asObject(value);
    if (nested !== undefined) {
      if (key === "hookSpecificOutput") {
        userFacing = describeHookJsonRecord(nested, lines) || userFacing;
      }
      continue;
    }
    const scalar = hookJsonScalar(value);
    if (scalar === undefined) continue;
    lines.push(`${HOOK_JSON_SCALAR_LABELS[key] ?? key}: ${scalar}`);
    if (isUserFacingHookJsonField(record, key)) userFacing = true;
  }
  return userFacing;
}

function readableHookOutputPart(part: string): ReadableHookOutput {
  const trimmed = part.trim();
  if (!trimmed.startsWith("{")) return { text: part, userFacing: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { text: part, userFacing: true };
  }
  const record = asObject(parsed);
  if (record === undefined) return { text: part, userFacing: true };
  const lines: string[] = [];
  const userFacing = describeHookJsonRecord(record, lines);
  return { text: lines.length > 0 ? lines.join("\n") : undefined, userFacing };
}

function readableHookOutput(payload: HookOutputPayload): ReadableHookOutput {
  const parts = [payload.output, payload.stdout, payload.stderr]
    .map((part) => (part === undefined ? undefined : part.replace(/\s+$/u, "")))
    .filter((part): part is string => part !== undefined && part.trim().length > 0);
  const readable = [...new Set(parts)].map(readableHookOutputPart);
  const texts = [
    ...new Set(readable.flatMap((entry) => (entry.text === undefined ? [] : [entry.text]))),
  ];
  return {
    text: texts.length > 0 ? texts.join("\n") : undefined,
    userFacing: readable.some((entry) => entry.userFacing && entry.text !== undefined),
  };
}

function hookDisplayName(payload: {
  readonly hookName?: string | undefined;
  readonly hookEvent?: string | undefined;
  readonly matcher?: string | undefined;
}): string | undefined {
  const { hookName, hookEvent, matcher } = payload;
  if (hookName === undefined || hookName === hookEvent) return undefined;
  if (matcher !== undefined && hookName === `${hookEvent}:${matcher}`) return undefined;
  return hookName;
}

function hookOutcomeLabel(payload: {
  readonly outcome: string;
  readonly status?: string | undefined;
  readonly exitCode?: number | undefined;
}): string {
  const label =
    payload.status === "blocked" || payload.status === "stopped" || payload.status === "failed"
      ? payload.status
      : payload.outcome === "success"
        ? "success"
        : payload.outcome === "cancelled"
          ? "cancelled"
          : "error";
  return payload.exitCode === undefined ? label : `${label} (exit code ${payload.exitCode})`;
}

function hookCompletedBody(
  payload: Extract<ProviderRuntimeEvent, { type: "hook.completed" }>["payload"],
  output: string | undefined,
): string {
  const name = hookDisplayName(payload);
  const lines = [
    ...(payload.hookEvent ? [`Event: ${payload.hookEvent}`] : []),
    ...(payload.matcher ? [`Matcher: ${payload.matcher}`] : []),
    ...(name ? [`Hook: ${name}`] : []),
    `Outcome: ${hookOutcomeLabel(payload)}`,
  ];
  return output === undefined ? lines.join("\n") : `${lines.join("\n")}\n\nOutput:\n${output}`;
}

export function hookActivityDedupeKey(input: {
  readonly hookId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly lifecycleGeneration?: string | undefined;
}): string {
  const scope =
    input.turnId !== undefined
      ? `turn:${input.turnId}`
      : `session:${input.lifecycleGeneration ?? "session"}`;
  return input.hookId === undefined ? `hooks:${scope}` : `hook:${scope}:${input.hookId}`;
}

function hookNotice(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "hook.started" | "hook.progress" | "hook.completed" }
  >,
): TranscriptNotice {
  const dedupeKey = hookActivityDedupeKey({
    hookId: event.payload.hookId,
    turnId: event.turnId,
    lifecycleGeneration: event.lifecycleGeneration,
  });
  if (event.type === "hook.started") {
    const payload = event.payload;
    const hookEvent = payload.hookEvent;
    return withDefined({
      noticeKind: "hook" as const,
      severity: "info" as const,
      status: "running" as const,
      title: composeNoticeTitle(`Running ${hookEvent} hook`, "Running hook"),
      detail: payload.statusMessage ?? hookDisplayName(payload) ?? payload.matcher,
      dedupeKey,
      nativeType: event.type,
      data: withDefined({
        hookId: payload.hookId,
        hookName: payload.hookName,
        hookEvent,
        matcher: payload.matcher,
      }),
    });
  }
  if (event.type === "hook.progress") {
    const payload = event.payload;
    return withDefined({
      noticeKind: "hook" as const,
      severity: "info" as const,
      status: "running" as const,
      title: payload.hookEvent
        ? composeNoticeTitle(`Running ${payload.hookEvent} hook`, "Running hook")
        : "Running hook",
      detail: hookDisplayName(payload) ?? payload.matcher,
      body: readableHookOutput(payload).text,
      dedupeKey,
      nativeType: event.type,
      data: withDefined({
        hookId: payload.hookId,
        hookName: payload.hookName,
        hookEvent: payload.hookEvent,
        matcher: payload.matcher,
      }),
    });
  }
  const payload = event.payload;
  const hookLabel = payload.hookEvent ?? "Lifecycle";
  const blocked = payload.status === "blocked";
  const failed =
    payload.status === "failed" || payload.status === "stopped" || payload.outcome === "error";
  const cancelled = payload.outcome === "cancelled" && !payload.status;
  const title = blocked
    ? `${hookLabel} hook blocked an action`
    : payload.status === "stopped"
      ? `${hookLabel} hook stopped execution`
      : failed
        ? `${hookLabel} hook failed`
        : cancelled
          ? `${hookLabel} hook cancelled`
          : `Ran ${hookLabel} hook`;
  return withDefined({
    noticeKind: blocked ? ("hook-blocked" as const) : ("hook" as const),
    severity: blocked || failed ? ("warning" as const) : ("info" as const),
    status: blocked
      ? ("blocked" as const)
      : failed
        ? ("failed" as const)
        : cancelled
          ? ("cancelled" as const)
          : ("completed" as const),
    title: composeNoticeTitle(title, "Hook finished"),
    detail: payload.statusMessage ?? hookDisplayName(payload) ?? payload.matcher,
    body: hookCompletedBody(payload, readableHookOutput(payload).text),
    dedupeKey,
    nativeType: event.type,
    data: withDefined({
      hookId: payload.hookId,
      hookName: payload.hookName,
      hookEvent: payload.hookEvent,
      matcher: payload.matcher,
      outcome: payload.outcome,
      status: payload.status,
      durationMs: payload.durationMs,
      exitCode: payload.exitCode,
    }),
  });
}

const MAX_GROUPED_HOOK_IDS = 50;
const MAX_GROUPED_HOOK_EVENTS = 10;

export function isQuietSuccessfulHook(
  event: Extract<ProviderRuntimeEvent, { type: "hook.completed" }>,
): boolean {
  return (
    event.payload.outcome === "success" &&
    (event.payload.status === undefined || event.payload.status === "completed") &&
    (event.payload.exitCode ?? 0) === 0 &&
    !readableHookOutput(event.payload).userFacing
  );
}

export function isQuietCancelledHook(
  event: Extract<ProviderRuntimeEvent, { type: "hook.completed" }>,
): boolean {
  return (
    event.payload.outcome === "cancelled" &&
    event.payload.status === undefined &&
    !readableHookOutput(event.payload).userFacing
  );
}

export const SESSION_STATUS_ACTIVITY_KIND = "session.status";

const MACHINE_STATUS_REASON_SUCH_AS_TASK_RUNNING = /^[a-z][a-z0-9_-]*:[a-z0-9_.-]+$/;

export function userFacingStatusReason(reason: string | undefined): string | undefined {
  const trimmed = nonEmptyTrimmed(reason);
  return trimmed === undefined || MACHINE_STATUS_REASON_SUCH_AS_TASK_RUNNING.test(trimmed)
    ? undefined
    : trimmed;
}

export function sessionStatusActivityId(threadId: ThreadId, turnId: TurnId): EventId {
  return EventId.makeUnsafe(`session-status:${threadId}:${turnId}`);
}

export function sessionStatusActivity(input: {
  readonly event: Extract<ProviderRuntimeEvent, { type: "session.state.changed" }>;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly sequence?: number;
}): OrchestrationThreadActivity {
  const reason = userFacingStatusReason(input.event.payload.reason);
  return {
    id: sessionStatusActivityId(input.threadId, input.turnId),
    createdAt: input.event.createdAt,
    tone: "info",
    kind: SESSION_STATUS_ACTIVITY_KIND,
    summary: reason === undefined ? "Working" : composeNoticeTitle(reason, "Working"),
    payload: toActivityPayload({
      state: input.event.payload.state,
      reason: reason === undefined ? null : capHead(reason, MAX_TYPED_SHORT_TEXT_CHARS).text,
    }),
    turnId: input.turnId,
    ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
  };
}

export function hookNoticeActivityId(
  threadId: ThreadId,
  event: Extract<
    ProviderRuntimeEvent,
    { type: "hook.started" | "hook.progress" | "hook.completed" }
  >,
): EventId {
  return transcriptNoticeActivityId(
    threadId,
    hookActivityDedupeKey({
      hookId: event.payload.hookId,
      turnId: event.turnId,
      lifecycleGeneration: event.lifecycleGeneration,
    }),
  );
}

export function quietHookGroupActivityId(
  threadId: ThreadId,
  turnId: TurnId | undefined,
  event: ProviderRuntimeEvent,
): EventId {
  return transcriptNoticeActivityId(
    threadId,
    hookActivityDedupeKey({ turnId, lifecycleGeneration: event.lifecycleGeneration }),
  );
}

export function quietHookGroupActivity(input: {
  readonly event: Extract<ProviderRuntimeEvent, { type: "hook.completed" }>;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly previous: OrchestrationThreadActivity | undefined;
  readonly sequence?: number;
}): OrchestrationThreadActivity | undefined {
  const previousData = asObject(asObject(input.previous?.payload)?.data);
  const previousIds = Array.isArray(previousData?.hookIds)
    ? previousData.hookIds.filter((id): id is string => typeof id === "string")
    : [];
  if (previousIds.includes(input.event.payload.hookId)) return undefined;
  const previousEvents = Array.isArray(previousData?.hookEvents)
    ? previousData.hookEvents.filter((name): name is string => typeof name === "string")
    : [];
  const count =
    (typeof previousData?.count === "number" ? previousData.count : previousIds.length) + 1;
  const hookEvents = [
    ...new Set([
      ...previousEvents,
      ...(input.event.payload.hookEvent ? [input.event.payload.hookEvent] : []),
    ]),
  ].slice(0, MAX_GROUPED_HOOK_EVENTS);
  const dedupeKey = hookActivityDedupeKey({
    turnId: input.turnId,
    lifecycleGeneration: input.event.lifecycleGeneration,
  });
  return transcriptNoticeActivity(
    { ...input.event, turnId: input.turnId ?? input.event.turnId },
    {
      noticeKind: "hook",
      severity: "info",
      status: "completed",
      title: count === 1 ? "Ran 1 hook" : `Ran ${count} hooks`,
      dedupeKey,
      nativeType: "hook.completed",
      data: {
        grouped: true,
        count,
        hookIds: [...previousIds, input.event.payload.hookId].slice(-MAX_GROUPED_HOOK_IDS),
        hookEvents,
      },
    },
    input.threadId,
    input.sequence === undefined ? {} : { sequence: input.sequence },
  );
}

function generationKey(event: ProviderRuntimeEvent): string {
  return event.lifecycleGeneration ?? "session";
}

function formatConfigRange(range: unknown): string | undefined {
  const record = asObject(range);
  const start = asObject(record?.start);
  const line = start?.line;
  return typeof line === "number" && Number.isFinite(line) ? String(line) : undefined;
}

function canonicalNotice(event: ProviderRuntimeEvent): TranscriptNotice | undefined {
  switch (event.type) {
    case "transcript.notice":
      return event.payload;
    case "config.warning": {
      const location = event.payload.path
        ? [event.payload.path, formatConfigRange(event.payload.range)].filter(Boolean).join(":")
        : undefined;
      return withDefined({
        noticeKind: "config-warning" as const,
        severity: "warning" as const,
        title: composeNoticeTitle(event.payload.summary, "Configuration warning"),
        detail: location,
        body: event.payload.details,
        dedupeKey: `config-warning:${generationKey(event)}:${event.payload.summary}`,
        nativeType: event.type,
      });
    }
    case "deprecation.notice":
      return withDefined({
        noticeKind: "deprecation" as const,
        severity: "warning" as const,
        title: composeNoticeTitle(event.payload.summary, "Deprecation notice"),
        body: event.payload.details,
        dedupeKey: `deprecation:${generationKey(event)}:${event.payload.summary}`,
        nativeType: event.type,
      });
    case "mcp.oauth.completed": {
      const server = event.payload.name ?? "MCP server";
      return withDefined({
        noticeKind: "mcp-oauth" as const,
        severity: event.payload.success ? ("info" as const) : ("warning" as const),
        status: event.payload.success ? ("completed" as const) : ("failed" as const),
        title: composeNoticeTitle(
          event.payload.success ? `Signed in to ${server}` : `Sign-in to ${server} failed`,
          "MCP sign-in finished",
        ),
        detail: event.payload.error,
        nativeType: event.type,
      });
    }
    case "files.persisted": {
      const saved = event.payload.files.length;
      const failed = event.payload.failed ?? [];
      const savedLabel = `Saved ${saved} ${saved === 1 ? "file" : "files"}`;
      return withDefined({
        noticeKind: "files-persisted" as const,
        severity: failed.length > 0 ? ("warning" as const) : ("info" as const),
        status: failed.length > 0 ? ("failed" as const) : ("completed" as const),
        title: failed.length > 0 ? `${savedLabel}, ${failed.length} failed` : savedLabel,
        body:
          failed.length > 0
            ? failed.map((entry) => `${entry.filename}: ${entry.error}`).join("\n")
            : event.payload.files.map((entry) => entry.filename).join("\n"),
        nativeType: event.type,
      });
    }
    default:
      return undefined;
  }
}

function toolProgressItemType(
  event: Extract<ProviderRuntimeEvent, { type: "tool.progress" }>,
  context: ProviderActivityProjectionContext | undefined,
): string | undefined {
  if (event.payload.itemType !== undefined) return event.payload.itemType;
  if (context?.startedItemType !== undefined) return context.startedItemType;
  return event.provider === "codex" ? "mcp_tool_call" : undefined;
}

function isReasoningPreviewProvider(provider: ProviderRuntimeEvent["provider"]): boolean {
  return provider === "codex" || provider === "antigravity" || provider === "claudeAgent";
}

export function providerReasoningActivityId(threadId: ThreadId | string, itemId: string): EventId {
  return EventId.makeUnsafe(`provider-reasoning:${threadId}:${itemId}`);
}

function projectReasoningActivity(
  event: ItemLifecycleEvent,
  maybeSequence: { readonly sequence?: number },
): OrchestrationThreadActivity | undefined {
  if (
    !isReasoningPreviewProvider(event.provider) ||
    event.type === "item.started" ||
    event.payload.itemType !== "reasoning" ||
    event.itemId === undefined
  ) {
    return undefined;
  }
  const reasoningDetail = readableReasoningDetail(event.payload.detail);
  const redacted = event.payload.reasoning?.redacted === true;
  if (reasoningDetail === undefined && !(redacted && event.type === "item.completed")) {
    return undefined;
  }
  const reasoningItemId = String(event.itemId);
  const detail =
    reasoningDetail === undefined
      ? undefined
      : truncateDetail(reasoningDetail, MAX_REASONING_DETAIL_CHARS);
  const heading = deriveReasoningHeading(reasoningDetail);
  const reasoning = capReasoningDetails(
    withDefined({
      ...event.payload.reasoning,
      summary: detail,
      summaryTruncated:
        event.payload.reasoning?.summaryTruncated === true ||
        (reasoningDetail !== undefined && reasoningDetail.length > MAX_REASONING_DETAIL_CHARS)
          ? true
          : undefined,
      heading: event.payload.reasoning?.heading ?? heading,
    }),
  );
  return {
    id: providerReasoningActivityId(event.threadId, reasoningItemId),
    createdAt: event.createdAt,
    tone: "tool",
    kind: "task.progress",
    summary: "Reasoning trace",
    payload: toActivityPayload({
      ...(event.payload.status ? { status: event.payload.status } : {}),
      ...(detail !== undefined ? { detail } : {}),
      reasoning,
      data: { toolCallId: reasoningItemId },
    }),
    turnId: toTurnId(event.turnId) ?? null,
    ...maybeSequence,
  };
}

export function projectProviderRuntimeActivities(
  event: ProviderRuntimeEvent,
  sessionSequence?: number,
  context?: ProviderActivityProjectionContext,
): ReadonlyArray<OrchestrationThreadActivity> {
  // Activity `sequence` is a NonNegativeInt. A fractional or negative runtime
  // counter has to be dropped: carrying it invalidates the whole command.
  const maybeSequence =
    typeof sessionSequence === "number" && Number.isInteger(sessionSequence) && sessionSequence >= 0
      ? { sequence: sessionSequence }
      : {};
  const targetThreadId = context?.threadId ?? event.threadId;
  if (
    (event.type === "item.started" ||
      event.type === "item.updated" ||
      event.type === "item.completed") &&
    event.payload.itemType === "reasoning"
  ) {
    const reasoningActivity = projectReasoningActivity(event, maybeSequence);
    return reasoningActivity ? [reasoningActivity] : [];
  }
  const notice = canonicalNotice(event);
  if (notice !== undefined) {
    return [transcriptNoticeActivity(event, notice, targetThreadId, maybeSequence)];
  }
  switch (event.type) {
    case "session.configured": {
      const payload = buildConfiguredContextWindowPayload(event);
      if (!payload) {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-window.configured",
          summary: "Context window configured",
          payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "request.opened":
    case "request.resolved": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      const permissionProfile =
        event.type === "request.opened" ? requestedPermissionProfile(event) : undefined;
      const canApproveForSession =
        event.type === "request.opened" ? sessionApprovalAvailable(event) : undefined;
      const toolCallPresentation =
        event.type === "request.opened" ? requestedMcpToolCallPresentation(event) : {};
      const promptFields =
        event.type === "request.opened" ? requestedApprovalPromptFields(event) : {};
      const approvalRuleOptions =
        event.type === "request.opened"
          ? Schema.decodeUnknownOption(Schema.Array(ProviderApprovalRule))(
              asObject(event.payload.args)?.approvalRuleOptions ?? [],
            ).pipe(Option.getOrElse(() => []))
          : [];
      const requestId = nonEmptyTrimmed(event.requestId);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: event.type === "request.opened" ? "approval.requested" : "approval.resolved",
          summary:
            event.type === "request.resolved"
              ? "Approval resolved"
              : requestKind === "command"
                ? "Command approval requested"
                : requestKind === "file-read"
                  ? "File-read approval requested"
                  : requestKind === "file-change"
                    ? "File-change approval requested"
                    : requestKind === "permissions"
                      ? "Permission approval requested"
                      : requestKind === "tool"
                        ? "Tool approval requested"
                        : "Approval requested",
          payload: toActivityPayload(
            boundActivityPayloadTotal({
              ...(requestId ? { requestId: ApprovalRequestId.makeUnsafe(requestId) } : {}),
              ...(event.lifecycleGeneration !== undefined
                ? { lifecycleGeneration: event.lifecycleGeneration }
                : {}),
              ...(requestKind ? { requestKind } : {}),
              requestType: event.payload.requestType,
              ...(event.type === "request.opened" && event.payload.detail
                ? { detail: truncateDetail(event.payload.detail, MAX_ACTIVITY_DATA_STRING_CHARS) }
                : {}),
              ...(permissionProfile ? { permissionProfile } : {}),
              ...toolCallPresentation,
              ...promptFields,
              ...(approvalRuleOptions.length > 0 ? { approvalRuleOptions } : {}),
              ...(canApproveForSession !== undefined
                ? { sessionApprovalAvailable: canApproveForSession }
                : {}),
              ...(event.type === "request.resolved" && event.payload.decision
                ? { decision: event.payload.decision }
                : {}),
            }),
          ),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.error": {
      const payload = runtimePayloadRecord(event);
      const message = asString(payload?.message);
      if (!message) {
        return [];
      }
      const errorClass = asString(payload?.class);
      const detail = projectRuntimeErrorDetail(event.payload.detail);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: "Provider runtime error",
          payload: toActivityPayload({
            message: truncateDetail(message, 500),
            ...(errorClass ? { class: errorClass } : {}),
            ...(event.payload.errorCode ? { errorCode: event.payload.errorCode } : {}),
            ...(detail ? { detail } : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.warning": {
      const raw = asObject((event as { raw?: unknown }).raw);
      const nativeType = asString(asObject(raw?.payload)?.type);
      // Claude backgrounding notices arrive as warnings whose detail is the
      // SDK background_tasks_changed message; they present as a plain info
      // line ("Moved to background: <work>"), not as a runtime warning.
      const detailSubtype = asString(asObject(event.payload.detail)?.subtype);
      const isBackgroundMove = detailSubtype === "background_tasks_changed";
      const isClaudeRetry = event.provider === "claudeAgent" && detailSubtype === "api_retry";
      const willRetry =
        event.payload.willRetry === true || asObject(event.payload.detail)?.willRetry === true;
      const isPiInfoNotification =
        event.provider === "pi" &&
        raw?.method === "extension/ui/notify" &&
        asObject(event.payload.detail)?.type === "info";
      // The row already clips the notice to one line via CSS; the hover card can
      // only reveal what the server stored, so keep the full message (bounded by
      // the shared activity-data cap) instead of pre-truncating it to fit the row.
      const message = truncateDetail(event.payload.message, MAX_ACTIVITY_DATA_STRING_CHARS);
      const retryAttempt = event.payload.retryAttempt;
      const retryMaxAttempts = event.payload.retryMaxAttempts;
      const retryCounter =
        retryAttempt !== undefined && retryMaxAttempts !== undefined && retryMaxAttempts > 0
          ? `Reconnecting ${retryAttempt}/${retryMaxAttempts}`
          : undefined;
      const retryTurnId = toTurnId(event.turnId);
      const upsertsRetryRow = (willRetry || isClaudeRetry) && retryTurnId !== undefined;
      return [
        {
          id: upsertsRetryRow
            ? providerRetryActivityId(targetThreadId, retryTurnId)
            : event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.warning",
          summary: isPiInfoNotification
            ? "Pi extension"
            : retryCounter !== undefined
              ? retryCounter
              : willRetry
                ? "Provider retrying"
                : isClaudeRetry
                  ? message
                  : isBackgroundMove
                    ? "Moved to background"
                    : event.provider === "opencode" &&
                        (nativeType === "session.next.retried" || nativeType === "session.status")
                      ? "OpenCode retrying"
                      : "Runtime warning",
          // Keep the user-visible message even when raw detail is structured.
          payload: toActivityPayload({
            message,
            detail: message,
            ...(willRetry ? { willRetry: true } : {}),
            ...(retryAttempt !== undefined ? { retryAttempt } : {}),
            ...(retryMaxAttempts !== undefined ? { retryMaxAttempts } : {}),
            ...(isBackgroundMove || isClaudeRetry
              ? { nativeEventType: detailSubtype }
              : nativeType
                ? { nativeEventType: nativeType }
                : {}),
            ...activityDataField(event.payload.detail),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "model.rerouted": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "model.rerouted",
          summary: `Model switched: ${event.payload.fromModel} -> ${event.payload.toModel}`,
          payload: toActivityPayload({
            fromModel: event.payload.fromModel,
            toModel: event.payload.toModel,
            detail: truncateDetail(event.payload.reason, 500),
            ...(event.payload.refusalCategory !== undefined
              ? { refusalCategory: truncateDetail(event.payload.refusalCategory, 200) }
              : {}),
            ...(event.payload.refusalExplanation !== undefined
              ? {
                  refusalExplanation: truncateDetail(
                    event.payload.refusalExplanation,
                    MAX_ACTIVITY_DATA_STRING_CHARS,
                  ),
                }
              : {}),
            ...(event.payload.retractedItemIds && event.payload.retractedItemIds.length > 0
              ? {
                  retractedMessageIds: event.payload.retractedItemIds
                    .slice(0, MAX_TYPED_LIST_ENTRIES)
                    .map((itemId) => `assistant:${itemId}`),
                }
              : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.tasks.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "turn.tasks.updated",
          summary: "Tasks updated",
          payload: toActivityPayload({
            tasks: event.payload.tasks,
            ...(event.payload.explanation !== undefined
              ? { explanation: event.payload.explanation }
              : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.requested":
    case "user-input.resolved": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: event.type,
          summary:
            event.type === "user-input.requested" ? "User input requested" : "User input submitted",
          payload: toActivityPayload({
            ...(event.requestId ? { requestId: event.requestId } : {}),
            ...(event.lifecycleGeneration !== undefined
              ? { lifecycleGeneration: event.lifecycleGeneration }
              : {}),
            ...(event.type === "user-input.requested"
              ? { questions: event.payload.questions }
              : { answers: event.payload.answers }),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.started": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.started",
          summary:
            event.payload.taskType === "plan"
              ? "Plan task started"
              : event.payload.taskType
                ? `${event.payload.taskType} task started`
                : "Task started",
          payload: toActivityPayload({
            taskId: event.payload.taskId,
            ...(event.payload.taskType ? { taskType: event.payload.taskType } : {}),
            ...(event.payload.subagentType ? { subagentType: event.payload.subagentType } : {}),
            ...(event.payload.workflowName ? { workflowName: event.payload.workflowName } : {}),
            ...(event.payload.workflowTaskId
              ? { workflowTaskId: event.payload.workflowTaskId }
              : {}),
            ...(event.payload.workflowPhases
              ? { workflowPhases: event.payload.workflowPhases }
              : {}),
            ...(event.payload.workflowAgentPhases
              ? { workflowAgentPhases: event.payload.workflowAgentPhases }
              : {}),
            ...(event.payload.workflowAgentPlans
              ? { workflowAgentPlans: event.payload.workflowAgentPlans }
              : {}),
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.progress": {
      const progressDetail =
        event.provider === "claudeAgent"
          ? event.payload.summary
          : (event.payload.summary ?? event.payload.description);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.progress",
          summary: event.provider === "claudeAgent" ? "Task progress" : "Reasoning update",
          payload: toActivityPayload({
            taskId: event.payload.taskId,
            ...(progressDetail ? { detail: truncateDetail(progressDetail) } : {}),
            // Kept verbatim next to detail: workflow progress encodes
            // "<phase>: <agent label>" here and the panel parses it back out.
            description: truncateDetail(event.payload.description),
            ...(event.payload.summary ? { summary: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.lastToolName ? { lastToolName: event.payload.lastToolName } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...(event.payload.workflowTaskId
              ? { workflowTaskId: event.payload.workflowTaskId }
              : {}),
            ...(event.payload.workflowAgents
              ? { workflowAgents: event.payload.workflowAgents }
              : {}),
            ...(event.payload.toolUseId ? { data: { toolUseId: event.payload.toolUseId } } : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.completed": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.completed",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status === "stopped"
                ? "Task stopped"
                : "Task completed",
          payload: toActivityPayload({
            taskId: event.payload.taskId,
            status: event.payload.status,
            ...(event.payload.summary
              ? { detail: truncateDetail(event.payload.summary, MAX_ACTIVITY_DATA_STRING_CHARS) }
              : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...(event.payload.workflowTaskId
              ? { workflowTaskId: event.payload.workflowTaskId }
              : {}),
            ...(event.payload.workflowAgents
              ? { workflowAgents: event.payload.workflowAgents }
              : {}),
            ...(nonEmptyTrimmed(event.payload.outputFile)
              ? {
                  outputFile: truncateDetail(event.payload.outputFile!, MAX_TYPED_SHORT_TEXT_CHARS),
                }
              : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.updated",
          summary:
            event.payload.status === "paused"
              ? "Task paused"
              : event.payload.status === "killed"
                ? "Task killed"
                : event.payload.isBackgrounded === true
                  ? "Task moved to background"
                  : "Task updated",
          payload: toActivityPayload({
            taskId: event.payload.taskId,
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.isBackgrounded !== undefined
              ? { isBackgrounded: event.payload.isBackgrounded }
              : {}),
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.error
              ? { detail: truncateDetail(event.payload.error, MAX_ACTIVITY_DATA_STRING_CHARS) }
              : {}),
            ...(event.payload.workflowTaskId
              ? { workflowTaskId: event.payload.workflowTaskId }
              : {}),
            ...(event.payload.workflowRunId ? { workflowRunId: event.payload.workflowRunId } : {}),
            ...(event.payload.workflowScriptPath
              ? { workflowScriptPath: event.payload.workflowScriptPath }
              : {}),
            ...(nonEmptyTrimmed(event.payload.description)
              ? { description: truncateDetail(event.payload.description!.trim()) }
              : {}),
            ...(event.payload.endTime !== undefined ? { endTime: event.payload.endTime } : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.steered": {
      // A steer of the thread's own turn is already visible as the sent user
      // message that produced it, so an activity row would just repeat the text
      // under the bubble. Only a subagent delivery needs its own marker: it
      // lands on the child thread, which never renders the message otherwise.
      if (event.payload.target === "turn") {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "turn.steered",
          summary: "Message delivered to subagent",
          payload: toActivityPayload({
            detail: truncateDetail(event.payload.message),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.state.changed": {
      if (event.payload.state !== "compacted") {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-compaction",
          summary: "Context compacted manually",
          payload: toActivityPayload({
            state: event.payload.state,
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.token-usage.updated": {
      const payload = buildContextWindowActivityPayload(event);
      if (!payload) {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.updated":
    case "item.completed":
    case "item.started": {
      if (event.payload.itemType === "context_compaction") {
        const failed = event.type === "item.completed" && event.payload.status === "failed";
        return [
          {
            id: event.eventId,
            createdAt: event.createdAt,
            tone: failed ? "error" : "info",
            kind: "context-compaction",
            summary:
              event.type !== "item.completed"
                ? "Compacting context"
                : failed
                  ? "Context compaction failed"
                  : "Context compacted",
            payload: toActivityPayload({
              itemType: event.payload.itemType,
              status: event.payload.status,
              ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
              ...activityDataField(event.payload.data),
            }),
            turnId: toTurnId(event.turnId) ?? null,
            ...maybeSequence,
          },
        ];
      }
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      // A provider that sends a blank title must not turn into a blank summary:
      // `??` falls back on undefined only, so normalize before choosing.
      const itemTitle = nonEmptyTrimmed(event.payload.title);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind:
            event.type === "item.started"
              ? "tool.started"
              : event.type === "item.completed"
                ? "tool.completed"
                : "tool.updated",
          summary:
            event.type === "item.started"
              ? `${itemTitle ?? "Tool"} started`
              : (itemTitle ?? (event.type === "item.completed" ? "Tool" : "Tool updated")),
          payload: toActivityPayload(
            boundActivityPayloadTotal({
              itemType: event.payload.itemType,
              ...(event.payload.status ? { status: event.payload.status } : {}),
              ...(itemTitle ? { title: itemTitle } : {}),
              ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
              ...typedToolActivityFields(event.payload),
              ...activityDataField(event.payload.data),
            }),
          ),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "tool.summary": {
      if (event.provider !== "claudeAgent") return [];
      const summary = nonEmptyTrimmed(event.payload.summary);
      if (!summary) return [];
      const precedingToolUseIds = event.payload.precedingToolUseIds;
      const lastToolUseId = precedingToolUseIds?.at(-1);
      return [
        {
          id: lastToolUseId
            ? EventId.makeUnsafe(
                `provider-tool-summary:${event.provider}:${event.threadId}:${event.turnId ?? "session"}:${lastToolUseId}`,
              )
            : event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "tool.summary",
          summary: "Tool summary",
          payload: toActivityPayload({
            detail: truncateDetail(summary, MAX_REASONING_DETAIL_CHARS),
            ...(precedingToolUseIds ? { data: { precedingToolUseIds } } : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "auth.status": {
      if (event.provider !== "claudeAgent") return [];
      const failed = Boolean(nonEmptyTrimmed(event.payload.error));
      if (!failed && event.payload.isAuthenticating === undefined) return [];
      // Login output and errors can contain credentials or one-time URLs. Only
      // project the state; raw provider output stays out of the transcript.
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: failed ? "error" : "info",
          kind: "auth.status",
          summary: failed
            ? "Claude authentication needs attention."
            : event.payload.isAuthenticating
              ? "Claude authentication started"
              : "Claude authentication finished",
          payload: toActivityPayload({
            provider: event.provider,
            ...(failed ? { detail: "Check your Claude account in Settings." } : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "tool.progress": {
      const itemType = toolProgressItemType(event, context);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.updated",
          summary:
            nonEmptyTrimmed(event.payload.toolName) ??
            nonEmptyTrimmed(event.payload.summary) ??
            (itemType === "mcp_tool_call" ? "MCP tool call" : "Tool call"),
          payload: buildToolProgressActivityPayload(event, itemType),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.completed": {
      const state = runtimeTurnState(event);
      const modelUsage = compactTurnModelUsage(event.payload.modelUsage);
      const errorMessage = asString(runtimePayloadRecord(event)?.errorMessage);
      const interrupted = state === "interrupted" || state === "cancelled";
      let summary = "Turn completed";
      if (state === "failed") {
        summary = "Turn failed";
      } else if (interrupted) {
        summary = "Turn interrupted";
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: state === "failed" ? "error" : "info",
          kind: "turn.completed",
          summary,
          payload: toActivityPayload({
            state,
            ...(event.provider === "claudeAgent" ? { provider: event.provider } : {}),
            ...(event.payload.tokenAccountingVersion === 1
              ? { tokenAccountingVersion: 1, mainLoopTokens: event.payload.mainLoopTokens }
              : {}),
            ...(modelUsage ? { modelUsage } : {}),
            ...(typeof event.payload.totalCostUsd === "number"
              ? { totalCostUsd: event.payload.totalCostUsd }
              : {}),
            ...(typeof event.payload.cumulativeCostUsd === "number"
              ? { cumulativeCostUsd: event.payload.cumulativeCostUsd }
              : {}),
            ...(errorMessage ? { errorMessage } : {}),
            ...(event.payload.errorCode ? { errorCode: event.payload.errorCode } : {}),
            ...(context?.finalAssistantMessageId !== undefined
              ? { finalAssistantMessageId: context.finalAssistantMessageId }
              : {}),
            ...(context?.turnOrigin !== undefined ? { origin: context.turnOrigin } : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "hook.started":
      return [];
    case "hook.progress":
      return !readableHookOutput(event.payload).userFacing
        ? []
        : [transcriptNoticeActivity(event, hookNotice(event), targetThreadId, maybeSequence)];
    case "hook.completed":
      return [transcriptNoticeActivity(event, hookNotice(event), targetThreadId, maybeSequence)];

    case "account.rate-limits.updated": {
      const rawRateLimits = event.payload.rateLimits;
      if (!rawRateLimits || typeof rawRateLimits !== "object") {
        return [];
      }
      const rl = rawRateLimits as Record<string, unknown>;
      if (Object.keys(rl).length === 0) {
        return [];
      }
      const status = rl.status;
      // Normalize resetsAt: Claude SDK sends Unix seconds (number), Codex may send ISO string
      const resetsAtRaw = rl.resetsAt;
      const resetsAt =
        typeof resetsAtRaw === "number"
          ? new Date(resetsAtRaw * 1000).toISOString()
          : typeof resetsAtRaw === "string"
            ? resetsAtRaw
            : undefined;
      // Preserve per-window rate limit breakdown when the provider sends it.
      // Claude SDK may include a `limits` array with per-window entries
      // (e.g. { window: "5h", utilization: 0.06, resetsAt: ... }).
      const rawLimits = Array.isArray(rl.limits) ? rl.limits : undefined;
      const limits = rawLimits
        ?.filter(
          (l): l is Record<string, unknown> =>
            l !== null &&
            typeof l === "object" &&
            typeof (l as Record<string, unknown>).window === "string",
        )
        .map((l) => {
          const lResetsAtRaw = l.resetsAt;
          const lResetsAt =
            typeof lResetsAtRaw === "number"
              ? new Date(lResetsAtRaw * 1000).toISOString()
              : typeof lResetsAtRaw === "string"
                ? lResetsAtRaw
                : undefined;
          const limit = { window: l.window as string } as {
            window: string;
            utilization?: number;
            resetsAt?: string;
          };
          if (typeof l.utilization === "number") {
            limit.utilization = l.utilization;
          }
          if (lResetsAt) {
            limit.resetsAt = lResetsAt;
          }
          return limit;
        });
      const normalizedPayload = {
        provider: event.provider,
        ...rl,
        ...(resetsAt ? { resetsAt } : {}),
        ...(typeof rl.utilization === "number" ? { utilization: rl.utilization } : {}),
        ...(limits && limits.length > 0 ? { limits } : {}),
      };
      const activities: OrchestrationThreadActivity[] = [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "account.rate-limits.updated",
          summary: "Rate limits updated",
          payload: toActivityPayload(normalizedPayload),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
      if (status !== "rejected" && status !== "allowed_warning") {
        return activities;
      }
      return [
        ...activities,
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: (status === "rejected" ? "error" : "info") as "error" | "info",
          kind: "account.rate-limited",
          summary: status === "rejected" ? "Rate limited" : "Approaching rate limit",
          payload: toActivityPayload({
            ...normalizedPayload,
            status,
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "event.unmapped": {
      const payload = runtimePayloadRecord(event);
      const nativeType = asString(payload?.nativeType);
      if (!nativeType) {
        return [];
      }
      const detail = asString(payload?.detail);
      const rawData = payload?.data;
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "provider.event.unmapped",
          summary: nativeType,
          payload: toActivityPayload({
            nativeEventType: nativeType,
            ...(detail ? { detail: sanitizeUnmappedProviderDetail(detail) } : {}),
            ...(rawData !== undefined ? { data: sanitizeUnmappedProviderData(rawData) } : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    default:
      break;
  }

  return [];
}

export function providerActivityUpdateDedupeKey(
  event: ProviderRuntimeEvent,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
): string | undefined {
  const prefix = `${threadId}:${event.provider}:${activity.kind}`;
  if (
    activity.kind === "context-window.updated" ||
    activity.kind === "account.rate-limits.updated"
  ) {
    return prefix;
  }

  if (
    activity.kind === TRANSCRIPT_NOTICE_ACTIVITY_KIND ||
    activity.kind === SESSION_STATUS_ACTIVITY_KIND
  ) {
    return `${prefix}:${activity.id}`;
  }
  if (activity.kind === "runtime.warning" && activity.id !== event.eventId) {
    return `${prefix}:${activity.id}`;
  }

  const payload = asObject(activity.payload);
  if (activity.kind === "task.progress") {
    if (
      (event.type === "item.updated" || event.type === "item.completed") &&
      event.payload.itemType === "reasoning" &&
      event.itemId
    ) {
      return `${prefix}:reasoning:${event.itemId}`;
    }
    const taskId = asString(payload?.taskId);
    return taskId ? `${prefix}:${taskId}` : undefined;
  }
  if (activity.kind !== "tool.updated") {
    return undefined;
  }

  const data = asObject(payload?.data);
  const toolUpdateId =
    event.itemId ??
    asString(data?.toolUseId) ??
    asString(data?.toolCallId) ??
    asString(data?.callId) ??
    asString(data?.callID);
  return toolUpdateId ? `${prefix}:${toolUpdateId}` : undefined;
}

export function providerActivityUpdateFingerprint(activity: OrchestrationThreadActivity): string {
  return stringifyJsonLike({
    kind: activity.kind,
    summary: activity.summary,
    payload: activity.payload,
    turnId: activity.turnId,
  });
}

function compareActivityPayloadEntries(
  left: readonly [string, unknown],
  right: readonly [string, unknown],
): number {
  const byRank = activityPayloadKeyRank(left[0]) - activityPayloadKeyRank(right[0]);
  return byRank !== 0 ? byRank : left[0].localeCompare(right[0]);
}

/**
 * The first `limit` entries in rank/name order, without sorting the whole
 * object first. Payloads are untrusted and can be arbitrarily wide, so a full
 * sort just to keep a handful of keys made truncation itself the expensive
 * step. Keys are unique, so the comparator never ties and the selection is
 * exactly `toSorted(...).slice(0, limit)`.
 */
function selectLeadingActivityPayloadEntries(
  entries: ReadonlyArray<[string, unknown]>,
  limit: number,
): Array<[string, unknown]> {
  if (limit <= 0) {
    return [];
  }
  if (entries.length <= limit) {
    return entries.toSorted(compareActivityPayloadEntries);
  }
  const leading: Array<[string, unknown]> = [];
  for (const entry of entries) {
    if (
      leading.length === limit &&
      compareActivityPayloadEntries(entry, leading[leading.length - 1]!) >= 0
    ) {
      continue;
    }
    let low = 0;
    let high = leading.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareActivityPayloadEntries(leading[middle]!, entry) <= 0) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    leading.splice(low, 0, entry);
    if (leading.length > limit) {
      leading.pop();
    }
  }
  return leading;
}
