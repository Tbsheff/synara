import { splitMarkdownTableRowCells } from "./markdownTableRepair";

const FENCE_LINE_REGEX = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const PARTIAL_BACKTICK_FENCE_REGEX = /^ {0,3}`{1,2}$/;
const TABLE_ROW_REGEX = /^ {0,3}\|/;
const PARTIAL_TABLE_DELIMITER_REGEX = /^ {0,3}[|:\- ]*$/;
const TABLE_DELIMITER_CELL_REGEX = /^:?-+:?$/;
const WHITESPACE_REGEX = /\s/;
const PUNCTUATION_REGEX = /[\p{P}\p{S}]/u;
const MAX_HIDDEN_LINK_LABEL_CHARS = 80;
const TRAILING_BARE_DOLLAR_REGEX = /(^|\s)\$$/;
const BACKTICK_RUN_REGEX = /`+/g;
const PARTIAL_DISPLAY_MATH_CLOSER_REGEX = /(^|\n)[^\S\n]*\$$/;
const MIN_FENCE_LENGTH = 3;

const BLOCK_MARKER_ONLY_LINE_PATTERNS: readonly RegExp[] = [
  /^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d{1,9}[.)]?)$|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[(?:[ xX](?:\][ \t]*)?)?)?$)/,
  /^ {0,3}(?:>[ \t]*)*#{1,6}[ \t]*$/,
  /^[ \t]*(?:>[ \t]*)+$/,
];

export const PENDING_DISPLAY_MATH_LANGUAGE = "synara-pending-math";

export function isBlockMarkerOnlyLine(line: string): boolean {
  return BLOCK_MARKER_ONLY_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

interface OpenFence {
  readonly marker: string;
  readonly length: number;
}

function matchFenceLine(line: string): (OpenFence & { readonly info: string }) | null {
  const match = FENCE_LINE_REGEX.exec(line);
  if (!match) return null;
  const run = match[1] ?? "";
  const info = (match[2] ?? "").trim();
  const marker = run[0] ?? "`";
  if (marker === "`" && info.includes("`")) return null;
  return { marker, length: run.length, info };
}

function isClosingFence(line: string, fence: OpenFence): boolean {
  const match = matchFenceLine(line);
  return (
    match !== null &&
    match.marker === fence.marker &&
    match.length >= fence.length &&
    match.info === ""
  );
}

function findOpenFenceAtEnd(lines: readonly string[]): OpenFence | null {
  let fence: OpenFence | null = null;
  for (const line of lines) {
    if (fence) {
      if (isClosingFence(line, fence)) fence = null;
      continue;
    }
    const match = matchFenceLine(line);
    if (match) fence = { marker: match.marker, length: match.length };
  }
  return fence;
}

function dropLastLine(text: string): string {
  const newlineIndex = text.lastIndexOf("\n");
  return newlineIndex === -1 ? "" : text.slice(0, newlineIndex + 1);
}

function repairOpenFenceTail(text: string, fence: OpenFence): string {
  const lastLine = text.slice(text.lastIndexOf("\n") + 1);
  const trimmed = lastLine.trim();
  const isPartialClosingFence =
    trimmed.length > 0 &&
    trimmed.length < fence.length &&
    [...trimmed].every((char) => char === fence.marker) &&
    lastLine.length - lastLine.trimStart().length <= 3;
  return isPartialClosingFence ? dropLastLine(text) : text;
}

function skipInlineCodeSpan(line: string, start: number): number {
  let runEnd = start;
  while (line[runEnd] === "`") runEnd += 1;
  const runLength = runEnd - start;
  let cursor = runEnd;
  while (cursor < line.length) {
    if (line[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    let closeEnd = cursor;
    while (line[closeEnd] === "`") closeEnd += 1;
    if (closeEnd - cursor === runLength) return closeEnd;
    cursor = closeEnd;
  }
  return -1;
}

function findUnclosedDisplayMathStart(text: string): number {
  let fence: OpenFence | null = null;
  let openAt = -1;
  let lineStart = 0;
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const isBlankLine = line.trim().length === 0 && index < lines.length - 1;
    if (fence) {
      if (isClosingFence(line, fence)) fence = null;
    } else if (isBlankLine) {
      openAt = -1;
    } else {
      const fenceMatch = openAt === -1 ? matchFenceLine(line) : null;
      if (fenceMatch) {
        fence = { marker: fenceMatch.marker, length: fenceMatch.length };
      } else {
        let cursor = 0;
        while (cursor < line.length) {
          const char = line[cursor];
          if (char === "\\") {
            cursor += 2;
            continue;
          }
          if (char === "`" && openAt === -1) {
            const end = skipInlineCodeSpan(line, cursor);
            if (end !== -1) {
              cursor = end;
              continue;
            }
          }
          if (char === "$" && line[cursor + 1] === "$") {
            openAt = openAt === -1 ? lineStart + cursor : -1;
            cursor += 2;
            continue;
          }
          cursor += 1;
        }
      }
    }
    lineStart += line.length + 1;
  }
  return openAt;
}

function isWhitespaceOrEdge(char: string | undefined): boolean {
  return char === undefined || WHITESPACE_REGEX.test(char);
}

function isPunctuation(char: string | undefined): boolean {
  return char !== undefined && PUNCTUATION_REGEX.test(char);
}

interface OpenDelimiter {
  readonly char: string;
  readonly length: number;
  readonly position: number;
}

function findClosingParen(line: string, start: number): number {
  let depth = 0;
  for (let cursor = start; cursor < line.length; cursor += 1) {
    const char = line[cursor];
    if (char === "\\") {
      cursor += 1;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return -1;
}

function repairLastLine(line: string): string {
  if (PARTIAL_BACKTICK_FENCE_REGEX.test(line)) return "";

  let cutAt = line.length;
  const brackets: number[] = [];
  const delimiters: OpenDelimiter[] = [];
  let openCode: { readonly position: number; readonly length: number } | null = null;

  let cursor = 0;
  while (cursor < line.length) {
    const char = line[cursor]!;

    if (char === "`") {
      let runEnd = cursor;
      while (line[runEnd] === "`") runEnd += 1;
      const runLength = runEnd - cursor;
      if (openCode === null) {
        openCode = { position: cursor, length: runLength };
      } else if (openCode.length === runLength) {
        openCode = null;
      }
      cursor = runEnd;
      continue;
    }
    if (openCode !== null) {
      cursor += 1;
      continue;
    }
    if (char === "\\") {
      cursor += 2;
      continue;
    }

    if (char === "[") {
      brackets.push(line[cursor - 1] === "!" ? cursor - 1 : cursor);
      cursor += 1;
      continue;
    }
    if (char === "]") {
      const start = brackets.pop();
      if (start === undefined) {
        cursor += 1;
        continue;
      }
      const next = line[cursor + 1];
      if (next === undefined) {
        if (cursor - start <= MAX_HIDDEN_LINK_LABEL_CHARS) cutAt = Math.min(cutAt, start);
        break;
      }
      if (next === "(") {
        const closeParen = findClosingParen(line, cursor + 1);
        if (closeParen === -1) {
          cutAt = Math.min(cutAt, start);
          break;
        }
        cursor = closeParen + 1;
        continue;
      }
      cursor += 1;
      continue;
    }

    if (char === "*" || char === "_") {
      let runEnd = cursor;
      while (line[runEnd] === char) runEnd += 1;
      const before = line[cursor - 1];
      const after = line[runEnd];
      const leftFlanking =
        !isWhitespaceOrEdge(after) &&
        (!isPunctuation(after) || isWhitespaceOrEdge(before) || isPunctuation(before));
      const rightFlanking =
        !isWhitespaceOrEdge(before) &&
        (!isPunctuation(before) || isWhitespaceOrEdge(after) || isPunctuation(after));
      const openIndex = delimiters.findLastIndex((delimiter) => delimiter.char === char);
      const isPartialCloser =
        after === undefined && openIndex !== -1 && runEnd - cursor < delimiters[openIndex]!.length;
      if (rightFlanking && isPartialCloser) {
        cutAt = Math.min(cutAt, cursor);
        break;
      } else if (rightFlanking && openIndex !== -1) {
        delimiters.length = openIndex;
      } else if (after === undefined && (isWhitespaceOrEdge(before) || isPunctuation(before))) {
        cutAt = Math.min(cutAt, cursor);
        break;
      } else if (leftFlanking && (isWhitespaceOrEdge(before) || isPunctuation(before))) {
        delimiters.push({ char, length: Math.min(3, runEnd - cursor), position: cursor });
      }
      cursor = runEnd;
      continue;
    }

    cursor += 1;
  }

  const shortUnclosedLabelStart = brackets.find(
    (start) => line.length - start <= MAX_HIDDEN_LINK_LABEL_CHARS,
  );
  if (shortUnclosedLabelStart !== undefined) cutAt = Math.min(cutAt, shortUnclosedLabelStart);

  let closers = "";
  if (openCode !== null && openCode.position < cutAt) {
    if (line.slice(openCode.position + openCode.length, cutAt).trim().length === 0) {
      cutAt = openCode.position;
    } else {
      closers += "`".repeat(openCode.length);
    }
  }
  for (let index = delimiters.length - 1; index >= 0; index -= 1) {
    const delimiter = delimiters[index]!;
    if (delimiter.position >= cutAt) continue;
    const content = line.slice(delimiter.position + delimiter.length, cutAt);
    if (content.trim().length === 0) {
      cutAt = delimiter.position;
      closers = "";
      continue;
    }
    closers += delimiter.char.repeat(delimiter.length);
  }

  const kept = line.slice(0, cutAt);
  if (closers.length === 0) return kept;
  return kept.trimEnd() + closers;
}

function tableDelimiterRow(cellCount: number): string {
  return `|${" --- |".repeat(cellCount)}`;
}

function isTableHeaderCandidate(lines: readonly string[], index: number): boolean {
  const line = lines[index];
  if (line === undefined || !TABLE_ROW_REGEX.test(line)) return false;
  const previous = lines[index - 1];
  return previous === undefined || !TABLE_ROW_REGEX.test(previous);
}

function isCompleteTableDelimiter(line: string): boolean {
  const cells = splitMarkdownTableRowCells(line);
  return cells !== null && cells.every((cell) => TABLE_DELIMITER_CELL_REGEX.test(cell.trim()));
}

function repairTableTail(text: string): string {
  const lines = text.split("\n");
  const lastIndex = lines.length - 1;
  const lastLine = lines[lastIndex] ?? "";

  if (
    lastIndex >= 1 &&
    PARTIAL_TABLE_DELIMITER_REGEX.test(lastLine) &&
    isTableHeaderCandidate(lines, lastIndex - 1)
  ) {
    if (lastLine.trim().length > 0 && isCompleteTableDelimiter(lastLine)) return text;
    const headerCells = splitMarkdownTableRowCells(lines[lastIndex - 1] ?? "")?.length ?? 0;
    if (headerCells === 0) return text;
    lines[lastIndex] = tableDelimiterRow(headerCells);
    return lines.join("\n");
  }

  if (isTableHeaderCandidate(lines, lastIndex)) {
    const headerCells = splitMarkdownTableRowCells(lastLine)?.length ?? 0;
    if (headerCells < 2) return dropLastLine(text);
    return `${text}\n${tableDelimiterRow(headerCells)}`;
  }

  return text;
}

function longestBacktickRun(text: string): number {
  return Math.max(0, ...Array.from(text.matchAll(BACKTICK_RUN_REGEX), (match) => match[0].length));
}

function renderPendingDisplayMath(text: string, mathStart: number): string {
  const lineStart = text.lastIndexOf("\n", mathStart - 1) + 1;
  const indent = text.slice(lineStart, mathStart);
  if (indent.trim().length > 0) return text.slice(0, mathStart);
  const source = text
    .slice(mathStart + 2)
    .replace(/^[^\S\n]*\n?/, "")
    .replace(PARTIAL_DISPLAY_MATH_CLOSER_REGEX, "");
  const fence = "`".repeat(Math.max(MIN_FENCE_LENGTH, longestBacktickRun(source) + 1));
  const body = source.length === 0 || source.endsWith("\n") ? source : `${source}\n`;
  return `${text.slice(0, lineStart)}${indent}${fence}${PENDING_DISPLAY_MATH_LANGUAGE}\n${body}${indent}${fence}`;
}

function dropTrailingBareDollar(text: string): string {
  return TRAILING_BARE_DOLLAR_REGEX.test(text) ? text.slice(0, -1) : text;
}

export function repairStreamingMarkdown(text: string): string {
  if (text.length === 0) return text;

  const openFence = findOpenFenceAtEnd(text.split("\n"));
  if (openFence) return repairOpenFenceTail(text, openFence);

  let repaired = text;
  const mathStart = findUnclosedDisplayMathStart(repaired);
  if (mathStart !== -1) return renderPendingDisplayMath(repaired, mathStart);
  repaired = dropTrailingBareDollar(repaired);
  if (isBlockMarkerOnlyLine(repaired.slice(repaired.lastIndexOf("\n") + 1))) {
    repaired = dropLastLine(repaired);
  }

  const lastLineStart = repaired.lastIndexOf("\n") + 1;
  const lastLine = repaired.slice(lastLineStart);
  const repairedLastLine = repairLastLine(lastLine);
  if (repairedLastLine !== lastLine) {
    repaired = repaired.slice(0, lastLineStart) + repairedLastLine;
  }

  return repairTableTail(repaired);
}
