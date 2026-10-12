import type { Root, RootContent, Text } from "mdast";
import { decodeString } from "micromark-util-decode-string";

type Point = NonNullable<Text["position"]>["start"];

function advance(start: Point, source: string): Point {
  const lines = source.split("\n");
  return {
    line: start.line + lines.length - 1,
    column: lines.length === 1 ? start.column + source.length : lines.at(-1)!.length + 1,
    offset: (start.offset ?? 0) + source.length,
  };
}

function splitMath(node: Text, source: string, blocked: Uint8Array): RootContent[] | null {
  const start = node.position?.start;
  const end = node.position?.end.offset;
  if (start?.offset === undefined || end === undefined) return null;
  const raw = source.slice(start.offset, end);
  if (decodeString(raw) !== node.value) return null;
  const escapedOffsets = new Uint8Array(raw.length);
  const nextBlocked = new Int32Array(raw.length + 1);
  let slashRun = 0;
  for (let index = 0; index < raw.length; index++) {
    escapedOffsets[index] = slashRun % 2;
    slashRun = raw[index] === "\\" ? slashRun + 1 : 0;
  }
  nextBlocked[raw.length] = raw.length;
  for (let index = raw.length - 1; index >= 0; index--)
    nextBlocked[index] = blocked[index] ? index : nextBlocked[index + 1]!;
  const closers: Record<"(" | "[", number[]> = { "(": [], "[": [] };
  const closerIndexes = { "(": 0, "[": 0 };
  for (let index = 0; index < raw.length - 1; index++) {
    if (raw[index] !== "\\" || escapedOffsets[index] || blocked[index]) continue;
    if (raw[index + 1] === ")") closers["("].push(index);
    if (raw[index + 1] === "]") closers["["].push(index);
  }
  const parts: RootContent[] = [];
  let cursor = 0;
  let point = start;
  const appendText = (text: string) => {
    if (!text) return;
    const end = advance(point, text);
    parts.push({ type: "text", value: decodeString(text), position: { start: point, end } });
    point = end;
  };
  for (let index = 0; index < raw.length - 1; index++) {
    if (raw[index] !== "\\" || escapedOffsets[index] || blocked[index]) continue;
    const delimiter = raw[index + 1];
    if (delimiter !== "(" && delimiter !== "[") continue;
    if (
      delimiter === "[" &&
      (raw.startsWith("\\[", index + 2) || raw.slice(Math.max(0, index - 2), index) === "\\[")
    )
      continue;
    const candidates = closers[delimiter];
    while ((candidates[closerIndexes[delimiter]] ?? Infinity) < index + 2)
      closerIndexes[delimiter]++;
    const close = candidates[closerIndexes[delimiter]];
    if (close === undefined || nextBlocked[index]! < close + 2) continue;
    const value = raw.slice(index + 2, close);
    if (!value.trim()) continue;
    appendText(raw.slice(cursor, index));
    const end = advance(point, raw.slice(index, close + 2));
    parts.push({
      type: delimiter === "(" ? "inlineMath" : "math",
      value,
      data: {
        hName: "code",
        hProperties: {
          className: ["language-math", delimiter === "(" ? "math-inline" : "math-display"],
        },
        hChildren: [{ type: "text", value }],
      },
      position: { start: point, end },
    });
    point = end;
    cursor = close + 2;
    index = cursor - 1;
  }
  if (!parts.length) return null;
  appendText(raw.slice(cursor));
  return parts;
}

const PROTECTED_NODE_TYPES = new Set([
  "link",
  "linkReference",
  "image",
  "imageReference",
  "inlineCode",
  "html",
  "code",
]);

function hasProtectedContent(node: RootContent): boolean {
  if (PROTECTED_NODE_TYPES.has(node.type)) return true;
  return "children" in node && (node.children as RootContent[]).some(hasProtectedContent);
}

function textSlice(node: Text, from: number, to: number, source: string): Text | null {
  if (from >= to || !node.position) return null;
  const start = advance(node.position.start, source.slice(node.position.start.offset, from));
  const raw = source.slice(from, to);
  return { type: "text", value: decodeString(raw), position: { start, end: advance(start, raw) } };
}

function rewriteMathChildren(parent: { children: RootContent[] }, source: string): void {
  const first = parent.children[0]?.position?.start;
  const last = parent.children.at(-1)?.position?.end;
  if (
    !first ||
    first.offset === undefined ||
    !last ||
    last.offset === undefined ||
    !parent.children.some((child) => child.type === "text")
  )
    return;
  const raw = source.slice(first.offset, last.offset);
  const blocked = new Uint8Array(raw.length);
  const pending = [...parent.children];
  while (pending.length) {
    const child = pending.pop()!;
    if (PROTECTED_NODE_TYPES.has(child.type)) {
      const start = child.position?.start.offset;
      const end = child.position?.end.offset;
      if (start !== undefined && end !== undefined)
        blocked.fill(1, start - first.offset, end - first.offset);
    } else if ("children" in child) pending.push(...(child.children as RootContent[]));
  }
  const parts = splitMath(
    { type: "text", value: decodeString(raw), position: { start: first, end: last } },
    source,
    blocked,
  );
  for (const math of (parts ?? []).toReversed()) {
    if (math.type !== "math" && math.type !== "inlineMath") continue;
    const start = math.position!.start.offset!;
    const end = math.position!.end.offset!;
    const startIndex = parent.children.findIndex(
      (child) =>
        child.type === "text" &&
        child.position?.start.offset !== undefined &&
        child.position.end.offset !== undefined &&
        child.position.start.offset <= start &&
        child.position.end.offset > start,
    );
    const endIndex = parent.children.findIndex(
      (child) =>
        child.type === "text" &&
        child.position?.start.offset !== undefined &&
        child.position.end.offset !== undefined &&
        child.position.start.offset < end &&
        child.position.end.offset >= end,
    );
    if (
      startIndex < 0 ||
      endIndex < startIndex ||
      parent.children.slice(startIndex, endIndex + 1).some(hasProtectedContent)
    )
      continue;
    const firstNode = parent.children[startIndex] as Text;
    const lastNode = parent.children[endIndex] as Text;
    const before = textSlice(firstNode, firstNode.position!.start.offset!, start, source);
    const after = textSlice(lastNode, end, lastNode.position!.end.offset!, source);
    parent.children.splice(
      startIndex,
      endIndex - startIndex + 1,
      ...(before ? [before] : []),
      math,
      ...(after ? [after] : []),
    );
  }
}

export function remarkBackslashMath() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    if (!source.includes("\\(") && !source.includes("\\[")) return;
    const parents: { children: RootContent[] }[] = [tree];
    while (parents.length) {
      const parent = parents.pop()!;
      rewriteMathChildren(parent, source);
      for (const node of parent.children) {
        if ("children" in node && !PROTECTED_NODE_TYPES.has(node.type))
          parents.push(node as { children: RootContent[] });
      }
    }
  };
}
