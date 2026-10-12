import type { CloudTaskId } from "@synara/contracts";
import { decodeJsonResult } from "@synara/shared/schemaJson";
import { Result, Schema } from "effect";

import { parseGenericCliVersion } from "../provider/providerMaintenance.ts";
import { cleanCliText, decodeCloudTaskId } from "./codexCloudCli.ts";

const CLAUDE_CODE_WEB_HOST = "claude.ai";
const CLAUDE_CODE_WEB_PATH_PREFIX = "/code/";
const INTERACTIVE_ONLY_PATTERN = /interactive only|cannot be combined with --print/i;
const NOT_FOUND_PATTERN = /\bnot found\b|\b404\b/i;

export type ClaudeCloudFailureKind = "interactive-only" | "not-found" | "other";

export function classifyClaudeCloudStderr(stderr: string): ClaudeCloudFailureKind {
  const cleaned = cleanCliText(stderr);
  if (INTERACTIVE_ONLY_PATTERN.test(cleaned)) return "interactive-only";
  if (NOT_FOUND_PATTERN.test(cleaned)) return "not-found";
  return "other";
}

export function parseClaudeVersion(stdout: string): string | null {
  return parseGenericCliVersion(cleanCliText(stdout));
}

function sessionIdFromClaudeWebUrl(reference: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(reference);
  } catch {
    return null;
  }
  const isClaudeCodeUrl =
    parsed.protocol === "https:" &&
    parsed.hostname === CLAUDE_CODE_WEB_HOST &&
    parsed.pathname.startsWith(CLAUDE_CODE_WEB_PATH_PREFIX);
  if (!isClaudeCodeUrl) return null;
  const segments = parsed.pathname.slice(CLAUDE_CODE_WEB_PATH_PREFIX.length).split("/");
  return segments.length === 1 && segments[0] ? segments[0] : null;
}

export function parseClaudeSessionReference(reference: string): CloudTaskId | null {
  const trimmed = reference.trim();
  const candidate = trimmed.startsWith("https://") ? sessionIdFromClaudeWebUrl(trimmed) : trimmed;
  return candidate ? decodeCloudTaskId(candidate) : null;
}

const RawClaudeFollowUpReceipt = Schema.Struct({
  ok: Schema.optional(Schema.NullOr(Schema.Boolean)),
  session_id: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  error: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeRawClaudeFollowUpReceipt = decodeJsonResult(RawClaudeFollowUpReceipt);

export type ClaudeFollowUpParseResult =
  | { readonly ok: true; readonly sessionId: CloudTaskId; readonly url: string | null }
  | { readonly ok: false; readonly detail: string };

export function parseClaudeFollowUpReceipt(
  stdout: string,
  expectedSessionId: CloudTaskId,
): ClaudeFollowUpParseResult {
  const decoded = decodeRawClaudeFollowUpReceipt(stdout.trim());
  if (Result.isFailure(decoded)) {
    return { ok: false, detail: "follow-up output was not the expected JSON receipt" };
  }
  const receipt = decoded.success;
  if (receipt.ok !== true) {
    return { ok: false, detail: receipt.error ?? "follow-up receipt did not report ok" };
  }
  const sessionId = receipt.session_id ? decodeCloudTaskId(receipt.session_id) : null;
  if (sessionId !== null && sessionId !== expectedSessionId) {
    return { ok: false, detail: "follow-up receipt names a different session" };
  }
  const url = receipt.url ?? null;
  const urlNamesSession = url !== null && parseClaudeSessionReference(url) === expectedSessionId;
  return { ok: true, sessionId: expectedSessionId, url: urlNamesSession ? url : null };
}
