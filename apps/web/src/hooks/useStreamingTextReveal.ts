import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

import { useMediaQuery } from "./useMediaQuery";

export const STREAMING_REVEAL_FADE_MS = 200;
export const REVEAL_DELAY_PER_CHAR_MS = 2.5;
export const MAX_REVEAL_DELAY_MS = 600;
export const REVEAL_CHUNK_CHARS = 16;
export const FAST_INPUT_WINDOW_MS = 100;
export const FAST_INPUT_CHARS_PER_MS = 1.6;
const REVEAL_LEVELS = 8;
const HIDDEN_LEVEL = -1;
const HIGHLIGHT_NAME_PREFIX = "chat-stream-reveal";
const HIDDEN_TEXT_SELECTOR = ".katex-mathml";

interface RevealFragment {
  readonly start: number;
  readonly end: number;
  readonly startedAt: number;
}

interface PaintedRange {
  highlight: Highlight;
  readonly range: Range;
  readonly end: number;
  readonly startedAt: number;
}

export function supportsStreamingTextReveal(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight === "function" &&
    typeof CSSStyleSheet === "function"
  );
}

function revealLevelForAge(ageMs: number): number {
  if (ageMs < 0) return HIDDEN_LEVEL;
  return Math.min(
    REVEAL_LEVELS - 1,
    Math.floor((ageMs / STREAMING_REVEAL_FADE_MS) * REVEAL_LEVELS),
  );
}

function revealOpacityPercent(level: number): number {
  return level === HIDDEN_LEVEL ? 0 : Math.round(((level + 0.5) / REVEAL_LEVELS) * 100);
}

export function commonPrefixLength(previous: string, next: string): number {
  const limit = Math.min(previous.length, next.length);
  let index = 0;
  while (index < limit && previous.charCodeAt(index) === next.charCodeAt(index)) index += 1;
  return index;
}

export interface RevealArrival {
  readonly at: number;
  readonly chars: number;
}

export interface RevealSchedule {
  readonly fragments: RevealFragment[];
  readonly arrivals: RevealArrival[];
  readonly lastStartAt: number;
}

export function emptyRevealSchedule(): RevealSchedule {
  return { fragments: [], arrivals: [], lastStartAt: 0 };
}

export function nextRevealSchedule(
  schedule: RevealSchedule,
  previousText: string,
  nextText: string,
  now: number,
): RevealSchedule {
  return nextRevealScheduleForPrefix(
    schedule,
    commonPrefixLength(previousText, nextText),
    nextText.length,
    now,
  );
}

function nextRevealScheduleForPrefix(
  schedule: RevealSchedule,
  prefix: number,
  nextLength: number,
  now: number,
): RevealSchedule {
  const fragments = schedule.fragments.flatMap((fragment) =>
    fragment.start >= prefix ? [] : [{ ...fragment, end: Math.min(fragment.end, prefix) }],
  );
  const freshChars = nextLength - prefix;
  const arrivals = [
    ...schedule.arrivals.filter((arrival) => now - arrival.at < FAST_INPUT_WINDOW_MS),
    { at: now, chars: Math.max(0, freshChars) },
  ];
  const recentChars = arrivals.reduce((total, arrival) => total + arrival.chars, 0);
  if (freshChars <= 0 || recentChars / FAST_INPUT_WINDOW_MS > FAST_INPUT_CHARS_PER_MS) {
    return { fragments, arrivals, lastStartAt: schedule.lastStartAt };
  }
  let lastStartAt = now;
  for (let start = prefix; start < nextLength; start += REVEAL_CHUNK_CHARS) {
    const end = Math.min(nextLength, start + REVEAL_CHUNK_CHARS);
    lastStartAt = Math.min(
      now + MAX_REVEAL_DELAY_MS,
      now + (end - prefix) * REVEAL_DELAY_PER_CHAR_MS,
    );
    fragments.push({ start, end, startedAt: lastStartAt });
  }
  return { fragments, arrivals, lastStartAt };
}

class RevealHighlightRegistry {
  private sheet: CSSStyleSheet | null = null;
  private readonly highlights = new Map<string, Highlight>();
  private readonly colorIds = new Map<string, number>();

  highlightFor(color: string, level: number): Highlight {
    const key = `${color}|${level}`;
    const existing = this.highlights.get(key);
    if (existing) return existing;
    const colorId = this.colorIds.get(color) ?? this.colorIds.size;
    this.colorIds.set(color, colorId);
    const name = `${HIGHLIGHT_NAME_PREFIX}-${colorId}-${level}`;
    const highlight = new Highlight();
    CSS.highlights.set(name, highlight);
    const percent = revealOpacityPercent(level);
    this.styleSheet().insertRule(
      `::highlight(${name}) { color: color-mix(in srgb, ${color} ${percent}%, transparent); }`,
    );
    this.highlights.set(key, highlight);
    return highlight;
  }

  private styleSheet(): CSSStyleSheet {
    if (!this.sheet) {
      this.sheet = new CSSStyleSheet();
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, this.sheet];
    }
    return this.sheet;
  }
}

let sharedRegistry: RevealHighlightRegistry | null = null;

function revealRegistry(): RevealHighlightRegistry {
  sharedRegistry ??= new RevealHighlightRegistry();
  return sharedRegistry;
}

export function visibleTextNodes(root: Node): Text[] {
  const nodes: Text[] = [];
  if (root.nodeType === Node.TEXT_NODE) {
    return root.parentElement?.closest(HIDDEN_TEXT_SELECTOR) ? [] : [root as Text];
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(HIDDEN_TEXT_SELECTOR)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

function lastIndexAtOrBefore(sortedStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = sortedStarts.length - 1;
  let found = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (sortedStarts[middle]! <= offset) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

export class StreamingTextRevealController {
  private enabled = false;
  private text: number | null = null;
  private nodeTexts: string[] = [];
  private nodeIndexes = new WeakMap<Text, number>();
  private tailBlock: ChildNode | null = null;
  private tailNodeIndex = 0;
  private observer: MutationObserver | null = null;
  private mutations: MutationRecord[] = [];
  private nodes: Text[] = [];
  private nodeStarts: number[] = [];
  private schedule: RevealSchedule = emptyRevealSchedule();
  private painted = new Map<Text, Map<number, PaintedRange>>();
  private frame = 0;
  private root: HTMLElement | null = null;
  private colors = new WeakMap<Element, string>();

  observe(root: HTMLElement, enabled: boolean): void {
    const sameRoot = this.root === root;
    this.colors = new WeakMap();
    this.enabled = enabled;
    if (!enabled && this.schedule.fragments.length === 0) {
      this.clearPainted();
      this.releaseIndex();
      return;
    }
    const records = this.takeMutations();
    const hadText = this.text !== null;
    const prefix = this.updateIndex(root, sameRoot ? records : null);
    this.root = root;
    const length = this.nodes.length ? this.nodeStarts.at(-1)! + this.nodeTexts.at(-1)!.length : 0;
    if (enabled && hadText) {
      this.schedule = nextRevealScheduleForPrefix(this.schedule, prefix, length, performance.now());
    }
    this.text = enabled ? length : null;
    if (!sameRoot || !this.observer) {
      this.observer?.disconnect();
      this.observer = new MutationObserver((mutations) => this.mutations.push(...mutations));
      this.observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
    }
    this.paint(performance.now());
  }

  private takeMutations(): MutationRecord[] {
    const records = this.mutations;
    this.mutations = [];
    records.push(...(this.observer?.takeRecords() ?? []));
    return records;
  }

  private updateIndex(root: HTMLElement, records: MutationRecord[] | null): number {
    const tail = this.tailBlock;
    const inTail = (node: Node) => tail !== null && (node === tail || tail.contains(node));
    const textChangesOnly = records?.every(
      (record) => record.type === "characterData" && inTail(record.target),
    );
    if (textChangesOnly && records) {
      if (records.length === 0) return this.text ?? 0;
      const indexes = records.map((record) => this.nodeIndexes.get(record.target as Text));
      const changed = indexes.filter((index): index is number => index !== undefined);
      if (changed.length === 0) return this.text ?? 0;
      const first = Math.min(...changed);
      const start = this.nodeStarts[first]!;
      if (first === this.nodes.length - 1) {
        const previous = this.nodeTexts[first]!;
        const next = this.nodes[first]!.data;
        this.nodeTexts[first] = next;
        return start + commonPrefixLength(previous, next);
      }
      const previous = this.nodeTexts.slice(first).join("");
      for (const index of changed) this.nodeTexts[index] = this.nodes[index]!.data;
      const next = this.nodeTexts.slice(first).join("");
      this.indexOffsets(first, start);
      return start + commonPrefixLength(previous, next);
    }
    const followsTail = (node: Node) => {
      let block = node;
      while (block.parentNode && block.parentNode !== root) block = block.parentNode;
      return (
        block.parentNode === root &&
        tail !== null &&
        Boolean(tail.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
    };
    const appendedBlocksOnly =
      tail?.parentNode === root &&
      records?.every((record) =>
        record.type === "characterData"
          ? inTail(record.target) || followsTail(record.target)
          : record.type === "childList" &&
            record.target === root &&
            record.removedNodes.length === 0 &&
            record.nextSibling === null &&
            record.previousSibling !== null &&
            (record.previousSibling === tail ||
              Boolean(
                tail.compareDocumentPosition(record.previousSibling) &
                Node.DOCUMENT_POSITION_FOLLOWING,
              )),
      );
    const first = appendedBlocksOnly ? this.tailNodeIndex : 0;
    const start =
      this.nodeStarts[first] ??
      (this.nodeStarts.at(-1) ?? 0) + (this.nodeTexts.at(-1)?.length ?? 0);
    const previous = this.nodeTexts.slice(first).join("");
    let nextNodes: Text[];
    if (appendedBlocksOnly) {
      nextNodes = [];
      for (let block: ChildNode | null = tail; block; block = block.nextSibling) {
        nextNodes.push(...visibleTextNodes(block));
      }
    } else {
      nextNodes = visibleTextNodes(root);
      this.colors = new WeakMap();
      this.nodeIndexes = new WeakMap();
    }
    this.nodes.length = first;
    this.nodeTexts.length = first;
    this.nodeStarts.length = first;
    for (const node of nextNodes) {
      this.nodes.push(node);
      this.nodeTexts.push(node.data);
    }
    this.indexOffsets(first, start);
    this.tailBlock = root.lastChild;
    this.tailNodeIndex = this.nodes.length;
    for (let index = this.nodes.length - 1; index >= first; index -= 1) {
      const node = this.nodes[index]!;
      if (!this.tailBlock?.contains(node)) break;
      this.tailNodeIndex = index;
    }
    return start + commonPrefixLength(previous, this.nodeTexts.slice(first).join(""));
  }

  private indexOffsets(first: number, start: number): void {
    let offset = start;
    for (let index = first; index < this.nodes.length; index += 1) {
      this.nodeIndexes.set(this.nodes[index]!, index);
      this.nodeStarts[index] = offset;
      offset += this.nodeTexts[index]!.length;
    }
  }

  dispose(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.enabled = false;
    this.schedule = emptyRevealSchedule();
    this.clearPainted();
    this.releaseIndex();
  }

  private releaseIndex(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.text = null;
    this.nodes = [];
    this.nodeStarts = [];
    this.nodeTexts = [];
    this.nodeIndexes = new WeakMap();
    this.tailBlock = null;
    this.tailNodeIndex = 0;
    this.observer?.disconnect();
    this.observer = null;
    this.mutations = [];
    this.root = null;
    this.colors = new WeakMap();
    this.schedule = emptyRevealSchedule();
  }

  private readonly tick = (now: number) => {
    this.frame = 0;
    this.mutations.push(...(this.observer?.takeRecords() ?? []));
    if (this.root && this.mutations.length > 0) {
      this.observe(this.root, this.enabled);
    } else {
      this.paint(now);
    }
  };

  private clearPainted(): void {
    for (const ranges of this.painted.values()) {
      for (const { highlight, range } of ranges.values()) highlight.delete(range);
    }
    this.painted.clear();
  }

  private colorOf(element: Element): string {
    const cached = this.colors.get(element);
    if (cached) return cached;
    const color = getComputedStyle(element).color;
    this.colors.set(element, color);
    return color;
  }

  private paint(now: number): void {
    const fragments = this.schedule.fragments.filter(
      (fragment) => now - fragment.startedAt < STREAMING_REVEAL_FADE_MS,
    );
    this.schedule = { ...this.schedule, fragments };
    const root = this.root;
    if (fragments.length === 0 || !root) {
      this.clearPainted();
      if (!this.enabled) this.releaseIndex();
      return;
    }
    const nextPainted = new Map<Text, Map<number, PaintedRange>>();
    const firstStart = Math.min(...fragments.map((fragment) => fragment.start));
    const registry = revealRegistry();
    for (
      let index = lastIndexAtOrBefore(this.nodeStarts, firstStart);
      index < this.nodes.length;
      index += 1
    ) {
      const node = this.nodes[index]!;
      const nodeStart = this.nodeStarts[index]!;
      const nodeEnd = nodeStart + node.data.length;
      if (nodeEnd > firstStart && node.parentElement) {
        for (const fragment of fragments) {
          const from = Math.max(fragment.start, nodeStart);
          const to = Math.min(fragment.end, nodeEnd);
          if (from >= to) continue;
          const start = from - nodeStart;
          const end = to - nodeStart;
          const previous = this.painted.get(node)?.get(start);
          const reusable = previous?.end === end && previous.startedAt === fragment.startedAt;
          const range = reusable ? previous.range : new Range();
          if (range.startContainer !== node || range.startOffset !== start)
            range.setStart(node, start);
          if (range.endContainer !== node || range.endOffset !== end) range.setEnd(node, end);
          const highlight = registry.highlightFor(
            this.colorOf(node.parentElement),
            revealLevelForAge(now - fragment.startedAt),
          );
          const painted = reusable
            ? previous
            : { highlight, range, end, startedAt: fragment.startedAt };
          if (!reusable || painted.highlight !== highlight) {
            if (reusable) painted.highlight.delete(range);
            highlight.add(range);
            painted.highlight = highlight;
          }
          if (reusable) this.painted.get(node)!.delete(start);
          let nodeRanges = nextPainted.get(node);
          if (!nodeRanges) {
            nodeRanges = new Map();
            nextPainted.set(node, nodeRanges);
          }
          nodeRanges.set(start, painted);
        }
      }
    }
    this.clearPainted();
    this.painted = nextPainted;
    if (!this.frame) this.frame = requestAnimationFrame(this.tick);
  }
}

export function useStreamingTextReveal(
  rootRef: RefObject<HTMLElement | null>,
  isLive: boolean,
  revision: string,
): void {
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const controllerRef = useRef<StreamingTextRevealController | null>(null);
  const enabled = isLive && !reduceMotion && supportsStreamingTextReveal();

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (reduceMotion) {
      controllerRef.current?.dispose();
      controllerRef.current = null;
      return;
    }
    if (!root || (!enabled && controllerRef.current === null)) return;
    controllerRef.current ??= new StreamingTextRevealController();
    controllerRef.current.observe(root, enabled);
  }, [enabled, reduceMotion, revision, rootRef]);

  useEffect(
    () => () => {
      controllerRef.current?.dispose();
    },
    [],
  );
}
