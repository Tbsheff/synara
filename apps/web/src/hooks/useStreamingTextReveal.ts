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
  readonly highlight: Highlight;
  readonly range: Range;
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
  const prefix = commonPrefixLength(previousText, nextText);
  const fragments = schedule.fragments.flatMap((fragment) =>
    fragment.start >= prefix ? [] : [{ ...fragment, end: Math.min(fragment.end, prefix) }],
  );
  const freshChars = nextText.length - prefix;
  const arrivals = [
    ...schedule.arrivals.filter((arrival) => now - arrival.at < FAST_INPUT_WINDOW_MS),
    { at: now, chars: Math.max(0, freshChars) },
  ];
  const recentChars = arrivals.reduce((total, arrival) => total + arrival.chars, 0);
  if (freshChars <= 0 || recentChars / FAST_INPUT_WINDOW_MS > FAST_INPUT_CHARS_PER_MS) {
    return { fragments, arrivals, lastStartAt: schedule.lastStartAt };
  }
  let lastStartAt = now;
  for (let start = prefix; start < nextText.length; start += REVEAL_CHUNK_CHARS) {
    const end = Math.min(nextText.length, start + REVEAL_CHUNK_CHARS);
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

export function visibleTextNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = [];
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

class StreamingTextRevealController {
  private text: string | null = null;
  private nodes: Text[] = [];
  private nodeStarts: number[] = [];
  private schedule: RevealSchedule = emptyRevealSchedule();
  private painted: PaintedRange[] = [];
  private frame = 0;
  private root: HTMLElement | null = null;
  private colors = new WeakMap<Element, string>();

  observe(root: HTMLElement, enabled: boolean): void {
    this.root = root;
    this.colors = new WeakMap();
    if (!enabled) {
      this.text = null;
      return;
    }
    this.nodes = visibleTextNodes(root);
    let offset = 0;
    this.nodeStarts = this.nodes.map((node) => {
      const start = offset;
      offset += node.data.length;
      return start;
    });
    const nextText = this.nodes.map((node) => node.data).join("");
    if (this.text !== null) {
      this.schedule = nextRevealSchedule(this.schedule, this.text, nextText, performance.now());
    }
    this.text = nextText;
    this.paint(performance.now());
  }

  dispose(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.schedule = emptyRevealSchedule();
    this.clearPainted();
  }

  private readonly tick = (now: number) => {
    this.frame = 0;
    this.paint(now);
  };

  private clearPainted(): void {
    for (const { highlight, range } of this.painted) highlight.delete(range);
    this.painted = [];
  }

  private colorOf(element: Element): string {
    const cached = this.colors.get(element);
    if (cached) return cached;
    const color = getComputedStyle(element).color;
    this.colors.set(element, color);
    return color;
  }

  private paint(now: number): void {
    this.clearPainted();
    const fragments = this.schedule.fragments.filter(
      (fragment) => now - fragment.startedAt < STREAMING_REVEAL_FADE_MS,
    );
    this.schedule = { ...this.schedule, fragments };
    const root = this.root;
    if (fragments.length === 0 || !root) return;
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
          const range = new Range();
          range.setStart(node, from - nodeStart);
          range.setEnd(node, to - nodeStart);
          const highlight = registry.highlightFor(
            this.colorOf(node.parentElement),
            revealLevelForAge(now - fragment.startedAt),
          );
          highlight.add(range);
          this.painted.push({ highlight, range });
        }
      }
    }
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
    if (!root || (!enabled && controllerRef.current === null)) return;
    controllerRef.current ??= new StreamingTextRevealController();
    controllerRef.current.observe(root, enabled);
  }, [enabled, revision, rootRef]);

  useEffect(
    () => () => {
      controllerRef.current?.dispose();
    },
    [],
  );
}
