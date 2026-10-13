import {
  type CommandExecutionDetails,
  type FileChangeDetails,
  type FileChangeEntry,
  type ServerToolKind,
  type ToolCallDetails,
  type TranscriptImageFileRef,
  type TranscriptImageRef,
  type TranscriptResultBlockRef,
  type WebSearchDetails,
  type WebSearchResult,
  TRANSCRIPT_FILE_DIFF_MAX_CHARS,
  TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS,
  TRANSCRIPT_TOOL_ARGUMENTS_MAX_CHARS,
  TRANSCRIPT_TOOL_RESULT_MAX_CHARS,
} from "@synara/contracts";
import { splitsSurrogatePair, unicodeSafeEndOffset } from "@synara/shared/text";
import { Effect, type FileSystem, type PlatformError } from "effect";
import nodePath from "node:path";

export const CLAUDE_TOOL_RESULT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const CLAUDE_TOOL_RESULT_MAX_IMAGES = 20;
export const CLAUDE_TOOL_RESULT_MAX_OMITTED_IMAGES = 20;
export const CLAUDE_TOOL_RESULT_MAX_OTHER_BLOCKS = 50;
export const CLAUDE_TURN_IMAGE_MAX_BYTES = 50 * 1024 * 1024;
export const CLAUDE_TURN_IMAGE_MAX_COUNT = 100;
export const CLAUDE_WEB_SEARCH_MAX_RESULTS = 50;

export const CLAUDE_TOOL_RESULT_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export interface ClaudeToolResultImageWriteInput {
  readonly mediaType: string;
  readonly base64: string;
  readonly byteLength: number;
}

export type ClaudeToolResultImageWriter = (
  input: ClaudeToolResultImageWriteInput,
) => Effect.Effect<TranscriptImageFileRef | undefined>;

export interface ClaudeToolResultImageBudget {
  readonly maxBytes: number;
  readonly maxCount: number;
  usedBytes: number;
  usedCount: number;
}

export function makeClaudeToolResultImageBudget(limits?: {
  readonly maxBytes?: number;
  readonly maxCount?: number;
}): ClaudeToolResultImageBudget {
  return {
    maxBytes: limits?.maxBytes ?? CLAUDE_TURN_IMAGE_MAX_BYTES,
    maxCount: limits?.maxCount ?? CLAUDE_TURN_IMAGE_MAX_COUNT,
    usedBytes: 0,
    usedCount: 0,
  };
}

export function writeClaudeToolResultImageFile(
  fileSystem: FileSystem.FileSystem,
  input: { readonly directory: string; readonly filePath: string; readonly bytes: Uint8Array },
): Effect.Effect<void, PlatformError.PlatformError> {
  return Effect.gen(function* () {
    yield* fileSystem.makeDirectory(input.directory, { recursive: true });
    yield* fileSystem
      .writeFile(input.filePath, input.bytes)
      .pipe(
        Effect.onError(() =>
          fileSystem.remove(input.filePath, { force: true }).pipe(Effect.ignore),
        ),
      );
  });
}

export interface ClaudeToolIdentity {
  readonly toolName: string;
  readonly itemType: string;
  readonly input: Record<string, unknown>;
  readonly serverToolKind?: ServerToolKind | undefined;
  readonly mcpServer?: string | undefined;
}

export interface ClaudeToolDetails {
  readonly toolName: string;
  readonly toolCall: ToolCallDetails;
  readonly command?: CommandExecutionDetails;
  readonly fileChanges?: FileChangeDetails;
  readonly webSearch?: WebSearchDetails;
}

interface CappedText {
  readonly text: string;
  readonly truncated: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function readNonEmpty(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = readString(record, key)?.trim();
  return value && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): ReadonlyArray<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length > 0 ? strings : undefined;
}

function readNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function readInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

export function capHead(text: string, max: number): CappedText {
  return text.length > max
    ? { text: text.slice(0, unicodeSafeEndOffset(text, max)), truncated: true }
    : { text, truncated: false };
}

export function capTail(text: string, max: number): CappedText {
  if (text.length <= max) return { text, truncated: false };
  const start = text.length - max;
  return {
    text: text.slice(splitsSurrogatePair(text, start) ? start + 1 : start),
    truncated: true,
  };
}

export function capToolArguments(
  input: Record<string, unknown>,
): Pick<ToolCallDetails, "arguments" | "argumentsTruncated"> {
  if (Object.keys(input).length === 0) return {};
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return {};
  }
  if (serialized.length <= TRANSCRIPT_TOOL_ARGUMENTS_MAX_CHARS) {
    return { arguments: input };
  }
  return {
    arguments: capHead(serialized, TRANSCRIPT_TOOL_ARGUMENTS_MAX_CHARS).text,
    argumentsTruncated: true,
  };
}

function toolCallIdentity(tool: ClaudeToolIdentity): ToolCallDetails {
  return {
    toolName: tool.toolName,
    ...(tool.mcpServer ? { server: tool.mcpServer } : {}),
    ...(tool.serverToolKind ? { serverToolKind: tool.serverToolKind } : {}),
    ...capToolArguments(tool.input),
  };
}

function bashCommandStart(input: Record<string, unknown>): CommandExecutionDetails | undefined {
  const command = readString(input, "command");
  if (command === undefined) return undefined;
  const description = readNonEmpty(input, "description");
  return {
    command,
    ...(description ? { description } : {}),
    ...(input.run_in_background === true ? { background: true } : {}),
  };
}

function shellSessionId(input: Record<string, unknown>): string | undefined {
  return readNonEmpty(input, "bash_id") ?? readNonEmpty(input, "shell_id");
}

function clientCommandStart(tool: ClaudeToolIdentity): CommandExecutionDetails | undefined {
  switch (tool.toolName) {
    case "BashOutput": {
      const id = shellSessionId(tool.input);
      return { description: id ? `Read output of shell ${id}` : "Read shell output" };
    }
    case "KillShell": {
      const id = shellSessionId(tool.input);
      return { description: id ? `Stop shell ${id}` : "Stop shell" };
    }
    default:
      return bashCommandStart(tool.input);
  }
}

function serverCommandStart(input: Record<string, unknown>): CommandExecutionDetails | undefined {
  const command = readString(input, "command") ?? readString(input, "code");
  return command === undefined ? undefined : { command };
}

function webSearchStart(input: Record<string, unknown>): WebSearchDetails | undefined {
  const query = readString(input, "query");
  const allowedDomains = readStringArray(input.allowed_domains);
  const blockedDomains = readStringArray(input.blocked_domains);
  if (query === undefined && !allowedDomains && !blockedDomains) return undefined;
  return {
    ...(query !== undefined ? { query, action: { type: "search" as const, query } } : {}),
    ...(allowedDomains ? { allowedDomains } : {}),
    ...(blockedDomains ? { blockedDomains } : {}),
  };
}

export function buildClaudeToolStartDetails(tool: ClaudeToolIdentity): ClaudeToolDetails {
  const command =
    tool.itemType !== "command_execution"
      ? undefined
      : tool.serverToolKind
        ? serverCommandStart(tool.input)
        : clientCommandStart(tool);
  const webSearch = tool.itemType === "web_search" ? webSearchStart(tool.input) : undefined;
  return {
    toolName: tool.toolName,
    toolCall: toolCallIdentity(tool),
    ...(command ? { command } : {}),
    ...(webSearch ? { webSearch } : {}),
  };
}

interface StructuredPatchHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: ReadonlyArray<string>;
}

function readStructuredPatch(value: unknown): ReadonlyArray<StructuredPatchHunk> | undefined {
  if (!Array.isArray(value)) return undefined;
  const hunks: Array<StructuredPatchHunk> = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const lines = readStringArray(record?.lines) ?? [];
    const oldStart = readNonNegativeInt(record?.oldStart);
    const newStart = readNonNegativeInt(record?.newStart);
    if (oldStart === undefined || newStart === undefined) continue;
    hunks.push({
      oldStart,
      oldLines: readNonNegativeInt(record?.oldLines) ?? 0,
      newStart,
      newLines: readNonNegativeInt(record?.newLines) ?? 0,
      lines,
    });
  }
  return hunks;
}

function diffFromHunks(
  path: string,
  kind: FileChangeEntry["kind"],
  hunks: ReadonlyArray<StructuredPatchHunk>,
): Pick<FileChangeEntry, "unifiedDiff" | "diffTruncated" | "additions" | "deletions"> {
  let additions = 0;
  let deletions = 0;
  const body: Array<string> = [
    `--- ${kind === "add" ? "/dev/null" : path}`,
    `+++ ${kind === "delete" ? "/dev/null" : path}`,
  ];
  for (const hunk of hunks) {
    body.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
      body.push(line);
    }
  }
  if (hunks.length === 0) return { additions, deletions };
  const capped = capHead(body.join("\n"), TRANSCRIPT_FILE_DIFF_MAX_CHARS);
  return {
    unifiedDiff: capped.text,
    ...(capped.truncated ? { diffTruncated: true } : {}),
    additions,
    deletions,
  };
}

function hunksForCreatedContent(content: string): ReadonlyArray<StructuredPatchHunk> {
  if (content.length === 0) return [];
  const lines = content.replace(/\n$/, "").split("\n");
  return [
    {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: lines.length,
      lines: lines.map((line) => `+${line}`),
    },
  ];
}

function proposedPatchLines(lines: ReadonlyArray<string>, sign: string): Array<string> {
  return lines.flatMap((line) => [
    `${sign}${line.replace(/\n$/, "")}`,
    ...(line.endsWith("\n") ? [] : ["\\ No newline at end of file"]),
  ]);
}

export function buildClaudeProposedFileChanges(
  fileSystem: FileSystem.FileSystem,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): Effect.Effect<FileChangeDetails | undefined> {
  if (!["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(toolName)) {
    return Effect.succeed(undefined);
  }
  const path = readNonEmpty(input, toolName === "NotebookEdit" ? "notebook_path" : "file_path");
  if (!path) return Effect.succeed(undefined);
  const unavailable: FileChangeDetails = {
    changes: [{ path, kind: "update", diffTruncated: true }],
    totalFiles: 1,
  };
  return Effect.gen(function* () {
    const filePath = nodePath.resolve(cwd, path);
    const stat = yield* fileSystem.stat(filePath).pipe(Effect.result);
    const created = stat._tag === "Failure" && stat.failure.reason._tag === "NotFound";
    if (stat._tag === "Failure" && !created) return unavailable;
    if (
      stat._tag === "Success" &&
      (stat.success.type !== "File" || stat.success.size > 1024 * 1024)
    ) {
      return unavailable;
    }
    const original = created
      ? ""
      : yield* fileSystem
          .readFileString(filePath)
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (original === undefined || original.includes("\0")) return unavailable;
    let before = original;
    let after: string;
    if (toolName === "Write") {
      const content = readString(input, "content");
      if (content === undefined) return unavailable;
      after = content;
    } else if (toolName === "NotebookEdit") {
      const notebook = yield* Effect.try({
        try: () => asRecord(JSON.parse(original)),
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));
      const cells = Array.isArray(notebook?.cells) ? notebook.cells : [];
      const cell = cells.map(asRecord).find((entry) => entry?.id === input.cell_id);
      if (input.edit_mode !== "insert" && !cell) return unavailable;
      before =
        input.edit_mode === "insert"
          ? ""
          : typeof cell?.source === "string"
            ? cell.source
            : Array.isArray(cell?.source)
              ? cell.source.filter((line): line is string => typeof line === "string").join("")
              : "";
      const source = readString(input, "new_source");
      if (input.edit_mode !== "delete" && source === undefined) return unavailable;
      after = input.edit_mode === "delete" ? "" : (source ?? "");
    } else {
      if (created) return unavailable;
      const edits = toolName === "MultiEdit" ? input.edits : [input];
      if (!Array.isArray(edits) || edits.length === 0) return unavailable;
      after = original;
      for (const edit of edits) {
        const entry = asRecord(edit);
        const oldText = readString(entry, "old_string");
        const newText = readString(entry, "new_string");
        if (!oldText || newText === undefined) return unavailable;
        const first = after.indexOf(oldText);
        if (
          first < 0 ||
          (entry?.replace_all !== true && after.indexOf(oldText, first + oldText.length) >= 0)
        ) {
          return unavailable;
        }
        after =
          entry?.replace_all === true
            ? after.split(oldText).join(newText)
            : after.slice(0, first) + newText + after.slice(first + oldText.length);
      }
    }
    const oldLines = before.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const newLines = after.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    let prefix = 0;
    while (
      prefix < Math.min(oldLines.length, newLines.length) &&
      oldLines[prefix] === newLines[prefix]
    )
      prefix++;
    let suffix = 0;
    while (
      suffix < Math.min(oldLines.length, newLines.length) - prefix &&
      oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    )
      suffix++;
    const start = Math.max(0, prefix - 3);
    const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + 3);
    const newEnd = Math.min(newLines.length, newLines.length - suffix + 3);
    const kind = created ? "add" : "update";
    const hunks =
      before === after
        ? []
        : [
            {
              oldStart: oldLines.length === 0 ? 0 : start + 1,
              oldLines: oldEnd - start,
              newStart: newLines.length === 0 ? 0 : start + 1,
              newLines: newEnd - start,
              lines: [
                ...proposedPatchLines(oldLines.slice(start, prefix), " "),
                ...proposedPatchLines(oldLines.slice(prefix, oldLines.length - suffix), "-"),
                ...proposedPatchLines(newLines.slice(prefix, newLines.length - suffix), "+"),
                ...proposedPatchLines(oldLines.slice(oldLines.length - suffix, oldEnd), " "),
              ],
            },
          ];
    return {
      changes: [
        {
          path,
          kind,
          ...diffFromHunks(path, kind, hunks),
          ...(toolName === "NotebookEdit" ? { diffTruncated: true } : {}),
        },
      ],
      totalFiles: 1,
    };
  });
}

function fileChangesFromStructuredResult(
  tool: ClaudeToolIdentity,
  structured: Record<string, unknown> | undefined,
): FileChangeDetails | undefined {
  if (tool.toolName === "NotebookEdit") {
    const path = readString(structured, "notebook_path") ?? readString(tool.input, "notebook_path");
    return path ? { changes: [{ path, kind: "update" }], totalFiles: 1 } : undefined;
  }
  const path = readString(structured, "filePath") ?? readString(tool.input, "file_path");
  if (!path) return undefined;
  const created =
    tool.toolName === "Write" &&
    structured !== undefined &&
    (structured.type === "create" || structured.originalFile === null);
  const kind: FileChangeEntry["kind"] = created ? "add" : "update";
  const patch = readStructuredPatch(structured?.structuredPatch);
  const content = readString(structured, "content");
  const hunks =
    patch && patch.length > 0
      ? patch
      : created && content !== undefined
        ? hunksForCreatedContent(content)
        : [];
  return {
    changes: [{ path, kind, ...diffFromHunks(path, kind, hunks) }],
    totalFiles: 1,
  };
}

const EXIT_CODE_PATTERN = /^Exit code (-?\d+)[ \t]*(?:\r?\n|$)/;

function splitLeadingExitCode(text: string): {
  readonly exitCode?: number;
  readonly rest: string;
} {
  const match = EXIT_CODE_PATTERN.exec(text);
  const exitCode = match ? Number.parseInt(match[1]!, 10) : undefined;
  return match && exitCode !== undefined && Number.isSafeInteger(exitCode)
    ? { exitCode, rest: text.slice(match[0].length) }
    : { rest: text };
}

function commandOutputFields(
  structured: Record<string, unknown> | undefined,
  text: string,
): Pick<CommandExecutionDetails, "output" | "stdout" | "stderr" | "outputTotalChars"> & {
  readonly truncated: boolean;
} {
  const stdout = readString(structured, "stdout") ?? "";
  const stderr = readString(structured, "stderr") ?? "";
  if (stdout.length > 0 || stderr.length > 0) {
    const cappedStdout = capTail(stdout, TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS);
    const cappedStderr = capTail(stderr, TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS);
    return {
      ...(stdout.length > 0 ? { stdout: cappedStdout.text } : {}),
      ...(stderr.length > 0 ? { stderr: cappedStderr.text } : {}),
      outputTotalChars: stdout.length + stderr.length,
      truncated: cappedStdout.truncated || cappedStderr.truncated,
    };
  }
  if (text.length === 0) return { truncated: false };
  const output = capTail(text, TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS);
  return { output: output.text, outputTotalChars: text.length, truncated: output.truncated };
}

function commandFromBashResult(
  tool: ClaudeToolIdentity,
  structured: Record<string, unknown> | undefined,
  text: string,
  isError: boolean,
  durationMs: number | undefined,
): CommandExecutionDetails {
  const start = clientCommandStart(tool) ?? {};
  const structuredCommand =
    start.command === undefined ? readNonEmpty(structured, "command") : undefined;
  const leading = isError ? splitLeadingExitCode(text) : { rest: text };
  const { truncated, ...outputFields } = commandOutputFields(structured, leading.rest);
  const exitCode = leading.exitCode ?? readInt(structured?.exitCode);
  const background =
    start.background === true ||
    readNonEmpty(structured, "backgroundTaskId") !== undefined ||
    structured?.backgroundedByUser === true;
  return {
    ...start,
    ...(structuredCommand ? { command: structuredCommand } : {}),
    ...outputFields,
    ...(truncated ? { outputTruncated: true } : {}),
    ...(typeof structured?.interrupted === "boolean"
      ? { interrupted: structured.interrupted }
      : {}),
    ...(background ? { background: true } : {}),
    ...(exitCode !== undefined && Number.isSafeInteger(exitCode) ? { exitCode } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function webSearchFromStructuredResult(
  tool: ClaudeToolIdentity,
  structured: Record<string, unknown> | undefined,
): WebSearchDetails | undefined {
  const start = webSearchStart(tool.input) ?? {};
  const results: Array<WebSearchResult> = [];
  let total = 0;
  if (Array.isArray(structured?.results)) {
    for (const group of structured.results) {
      const content = asRecord(group)?.content;
      if (!Array.isArray(content)) continue;
      for (const hit of content) {
        const url = readString(asRecord(hit), "url");
        if (!url) continue;
        total += 1;
        if (results.length >= CLAUDE_WEB_SEARCH_MAX_RESULTS) continue;
        const title = readString(asRecord(hit), "title");
        results.push({ url, ...(title ? { title } : {}) });
      }
    }
  }
  const query = readString(structured, "query");
  if (results.length === 0 && Object.keys(start).length === 0 && query === undefined) {
    return undefined;
  }
  return {
    ...start,
    ...(query !== undefined && start.query === undefined ? { query } : {}),
    ...(results.length > 0 ? { results } : {}),
    ...(total > results.length ? { resultsTruncated: true } : {}),
  };
}

export function estimateBase64ByteLength(base64: string): number {
  const length = base64.length;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((length * 3) / 4) - padding);
}

export function omittedImage(
  reason: string,
  mediaType: string | undefined,
  byteLength: number | undefined,
): TranscriptImageRef {
  return {
    source: "omitted",
    reason,
    ...(mediaType ? { mediaType } : {}),
    ...(byteLength !== undefined ? { byteLength } : {}),
  };
}

function imageRefFromBlock(
  block: Record<string, unknown>,
  writer: ClaudeToolResultImageWriter | undefined,
  budget: ClaudeToolResultImageBudget | undefined,
): Effect.Effect<TranscriptImageRef> {
  const source = asRecord(block.source);
  const mediaType = readString(source, "media_type")?.toLowerCase();
  const data = readString(source, "data");
  if (source?.type !== "base64" || data === undefined) {
    return Effect.succeed(omittedImage("unsupported-source", mediaType, undefined));
  }
  const byteLength = estimateBase64ByteLength(data);
  if (!mediaType || !CLAUDE_TOOL_RESULT_IMAGE_MEDIA_TYPES.has(mediaType)) {
    return Effect.succeed(omittedImage("unsupported-media-type", mediaType, byteLength));
  }
  if (byteLength > CLAUDE_TOOL_RESULT_IMAGE_MAX_BYTES) {
    return Effect.succeed(omittedImage("too-large", mediaType, byteLength));
  }
  if (!writer) {
    return Effect.succeed(omittedImage("storage-unavailable", mediaType, byteLength));
  }
  if (budget && budget.usedCount >= budget.maxCount) {
    return Effect.succeed(omittedImage("turn-image-limit", mediaType, byteLength));
  }
  if (budget && budget.usedBytes + byteLength > budget.maxBytes) {
    return Effect.succeed(omittedImage("turn-byte-limit", mediaType, byteLength));
  }
  if (budget) {
    budget.usedCount += 1;
    budget.usedBytes += byteLength;
  }
  return writer({ mediaType, base64: data, byteLength }).pipe(
    Effect.catchCause(() => Effect.succeed(undefined)),
    Effect.map((ref): TranscriptImageRef => {
      if (ref) return ref;
      if (budget) {
        budget.usedCount -= 1;
        budget.usedBytes -= byteLength;
      }
      return omittedImage("write-failed", mediaType, byteLength);
    }),
  );
}

function otherBlockRef(block: Record<string, unknown>): TranscriptResultBlockRef | undefined {
  const blockType = readString(block, "type");
  if (!blockType || blockType === "text" || blockType === "image") return undefined;
  switch (blockType) {
    case "document": {
      const source = asRecord(block.source);
      const title = readNonEmpty(block, "title");
      const mediaType =
        readString(source, "media_type") ?? (source?.type === "text" ? "text/plain" : undefined);
      const uri = source?.type === "url" ? readString(source, "url") : undefined;
      return {
        blockType,
        ...(title ? { title } : {}),
        ...(mediaType ? { mediaType } : {}),
        ...(uri ? { uri } : {}),
      };
    }
    case "search_result": {
      const title = readNonEmpty(block, "title");
      const uri = readString(block, "source");
      return { blockType, ...(title ? { title } : {}), ...(uri ? { uri } : {}) };
    }
    case "tool_reference": {
      const title = readNonEmpty(block, "tool_name");
      return { blockType, ...(title ? { title } : {}) };
    }
    default:
      return { blockType };
  }
}

interface ContentBlockDetails {
  readonly images: ReadonlyArray<TranscriptImageRef>;
  readonly otherBlocks: ReadonlyArray<TranscriptResultBlockRef>;
}

export function collectClaudeResultContentBlocks(
  content: unknown,
  writer: ClaudeToolResultImageWriter | undefined,
  budget?: ClaudeToolResultImageBudget,
): Effect.Effect<ContentBlockDetails> {
  return Effect.gen(function* () {
    const images: Array<TranscriptImageRef> = [];
    const otherBlocks: Array<TranscriptResultBlockRef> = [];
    if (!Array.isArray(content)) return { images, otherBlocks };
    let seenImages = 0;
    let omittedImages = 0;
    const pushImage = (ref: TranscriptImageRef) => {
      if (ref.source === "omitted") {
        if (omittedImages >= CLAUDE_TOOL_RESULT_MAX_OMITTED_IMAGES) return;
        omittedImages += 1;
      }
      images.push(ref);
    };
    for (const entry of content) {
      const block = asRecord(entry);
      if (!block) continue;
      if (block.type === "image") {
        seenImages += 1;
        if (seenImages > CLAUDE_TOOL_RESULT_MAX_IMAGES) {
          const source = asRecord(block.source);
          const data = readString(source, "data");
          pushImage(
            omittedImage(
              "image-limit",
              readString(source, "media_type"),
              data === undefined ? undefined : estimateBase64ByteLength(data),
            ),
          );
          continue;
        }
        pushImage(yield* imageRefFromBlock(block, writer, budget));
        continue;
      }
      if (otherBlocks.length >= CLAUDE_TOOL_RESULT_MAX_OTHER_BLOCKS) continue;
      const ref = otherBlockRef(block);
      if (ref) otherBlocks.push(ref);
    }
    return { images, otherBlocks };
  });
}

export interface ClaudeToolResultInput {
  readonly tool: ClaudeToolIdentity;
  readonly content: unknown;
  readonly text: string;
  readonly isError: boolean;
  readonly structuredResult: unknown;
  readonly durationMs?: number | undefined;
  readonly imageBudget?: ClaudeToolResultImageBudget | undefined;
}

export function buildClaudeToolResultDetails(
  input: ClaudeToolResultInput,
  writer: ClaudeToolResultImageWriter | undefined,
): Effect.Effect<ClaudeToolDetails> {
  return Effect.gen(function* () {
    const { tool, text, isError } = input;
    const durationMs =
      input.durationMs !== undefined && Number.isFinite(input.durationMs) && input.durationMs >= 0
        ? input.durationMs
        : undefined;
    const structured = asRecord(input.structuredResult);
    const blocks = yield* collectClaudeResultContentBlocks(
      input.content,
      writer,
      input.imageBudget,
    );
    const command =
      tool.itemType === "command_execution" && !tool.serverToolKind
        ? commandFromBashResult(tool, structured, text, isError, durationMs)
        : undefined;
    const fileChanges =
      tool.itemType === "file_change" && !isError
        ? fileChangesFromStructuredResult(tool, structured)
        : undefined;
    const webSearch =
      tool.itemType === "web_search" ? webSearchFromStructuredResult(tool, structured) : undefined;
    const resultText = capHead(text, TRANSCRIPT_TOOL_RESULT_MAX_CHARS);
    const toolCall: ToolCallDetails = {
      ...toolCallIdentity(tool),
      success: !isError,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(!command && !isError && text.length > 0 ? { resultText: resultText.text } : {}),
      ...(!command && !isError && resultText.truncated ? { resultTruncated: true } : {}),
      ...(!command && isError && text.length > 0 ? { error: resultText.text } : {}),
      ...(blocks.images.length > 0 ? { images: blocks.images } : {}),
      ...(blocks.otherBlocks.length > 0 ? { otherBlocks: blocks.otherBlocks } : {}),
    };
    return {
      toolName: tool.toolName,
      toolCall,
      ...(command ? { command } : {}),
      ...(fileChanges ? { fileChanges } : {}),
      ...(webSearch ? { webSearch } : {}),
    };
  });
}

export interface ClaudeServerToolResult {
  readonly details: ClaudeToolDetails;
  readonly isError: boolean;
}

function serverResultError(content: Record<string, unknown> | undefined): string | undefined {
  const code = content?.error_code;
  if (typeof code === "string" && code.trim().length > 0) return code.trim();
  if (typeof content?.type === "string" && content.type.endsWith("_error")) return content.type;
  return undefined;
}

function textFromMcpResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((entry) => readString(asRecord(entry), "text") ?? "")
    .filter((entry) => entry.length > 0)
    .join("\n");
}

function webSearchFromServerResult(
  tool: ClaudeToolIdentity,
  content: unknown,
): { readonly webSearch: WebSearchDetails; readonly error?: string } {
  const start = webSearchStart(tool.input) ?? {};
  if (!Array.isArray(content)) {
    const error = serverResultError(asRecord(content)) ?? "web_search_error";
    return { webSearch: { ...start, error }, error };
  }
  const results: Array<WebSearchResult> = [];
  for (const hit of content) {
    const url = readString(asRecord(hit), "url");
    if (!url || results.length >= CLAUDE_WEB_SEARCH_MAX_RESULTS) continue;
    const title = readString(asRecord(hit), "title");
    results.push({ url, ...(title ? { title } : {}) });
  }
  return {
    webSearch: {
      ...start,
      ...(results.length > 0 ? { results } : {}),
      ...(content.length > results.length ? { resultsTruncated: true } : {}),
    },
  };
}

function codeExecutionResult(content: Record<string, unknown> | undefined): {
  readonly command?: CommandExecutionDetails;
  readonly otherBlocks: ReadonlyArray<TranscriptResultBlockRef>;
} {
  const stdout = readString(content, "stdout");
  const stderr = readString(content, "stderr");
  const exitCode = readInt(content?.return_code);
  const otherBlocks: Array<TranscriptResultBlockRef> = [];
  if (Array.isArray(content?.content)) {
    for (const entry of content.content) {
      const block = asRecord(entry);
      const blockType = readString(block, "type");
      if (!blockType || otherBlocks.length >= CLAUDE_TOOL_RESULT_MAX_OTHER_BLOCKS) continue;
      const title = readNonEmpty(block, "file_id");
      otherBlocks.push({ blockType, ...(title ? { title } : {}) });
    }
  }
  if (content?.type === "encrypted_code_execution_result") {
    otherBlocks.push({ blockType: "encrypted_code_execution_result" });
  }
  if (stdout === undefined && stderr === undefined && exitCode === undefined) {
    return { otherBlocks };
  }
  const cappedStdout =
    stdout === undefined ? undefined : capTail(stdout, TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS);
  const cappedStderr =
    stderr === undefined ? undefined : capTail(stderr, TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS);
  return {
    command: {
      ...(cappedStdout ? { stdout: cappedStdout.text } : {}),
      ...(cappedStderr ? { stderr: cappedStderr.text } : {}),
      ...(cappedStdout?.truncated || cappedStderr?.truncated ? { outputTruncated: true } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
    },
    otherBlocks,
  };
}

function textEditorResult(
  tool: ClaudeToolIdentity,
  content: Record<string, unknown> | undefined,
): { readonly resultText?: string; readonly fileChanges?: FileChangeDetails } {
  const path = readString(tool.input, "path") ?? readString(tool.input, "file_path");
  switch (content?.type) {
    case "text_editor_code_execution_view_result": {
      const text = readString(content, "content");
      return text ? { resultText: text } : {};
    }
    case "text_editor_code_execution_create_result": {
      if (!path) return {};
      return {
        fileChanges: {
          changes: [{ path, kind: content.is_file_update === true ? "update" : "add" }],
          totalFiles: 1,
        },
      };
    }
    case "text_editor_code_execution_str_replace_result": {
      if (!path) return {};
      const lines = readStringArray(content.lines);
      const oldStart = readNonNegativeInt(content.old_start);
      const newStart = readNonNegativeInt(content.new_start);
      const hunks =
        lines && oldStart !== undefined && newStart !== undefined
          ? [
              {
                oldStart,
                oldLines: readNonNegativeInt(content.old_lines) ?? 0,
                newStart,
                newLines: readNonNegativeInt(content.new_lines) ?? 0,
                lines,
              },
            ]
          : [];
      return {
        fileChanges: {
          changes: [{ path, kind: "update", ...diffFromHunks(path, "update", hunks) }],
          totalFiles: 1,
        },
      };
    }
    default:
      return {};
  }
}

function webFetchResult(content: Record<string, unknown> | undefined): {
  readonly resultText?: string;
  readonly otherBlocks: ReadonlyArray<TranscriptResultBlockRef>;
} {
  const document = asRecord(content?.content);
  const source = asRecord(document?.source);
  const text = source?.type === "text" ? readString(source, "data") : undefined;
  if (text !== undefined) return { resultText: text, otherBlocks: [] };
  const ref = document ? otherBlockRef(document) : undefined;
  const url = readString(content, "url");
  return {
    otherBlocks: ref ? [{ ...ref, ...(url && !ref.uri ? { uri: url } : {}) }] : [],
  };
}

export function buildClaudeServerToolResultDetails(
  tool: ClaudeToolIdentity,
  block: Record<string, unknown>,
): ClaudeServerToolResult {
  const blockType = readString(block, "type") ?? "";
  const content = block.content;
  const contentRecord = asRecord(content);
  const base = toolCallIdentity(tool);
  const finish = (input: {
    readonly error?: string | undefined;
    readonly resultText?: string | undefined;
    readonly otherBlocks?: ReadonlyArray<TranscriptResultBlockRef>;
    readonly command?: CommandExecutionDetails | undefined;
    readonly fileChanges?: FileChangeDetails | undefined;
    readonly webSearch?: WebSearchDetails | undefined;
  }): ClaudeServerToolResult => {
    const capped =
      input.resultText !== undefined && input.resultText.length > 0
        ? capHead(input.resultText, TRANSCRIPT_TOOL_RESULT_MAX_CHARS)
        : undefined;
    const isError = input.error !== undefined;
    return {
      isError,
      details: {
        toolName: tool.toolName,
        toolCall: {
          ...base,
          success: !isError,
          ...(capped ? { resultText: capped.text } : {}),
          ...(capped?.truncated ? { resultTruncated: true } : {}),
          ...(input.error ? { error: input.error } : {}),
          ...(input.otherBlocks && input.otherBlocks.length > 0
            ? { otherBlocks: input.otherBlocks }
            : {}),
        },
        ...(input.command
          ? { command: { ...serverCommandStart(tool.input), ...input.command } }
          : {}),
        ...(input.fileChanges ? { fileChanges: input.fileChanges } : {}),
        ...(input.webSearch ? { webSearch: input.webSearch } : {}),
      },
    };
  };

  switch (blockType) {
    case "web_search_tool_result": {
      const result = webSearchFromServerResult(tool, content);
      return finish({ error: result.error, webSearch: result.webSearch });
    }
    case "web_fetch_tool_result": {
      const error = serverResultError(contentRecord);
      if (error) return finish({ error });
      return finish(webFetchResult(contentRecord));
    }
    case "advisor_tool_result": {
      const error = serverResultError(contentRecord);
      if (error) return finish({ error });
      if (contentRecord?.type === "advisor_result") {
        return finish({ resultText: readString(contentRecord, "text") });
      }
      const redactedType = readString(contentRecord, "type");
      return finish({ otherBlocks: redactedType ? [{ blockType: redactedType }] : [] });
    }
    case "code_execution_tool_result":
    case "bash_code_execution_tool_result": {
      const error = serverResultError(contentRecord);
      if (error) return finish({ error });
      return finish(codeExecutionResult(contentRecord));
    }
    case "text_editor_code_execution_tool_result": {
      const error = serverResultError(contentRecord);
      if (error) return finish({ error });
      return finish(textEditorResult(tool, contentRecord));
    }
    case "tool_search_tool_result": {
      const error = serverResultError(contentRecord);
      if (error) return finish({ error });
      const references = Array.isArray(contentRecord?.tool_references)
        ? contentRecord.tool_references
            .map((entry) => readString(asRecord(entry), "tool_name"))
            .filter((name): name is string => name !== undefined && name.length > 0)
        : [];
      return finish({
        resultText: references.join("\n"),
        otherBlocks: references
          .slice(0, CLAUDE_TOOL_RESULT_MAX_OTHER_BLOCKS)
          .map((title) => ({ blockType: "tool_reference", title })),
      });
    }
    case "mcp_tool_result": {
      const text = textFromMcpResultContent(content);
      if (block.is_error === true) {
        return finish({
          error: capHead(
            text.length > 0 ? text : "MCP tool failed.",
            TRANSCRIPT_TOOL_RESULT_MAX_CHARS,
          ).text,
        });
      }
      return finish({ resultText: text });
    }
    default:
      return finish({});
  }
}
