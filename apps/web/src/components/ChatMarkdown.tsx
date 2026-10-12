// FILE: ChatMarkdown.tsx
// Purpose: Renders assistant and plan markdown with syntax highlighting and local file links.
// Layer: Web chat presentation component
// Exports: ChatMarkdown

import { HTML_RENDER_DEFAULT_HEIGHT, HTML_RENDER_MAX_BYTES } from "@synara/contracts";
import { INLINE_HTML_RENDER_ON } from "../betaFeatures";
import { HtmlRenderFrame } from "./HtmlRenderFrame";
import {
  CheckIcon,
  CopyIcon,
  InfoIcon,
  LightbulbIcon,
  OctagonAlertIcon,
  TextWrapIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "~/lib/icons";
import { ThreadId, type ProviderMentionReference } from "@synara/contracts";
import type { SynaraPluginAppContext } from "@synara/plugin-sdk/app";
import { isLocalAbsolutePath } from "@synara/shared/path";
import "katex/dist/katex.min.css";
import { matchWikiLinkAt, remarkWikiLinks } from "../lib/remarkWikiLinks";
import { remarkGithubAlerts, type GithubAlertKind } from "../lib/remarkGithubAlerts";
import { remarkHtmlBreaks } from "../lib/remarkHtmlBreaks";
import React, {
  Children,
  createContext,
  Fragment,
  useContext,
  type CSSProperties,
  Suspense,
  isValidElement,
  memo,
  use,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { defaultUrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { remarkBackslashMath } from "../lib/remarkBackslashMath";
import { MarkdownMermaidBlock } from "./chat/MarkdownMermaidBlock";
import { toastManager } from "./ui/toast";
import { copyTextToClipboard } from "../hooks/useCopyToClipboard";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import {
  loadSyntaxHighlighting,
  type SyntaxHighlightingModule,
} from "../lib/syntaxHighlightingLoader";
import {
  classifyStreamingCodeBlock,
  dedentCode,
  parseCodeFenceInfo,
  type CodeFenceInfo,
} from "../lib/codeFence";
import { getFileIconName, pathLooksLikeKnownFile } from "../file-icons";
import { CentralIcon } from "~/lib/central-icons";
import { isLocalImageMarkdownSrc } from "../lib/localImageUrls";
import {
  PENDING_DISPLAY_MATH_LANGUAGE,
  createStreamingMarkdownRepair,
} from "../lib/markdownStreamingRepair";
import {
  remarkMarkdownBlockOrigin,
  splitMarkdownBlocks,
  type MarkdownBlock,
} from "../lib/markdownBlocks";
import { repairMarkdownTableDelimiters } from "../lib/markdownTableRepair";
import { showFileReferenceContextMenu } from "../lib/fileReferenceContextMenu";
import {
  ChatLinkActionsContext,
  resolveGitHubItemClickOpener,
  showLinkContextMenu,
} from "../lib/linkContextMenu";
import { useTheme } from "../hooks/useTheme";
import { useSmoothStreamedText } from "../hooks/useSmoothStreamedText";
import { useStableCallback } from "../hooks/useStableCallback";
import { useStableValue } from "../hooks/useStableValue";
import { useStreamingTextReveal } from "../hooks/useStreamingTextReveal";
import { useThrottledStreamingValue } from "../hooks/useThrottledStreamingValue";
import { openWorkspaceFileReference, useWorkspaceFileOpener } from "../lib/workspaceFileOpener";
import { useQuery } from "@tanstack/react-query";
import { projectResolveWorkspaceFileReferenceQueryOptions } from "../lib/projectReactQuery";
import {
  extractAbsoluteFilesystemPaths,
  resolveChatFileChipTarget,
  resolveMarkdownFileLinkTarget,
  rewriteMarkdownFileUriHref,
} from "../markdown-links";
import type { ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { GeneratedMarkdownImage } from "./chat/GeneratedMarkdownImage";
import { PendingDisplayMath } from "./chat/PendingDisplayMath";
import { TerminalContextInlineChip } from "./chat/TerminalContextInlineChip";
import type { ParsedTerminalContextEntry } from "../lib/terminalContext";
import { formatInlineTerminalContextLabel } from "./chat/userMessageTerminalContexts";
import {
  COMPOSER_INLINE_CHIP_ICON_LABEL_GAP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_TOKEN_ICON_CLASS_NAME,
} from "./composerInlineChip";
import { LinkChipIcon } from "./LinkChipIcon";
import { InlineAgentChip } from "./chat/InlineAgentChip";
import { InlineLinkChip } from "./InlineLinkChip";
import { InlineMentionChip } from "./chat/InlineMentionChip";
import { InlineSkillChip } from "./chat/InlineSkillChip";
import { InlineSlashCommandChip } from "./chat/InlineSlashCommandChip";
import {
  COMPOSER_CHIP_SEGMENT_ATTRIBUTE,
  COMPOSER_CHIP_TAG_NAME,
  TERMINAL_CONTEXT_CHIP_INDEX_ATTRIBUTE,
  TERMINAL_CONTEXT_CHIP_TAG_NAME,
  createComposerChipsRemarkPlugin,
  parseComposerChipSegment,
} from "../lib/remarkComposerChips";
import { IconButton } from "./ui/icon-button";
import { Button } from "./ui/button";
import { applyActiveChatFindMatch, type ThreadFindRange } from "./chat/threadFind.logic";
import {
  ChatFindRenderProvider,
  FindAwareCodeFallback,
  FindAwareMarkdownText,
  FindAwareShikiHtml,
} from "./ChatMarkdownFind";
import {
  buildPluginMessageDirectiveRegistry,
  createPluginMessageDirectiveRemarkPlugin,
  PLUGIN_MESSAGE_DIRECTIVE_ATTRIBUTES_ATTRIBUTE,
  PLUGIN_MESSAGE_DIRECTIVE_NAME_ATTRIBUTE,
  PLUGIN_MESSAGE_DIRECTIVE_SOURCE_ATTRIBUTE,
  PLUGIN_MESSAGE_DIRECTIVE_TAG_NAME,
  PluginMessageDirectiveMount,
  readPluginMessageDirectiveElement,
  type PluginMessageDirectiveRegistry,
} from "../plugins/PluginMessageDirective";
import { usePluginContributions } from "../plugins/runtime";

const EXTERNAL_HTTP_HREF_PATTERN = /^https?:\/\//i;
// Trailing `:line` / `:line:col` position suffix on a resolved file link. Kept on
// the href (so opening jumps to the line) but stripped for icon/title resolution.
const MARKDOWN_LINK_POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const MARKDOWN_EXTERNAL_LINK_CLASS_NAME =
  "inline font-medium text-[var(--info-foreground)] underline-offset-2 hover:underline";
const MARKDOWN_EXTERNAL_LINK_ICON_CLASS_NAME = `${COMPOSER_INLINE_CHIP_TOKEN_ICON_CLASS_NAME} ${COMPOSER_INLINE_CHIP_ICON_LABEL_GAP_CLASS_NAME}`;

function isExternalHttpHref(href: string | undefined): href is string {
  return typeof href === "string" && EXTERNAL_HTTP_HREF_PATTERN.test(href);
}

class CodeHighlightErrorBoundary extends React.Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
  wikiLinkRoot?: string | undefined;
  isStreaming?: boolean;
  revealKey?: string | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
  onImageExpand?:
    | ((preview: ExpandedImagePreview, sourceImage?: HTMLImageElement) => void)
    | undefined;
  /** Case-insensitive substring to wrap while in-thread find is open. */
  findQuery?: string | undefined;
  /** Active occurrence in this markdown body; other hits stay dimmer. */
  findActiveRange?: ThreadFindRange | null | undefined;
  /**
   * "user" renders a sent prompt: GFM plus hard line breaks (single newlines
   * survive the way they were typed), no math/KaTeX and no literal-dollar
   * rewriting (`$50` and `$skill` stay verbatim), and composer inline tokens
   * (skills, mentions, agents, bare links) render as the shared chips.
   */
  variant?: "assistant" | "user";
  /** Mention metadata for chip icon resolution; only used by the user variant. */
  mentionReferences?: ReadonlyArray<ProviderMentionReference> | undefined;
  /**
   * Parses and sanitizes authored HTML embedded in the markdown. Keep this
   * disabled for provider/user content, which must continue to render HTML as
   * text.
   */
  parseHtml?: boolean | undefined;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
  /** Terminal selections rendered as inline chips inside user-message markdown. */
  terminalContexts?: ReadonlyArray<ParsedTerminalContextEntry> | undefined;
  /**
   * Makes GFM task-list checkboxes interactive. Receives the 1-based line of
   * the task item in `text` so the caller can flip that `[ ]` marker at the
   * source (line numbers stay valid because the internal dollar protection is
   * length- and newline-preserving). Without it checkboxes render read-only.
   */
  onTaskToggle?: ((input: { sourceLine: number; checked: boolean }) => void) | undefined;
  /**
   * Absolute paths already observed on this turn's tool calls. A relative
   * inline-code chip uses one of these when the match is unique.
   */
  knownAbsoluteFilePaths?: ReadonlyArray<string> | undefined;
  pluginContext?: SynaraPluginAppContext | undefined;
}

// Source line of the enclosing task-list item, provided by the `li` override.
// The checkbox `input` element is synthesized by mdast-util-to-hast without
// position info, so it cannot read its own source location.
const TaskItemSourceLineContext = React.createContext<number | null>(null);

function MarkdownTaskCheckbox(props: {
  checked: boolean;
  onTaskToggle: ChatMarkdownProps["onTaskToggle"];
}) {
  const { checked, onTaskToggle } = props;
  const sourceLine = React.useContext(TaskItemSourceLineContext);
  const interactive = onTaskToggle !== undefined && sourceLine !== null;
  return (
    <input
      type="checkbox"
      className="chat-markdown-task-checkbox"
      checked={checked}
      disabled={!interactive}
      {...(interactive ? { onChange: () => onTaskToggle({ sourceLine, checked: !checked }) } : {})}
    />
  );
}

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
type MarkdownRemarkPlugins = NonNullable<
  React.ComponentProps<typeof ReactMarkdown>["remarkPlugins"]
>;
type MarkdownRehypePlugins = NonNullable<
  React.ComponentProps<typeof ReactMarkdown>["rehypePlugins"]
>;
interface ParsedMarkdownProps {
  text: string;
  remarkPlugins: MarkdownRemarkPlugins;
  rehypePlugins: MarkdownRehypePlugins;
  components: Components;
}

const ParsedMarkdown = memo(function ParsedMarkdown(props: ParsedMarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={props.remarkPlugins}
      rehypePlugins={props.rehypePlugins}
      components={props.components}
      urlTransform={markdownUrlTransform}
    >
      {props.text}
    </ReactMarkdown>
  );
});

const MARKDOWN_REMARK_PLUGINS: MarkdownRemarkPlugins = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: true }],
  remarkBackslashMath,
  remarkGithubAlerts,
  remarkHtmlBreaks,
];
// User prompts are casual typing, not authored markdown: hard-break single
// newlines and skip math entirely (the composer chip plugin is appended per
// render because it closes over the message's mention references).
const USER_MARKDOWN_REMARK_PLUGINS: MarkdownRemarkPlugins = [remarkGfm, remarkBreaks];
const USER_MARKDOWN_REHYPE_PLUGINS: MarkdownRehypePlugins = [];
const LITERAL_DOLLAR_PLACEHOLDER = "\uE000";
// `\$` is two source characters that render as a single `$`. Collapsing it to one placeholder used
// to shorten the protected string, which shifted every downstream source offset (find positions
// are resolved against the raw text but applied against the parsed mdast positions). A two-character
// placeholder keeps `protectLiteralMarkdownDollars` length-preserving so those offsets stay aligned;
// it is restored ahead of the single-char placeholder (the two share no characters, so order is
// only for clarity).
const ESCAPED_DOLLAR_PLACEHOLDER = "\uE001\uE002";

function restoreLiteralDollarPlaceholders(value: string): string {
  return value
    .replaceAll(ESCAPED_DOLLAR_PLACEHOLDER, "$")
    .replaceAll(LITERAL_DOLLAR_PLACEHOLDER, "$")
    .replaceAll(encodeURIComponent(ESCAPED_DOLLAR_PLACEHOLDER), "$")
    .replaceAll(encodeURIComponent(LITERAL_DOLLAR_PLACEHOLDER), "$");
}

// synara://thread/<target> links carry an id or title that may be
// %-encoded; a malformed sequence keeps the raw target instead of throwing.
function decodeSynaraThreadLinkTarget(target: string): string {
  try {
    return decodeURIComponent(target).trim();
  } catch {
    return target.trim();
  }
}

function markdownUrlTransform(href: string): string {
  const restoredHref = restoreLiteralDollarPlaceholders(href);
  if (restoredHref.startsWith("thread://") || restoredHref.startsWith("synara://thread/")) {
    return restoredHref;
  }
  return rewriteMarkdownFileUriHref(restoredHref) ?? defaultUrlTransform(restoredHref);
}

function restoreLiteralDollarsInNode(node: unknown): void {
  if (!node || typeof node !== "object") {
    return;
  }

  if ("type" in node && node.type === "text" && "value" in node && typeof node.value === "string") {
    node.value = restoreLiteralDollarPlaceholders(node.value);
  }

  if ("children" in node && Array.isArray(node.children)) {
    for (const child of node.children) {
      restoreLiteralDollarsInNode(child);
    }
  }
}

function rehypeRestoreLiteralDollars() {
  return (tree: unknown) => {
    restoreLiteralDollarsInNode(tree);
  };
}

const MARKDOWN_REHYPE_PLUGINS: MarkdownRehypePlugins = [
  [rehypeKatex, { output: "htmlAndMathml", strict: false, throwOnError: false }],
  rehypeRestoreLiteralDollars,
];
type MarkdownTextNode = {
  type: "text";
  value: string;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
};
type MarkdownParentNode = {
  type?: string;
  children?: MarkdownNode[];
};
type MarkdownNode = MarkdownTextNode | MarkdownParentNode | Record<string, unknown>;
const CHAT_FIND_TEXT_TAG_NAME = "chat-find-text";
const CHAT_FIND_TEXT_START_ATTRIBUTE = "data-chat-find-text-start";
// Keep the renderer's generated metadata through the authored-HTML sanitizer.
// KaTeX runs afterward so its generated MathML/styles do not widen this allowlist.
const AUTHORED_HTML_SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), CHAT_FIND_TEXT_TAG_NAME],
  attributes: {
    ...defaultSchema.attributes,
    [CHAT_FIND_TEXT_TAG_NAME]: ["dataChatFindTextStart"],
    blockquote: [
      ...(defaultSchema.attributes?.blockquote ?? []),
      ["dataGithubAlert", "note", "tip", "important", "warning", "caution"],
    ],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file", "thread", "synara"],
  },
};
function remarkFindableText() {
  return (tree: MarkdownNode) => wrapFindableTextNodes(tree);
}

function wrapFindableTextNodes(node: MarkdownNode): void {
  if (!node || typeof node !== "object" || !("children" in node) || !Array.isArray(node.children)) {
    return;
  }
  const parent = node as MarkdownParentNode;
  parent.children = (parent.children ?? []).map((child) => {
    if (child && typeof child === "object" && "type" in child && child.type === "text") {
      return wrapFindableTextNode(child as MarkdownTextNode);
    }
    wrapFindableTextNodes(child);
    return child;
  });
}

function wrapFindableTextNode(node: MarkdownTextNode): MarkdownNode {
  const startOffset = node.position?.start?.offset;
  if (startOffset === undefined || node.value.length === 0) {
    return node;
  }
  return {
    type: "chatFindText",
    data: {
      hName: CHAT_FIND_TEXT_TAG_NAME,
      hProperties: { [CHAT_FIND_TEXT_START_ATTRIBUTE]: String(startOffset) },
    },
    children: [node],
  };
}

const INLINE_MATH_HINT_REGEX = /[\\^_=+\-*/<>()[\]{}]/;
const ALL_CAPS_DOLLAR_IDENTIFIER_REGEX = /^[A-Z][A-Z0-9_]{1,31}$/;

function isLineStart(value: string, index: number): boolean {
  return index === 0 || value[index - 1] === "\n";
}

function matchFenceDelimiter(
  value: string,
  index: number,
): { marker: "`" | "~"; length: number } | null {
  if (!isLineStart(value, index)) {
    return null;
  }

  const marker = value[index];
  if (marker !== "`" && marker !== "~") {
    return null;
  }

  let cursor = index;
  while (value[cursor] === marker) {
    cursor += 1;
  }

  return cursor - index >= 3 ? { marker, length: cursor - index } : null;
}

function findFenceEndIndex(
  value: string,
  index: number,
  marker: "`" | "~",
  length: number,
): number {
  let cursor = value.indexOf("\n", index);
  if (cursor === -1) {
    return value.length;
  }
  cursor += 1;

  while (cursor < value.length) {
    if (isLineStart(value, cursor) && value[cursor] === marker) {
      let markerEnd = cursor;
      while (value[markerEnd] === marker) {
        markerEnd += 1;
      }
      if (markerEnd - cursor >= length) {
        const lineEnd = value.indexOf("\n", markerEnd);
        return lineEnd === -1 ? value.length : lineEnd + 1;
      }
    }

    const nextLine = value.indexOf("\n", cursor);
    if (nextLine === -1) {
      return value.length;
    }
    cursor = nextLine + 1;
  }

  return value.length;
}

function findInlineCodeEndIndex(value: string, index: number, length: number): number {
  let cursor = index + length;
  while (cursor < value.length) {
    if (value[cursor] !== "`") {
      cursor += 1;
      continue;
    }

    let markerEnd = cursor;
    while (value[markerEnd] === "`") {
      markerEnd += 1;
    }

    if (markerEnd - cursor === length) {
      return markerEnd;
    }
    cursor = markerEnd;
  }

  return value.length;
}

function looksLikeInlineMath(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (ALL_CAPS_DOLLAR_IDENTIFIER_REGEX.test(trimmed)) {
    return false;
  }
  if (INLINE_MATH_HINT_REGEX.test(trimmed)) {
    return true;
  }
  return /^(?:\d+(?:\.\d+)?)?[A-Za-z][A-Za-z0-9]{0,15}$/.test(trimmed);
}

// Reject obvious literal/currency dollars before searching for a closing math delimiter.
function canOpenInlineMath(value: string, index: number, links: MarkdownLinkIndex): boolean {
  const next = value[index + 1];
  if (!next || /\s/.test(next)) {
    return false;
  }
  if (/\d/.test(next)) {
    const closingIndex = findInlineMathClosingDollar(value, index + 1, links);
    if (closingIndex === -1 || /\d/.test(value[closingIndex + 1] ?? "")) {
      return false;
    }
    // A numeric prefix can be a coefficient. Require a complete expression
    // on this line; do not pair prices across lines or consume `$5-$10`.
    const content = value.slice(index + 1, closingIndex);
    return !/[\r\n]/.test(content) && looksLikeInlineMath(content);
  }
  return true;
}

// Markdown math delimiters should hug content; loose "$ " endings are treated as prose.
function canCloseInlineMath(value: string, index: number): boolean {
  const previous = value[index - 1];
  if (!previous || /\s/.test(previous)) {
    return false;
  }
  return true;
}

function findInlineMathClosingDollar(
  value: string,
  index: number,
  links: MarkdownLinkIndex,
): number {
  let cursor = index;
  while (cursor < value.length) {
    if (value[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    const linkEnd = findInlineMarkdownLinkEnd(value, cursor, links);
    if (linkEnd !== -1) {
      // Dollars in Markdown links/images cannot close preceding literal text.
      // Dollar-free [f](x) remains valid inside a TeX expression.
      if (value.slice(cursor, linkEnd).includes("$")) {
        return -1;
      }
      cursor = linkEnd;
      continue;
    }
    if (value[cursor] === "$") {
      return canCloseInlineMath(value, cursor) ? cursor : -1;
    }
    cursor += 1;
  }
  return -1;
}

function protectLiteralDollarsInMarkdownLinks(value: string): string {
  const links = indexMarkdownLinks(value);
  let result = "";
  let cursor = 0;

  while (cursor < value.length) {
    if (value[cursor] === "\\" && value[cursor + 1] === "$") {
      result += ESCAPED_DOLLAR_PLACEHOLDER;
      cursor += 2;
      continue;
    }

    // Scan links and math together: splitting at every `[` breaks TeX such as
    // \left[...\right] before its closing dollars can be found. A math span is
    // consumed whole below, so brackets inside it never enter link detection.
    const linkEnd = findInlineMarkdownLinkEnd(value, cursor, links);
    if (linkEnd !== -1) {
      result += value.slice(cursor, linkEnd).replaceAll("$", LITERAL_DOLLAR_PLACEHOLDER);
      cursor = linkEnd;
      continue;
    }

    if (value.startsWith("$$", cursor)) {
      const closingIndex = value.indexOf("$$", cursor + 2);
      if (closingIndex === -1) {
        result += `${LITERAL_DOLLAR_PLACEHOLDER}${LITERAL_DOLLAR_PLACEHOLDER}`;
        cursor += 2;
        continue;
      }
      result += value.slice(cursor, closingIndex + 2);
      cursor = closingIndex + 2;
      continue;
    }

    if (value[cursor] === "$") {
      if (!canOpenInlineMath(value, cursor, links)) {
        result += LITERAL_DOLLAR_PLACEHOLDER;
        cursor += 1;
        continue;
      }

      const closingIndex = findInlineMathClosingDollar(value, cursor + 1, links);
      if (closingIndex === -1) {
        result += LITERAL_DOLLAR_PLACEHOLDER;
        cursor += 1;
        continue;
      }

      const content = value.slice(cursor + 1, closingIndex);
      result += looksLikeInlineMath(content)
        ? `$${content}$`
        : `${LITERAL_DOLLAR_PLACEHOLDER}${content}${LITERAL_DOLLAR_PLACEHOLDER}`;
      cursor = closingIndex + 1;
      continue;
    }

    result += value[cursor];
    cursor += 1;
  }

  return result;
}

interface MarkdownLinkIndex {
  brackets: ReadonlyMap<number, number>;
  parens: ReadonlyMap<number, number>;
  wikiCandidates: ReadonlySet<number>;
}

function indexMarkdownLinks(value: string): MarkdownLinkIndex {
  const brackets = new Map<number, number>();
  const parens = new Map<number, number>();
  const bracketStack: number[] = [];
  const parenStack: number[] = [];
  for (let cursor = 0; cursor < value.length; cursor++) {
    const char = value[cursor];
    if (char === "\\") {
      cursor++;
      continue;
    }
    if (char === "[") bracketStack.push(cursor);
    else if (char === "(") parenStack.push(cursor);
    else if (char === "]") {
      const start = bracketStack.pop();
      if (start !== undefined) brackets.set(start, cursor);
    } else if (char === ")") {
      const start = parenStack.pop();
      if (start !== undefined) parens.set(start, cursor);
    }
  }
  const wikiCandidates = new Set<number>();
  let nextClose = -1;
  for (let cursor = value.length - 1; cursor >= 0; cursor--) {
    if (value[cursor] === "\n") nextClose = -1;
    else if (value[cursor] === "]") nextClose = cursor;
    else if (
      value.startsWith("[[", cursor) &&
      nextClose > cursor + 2 &&
      value[nextClose + 1] === "]"
    )
      wikiCandidates.add(cursor);
  }
  return { brackets, parens, wikiCandidates };
}

function findInlineMarkdownLinkEnd(value: string, index: number, links: MarkdownLinkIndex): number {
  const wikiLink = links.wikiCandidates.has(index) ? matchWikiLinkAt(value, index) : null;
  if (wikiLink) return index + wikiLink[0].length;
  const bracketStart = value[index] === "!" && value[index + 1] === "[" ? index + 1 : index;
  const bracketEnd = links.brackets.get(bracketStart);
  if (bracketEnd === undefined || value[bracketEnd + 1] !== "(") return -1;
  const parenEnd = links.parens.get(bracketEnd + 1);
  return parenEnd === undefined ? -1 : parenEnd + 1;
}

// Tighten single-dollar math so currency and escaped dollars stay literal without touching code spans.
export function protectLiteralMarkdownDollars(value: string): string {
  let result = "";
  let cursor = 0;

  while (cursor < value.length) {
    const fenceDelimiter = matchFenceDelimiter(value, cursor);
    if (fenceDelimiter) {
      const fenceEndIndex = findFenceEndIndex(
        value,
        cursor,
        fenceDelimiter.marker,
        fenceDelimiter.length,
      );
      result += value.slice(cursor, fenceEndIndex);
      cursor = fenceEndIndex;
      continue;
    }

    if (value[cursor] === "`") {
      let markerEnd = cursor;
      while (value[markerEnd] === "`") {
        markerEnd += 1;
      }
      const inlineCodeEndIndex = findInlineCodeEndIndex(value, cursor, markerEnd - cursor);
      result += value.slice(cursor, inlineCodeEndIndex);
      cursor = inlineCodeEndIndex;
      continue;
    }

    let nextCodeIndex = cursor;
    while (nextCodeIndex < value.length) {
      if (value[nextCodeIndex] === "`" || matchFenceDelimiter(value, nextCodeIndex)) {
        break;
      }
      nextCodeIndex += 1;
    }

    result += protectLiteralDollarsInMarkdownLinks(value.slice(cursor, nextCodeIndex));
    cursor = nextCodeIndex;
  }

  return result;
}

// Returns the raw fence info string (the token after ```), e.g. "ts" or the
// Cursor reference form "173:186:packages/shared/src/model.ts". Parsing into a
// highlighter language + file metadata is handled by `parseCodeFenceInfo`.
function extractRawFenceInfo(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  return match?.[1] ?? "text";
}

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return "";
}

function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) {
    return null;
  }

  // The single child is the fenced code element. Its rendered `type` is the
  // custom `code` component (not the string "code") once we override `code`
  // below, so detect by shape (a valid element carrying the code text) rather
  // than by tag identity. `pre` only ever wraps a code element in markdown.
  const onlyChild = childNodes[0];
  if (!isValidElement<{ className?: string; children?: ReactNode }>(onlyChild)) {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

const INLINE_CODE_FILE_PATH_MAX_LENGTH = 120;

// Decides whether an inline code span names a file/path that should render as a
// mention chip (icon + medium label), matching how a file reads in the composer.
// Conservative on purpose: requires a recognized filename/extension and rejects
// whitespace and URLs so ordinary prose tokens stay plain inline code.
function inlineCodeFilePath(raw: string): string | null {
  // Strip a pair of surrounding quotes/backticks the author may have wrapped the
  // path in (e.g. `'src/data/social-metrics.ts'`).
  const value = raw.trim().replace(/^['"`]+|['"`]+$/g, "");
  if (value.length === 0 || /\s/.test(value) || value.includes("://")) {
    return null;
  }
  const withoutPosition = value.replace(MARKDOWN_LINK_POSITION_SUFFIX_PATTERN, "");
  // Absolute local files and directories (`/Users/…/annotate-pr`) are chips
  // even without a known filename extension. Relative names still need a
  // recognizable file so ordinary tokens stay code.
  if (resolveMarkdownFileLinkTarget(withoutPosition)) {
    return value;
  }
  if (withoutPosition.length > INLINE_CODE_FILE_PATH_MAX_LENGTH) {
    return null;
  }
  return pathLooksLikeKnownFile(withoutPosition) ? value : null;
}

function VerifiedWorkspaceFileChip(props: {
  rawReference: string;
  cwd: string;
  theme: "light" | "dark";
  label?: ReactNode;
  href?: string;
}) {
  const relativePath = props.rawReference.replace(MARKDOWN_LINK_POSITION_SUFFIX_PATTERN, "");
  const query = useQuery(
    projectResolveWorkspaceFileReferenceQueryOptions({
      cwd: props.cwd,
      relativePath,
    }),
  );
  const fallback = <code>{props.label ?? relativePath}</code>;
  if (query.isPending || query.isError || query.data === undefined) {
    return fallback;
  }
  if (query.data === null) {
    return fallback;
  }
  return (
    <OpenableFileChip
      targetPath={query.data}
      theme={props.theme}
      {...(props.label !== undefined ? { label: props.label } : {})}
      {...(props.href ? { href: props.href } : {})}
    />
  );
}

// Shared openable file chip: the same mention-chip UI (file icon + medium label)
// used for both assistant markdown file links and inline code that names a file.
// A plain click prefers the surface's in-app viewer (right-dock file pane);
// meta/ctrl-click — or a surface without a viewer — opens the preferred
// external editor. `targetPath` may carry a `:line` suffix (used to open); the
// chip icon and title use the position-free path.
function OpenableFileChip(props: {
  targetPath: string;
  theme: "light" | "dark";
  label?: ReactNode;
  href?: string;
}) {
  const opener = useWorkspaceFileOpener();
  const chipPath = props.targetPath.replace(MARKDOWN_LINK_POSITION_SUFFIX_PATTERN, "");
  const revealPath = isLocalAbsolutePath(chipPath) ? chipPath : undefined;
  return (
    <InlineMentionChip
      path={chipPath}
      theme={props.theme}
      href={props.href ?? props.targetPath}
      onActivate={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const forceExternalEditor = event.metaKey || event.ctrlKey;
        openWorkspaceFileReference(forceExternalEditor ? null : opener, props.targetPath);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void showFileReferenceContextMenu({
          path: chipPath,
          ...(revealPath ? { revealPath } : {}),
          position: { x: event.clientX, y: event.clientY },
          onReferenceInChat: undefined,
        });
      }}
      {...(opener?.prefetchFile
        ? { onHoverPrefetch: () => opener.prefetchFile?.(props.targetPath) }
        : {})}
      {...(props.label !== undefined ? { label: props.label } : {})}
    />
  );
}

// Renders the custom element emitted by the composer-chips remark plugin with the
// shared chip components, so chips in a sent message match the composer exactly.
function ComposerChipElement(props: {
  serializedSegment: string | undefined;
  theme: "light" | "dark";
  mentionReferences: ReadonlyArray<ProviderMentionReference>;
}) {
  const segment = parseComposerChipSegment(props.serializedSegment);
  if (!segment) {
    return null;
  }
  if (segment.type === "skill") {
    return <InlineSkillChip skillName={segment.name} />;
  }
  if (segment.type === "mention") {
    return (
      <InlineMentionChip
        path={segment.path}
        theme={props.theme}
        mentionReferences={props.mentionReferences}
        {...(segment.kind ? { kind: segment.kind } : {})}
      />
    );
  }
  if (segment.type === "agent-mention") {
    return <InlineAgentChip alias={segment.alias} color={segment.color} />;
  }
  if (segment.type === "slash-command") {
    return <InlineSlashCommandChip command={segment.command} />;
  }
  return <InlineLinkChip url={segment.url} interactive />;
}

function CodeBlockHeaderTitle({ fence }: { fence: CodeFenceInfo }) {
  if (fence.isFileReference && fence.fileName) {
    return (
      <span className="chat-markdown-codeblock__file" title={fence.filePath ?? fence.fileName}>
        <CentralIcon
          name={getFileIconName(fence.filePath ?? fence.fileName)}
          className="chat-markdown-codeblock__file-icon"
        />
        <span className="chat-markdown-codeblock__file-name">{fence.fileName}</span>
        {fence.directory ? (
          <span className="chat-markdown-codeblock__file-dir">{fence.directory}</span>
        ) : null}
        {fence.lineRange ? (
          <span className="chat-markdown-codeblock__file-lines">{fence.lineRange}</span>
        ) : null}
      </span>
    );
  }

  return <span className="chat-markdown-codeblock__lang">{fence.language}</span>;
}

function MarkdownCodeBlock({
  code,
  fence,
  isOpen,
  allowHtmlPreview,
  children,
}: {
  code: string;
  fence: CodeFenceInfo;
  isOpen: boolean;
  allowHtmlPreview: boolean;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [preview, setPreview] = useState(false);
  const showHtmlToggle =
    INLINE_HTML_RENDER_ON &&
    allowHtmlPreview &&
    !isOpen &&
    fence.language === "html" &&
    code.length > 0 &&
    code.length <= HTML_RENDER_MAX_BYTES &&
    new TextEncoder().encode(code).byteLength <= HTML_RENDER_MAX_BYTES;
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopy = () => {
    void copyTextToClipboard(code)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch(() => {
        toastManager.add({
          type: "error",
          title: "Could not copy code",
          description: "Select and copy the code manually.",
        });
      });
  };
  const toggleWrap = () => setWrap((previous) => !previous);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div className="chat-markdown-codeblock" data-wrap={wrap ? "true" : "false"}>
      <div className="chat-markdown-codeblock__header">
        <CodeBlockHeaderTitle fence={fence} />
        <div className="chat-markdown-codeblock__actions">
          {showHtmlToggle && (
            <Button
              size="xs"
              variant="ghost"
              className="text-ui-xs"
              aria-pressed={preview}
              onClick={() => setPreview((current) => !current)}
            >
              {preview ? "Code" : "Preview"}
            </Button>
          )}
          <IconButton
            className="chat-markdown-codeblock__action"
            onClick={toggleWrap}
            title={wrap ? "Disable soft wrap" : "Enable soft wrap"}
            label={wrap ? "Disable soft wrap" : "Enable soft wrap"}
            aria-pressed={wrap}
            data-active={wrap ? "true" : "false"}
            size="icon-xs"
            variant="ghost"
          >
            <TextWrapIcon className="size-3" />
          </IconButton>
          {isOpen ? null : (
            <IconButton
              className="chat-markdown-codeblock__action"
              onClick={handleCopy}
              title={copied ? "Copied" : "Copy code"}
              label={copied ? "Copied" : "Copy code"}
              size="icon-xs"
              variant="ghost"
            >
              {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            </IconButton>
          )}
        </div>
      </div>
      <div className="chat-markdown-codeblock__body">
        {showHtmlToggle && preview ? (
          <HtmlRenderFrame
            document={{ title: "HTML preview", html: code, height: HTML_RENDER_DEFAULT_HEIGHT }}
          />
        ) : (
          children
        )}
      </div>
    </div>
  );
}

interface SuspenseShikiCodeBlockProps {
  language: string;
  code: string;
  themeName: DiffThemeName;
  isStreaming: boolean;
  sourceOffset: number;
}

// Each highlight costs roughly linearly in block length, so the cadence also stretches
// with size: small blocks stay at the base interval, a block at
// `STREAMING_CODE_HIGHLIGHT_SLOW_CHARS` is highlighted at most once per
// `STREAMING_CODE_HIGHLIGHT_MAX_INTERVAL_MS`, keeping per-second tokenization work bounded.
const STREAMING_CODE_HIGHLIGHT_INTERVAL_MS = 160;
const STREAMING_CODE_HIGHLIGHT_MAX_INTERVAL_MS = 1_000;
const STREAMING_CODE_HIGHLIGHT_BASE_CHARS = 8_000;
const STREAMING_CODE_HIGHLIGHT_SLOW_CHARS = 80_000;

export function streamingCodeHighlightIntervalMs(codeLength: number): number {
  if (codeLength <= STREAMING_CODE_HIGHLIGHT_BASE_CHARS) {
    return STREAMING_CODE_HIGHLIGHT_INTERVAL_MS;
  }
  const progress = Math.min(
    1,
    (codeLength - STREAMING_CODE_HIGHLIGHT_BASE_CHARS) /
      (STREAMING_CODE_HIGHLIGHT_SLOW_CHARS - STREAMING_CODE_HIGHLIGHT_BASE_CHARS),
  );
  return Math.round(
    STREAMING_CODE_HIGHLIGHT_INTERVAL_MS +
      progress * (STREAMING_CODE_HIGHLIGHT_MAX_INTERVAL_MS - STREAMING_CODE_HIGHLIGHT_INTERVAL_MS),
  );
}

function SuspenseShikiCodeBlock({
  language,
  code: liveCode,
  themeName,
  isStreaming,
  sourceOffset,
}: SuspenseShikiCodeBlockProps) {
  const throttledCode = useThrottledStreamingValue(
    liveCode,
    isStreaming,
    streamingCodeHighlightIntervalMs(liveCode.length),
  );
  const throttledCodeIsPrefix = liveCode.startsWith(throttledCode);
  const syntaxHighlighting = use(loadSyntaxHighlighting());
  return (
    <LoadedShikiCodeBlock
      syntaxHighlighting={syntaxHighlighting}
      language={language}
      code={throttledCodeIsPrefix ? throttledCode : liveCode}
      plainTail={throttledCodeIsPrefix ? liveCode.slice(throttledCode.length) : ""}
      themeName={themeName}
      isStreaming={isStreaming}
      sourceOffset={sourceOffset}
    />
  );
}

interface HighlightedCodeBlockProps extends SuspenseShikiCodeBlockProps {
  syntaxHighlighting: SyntaxHighlightingModule;
  plainTail: string;
}

function LoadedShikiCodeBlock({
  syntaxHighlighting,
  language,
  code,
  plainTail,
  themeName,
  isStreaming,
  sourceOffset,
}: HighlightedCodeBlockProps) {
  const cacheKey = syntaxHighlighting.createSyntaxHighlightCacheKey(code, language, themeName);
  const cachedHighlightedHtml = isStreaming
    ? null
    : syntaxHighlighting.getCachedSyntaxHighlightedHtml(cacheKey);
  const highlighter =
    cachedHighlightedHtml == null
      ? use(syntaxHighlighting.getSyntaxHighlighterPromise(language))
      : null;
  const highlightedHtml =
    cachedHighlightedHtml ??
    syntaxHighlighting.highlightCodeToHtmlWithFallback(highlighter!, code, language, themeName);
  const needsCaching = !isStreaming && cachedHighlightedHtml == null;

  useEffect(() => {
    if (needsCaching) {
      syntaxHighlighting.cacheSyntaxHighlightedHtml(cacheKey, highlightedHtml, code);
    }
  }, [cacheKey, code, highlightedHtml, needsCaching, syntaxHighlighting]);

  return (
    <FindAwareShikiHtml
      html={syntaxHighlighting.appendPlainTextToHighlightedHtml(highlightedHtml, plainTail)}
      highlightedHtml={highlightedHtml}
      plainTail={plainTail}
      sourceOffset={sourceOffset}
    />
  );
}

interface MarkdownRenderContextValue {
  isInsideLink: boolean;
  cwd: ChatMarkdownProps["cwd"];
  knownAbsoluteFilePaths: string[] | undefined;
  diffThemeName: DiffThemeName;
  isStreaming: boolean;
  isUserVariant: boolean;
  mentionReferences: ChatMarkdownProps["mentionReferences"];
  onImageExpand: ChatMarkdownProps["onImageExpand"];
  onOpenThread: ChatMarkdownProps["onOpenThread"];
  onTaskToggle: ChatMarkdownProps["onTaskToggle"];
  resolvedTheme: ReturnType<typeof useTheme>["resolvedTheme"];
  terminalContexts: ChatMarkdownProps["terminalContexts"];
  sourceText: string;
  sourceBase: number;
  parsedText: string;
  pluginContext: SynaraPluginAppContext | undefined;
  pluginDirectiveRegistry: PluginMessageDirectiveRegistry;
}

type MarkdownBaseRenderContextValue = Omit<
  MarkdownRenderContextValue,
  "isStreaming" | "sourceText" | "sourceBase" | "parsedText"
>;

function locateInSource(
  context: Pick<MarkdownRenderContextValue, "sourceText" | "sourceBase">,
  needle: string,
  fromOffset: number,
): number {
  const localOffset = context.sourceText.indexOf(needle, fromOffset - context.sourceBase);
  return localOffset < 0 ? fromOffset : localOffset + context.sourceBase;
}

const MarkdownRenderContext = createContext<MarkdownRenderContextValue | null>(null);

// Stable component types preserve code highlighting timers, copy state and image state.
const GITHUB_ALERTS: Record<GithubAlertKind, { title: string; icon: LucideIcon }> = {
  note: { title: "Note", icon: InfoIcon },
  tip: { title: "Tip", icon: LightbulbIcon },
  important: { title: "Important", icon: InfoIcon },
  warning: { title: "Warning", icon: TriangleAlertIcon },
  caution: { title: "Caution", icon: OctagonAlertIcon },
};

const MARKDOWN_COMPONENTS: Components = {
  blockquote: function MarkdownBlockquote({ node: _node, children, ...props }) {
    const kind = (props as { "data-github-alert"?: GithubAlertKind })["data-github-alert"];
    const alert = kind ? GITHUB_ALERTS[kind] : undefined;
    if (!alert) return <blockquote {...props}>{children}</blockquote>;
    const Icon = alert.icon;
    return (
      <blockquote {...props}>
        <p className="markdown-alert-title">
          <Icon aria-hidden className="size-[1.1em] shrink-0" />
          {alert.title}
        </p>
        {children}
      </blockquote>
    );
  },
  a: function MarkdownLink({ node: _node, href, children, ...props }) {
    const context = useContext(MarkdownRenderContext)!;
    const { isUserVariant, cwd, knownAbsoluteFilePaths, resolvedTheme, onOpenThread } = context;
    const linkedContext = useMemo(
      () => ({ ...context, onImageExpand: undefined, isInsideLink: true }),
      [context],
    );
    // Linked images belong to the link, not to the fullscreen gallery.
    const linkedChildren = (
      <MarkdownRenderContext.Provider value={linkedContext}>
        {children}
      </MarkdownRenderContext.Provider>
    );
    const linkActions = useContext(ChatLinkActionsContext);
    const restoredHref = href ? restoreLiteralDollarPlaceholders(href) : href;
    const threadHref = restoredHref?.startsWith("thread://")
      ? restoredHref.slice("thread://".length)
      : restoredHref?.startsWith("synara://thread/")
        ? decodeSynaraThreadLinkTarget(restoredHref.slice("synara://thread/".length))
        : null;
    if (threadHref && onOpenThread) {
      return (
        <button
          type="button"
          className="inline p-0 text-inherit underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground/70"
          onClick={() => onOpenThread(ThreadId.makeUnsafe(threadHref))}
        >
          {linkedChildren}
        </button>
      );
    }
    const isExternalHttp = isExternalHttpHref(restoredHref);
    if (isUserVariant && isExternalHttp) {
      // GFM autolinks a pasted URL before the chips plugin can see it; when the
      // link text is just the URL itself, render the composer's link chip so a
      // pasted link looks identical in the composer and in the sent bubble.
      // Authored `[label](url)` links keep the regular anchor treatment below.
      const plainText = nodeToPlainText(children);
      if (
        plainText === restoredHref ||
        restoredHref === `http://${plainText}` ||
        restoredHref === `https://${plainText}`
      ) {
        return <InlineLinkChip url={restoredHref} interactive />;
      }
    }
    const targetPath = isExternalHttp
      ? null
      : resolveChatFileChipTarget(restoredHref, cwd, knownAbsoluteFilePaths);
    if (!targetPath) {
      return (
        <a
          {...props}
          href={restoredHref}
          target="_blank"
          rel="noopener noreferrer"
          className={isExternalHttp ? MARKDOWN_EXTERNAL_LINK_CLASS_NAME : props.className}
          {...(isExternalHttp
            ? {
                // A plain click on a pull request or issue follows the user's setting (in
                // the app by default); cmd/ctrl-click keeps the default external open.
                onClick: (event: React.MouseEvent) => {
                  if (event.metaKey || event.ctrlKey) return;
                  const openGitHubItem = resolveGitHubItemClickOpener(restoredHref, linkActions);
                  if (!openGitHubItem) return;
                  event.preventDefault();
                  openGitHubItem(restoredHref);
                },
                onContextMenu: (event: React.MouseEvent) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void showLinkContextMenu({
                    url: restoredHref,
                    position: { x: event.clientX, y: event.clientY },
                    actions: linkActions,
                  });
                },
              }
            : {})}
        >
          {isExternalHttp ? (
            <LinkChipIcon url={restoredHref} className={MARKDOWN_EXTERNAL_LINK_ICON_CLASS_NAME} />
          ) : null}
          {linkedChildren}
        </a>
      );
    }

    return (
      <OpenableFileChip
        targetPath={targetPath}
        theme={resolvedTheme}
        label={linkedChildren}
        {...(restoredHref ? { href: restoredHref } : {})}
      />
    );
  },
  pre: function MarkdownPre({ node, children, ...props }) {
    const context = useContext(MarkdownRenderContext)!;
    const { parsedText, diffThemeName, isStreaming } = context;
    const codeBlock = extractCodeBlock(children);
    if (!codeBlock) {
      return <pre {...props}>{children}</pre>;
    }

    const rawFenceInfo = extractRawFenceInfo(codeBlock.className);
    const code = dedentCode(codeBlock.code);
    if (rawFenceInfo === PENDING_DISPLAY_MATH_LANGUAGE) {
      return <PendingDisplayMath tex={code} />;
    }
    const fence = parseCodeFenceInfo(rawFenceInfo);
    const blockStart = node?.position?.start?.offset ?? 0;
    const blockState = isStreaming
      ? classifyStreamingCodeBlock(parsedText, blockStart, node?.position?.end?.offset)
      : "settled";
    const sourceOffset = locateInSource(context, code, blockStart);
    const highlightedFallback = (
      <pre {...props}>
        <FindAwareCodeFallback code={code} sourceOffset={sourceOffset}>
          {children}
        </FindAwareCodeFallback>
      </pre>
    );

    const content = (
      <CodeHighlightErrorBoundary fallback={highlightedFallback}>
        <Suspense fallback={highlightedFallback}>
          <SuspenseShikiCodeBlock
            language={blockState === "awaiting-info-line" ? "text" : fence.language}
            code={code}
            themeName={diffThemeName}
            isStreaming={blockState !== "settled"}
            sourceOffset={sourceOffset}
          />
        </Suspense>
      </CodeHighlightErrorBoundary>
    );
    return (
      <MarkdownCodeBlock
        code={codeBlock.code}
        fence={fence}
        isOpen={blockState !== "settled"}
        allowHtmlPreview={!context.isUserVariant}
      >
        {fence.language === "mermaid" && blockState === "settled" ? (
          <MarkdownMermaidBlock source={codeBlock.code} theme={context.resolvedTheme}>
            {content}
          </MarkdownMermaidBlock>
        ) : (
          content
        )}
      </MarkdownCodeBlock>
    );
  },
  code: function MarkdownInlineCode({ node, className, children, ...props }) {
    const context = useContext(MarkdownRenderContext)!;
    const { knownAbsoluteFilePaths, cwd, resolvedTheme } = context;
    // Fenced blocks carry a `language-*` class and are rendered by `pre`;
    // only inline code (no class) that names a file becomes an openable
    // mention chip. Absolute local paths chip immediately. Relative names
    // chip only when that file actually exists in the chat workspace.
    if (!className) {
      const filePath = inlineCodeFilePath(nodeToPlainText(children));
      if (filePath) {
        const nodeStart = node?.position?.start?.offset ?? 0;
        const sourceOffset = locateInSource(context, filePath, nodeStart);
        const findLabelProps = {
          label: <FindAwareMarkdownText text={filePath} sourceOffset={sourceOffset} />,
        };
        const knownTarget = resolveChatFileChipTarget(filePath, undefined, knownAbsoluteFilePaths);
        if (knownTarget) {
          return (
            <OpenableFileChip targetPath={knownTarget} theme={resolvedTheme} {...findLabelProps} />
          );
        }
        if (resolveMarkdownFileLinkTarget(filePath, cwd) && cwd) {
          return (
            <VerifiedWorkspaceFileChip
              rawReference={filePath}
              cwd={cwd}
              theme={resolvedTheme}
              {...findLabelProps}
            />
          );
        }
      }
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  img: function MarkdownImage({ node: _node, src, alt: altProp, ...props }) {
    const { cwd, onImageExpand, isInsideLink } = useContext(MarkdownRenderContext)!;
    const alt = altProp ?? "";
    const restoredSrc = src ? restoreLiteralDollarPlaceholders(src) : "";
    if (isLocalImageMarkdownSrc(restoredSrc)) {
      return (
        <GeneratedMarkdownImage
          src={restoredSrc}
          alt={alt}
          cwd={cwd}
          onImageExpand={onImageExpand}
          isLinked={isInsideLink}
        />
      );
    }
    if (!onImageExpand || !restoredSrc) {
      return <img {...props} src={restoredSrc} alt={alt} loading="lazy" />;
    }
    const expandImage = (event: SyntheticEvent<HTMLImageElement>) => {
      event.preventDefault();
      onImageExpand(
        { images: [{ src: restoredSrc, name: alt || "Image" }], index: 0 },
        event.currentTarget,
      );
    };
    return (
      <img
        {...props}
        src={restoredSrc}
        alt={alt}
        loading="lazy"
        role="button"
        tabIndex={0}
        data-expandable-image=""
        onClick={expandImage}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") expandImage(event);
        }}
      />
    );
  },
  li: function MarkdownListItem({ node, children, ...props }) {
    // Task items carry their source line down to the checkbox via context.
    const isTaskItem =
      typeof props.className === "string" && props.className.includes("task-list-item");
    const sourceLine = node?.position?.start.line ?? null;
    if (!isTaskItem || sourceLine === null) {
      return <li {...props}>{children}</li>;
    }
    return (
      <li {...props}>
        <TaskItemSourceLineContext.Provider value={sourceLine}>
          {children}
        </TaskItemSourceLineContext.Provider>
      </li>
    );
  },
  input: function MarkdownInput({ node: _node, ...props }) {
    const { onTaskToggle } = useContext(MarkdownRenderContext)!;
    if (props.type === "checkbox") {
      return <MarkdownTaskCheckbox checked={props.checked === true} onTaskToggle={onTaskToggle} />;
    }
    return <input {...props} />;
  },
  // Custom elements emitted by the composer-chips remark plugin (user
  // variant only; they never appear in assistant markdown). `Components`
  // only models intrinsic tags, so these entries are typed on their own
  // and cast into the map.
  ...({
    [COMPOSER_CHIP_TAG_NAME]: function MarkdownComposerChip(props: {
      className?: string | undefined;
      [COMPOSER_CHIP_SEGMENT_ATTRIBUTE]?: string | undefined;
    }) {
      const { resolvedTheme, mentionReferences } = useContext(MarkdownRenderContext)!;
      return (
        <ComposerChipElement
          serializedSegment={props[COMPOSER_CHIP_SEGMENT_ATTRIBUTE]}
          theme={resolvedTheme}
          mentionReferences={mentionReferences ?? []}
        />
      );
    },
    [TERMINAL_CONTEXT_CHIP_TAG_NAME]: function MarkdownTerminalChip(props: {
      [TERMINAL_CONTEXT_CHIP_INDEX_ATTRIBUTE]?: string | undefined;
    }) {
      const { terminalContexts } = useContext(MarkdownRenderContext)!;
      const rawIndex = props[TERMINAL_CONTEXT_CHIP_INDEX_ATTRIBUTE];
      const index = rawIndex === undefined ? Number.NaN : Number.parseInt(rawIndex, 10);
      const context = Number.isInteger(index) ? terminalContexts?.[index] : undefined;
      if (!context) {
        return null;
      }
      const tooltipText =
        context.body.length > 0 ? `${context.header}\n${context.body}` : context.header;
      return <TerminalContextInlineChip label={context.header} tooltipText={tooltipText} />;
    },
    [CHAT_FIND_TEXT_TAG_NAME]: function MarkdownFindText(props: {
      children?: ReactNode;
      [CHAT_FIND_TEXT_START_ATTRIBUTE]?: string | undefined;
    }) {
      const rawSourceOffset = props[CHAT_FIND_TEXT_START_ATTRIBUTE];
      const sourceOffset =
        rawSourceOffset === undefined ? Number.NaN : Number.parseInt(rawSourceOffset, 10);
      const text = nodeToPlainText(props.children);
      if (!Number.isFinite(sourceOffset) || text.length === 0) {
        return <>{props.children}</>;
      }
      return <FindAwareMarkdownText text={text} sourceOffset={sourceOffset} />;
    },
    [PLUGIN_MESSAGE_DIRECTIVE_TAG_NAME]: function MarkdownPluginMessageDirective(props: {
      [PLUGIN_MESSAGE_DIRECTIVE_NAME_ATTRIBUTE]?: string | undefined;
      [PLUGIN_MESSAGE_DIRECTIVE_ATTRIBUTES_ATTRIBUTE]?: string | undefined;
      [PLUGIN_MESSAGE_DIRECTIVE_SOURCE_ATTRIBUTE]?: string | undefined;
    }) {
      const { pluginContext, pluginDirectiveRegistry } = useContext(MarkdownRenderContext)!;
      if (!pluginContext) return null;
      const parsed = readPluginMessageDirectiveElement(props);
      if (!parsed) return null;
      return (
        <PluginMessageDirectiveMount
          directive={{
            ...parsed,
            source: restoreLiteralDollarPlaceholders(parsed.source),
            attributes: Object.fromEntries(
              Object.entries(parsed.attributes).map(([key, value]) => [
                key,
                restoreLiteralDollarPlaceholders(value),
              ]),
            ),
          }}
          registry={pluginDirectiveRegistry}
          context={pluginContext}
        />
      );
    },
  } as unknown as Components),
};

function areOptionalStringArraysEqual(
  previous: readonly string[] | undefined,
  next: readonly string[] | undefined,
): boolean {
  if (previous === undefined || next === undefined) return previous === next;
  return previous.length === next.length && previous.every((value, index) => value === next[index]);
}

function singleMarkdownBlock(markdown: string): MarkdownBlock[] {
  return [{ start: 0, end: markdown.length, line: 0 }];
}

interface MarkdownBlockViewProps {
  text: string;
  origin: number;
  line: number;
  sourceText: string;
  parsedText: string;
  isStreaming: boolean;
  baseContext: MarkdownBaseRenderContextValue;
  remarkPlugins: MarkdownRemarkPlugins;
  rehypePlugins: MarkdownRehypePlugins;
}

const MarkdownBlockView = memo(function MarkdownBlockView({
  text,
  origin,
  line,
  sourceText,
  parsedText,
  isStreaming,
  baseContext,
  remarkPlugins,
  rehypePlugins,
}: MarkdownBlockViewProps) {
  const blockRemarkPlugins = useMemo<MarkdownRemarkPlugins>(
    () =>
      origin === 0
        ? [...remarkPlugins, remarkFindableText]
        : [
            ...remarkPlugins,
            [remarkMarkdownBlockOrigin, { offset: origin, line }],
            remarkFindableText,
          ],
    [line, origin, remarkPlugins],
  );
  const renderContext = useMemo<MarkdownRenderContextValue>(
    () => ({ ...baseContext, isStreaming, sourceText, sourceBase: origin, parsedText }),
    [baseContext, isStreaming, origin, parsedText, sourceText],
  );
  return (
    <MarkdownRenderContext.Provider value={renderContext}>
      <ParsedMarkdown
        text={text}
        remarkPlugins={blockRemarkPlugins}
        rehypePlugins={rehypePlugins}
        components={MARKDOWN_COMPONENTS}
      />
    </MarkdownRenderContext.Provider>
  );
});

function ChatMarkdown({
  text,
  cwd,
  wikiLinkRoot,
  isStreaming: isStreamingProp,
  revealKey,
  className: classNameProp,
  style,
  onImageExpand,
  findQuery: findQueryProp,
  findActiveRange: findActiveRangeProp,
  onTaskToggle,
  knownAbsoluteFilePaths: knownAbsoluteFilePathsProp,
  variant: variantProp,
  mentionReferences,
  terminalContexts,
  pluginContext,
  onOpenThread,
  parseHtml: parseHtmlProp,
}: ChatMarkdownProps) {
  // Defaults applied with ?? in the body, not in the destructuring: default
  // values in parameter destructuring make React Compiler 1.0.0 bail on the
  // whole component (BuildHIR AssignmentPattern), losing its auto-memoization.
  const isStreaming = isStreamingProp ?? false;
  const className = classNameProp ?? "text-chat leading-relaxed";
  const variant = variantProp ?? "assistant";
  const parseHtml = parseHtmlProp ?? false;
  const findQuery = findQueryProp ?? "";
  const findActiveRange = findActiveRangeProp ?? null;
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const isUserVariant = variant === "user";
  const extractedAbsoluteFilePaths = useMemo(() => extractAbsoluteFilesystemPaths(text), [text]);
  const mergedAbsoluteFilePaths = useMemo(() => {
    if (
      (knownAbsoluteFilePathsProp === undefined || knownAbsoluteFilePathsProp.length === 0) &&
      extractedAbsoluteFilePaths.length === 0
    ) {
      return undefined;
    }
    return [...new Set([...(knownAbsoluteFilePathsProp ?? []), ...extractedAbsoluteFilePaths])];
  }, [extractedAbsoluteFilePaths, knownAbsoluteFilePathsProp]);
  const knownAbsoluteFilePaths = useStableValue(
    mergedAbsoluteFilePaths,
    areOptionalStringArraysEqual,
  );
  const latestImageExpand = useStableCallback(
    (...args: Parameters<NonNullable<ChatMarkdownProps["onImageExpand"]>>) =>
      onImageExpand?.(...args),
  );
  const latestOpenThread = useStableCallback((threadId: ThreadId) => onOpenThread?.(threadId));
  const latestTaskToggle = useStableCallback((input: { sourceLine: number; checked: boolean }) =>
    onTaskToggle?.(input),
  );
  const imageExpandHandler = onImageExpand ? latestImageExpand : undefined;
  const openThreadHandler = onOpenThread ? latestOpenThread : undefined;
  const taskToggleHandler = onTaskToggle ? latestTaskToggle : undefined;
  // Reveal streamed text at a steady, adaptive cadence so tokens appear fluidly instead of
  // in the ~100ms network clumps that land in the store. No-ops (returns `text`) when not
  // streaming or under reduced motion. Governs cadence only; the deferred value below still
  // bounds the markdown re-parse cost.
  const { text: smoothedText, isRevealing } = useSmoothStreamedText(text, isStreaming, revealKey);
  const isLive = isStreaming || isRevealing;
  // The dollar rewrite exists to disambiguate math from currency; the user
  // variant has no math, so its text must stay byte-for-byte what was typed.
  // Table repair runs first so find offsets use the same normalized text.
  const repairStream = useMemo(() => createStreamingMarkdownRepair(), [revealKey]);
  const normalizedText = useMemo(
    () =>
      isUserVariant
        ? smoothedText
        : protectLiteralMarkdownDollars(
            repairMarkdownTableDelimiters(isLive ? repairStream(smoothedText) : smoothedText),
          ),
    [isLive, isUserVariant, smoothedText, repairStream],
  );
  // While streaming, let React deprioritize and coalesce the markdown re-parse so a
  // fast token stream (one flush per ~100ms) doesn't re-render the full ReactMarkdown
  // tree on every flush. The deferred value always converges to the latest text, and
  // completed messages render the exact current text immediately (no visual change).
  const deferredNormalizedText = useDeferredValue(normalizedText);
  const renderedText = isLive ? deferredNormalizedText : normalizedText;
  const sourceText = useMemo(
    () => (isUserVariant ? text : repairMarkdownTableDelimiters(text)),
    [isUserVariant, text],
  );
  const [hasStreamed, setHasStreamed] = useState(isLive);
  if (isLive && !hasStreamed) setHasStreamed(true);
  const splitsIntoBlocks = hasStreamed && !isUserVariant && !parseHtml;
  const blocks = useMemo(
    () =>
      splitsIntoBlocks ? splitMarkdownBlocks(renderedText) : singleMarkdownBlock(renderedText),
    [renderedText, splitsIntoBlocks],
  );
  const composerChipsRemarkPlugin = useMemo(
    () =>
      isUserVariant
        ? createComposerChipsRemarkPlugin(
            mentionReferences ?? [],
            (terminalContexts ?? []).map((context, index) => ({
              label: formatInlineTerminalContextLabel(context.header),
              index,
            })),
          )
        : null,
    [isUserVariant, mentionReferences, terminalContexts],
  );
  const pluginMessageDirectiveContributions = usePluginContributions("messageDirectives");
  const pluginDirectiveRegistry = useMemo(
    () => buildPluginMessageDirectiveRegistry(pluginMessageDirectiveContributions),
    [pluginMessageDirectiveContributions],
  );
  const pluginMessageDirectiveRemarkPlugin = useMemo(
    () =>
      !isUserVariant && pluginContext
        ? createPluginMessageDirectiveRemarkPlugin(pluginDirectiveRegistry)
        : null,
    [isUserVariant, pluginContext, pluginDirectiveRegistry],
  );
  const remarkPlugins = useMemo<MarkdownRemarkPlugins>(() => {
    if (composerChipsRemarkPlugin) {
      return [...USER_MARKDOWN_REMARK_PLUGINS, composerChipsRemarkPlugin];
    }
    const assistantPlugins: MarkdownRemarkPlugins = [
      ...MARKDOWN_REMARK_PLUGINS,
      [remarkWikiLinks, { root: wikiLinkRoot ?? cwd }],
    ];
    if (pluginMessageDirectiveRemarkPlugin) {
      assistantPlugins.push(pluginMessageDirectiveRemarkPlugin);
    }
    return assistantPlugins;
  }, [composerChipsRemarkPlugin, wikiLinkRoot, cwd, pluginMessageDirectiveRemarkPlugin]);
  const rehypePlugins = useMemo<MarkdownRehypePlugins>(() => {
    if (isUserVariant) {
      return USER_MARKDOWN_REHYPE_PLUGINS;
    }
    if (parseHtml) {
      // Raw HTML is only enabled for authored local-file previews. Sanitize
      // immediately after parsing so scripts, event handlers, and unsafe URL
      // schemes never reach React's renderer.
      return [rehypeRaw, [rehypeSanitize, AUTHORED_HTML_SCHEMA], ...MARKDOWN_REHYPE_PLUGINS];
    }
    return MARKDOWN_REHYPE_PLUGINS;
  }, [isUserVariant, parseHtml]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    applyActiveChatFindMatch(rootRef.current, findActiveRange);
  }, [findActiveRange, findQuery, renderedText]);
  useStreamingTextReveal(rootRef, isLive, renderedText);
  const baseContext = useMemo<MarkdownBaseRenderContextValue>(
    () => ({
      isInsideLink: false,
      cwd,
      knownAbsoluteFilePaths,
      diffThemeName,
      isUserVariant,
      mentionReferences,
      onImageExpand: imageExpandHandler,
      onOpenThread: openThreadHandler,
      onTaskToggle: taskToggleHandler,
      resolvedTheme,
      terminalContexts,
      pluginContext,
      pluginDirectiveRegistry,
    }),
    [
      cwd,
      knownAbsoluteFilePaths,
      diffThemeName,
      isUserVariant,
      mentionReferences,
      imageExpandHandler,
      openThreadHandler,
      taskToggleHandler,
      resolvedTheme,
      terminalContexts,
      pluginContext,
      pluginDirectiveRegistry,
    ],
  );
  const lastBlockIndex = blocks.length - 1;

  return (
    <div
      ref={rootRef}
      className={`chat-markdown ${isUserVariant ? "chat-markdown--user " : ""}w-full min-w-0 ${className} text-foreground`}
      style={style}
    >
      <ChatFindRenderProvider
        query={findQuery}
        sourceText={findQuery ? sourceText : ""}
        activeRange={findActiveRange}
      >
        {blocks.map((block, index) => (
          <Fragment key={block.start}>
            {index > 0 ? "\n" : null}
            <MarkdownBlockView
              text={renderedText.slice(block.start, block.end)}
              origin={block.start}
              line={block.line}
              sourceText={
                index === lastBlockIndex
                  ? sourceText.slice(block.start)
                  : sourceText.slice(block.start, block.end)
              }
              parsedText={index === lastBlockIndex && isLive ? renderedText : ""}
              isStreaming={index === lastBlockIndex && isLive}
              baseContext={baseContext}
              remarkPlugins={remarkPlugins}
              rehypePlugins={rehypePlugins}
            />
          </Fragment>
        ))}
      </ChatFindRenderProvider>
    </div>
  );
}

export default memo(ChatMarkdown);
