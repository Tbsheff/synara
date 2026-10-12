import { unicodeSafeEndOffset } from "@synara/shared/text";

const MAX_REASONING_HEADING_CHARS = 160;
const BOLD_ONLY_LINE = /^(?:\*\*|__)(.+?)(?:\*\*|__)[:.]?$/u;

function stripInlineMarkdown(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/u, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/u, "")
    .replace(/^\s*>\s?/u, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/(\*\*|__)(.+?)\1/gu, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=$|[^\w*])/gu, "$1$2")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function capHeading(value: string): string {
  return value.length > MAX_REASONING_HEADING_CHARS
    ? `${value.slice(0, unicodeSafeEndOffset(value, MAX_REASONING_HEADING_CHARS - 1)).trimEnd()}…`
    : value;
}

export function deriveReasoningHeading(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  const firstLine = summary
    .replace(/<!--[\s\S]*?-->/gu, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return undefined;
  const boldMatch = BOLD_ONLY_LINE.exec(firstLine);
  const heading = stripInlineMarkdown(boldMatch ? boldMatch[1]! : firstLine);
  return heading.length > 0 ? capHeading(heading) : undefined;
}
