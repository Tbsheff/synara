import { stripVTControlCharacters } from "node:util";

import {
  CloudEnvironmentId,
  CloudTaskId,
  type CloudTask,
  type CloudTaskPage,
  type CloudTaskStatus,
} from "@synara/contracts";
import { decodeJsonResult } from "@synara/shared/schemaJson";
import { Option, Result, Schema } from "effect";

import { parseGenericCliVersion } from "../provider/providerMaintenance.ts";

export const CODEX_CLOUD_TASK_URL_PREFIX = "https://chatgpt.com/codex/tasks/";
export const CODEX_CLOUD_MAX_ATTEMPTS = 4;
export const CODEX_CLOUD_LIST_PAGE_LIMIT = 20;
export const CLOUD_CLI_DETAIL_MAX_LENGTH = 600;

const CODEX_TASK_URL_PATTERN =
  /^https:\/\/chatgpt\.com\/codex\/tasks\/([A-Za-z0-9][A-Za-z0-9_-]{0,159})\/?$/;
const STATUS_TOKEN_PATTERN = /^\[([A-Z_]+)\]\s*(.*)$/;
const NOT_FOUND_PATTERN = /\b404 Not Found\b|Invalid task ID/i;
const NO_DIFF_PATTERN = /No diff available for task/i;
const ENVIRONMENT_LINE_SEPARATOR = "•";
const NO_DIFF_STATUS_LINE = "no diff";
const EMPTY_DIFF_SUMMARY = { filesChanged: 0, linesAdded: 0, linesRemoved: 0 } as const;
const CODEX_CLOUD_SUBCOMMANDS = ["exec", "status", "list", "apply", "diff"] as const;

export type CodexCloudSubcommand = (typeof CODEX_CLOUD_SUBCOMMANDS)[number];

export function cleanCliText(text: string): string {
  return stripVTControlCharacters(text).replaceAll("\r\n", "\n");
}

export function capCliDetail(text: string): string {
  const cleaned = cleanCliText(text).trim();
  return cleaned.length > CLOUD_CLI_DETAIL_MAX_LENGTH
    ? `${cleaned.slice(0, CLOUD_CLI_DETAIL_MAX_LENGTH)}…`
    : cleaned;
}

function nonEmptyLines(text: string): string[] {
  return cleanCliText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function normalizeCodexCloudStatus(raw: string | null | undefined): CloudTaskStatus {
  switch (raw?.trim().toLowerCase()) {
    case "pending":
    case "queued":
    case "running":
    case "in_progress":
      return "pending";
    case "ready":
    case "applied":
    case "completed":
      return "ready";
    case "error":
    case "failed":
      return "error";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "unknown";
  }
}

export function decodeCloudTaskId(value: string): CloudTaskId | null {
  return Option.getOrNull(Schema.decodeUnknownOption(CloudTaskId)(value));
}

export function decodeCloudEnvironmentId(
  value: string | null | undefined,
): CloudEnvironmentId | null {
  if (value === null || value === undefined) return null;
  return Option.getOrNull(Schema.decodeUnknownOption(CloudEnvironmentId)(value));
}

export function parseCodexTaskIdFromUrl(url: string): CloudTaskId | null {
  const match = CODEX_TASK_URL_PATTERN.exec(url.trim());
  return match?.[1] ? decodeCloudTaskId(match[1]) : null;
}

export function codexTaskUrl(taskId: CloudTaskId): string {
  return `${CODEX_CLOUD_TASK_URL_PREFIX}${taskId}`;
}

export function parseCodexExecOutput(
  stdout: string,
): { readonly taskId: CloudTaskId; readonly url: string } | null {
  const urlLines = nonEmptyLines(stdout).filter((line) =>
    line.startsWith(CODEX_CLOUD_TASK_URL_PREFIX),
  );
  if (urlLines.length !== 1) return null;
  const url = urlLines[0]!;
  const taskId = parseCodexTaskIdFromUrl(url);
  return taskId ? { taskId, url } : null;
}

const NonNegativeCount = Schema.Finite;

const RawCodexCloudTask = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
  environment_id: Schema.optional(Schema.NullOr(Schema.String)),
  environment_label: Schema.optional(Schema.NullOr(Schema.String)),
  summary: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        files_changed: NonNegativeCount,
        lines_added: NonNegativeCount,
        lines_removed: NonNegativeCount,
      }),
    ),
  ),
  is_review: Schema.optional(Schema.NullOr(Schema.Boolean)),
  attempt_total: Schema.optional(Schema.NullOr(Schema.Finite)),
});
type RawCodexCloudTask = typeof RawCodexCloudTask.Type;

const RawCodexCloudList = Schema.Struct({
  tasks: Schema.Array(RawCodexCloudTask),
  cursor: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeRawCodexCloudList = decodeJsonResult(RawCodexCloudList);

function toCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function toCodexCloudTask(raw: RawCodexCloudTask): CloudTask | null {
  const id = decodeCloudTaskId(raw.id);
  if (!id) return null;
  const rawStatus = raw.status ?? null;
  return {
    provider: "codex",
    id,
    url: codexTaskUrl(id),
    title: raw.title ?? null,
    status: normalizeCodexCloudStatus(rawStatus),
    rawStatus,
    updatedAt: raw.updated_at ?? null,
    environmentId: decodeCloudEnvironmentId(raw.environment_id),
    environmentLabel: raw.environment_label ?? null,
    diffSummary: raw.summary
      ? {
          filesChanged: toCount(raw.summary.files_changed),
          linesAdded: toCount(raw.summary.lines_added),
          linesRemoved: toCount(raw.summary.lines_removed),
        }
      : null,
    attemptTotal:
      raw.attempt_total === null || raw.attempt_total === undefined
        ? null
        : toCount(raw.attempt_total),
    isReview: raw.is_review ?? false,
  };
}

export type CodexListParseResult =
  | { readonly ok: true; readonly page: CloudTaskPage }
  | { readonly ok: false; readonly detail: string };

export function parseCodexListJson(stdout: string): CodexListParseResult {
  const decoded = decodeRawCodexCloudList(stdout.trim());
  if (Result.isFailure(decoded)) {
    return { ok: false, detail: "list --json output did not match the expected shape" };
  }
  const tasks: CloudTask[] = [];
  for (const raw of decoded.success.tasks) {
    const task = toCodexCloudTask(raw);
    if (!task) {
      return { ok: false, detail: "list --json returned a task id Synara does not accept" };
    }
    tasks.push(task);
  }
  return { ok: true, page: { tasks, cursor: decoded.success.cursor ?? null } };
}

export interface CodexStatusSnapshot {
  readonly rawStatus: string;
  readonly status: CloudTaskStatus;
  readonly title: string | null;
  readonly environmentLabel: string | null;
  readonly reportsNoDiff: boolean;
}

export function parseCodexStatusText(stdout: string): CodexStatusSnapshot | null {
  const lines = nonEmptyLines(stdout);
  const tokenMatch = lines[0] ? STATUS_TOKEN_PATTERN.exec(lines[0]) : null;
  if (!tokenMatch?.[1]) return null;
  const title = tokenMatch[2]?.trim() ?? "";
  const environmentLine = lines[1];
  const separatorIndex = environmentLine?.indexOf(ENVIRONMENT_LINE_SEPARATOR) ?? -1;
  const environmentLabel =
    environmentLine && separatorIndex > 0 ? environmentLine.slice(0, separatorIndex).trim() : null;
  return {
    rawStatus: tokenMatch[1],
    status: normalizeCodexCloudStatus(tokenMatch[1]),
    title: title.length > 0 ? title : null,
    environmentLabel: environmentLabel && environmentLabel.length > 0 ? environmentLabel : null,
    reportsNoDiff: lines.slice(1).some((line) => line.toLowerCase() === NO_DIFF_STATUS_LINE),
  };
}

export function codexStatusSnapshotToTask(
  taskId: CloudTaskId,
  snapshot: CodexStatusSnapshot,
): CloudTask {
  return {
    provider: "codex",
    id: taskId,
    url: codexTaskUrl(taskId),
    title: snapshot.title,
    status: snapshot.status,
    rawStatus: snapshot.rawStatus,
    updatedAt: null,
    environmentId: null,
    environmentLabel: snapshot.environmentLabel,
    diffSummary: snapshot.reportsNoDiff ? EMPTY_DIFF_SUMMARY : null,
    attemptTotal: null,
    isReview: false,
  };
}

export function isCodexNotFoundStderr(stderr: string): boolean {
  return NOT_FOUND_PATTERN.test(cleanCliText(stderr));
}

export function isCodexNoDiffStderr(stderr: string): boolean {
  return NO_DIFF_PATTERN.test(cleanCliText(stderr));
}

export function parseCodexVersion(stdout: string): string | null {
  return parseGenericCliVersion(cleanCliText(stdout));
}

const HELP_SECTION_HEADER_PATTERN = /^\S.*:$/;
const COMMANDS_SECTION_HEADER = "Commands:";

function helpSectionLines(helpText: string, header: string): string[] {
  const lines = cleanCliText(helpText).split("\n");
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return [];
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (HELP_SECTION_HEADER_PATTERN.test(line)) break;
    section.push(line.trim());
  }
  return section;
}

export function parseCodexCloudSubcommands(helpText: string): ReadonlySet<CodexCloudSubcommand> {
  const found = new Set<CodexCloudSubcommand>();
  for (const line of helpSectionLines(helpText, COMMANDS_SECTION_HEADER)) {
    const firstWord = line.split(/\s+/, 1)[0];
    const subcommand = CODEX_CLOUD_SUBCOMMANDS.find((candidate) => candidate === firstWord);
    if (subcommand) found.add(subcommand);
  }
  return found;
}

export function helpListsFlag(helpText: string, flag: string): boolean {
  return cleanCliText(helpText)
    .split(/[\s,=[\]<>]+/)
    .some((word) => word === flag);
}

export type CodexApplyOutcome = "applied" | "partial" | "failed";

export function classifyCodexApplyOutput(input: {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}): CodexApplyOutcome {
  if (input.exitCode === 0) return "applied";
  const combined = cleanCliText(`${input.stdout}\n${input.stderr}`);
  return /partial/i.test(combined) ? "partial" : "failed";
}

export function firstOutputLines(text: string, maxLines = 5): string {
  return capCliDetail(nonEmptyLines(text).slice(0, maxLines).join("\n"));
}
