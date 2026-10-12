// FILE: toolCallDetails.ts
// Purpose: Extract bounded command/edit details from provider tool lifecycle payloads.
// Layer: Web transcript data utility
// Exports: deriveWorkLogToolDetails, mergeWorkLogToolDetails
// Depends on: provider runtime item metadata already truncated by server ingestion

import type {
  CommandExecutionDetails,
  FileChangeEntry,
  ToolCallDetails,
  ToolLifecycleItemType,
  TranscriptImageRef,
  TranscriptResultBlockRef,
  WebSearchDetails,
  WebSearchResult,
} from "@synara/contracts";
import { stripTrailingToolExitCode as stripTrailingExitCode } from "@synara/shared/toolOutputSummary";

type WorkLogRequestKind = "command" | "file-read" | "file-change" | "permissions" | "tool";

export interface WorkLogToolOutputDetails {
  output?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  truncated?: boolean;
}

export interface WorkLogToolEditDetails {
  path?: string;
  oldText?: string;
  newText?: string;
}

export interface WorkLogToolDetails {
  kind: "command" | "file-change";
  title: string;
  command?: string;
  output?: WorkLogToolOutputDetails;
  diff?: string;
  content?: string;
  edits?: ReadonlyArray<WorkLogToolEditDetails>;
  files?: ReadonlyArray<string>;
}

export interface DeriveWorkLogToolDetailsInput {
  payload: Record<string, unknown> | null;
  itemType?: ToolLifecycleItemType | undefined;
  requestKind?: WorkLogRequestKind | undefined;
  command?: string | undefined;
  rawCommand?: string | undefined;
  detail?: string | undefined;
  changedFiles?: ReadonlyArray<string> | undefined;
  label: string;
  toolTitle?: string | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = asTrimmedString(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function firstOutputText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    if (value.trim().length === 0) {
      continue;
    }
    return value;
  }
  return undefined;
}

function asRawOutputRecord(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (record) {
    return record;
  }
  const output = firstOutputText(value);
  return output !== undefined ? { output } : null;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const normalized = asFiniteNumber(value);
    if (normalized !== undefined) {
      return normalized;
    }
  }
  return undefined;
}

function outputText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  return stripTrailingExitCode(value).output ?? undefined;
}

function outputExitCode(value: unknown): number | undefined {
  const normalized = asTrimmedString(value);
  return normalized ? stripTrailingExitCode(normalized).exitCode : undefined;
}

// Collects command output without stringifying the full payload; ingestion already bounds each field.
function extractToolOutputDetails(input: {
  payload: Record<string, unknown> | null;
  requestSummaryWithExitMarker?: string | undefined;
}): WorkLogToolOutputDetails | undefined {
  const data = asRecord(input.payload?.data);
  const rawOutput = asRawOutputRecord(data?.rawOutput);
  const rawOutputDetails = asRecord(rawOutput?.details);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const result = asRecord(data?.result);
  const partialResult = asRecord(data?.partialResult);
  const stdout = outputText(
    firstOutputText(
      rawOutput?.stdout,
      rawOutput?.out,
      data?.stdout,
      itemResult?.stdout,
      result?.stdout,
    ),
  );
  const stderr = outputText(
    firstOutputText(
      rawOutput?.stderr,
      rawOutput?.err,
      data?.stderr,
      itemResult?.stderr,
      result?.stderr,
    ),
  );
  const output = outputText(
    firstOutputText(
      rawOutput?.output,
      rawOutput?.content,
      data?.output,
      item?.aggregatedOutput,
      itemResult?.output,
      itemResult?.content,
      result?.output,
      result?.content,
      partialResult?.output,
      partialResult?.content,
      rawOutputDetails?.output,
    ),
  );
  const exitCode = firstNumber(
    rawOutput?.exitCode,
    rawOutput?.code,
    data?.exitCode,
    item?.exitCode,
    itemResult?.exitCode,
    result?.exitCode,
    outputExitCode(input.requestSummaryWithExitMarker),
  );
  const truncated = rawOutput?.truncated === true || data?.__synaraTruncated === true;
  if (!stdout && !stderr && !output && exitCode === undefined && !truncated) {
    return undefined;
  }
  return {
    ...(output ? { output } : {}),
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

function extractUnifiedDiff(payload: Record<string, unknown> | null): string | undefined {
  const data = asRecord(payload?.data);
  const rawOutput = asRecord(data?.rawOutput);
  const rawOutputDetails = asRecord(rawOutput?.details);
  const result = asRecord(data?.result);
  const resultDetails = asRecord(result?.details);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  return firstString(
    data?.unifiedDiff,
    data?.diff,
    data?.patch,
    rawOutput?.unifiedDiff,
    rawOutput?.diff,
    rawOutput?.patch,
    rawOutputDetails?.unifiedDiff,
    rawOutputDetails?.diff,
    rawOutputDetails?.patch,
    result?.unifiedDiff,
    result?.diff,
    result?.patch,
    resultDetails?.unifiedDiff,
    resultDetails?.diff,
    resultDetails?.patch,
    itemResult?.unifiedDiff,
    itemResult?.diff,
    itemResult?.patch,
  );
}

function extractWriteContent(payload: Record<string, unknown> | null): string | undefined {
  const data = asRecord(payload?.data);
  const input = asRecord(data?.input);
  const rawInput = asRecord(data?.rawInput);
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  return firstString(
    data?.content,
    input?.content,
    rawInput?.content,
    item?.content,
    itemInput?.content,
  );
}

function editText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function extractEditPath(record: Record<string, unknown>): string | undefined {
  return firstString(
    record.path,
    record.filePath,
    record.file_path,
    record.filename,
    record.file,
    record.relativePath,
  );
}

function normalizeEditEntry(value: unknown): WorkLogToolEditDetails | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const path = extractEditPath(record);
  const oldText = editText(
    record.oldText ?? record.old_string ?? record.oldString ?? record.before ?? record.original,
  );
  const newText = editText(
    record.newText ?? record.new_string ?? record.newString ?? record.after ?? record.replacement,
  );
  if (oldText === undefined && newText === undefined) {
    return undefined;
  }
  return {
    ...(path ? { path } : {}),
    ...(oldText !== undefined ? { oldText } : {}),
    ...(newText !== undefined ? { newText } : {}),
  };
}

function collectEditEntries(value: unknown, target: WorkLogToolEditDetails[]) {
  if (!Array.isArray(value)) {
    const edit = normalizeEditEntry(value);
    if (edit) {
      target.push(edit);
    }
    return;
  }
  for (const entry of value) {
    const edit = normalizeEditEntry(entry);
    if (edit) {
      target.push(edit);
    }
  }
}

function dedupeEditEntries(edits: ReadonlyArray<WorkLogToolEditDetails>): WorkLogToolEditDetails[] {
  const seen = new Set<string>();
  const deduped: WorkLogToolEditDetails[] = [];
  for (const edit of edits) {
    const key = JSON.stringify([edit.path ?? "", edit.oldText ?? "", edit.newText ?? ""]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(edit);
  }
  return deduped;
}

function extractEditEntries(payload: Record<string, unknown> | null): WorkLogToolEditDetails[] {
  const data = asRecord(payload?.data);
  const input = asRecord(data?.input);
  const rawInput = asRecord(data?.rawInput);
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const edits: WorkLogToolEditDetails[] = [];
  collectEditEntries(data?.edits, edits);
  collectEditEntries(input?.edits, edits);
  collectEditEntries(rawInput?.edits, edits);
  collectEditEntries(item?.edits, edits);
  collectEditEntries(itemInput?.edits, edits);
  collectEditEntries(rawInput, edits);
  collectEditEntries(input, edits);
  return dedupeEditEntries(edits);
}

function detailsTitle(input: DeriveWorkLogToolDetailsInput): string {
  return input.toolTitle ?? input.label;
}

function shouldBuildCommandDetails(input: DeriveWorkLogToolDetailsInput): boolean {
  return (
    input.requestKind === "command" ||
    input.itemType === "command_execution" ||
    Boolean(input.command)
  );
}

function shouldBuildFileChangeDetails(input: DeriveWorkLogToolDetailsInput): boolean {
  return input.requestKind === "file-change" || input.itemType === "file_change";
}

export function deriveWorkLogToolDetails(
  input: DeriveWorkLogToolDetailsInput,
): WorkLogToolDetails | undefined {
  const command = input.rawCommand ?? input.command;
  if (shouldBuildCommandDetails(input)) {
    const output = extractToolOutputDetails({
      payload: input.payload,
      requestSummaryWithExitMarker: input.detail,
    });
    if (!command && !output) {
      return undefined;
    }
    return {
      kind: "command",
      title: detailsTitle(input),
      ...(command ? { command } : {}),
      ...(output ? { output } : {}),
    };
  }

  if (!shouldBuildFileChangeDetails(input)) {
    return undefined;
  }
  const diff = extractUnifiedDiff(input.payload);
  const content = extractWriteContent(input.payload);
  const edits = extractEditEntries(input.payload);
  const output = extractToolOutputDetails({ payload: input.payload });
  const files = input.changedFiles?.length ? input.changedFiles : undefined;
  if (!diff && !content && edits.length === 0 && !output) {
    return undefined;
  }
  return {
    kind: "file-change",
    title: detailsTitle(input),
    ...(diff ? { diff } : {}),
    ...(content ? { content } : {}),
    ...(edits.length > 0 ? { edits } : {}),
    ...(files ? { files } : {}),
    ...(output ? { output } : {}),
  };
}

function mergeStringArrays(
  left: ReadonlyArray<string> | undefined,
  right: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> | undefined {
  const merged = [...(left ?? []), ...(right ?? [])];
  return merged.length > 0 ? [...new Set(merged)] : undefined;
}

function mergeOutputs(
  left: WorkLogToolOutputDetails | undefined,
  right: WorkLogToolOutputDetails | undefined,
): WorkLogToolOutputDetails | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    ...(left.output || right.output ? { output: right.output ?? left.output } : {}),
    ...(left.stdout || right.stdout ? { stdout: right.stdout ?? left.stdout } : {}),
    ...(left.stderr || right.stderr ? { stderr: right.stderr ?? left.stderr } : {}),
    ...(left.exitCode !== undefined || right.exitCode !== undefined
      ? { exitCode: right.exitCode ?? left.exitCode }
      : {}),
    ...(left.truncated === true || right.truncated === true ? { truncated: true } : {}),
  };
}

export function mergeWorkLogToolDetails(
  left: WorkLogToolDetails | undefined,
  right: WorkLogToolDetails | undefined,
): WorkLogToolDetails | undefined {
  if (!left) return right;
  if (!right) return left;
  if (left.kind !== right.kind) return right;
  const output = mergeOutputs(left.output, right.output);
  const files = mergeStringArrays(left.files, right.files);
  return {
    kind: right.kind,
    title: right.title || left.title,
    ...((right.command ?? left.command) ? { command: right.command ?? left.command } : {}),
    ...(output ? { output } : {}),
    ...((right.diff ?? left.diff) ? { diff: right.diff ?? left.diff } : {}),
    ...((right.content ?? left.content) ? { content: right.content ?? left.content } : {}),
    ...((right.edits ?? left.edits) ? { edits: right.edits ?? left.edits } : {}),
    ...(files ? { files } : {}),
  };
}

export type TypedToolRowStatus = "running" | "completed" | "failed" | "cancelled";

export type CommandFooterTone = "success" | "error" | "muted";

export interface CommandFooter {
  label: string;
  tone: CommandFooterTone;
}

export interface LiveOutputInput {
  tail: string;
  truncated: boolean;
  totalChars: number;
}

export interface TypedCommandView {
  command: string | null;
  cwd: string | null;
  description: string | null;
  output: string | null;
  stdout: string | null;
  stderr: string | null;
  isLiveOutput: boolean;
  outputTruncated: boolean;
  outputTotalChars: number | null;
  footer: CommandFooter | null;
  lastStdin: string | null;
  background: boolean;
}

function nonEmptyText(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function withoutCombinedOutputWhenSplit(
  output: WorkLogToolOutputDetails,
): WorkLogToolOutputDetails {
  if (!nonEmptyText(output.stdout) && !nonEmptyText(output.stderr)) return output;
  const split: WorkLogToolOutputDetails = { ...output };
  delete split.output;
  return split;
}

const LEADING_EXIT_CODE_LINE_PATTERN = /^Exit code (-?\d+)[ \t]*(?:\r?\n|$)/u;

export function stripLeadingExitCodeLine(
  output: string | null,
  exitCode: number | null | undefined,
): string | null {
  if (output === null || typeof exitCode !== "number") return output;
  const match = LEADING_EXIT_CODE_LINE_PATTERN.exec(output);
  if (!match || Number.parseInt(match[1]!, 10) !== exitCode) return output;
  return nonEmptyText(output.slice(match[0].length));
}

export function deriveCommandFooter(input: {
  status: TypedToolRowStatus;
  exitCode: number | null | undefined;
  interrupted: boolean | undefined;
}): CommandFooter | null {
  if (input.interrupted === true || input.status === "cancelled") {
    return { label: "Stopped", tone: "muted" };
  }
  if (input.status === "running") return null;
  if (input.exitCode === null) return { label: "Exit code unknown", tone: "muted" };
  if (input.exitCode === 0) return { label: "Success", tone: "success" };
  if (typeof input.exitCode === "number") {
    return { label: `Exit code ${input.exitCode}`, tone: "error" };
  }
  return input.status === "failed"
    ? { label: "Failed", tone: "error" }
    : { label: "Success", tone: "success" };
}

export function buildTypedCommandView(input: {
  command: CommandExecutionDetails;
  status: TypedToolRowStatus;
  fallbackCommand?: string | undefined;
  fallbackOutput?: WorkLogToolOutputDetails | undefined;
  liveOutput?: LiveOutputInput | undefined;
}): TypedCommandView {
  const details = input.command;
  const legacy = input.fallbackOutput;
  const stdout = nonEmptyText(details.stdout) ?? nonEmptyText(legacy?.stdout);
  const stderr = nonEmptyText(details.stderr) ?? nonEmptyText(legacy?.stderr);
  const exitCode = details.exitCode !== undefined ? details.exitCode : legacy?.exitCode;
  const hasSplitOutput = Boolean(stdout || stderr);
  const finalOutput = hasSplitOutput
    ? null
    : stripLeadingExitCodeLine(
        nonEmptyText(details.output) ?? nonEmptyText(legacy?.output),
        exitCode,
      );
  const hasFinalOutput = Boolean(finalOutput || stdout || stderr);
  const useLive =
    input.liveOutput !== undefined &&
    nonEmptyText(input.liveOutput.tail) !== null &&
    (input.status === "running" || !hasFinalOutput);
  return {
    command: nonEmptyText(details.command) ?? nonEmptyText(input.fallbackCommand),
    cwd: nonEmptyText(details.cwd),
    description: nonEmptyText(details.description),
    output: useLive ? input.liveOutput!.tail : finalOutput,
    stdout: useLive ? null : stdout,
    stderr: useLive ? null : stderr,
    isLiveOutput: useLive,
    outputTruncated: useLive
      ? input.liveOutput!.truncated
      : details.outputTruncated === true || legacy?.truncated === true,
    outputTotalChars: useLive ? input.liveOutput!.totalChars : (details.outputTotalChars ?? null),
    footer: deriveCommandFooter({
      status: input.status,
      exitCode,
      interrupted: details.interrupted,
    }),
    lastStdin: nonEmptyText(details.lastStdin),
    background: details.background === true,
  };
}

export interface FileChangeStat {
  additions: number;
  deletions: number;
}

export function countUnifiedDiffLines(diff: string | undefined): FileChangeStat | null {
  if (!diff) return null;
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

export function resolveFileChangeStat(change: FileChangeEntry): FileChangeStat | null {
  if (change.additions !== undefined || change.deletions !== undefined) {
    return { additions: change.additions ?? 0, deletions: change.deletions ?? 0 };
  }
  return countUnifiedDiffLines(change.unifiedDiff);
}

function patchHead(diff: string): string {
  const firstHunk = diff.search(/^@@/mu);
  return firstHunk === -1 ? diff : diff.slice(0, firstHunk);
}

function hasPatchFileHeader(diff: string): boolean {
  const head = patchHead(diff);
  return /^--- /mu.test(head) && /^\+\+\+ /mu.test(head);
}

const MACOS_PRIVATE_ROOT_ALIAS_PATTERN = /^\/private(?=\/(?:tmp|var|etc)(?:\/|$))/u;
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:\//u;

function isAbsoluteFileChangePath(path: string): boolean {
  return path.startsWith("/") || WINDOWS_DRIVE_PATH_PATTERN.test(path);
}

function normalizeFileChangePath(path: string, cwd: string | undefined): string {
  const slashed = path.trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
  const base = cwd?.trim().replace(/\\/gu, "/").replace(/\/+$/u, "");
  const absolute = !isAbsoluteFileChangePath(slashed) && base ? `${base}/${slashed}` : slashed;
  return absolute.replace(MACOS_PRIVATE_ROOT_ALIAS_PATTERN, "").replace(/\/+$/u, "");
}

export function isSameFileChangePath(
  left: string,
  right: string,
  cwd?: string | undefined,
): boolean {
  const normalizedLeft = normalizeFileChangePath(left, cwd);
  const normalizedRight = normalizeFileChangePath(right, cwd);
  if (normalizedLeft === normalizedRight) return true;
  const leftAbsolute = isAbsoluteFileChangePath(normalizedLeft);
  if (leftAbsolute === isAbsoluteFileChangePath(normalizedRight)) return false;
  const [absolute, relative] = leftAbsolute
    ? [normalizedLeft, normalizedRight]
    : [normalizedRight, normalizedLeft];
  return absolute.endsWith(`/${relative}`);
}

export function effectiveFileChangeMovePath(
  change: FileChangeEntry,
  cwd?: string | undefined,
): string | null {
  if (change.kind !== "move" || !change.movePath) return null;
  return isSameFileChangePath(change.path, change.movePath, cwd) ? null : change.movePath;
}

export function effectiveFileChangeKind(
  change: FileChangeEntry,
  cwd?: string | undefined,
): FileChangeEntry["kind"] {
  return change.kind === "move" && effectiveFileChangeMovePath(change, cwd) === null
    ? "update"
    : change.kind;
}

const OLD_PATCH_HEADER_PATTERN = /^--- ([^\t\r\n]+)/mu;
const NEW_PATCH_HEADER_PATTERN = /^\+\+\+ ([^\t\r\n]+)/mu;
const DEV_NULL_PATH = "/dev/null";

function stripPatchSidePrefix(path: string, prefix: "a/" | "b/"): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function withoutFalseRenameHeader(diff: string, cwd: string | undefined): string {
  const head = patchHead(diff);
  if (/^diff --git /mu.test(head)) return diff;
  const rawOldPath = OLD_PATCH_HEADER_PATTERN.exec(head)?.[1];
  const rawNewPath = NEW_PATCH_HEADER_PATTERN.exec(head)?.[1];
  if (!rawOldPath || !rawNewPath || rawOldPath === rawNewPath) return diff;
  const oldPath = stripPatchSidePrefix(rawOldPath, "a/");
  const newPath = stripPatchSidePrefix(rawNewPath, "b/");
  if (oldPath === DEV_NULL_PATH || newPath === DEV_NULL_PATH) return diff;
  if (!isSameFileChangePath(oldPath, newPath, cwd)) return diff;
  return diff
    .replace(OLD_PATCH_HEADER_PATTERN, () => `--- ${newPath}`)
    .replace(NEW_PATCH_HEADER_PATTERN, () => `+++ ${newPath}`);
}

export function renderableFileChangePatch(
  change: FileChangeEntry,
  cwd?: string | undefined,
): string | undefined {
  const diff = change.unifiedDiff;
  if (!diff || diff.trim().length === 0) return undefined;
  if (hasPatchFileHeader(diff)) return withoutFalseRenameHeader(diff, cwd);
  const kind = effectiveFileChangeKind(change, cwd);
  const oldPath = kind === "add" ? DEV_NULL_PATH : change.path;
  const newPath =
    kind === "delete" ? DEV_NULL_PATH : (effectiveFileChangeMovePath(change, cwd) ?? change.path);
  return `--- ${oldPath}\n+++ ${newPath}\n${diff}`;
}

export function fileChangeDisplayPath(change: FileChangeEntry, cwd?: string | undefined): string {
  return effectiveFileChangeMovePath(change, cwd) ?? change.path;
}

const JSON_INDENT = 2;

export function formatToolJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return JSON.stringify(JSON.parse(trimmed), null, JSON_INDENT);
    } catch {
      return value;
    }
  }
  try {
    const text = JSON.stringify(value, null, JSON_INDENT);
    return text === undefined || text === "{}" || text === "[]" ? null : text;
  } catch {
    return null;
  }
}

export interface ToolImageView {
  key: string;
  kind: "attachment" | "local-file" | "omitted";
  src: string | null;
  label: string;
  reason: string | null;
}

const ATTACHMENTS_ROUTE = "/attachments/";

function isAbsoluteLocalPath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith("file://");
}

function safeAttachmentRoute(path: string): string | null {
  const segments = path.split(/[\\/]/u);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return `${ATTACHMENTS_ROUTE}${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

function imageFileLabel(path: string): string {
  const parts = path.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? path;
}

export function buildToolImageViews(images: ReadonlyArray<TranscriptImageRef> | undefined) {
  const views: ToolImageView[] = [];
  (images ?? []).forEach((image, index) => {
    if (image.source === "omitted") {
      views.push({
        key: `omitted:${index}`,
        kind: "omitted",
        src: null,
        label: image.mediaType ?? "Image",
        reason: image.reason.trim() || "Image not stored",
      });
      return;
    }
    const path = image.path.trim();
    if (!path) return;
    if (isAbsoluteLocalPath(path)) {
      views.push({
        key: `local:${index}:${path}`,
        kind: "local-file",
        src: path,
        label: image.alt?.trim() || imageFileLabel(path),
        reason: null,
      });
      return;
    }
    const route = safeAttachmentRoute(path);
    views.push(
      route
        ? {
            key: `attachment:${index}:${path}`,
            kind: "attachment",
            src: route,
            label: image.alt?.trim() || imageFileLabel(path),
            reason: null,
          }
        : {
            key: `invalid:${index}`,
            kind: "omitted",
            src: null,
            label: image.mediaType ?? "Image",
            reason: "Image path is not valid",
          },
    );
  });
  return views;
}

const RESULT_BLOCK_LABELS: Readonly<Record<string, string>> = {
  document: "Document",
  search_result: "Search result",
  tool_reference: "Tool reference",
  container_upload: "Uploaded file",
};

export function describeResultBlock(block: TranscriptResultBlockRef): string {
  const kind = RESULT_BLOCK_LABELS[block.blockType] ?? block.blockType.replace(/[_-]+/gu, " ");
  const mediaKind = block.mediaType === "application/pdf" ? "PDF document" : null;
  const name = block.title?.trim() || block.uri?.trim();
  const head = mediaKind ?? kind;
  return name ? `${head}: ${name}` : head;
}

export interface TypedToolCallView {
  argumentsText: string | null;
  argumentsTruncated: boolean;
  resultText: string | null;
  resultTruncated: boolean;
  structuredContentText: string | null;
  error: string | null;
  images: ToolImageView[];
  otherBlocks: string[];
  server: string | null;
  isEmpty: boolean;
}

export function buildTypedToolCallView(toolCall: ToolCallDetails): TypedToolCallView {
  const argumentsText = formatToolJson(toolCall.arguments);
  const resultText = nonEmptyText(toolCall.resultText);
  const structuredContentText = formatToolJson(toolCall.structuredContent);
  const error = nonEmptyText(toolCall.error);
  const images = buildToolImageViews(toolCall.images);
  const otherBlocks = (toolCall.otherBlocks ?? []).map(describeResultBlock);
  return {
    argumentsText,
    argumentsTruncated: toolCall.argumentsTruncated === true,
    resultText,
    resultTruncated: toolCall.resultTruncated === true,
    structuredContentText,
    error,
    images,
    otherBlocks,
    server: nonEmptyText(toolCall.server),
    isEmpty:
      !argumentsText &&
      !resultText &&
      !structuredContentText &&
      !error &&
      images.length === 0 &&
      otherBlocks.length === 0,
  };
}

export interface TypedWebSearchView {
  queries: string[];
  url: string | null;
  pattern: string | null;
  allowedDomains: string[];
  blockedDomains: string[];
  results: WebSearchResult[];
  resultsTruncated: boolean;
  error: string | null;
  isEmpty: boolean;
}

function uniqueTrimmed(values: ReadonlyArray<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim() ?? "").filter(Boolean))];
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function urlHostAndPath(url: URL): string {
  const path = url.pathname.replace(/\/+$/u, "");
  return `${url.host}${path}`;
}

function webSearchResultIdentity(rawUrl: string): string {
  const url = parseHttpUrl(rawUrl);
  return url ? `${urlHostAndPath(url)}${url.search}` : rawUrl;
}

export function webSearchResultLabel(result: WebSearchResult): string {
  const rawUrl = result.url.trim();
  const url = parseHttpUrl(rawUrl);
  const fallback = url ? urlHostAndPath(url) : rawUrl;
  const title = result.title?.trim();
  if (!title) return fallback;
  const comparableTitle = title.toLowerCase().replace(/\/+$/u, "");
  const titleRepeatsUrl =
    comparableTitle === rawUrl.toLowerCase().replace(/\/+$/u, "") ||
    (url !== null &&
      (comparableTitle === url.host || comparableTitle === urlHostAndPath(url).toLowerCase()));
  return titleRepeatsUrl ? fallback : title;
}

function uniqueWebSearchResults(results: ReadonlyArray<WebSearchResult>): WebSearchResult[] {
  const seen = new Set<string>();
  const unique: WebSearchResult[] = [];
  for (const result of results) {
    const url = result.url.trim();
    if (url.length === 0) continue;
    const identity = webSearchResultIdentity(url);
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(result);
  }
  return unique;
}

export function buildTypedWebSearchView(webSearch: WebSearchDetails): TypedWebSearchView {
  const queries = uniqueTrimmed([
    webSearch.action?.query,
    webSearch.query,
    ...(webSearch.queries ?? []),
  ]);
  const results = uniqueWebSearchResults(webSearch.results ?? []);
  const view = {
    queries,
    url: nonEmptyText(webSearch.action?.url),
    pattern: nonEmptyText(webSearch.action?.pattern),
    allowedDomains: uniqueTrimmed(webSearch.allowedDomains ?? []),
    blockedDomains: uniqueTrimmed(webSearch.blockedDomains ?? []),
    results,
    resultsTruncated: webSearch.resultsTruncated === true,
    error: nonEmptyText(webSearch.error),
  };
  return {
    ...view,
    isEmpty:
      view.queries.length === 0 &&
      !view.url &&
      view.results.length === 0 &&
      !view.error &&
      view.allowedDomains.length === 0 &&
      view.blockedDomains.length === 0,
  };
}

export function isWebSearchQueryEmpty(webSearch: WebSearchDetails): boolean {
  return (
    uniqueTrimmed([
      webSearch.action?.query,
      webSearch.action?.url,
      webSearch.query,
      ...(webSearch.queries ?? []),
    ]).length === 0
  );
}
