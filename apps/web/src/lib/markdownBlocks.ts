import type { Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

export interface MarkdownBlock {
  readonly start: number;
  readonly end: number;
  readonly line: number;
}

interface FenceState {
  readonly char: string;
  readonly length: number;
}

interface ListItemState {
  readonly contentIndent: number;
  readonly bullet: string | null;
  readonly delimiter: string | null;
}

type ListState = ListItemState | "unknown" | null;
type ParagraphState = "paragraph" | "unknown" | "none";

interface ListMarker {
  readonly contentIndent: number;
  readonly bullet: string | null;
  readonly delimiter: string | null;
  readonly start: number;
  readonly hasContent: boolean;
}

const REFERENCE_CANDIDATE_PATTERN = /^[ \t]*(?:(?:>|[-+*]|\d{1,9}[.)])[ \t]*)*\[/m;
const referenceParser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath, { singleDollarTextMath: true });

function hasReferenceDefinition(node: Nodes): boolean {
  return (
    node.type === "definition" ||
    node.type === "footnoteDefinition" ||
    ("children" in node && node.children.some(hasReferenceDefinition))
  );
}
const BLANK_LINE_PATTERN = /^[ \t]*$/;
const THEMATIC_BREAK_PATTERN = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const SETEXT_UNDERLINE_PATTERN = /^ {0,3}(?:=+|-+)[ \t]*$/;
const ATX_HEADING_PATTERN = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const BLOCKQUOTE_PATTERN = /^ {0,3}>/;
const HTML_START_PATTERN = /^ {0,3}<[A-Za-z/!?]/;
const BULLET_MARKER_PATTERN = /^( {0,3})([-+*])([ \t]+|$)(.*)$/;
const ORDERED_MARKER_PATTERN = /^( {0,3})(\d{1,9})([.)])([ \t]+|$)(.*)$/;
const FENCE_OPENER_PATTERN = /^ {0,3}(`{3,}|~{3,}|\${2,})(.*)$/;
const UNTERMINATED_HTML_PATTERNS: readonly (readonly [RegExp, RegExp])[] = [
  [/^ {0,3}<(?:script|pre|style|textarea)(?:[\s>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<![A-Za-z]/, />/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
];
const LIST_MARKER_PREFIX_PATTERN = /^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]*/;
const TAB_STOP = 4;
const MAX_FENCE_INDENT = 3;

function indentColumns(line: string): number {
  let columns = 0;
  for (const char of line) {
    if (char === " ") columns += 1;
    else if (char === "\t") columns += TAB_STOP - (columns % TAB_STOP);
    else break;
  }
  return columns;
}

function matchFenceOpener(line: string): FenceState | null {
  const match = FENCE_OPENER_PATTERN.exec(line);
  if (!match) return null;
  const run = match[1]!;
  const char = run[0]!;
  const info = match[2] ?? "";
  if ((char === "`" || char === "$") && info.includes(char)) return null;
  return { char, length: run.length };
}

function closesFence(line: string, fence: FenceState): boolean {
  if (indentColumns(line) > MAX_FENCE_INDENT) return false;
  const trimmed = line.trim();
  return (
    trimmed.length >= fence.length && [...trimmed].every((character) => character === fence.char)
  );
}

function matchListMarker(line: string): ListMarker | null {
  if (THEMATIC_BREAK_PATTERN.test(line)) return null;
  const bullet = BULLET_MARKER_PATTERN.exec(line);
  const ordered = bullet ? null : ORDERED_MARKER_PATTERN.exec(line);
  if (!bullet && !ordered) return null;
  const indent = (bullet ?? ordered)![1]!.length;
  const markerWidth = bullet ? 1 : ordered![2]!.length + 1;
  const spacing = (bullet ? bullet[3] : ordered![4]) ?? "";
  const content = (bullet ? bullet[4] : ordered![5]) ?? "";
  const hasContent = content.trim().length > 0;
  const spacingColumns = indentColumns(spacing);
  const contentGap = !hasContent || spacingColumns > TAB_STOP ? 1 : spacingColumns;
  return {
    contentIndent: indent + markerWidth + contentGap,
    bullet: bullet ? bullet[2]! : null,
    delimiter: ordered ? ordered[3]! : null,
    start: ordered ? Number(ordered[2]) : 1,
    hasContent,
  };
}

function canInterruptParagraph(marker: ListMarker): boolean {
  return marker.hasContent && (marker.bullet !== null || marker.start === 1);
}

function isSameListType(marker: ListMarker, item: ListItemState): boolean {
  return marker.bullet !== null
    ? marker.bullet === item.bullet
    : marker.delimiter === item.delimiter;
}

function listItemFrom(marker: ListMarker): ListItemState {
  return {
    contentIndent: marker.contentIndent,
    bullet: marker.bullet,
    delimiter: marker.delimiter,
  };
}

function htmlBlockIsUnterminated(line: string): boolean | null {
  for (const [opener, closer] of UNTERMINATED_HTML_PATTERNS) {
    if (opener.test(line)) return !closer.test(line.slice(line.indexOf("<") + 2));
  }
  return null;
}

function isLazyContinuationCandidate(line: string): boolean {
  return (
    matchFenceOpener(line) === null &&
    !ATX_HEADING_PATTERN.test(line) &&
    !THEMATIC_BREAK_PATTERN.test(line) &&
    !BLOCKQUOTE_PATTERN.test(line)
  );
}

class MarkdownBlockScanner {
  private fence: FenceState | null = null;
  private list: ListState = null;
  private nestedFence: FenceState | null = null;
  private paragraph: ParagraphState = "none";
  private blockquote = false;
  private htmlUntilBlank = false;
  private previousBlank = false;
  private previousWasEmptyItemMarker = false;
  poisoned = false;
  hasReferenceCandidate = false;

  canSplitBefore(line: string): boolean {
    if (this.poisoned || this.fence || this.nestedFence || !this.previousBlank) return false;
    const indent = indentColumns(line);
    if (indent > MAX_FENCE_INDENT) return false;
    const marker = matchListMarker(line);
    if (this.list === null) return marker === null || marker.hasContent;
    if (marker) return false;
    if (this.list === "unknown") return indent === 0;
    return indent < this.list.contentIndent;
  }

  scan(line: string): void {
    if (this.poisoned) return;
    if (this.fence) {
      if (closesFence(line, this.fence)) this.fence = null;
      this.previousBlank = false;
      return;
    }
    if (!this.nestedFence && REFERENCE_CANDIDATE_PATTERN.test(line)) {
      this.hasReferenceCandidate = true;
    }
    if (BLANK_LINE_PATTERN.test(line)) {
      this.scanBlank();
      return;
    }
    const wasBlank = this.previousBlank;
    this.previousBlank = false;
    this.previousWasEmptyItemMarker = false;
    if (this.htmlUntilBlank) {
      this.scanHtmlContinuation(line);
      return;
    }
    if (this.scanListContext(line, wasBlank)) return;
    this.scanDocumentLine(line, wasBlank);
  }

  private scanBlank(): void {
    if (this.previousWasEmptyItemMarker) this.list = "unknown";
    this.previousWasEmptyItemMarker = false;
    this.previousBlank = true;
    this.htmlUntilBlank = false;
    this.blockquote = false;
    this.paragraph = "none";
  }

  private poison(): void {
    this.poisoned = true;
  }

  private scanHtmlStart(line: string): void {
    if (htmlBlockIsUnterminated(line) === true) this.poison();
    this.htmlUntilBlank = true;
  }

  private startListItem(marker: ListMarker, line: string): void {
    this.list = listItemFrom(marker);
    this.nestedFence = matchFenceOpener(line.replace(LIST_MARKER_PREFIX_PATTERN, ""));
    this.previousWasEmptyItemMarker = !marker.hasContent;
    this.paragraph = "none";
  }

  private scanHtmlContinuation(line: string): void {
    if (indentColumns(line) > MAX_FENCE_INDENT) return;
    if (matchFenceOpener(line)) this.poison();
    else if (HTML_START_PATTERN.test(line)) this.scanHtmlStart(line);
    else if (matchListMarker(line)) this.list = "unknown";
  }

  private scanListItemContent(content: string): void {
    if (this.nestedFence) {
      if (closesFence(content, this.nestedFence)) this.nestedFence = null;
      return;
    }
    this.nestedFence = matchFenceOpener(content);
  }

  private closeList(): void {
    this.list = null;
    this.nestedFence = null;
    this.paragraph = "none";
  }

  private scanListContext(line: string, wasBlank: boolean): boolean {
    const list = this.list;
    if (list === null) return false;
    const indent = indentColumns(line);
    const fenceLike = indent <= MAX_FENCE_INDENT && matchFenceOpener(line) !== null;
    if (list === "unknown") {
      if (indent === 0 && fenceLike) {
        this.closeList();
        return false;
      }
      if (indent > 0) {
        if (fenceLike) this.poison();
        else if (indent <= MAX_FENCE_INDENT && HTML_START_PATTERN.test(line)) {
          if (htmlBlockIsUnterminated(line) !== null) this.poison();
          this.htmlUntilBlank = true;
        }
        return true;
      }
      const marker = matchListMarker(line);
      if (marker) {
        if (wasBlank || canInterruptParagraph(marker)) this.startListItem(marker, line);
        return true;
      }
      if (wasBlank || !isLazyContinuationCandidate(line)) {
        this.closeList();
        return false;
      }
      if (HTML_START_PATTERN.test(line)) this.scanHtmlStart(line);
      return true;
    }
    if (indent >= list.contentIndent) {
      this.scanListItemContent(line.trimStart());
      return true;
    }
    const marker = matchListMarker(line);
    if (marker) {
      if (wasBlank || isSameListType(marker, list) || canInterruptParagraph(marker)) {
        this.startListItem(marker, line);
      } else {
        this.list = "unknown";
      }
      return true;
    }
    if (!wasBlank && isLazyContinuationCandidate(line)) {
      this.list = "unknown";
      if (HTML_START_PATTERN.test(line)) this.scanHtmlStart(line);
      return true;
    }
    this.closeList();
    return false;
  }

  private scanDocumentLine(line: string, wasBlank: boolean): void {
    const indent = indentColumns(line);
    const fence = indent <= MAX_FENCE_INDENT ? matchFenceOpener(line) : null;
    if (this.blockquote && !BLOCKQUOTE_PATTERN.test(line) && !wasBlank) {
      this.blockquote = false;
      if (!fence && isLazyContinuationCandidate(line)) {
        this.paragraph = "unknown";
        const marker = matchListMarker(line);
        if (marker) {
          if (canInterruptParagraph(marker)) this.startListItem(marker, line);
          else this.list = "unknown";
          return;
        }
        if (HTML_START_PATTERN.test(line)) this.scanHtmlStart(line);
        return;
      }
    }
    if (fence) {
      this.fence = fence;
      this.paragraph = "none";
      return;
    }
    if (indent > MAX_FENCE_INDENT) {
      if (this.paragraph === "none") return;
      this.paragraph = "unknown";
      return;
    }
    if (BLOCKQUOTE_PATTERN.test(line)) {
      this.blockquote = true;
      this.paragraph = "none";
      return;
    }
    if (HTML_START_PATTERN.test(line)) {
      this.scanHtmlStart(line);
      this.paragraph = "unknown";
      return;
    }
    if (this.paragraph === "paragraph" && SETEXT_UNDERLINE_PATTERN.test(line)) {
      this.paragraph = "none";
      return;
    }
    const marker = matchListMarker(line);
    if (marker) {
      if (this.paragraph === "none" || canInterruptParagraph(marker)) {
        this.startListItem(marker, line);
      } else if (this.paragraph === "unknown") {
        this.list = "unknown";
      }
      return;
    }
    if (ATX_HEADING_PATTERN.test(line) || THEMATIC_BREAK_PATTERN.test(line)) {
      this.paragraph = "none";
      return;
    }
    this.paragraph = line.includes("|") ? "unknown" : "paragraph";
  }
}

export function splitMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const whole: MarkdownBlock[] = [{ start: 0, end: markdown.length, line: 0 }];
  const blocks: MarkdownBlock[] = [];
  const scanner = new MarkdownBlockScanner();
  let blockStart = 0;
  let blockLine = 0;
  let blockHasContent = false;
  let contentEnd = 0;
  let contentEndLine = 0;
  let lineStart = 0;
  let lineNumber = 0;
  while (lineStart <= markdown.length && !scanner.poisoned) {
    const newline = markdown.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? markdown.length : newline;
    const rawLine = markdown.slice(lineStart, lineEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const isBlank = BLANK_LINE_PATTERN.test(line);
    if (!isBlank && blockHasContent && scanner.canSplitBefore(line)) {
      blocks.push({ start: blockStart, end: contentEnd, line: blockLine });
      blockStart = contentEnd;
      blockLine = contentEndLine;
    }
    scanner.scan(line);
    if (!isBlank) {
      blockHasContent = true;
      contentEnd = newline === -1 ? markdown.length : newline + 1;
      contentEndLine = lineNumber + 1;
    }
    if (newline === -1) break;
    lineStart = newline + 1;
    lineNumber += 1;
  }
  blocks.push({ start: blockStart, end: markdown.length, line: blockLine });
  const hasReferenceCandidate =
    scanner.hasReferenceCandidate ||
    (scanner.poisoned && REFERENCE_CANDIDATE_PATTERN.test(markdown.slice(lineStart)));
  if (hasReferenceCandidate && hasReferenceDefinition(referenceParser.parse(markdown)))
    return whole;
  return blocks;
}

interface SourcePoint {
  readonly line: number;
  readonly column: number;
  readonly offset?: number | undefined;
}

interface PositionedNode {
  position?: { start: SourcePoint; end: SourcePoint } | undefined;
  children?: PositionedNode[] | undefined;
}

export interface MarkdownBlockOrigin {
  readonly offset: number;
  readonly line: number;
}

function shiftPoint(point: SourcePoint, origin: MarkdownBlockOrigin): SourcePoint {
  return {
    line: point.line + origin.line,
    column: point.column,
    ...(point.offset === undefined ? {} : { offset: point.offset + origin.offset }),
  };
}

function shiftNodePositions(node: PositionedNode, origin: MarkdownBlockOrigin): void {
  if (node.position) {
    node.position = {
      start: shiftPoint(node.position.start, origin),
      end: shiftPoint(node.position.end, origin),
    };
  }
  for (const child of node.children ?? []) shiftNodePositions(child, origin);
}

export function remarkMarkdownBlockOrigin(origin: MarkdownBlockOrigin) {
  return (tree: PositionedNode): void => shiftNodePositions(tree, origin);
}
