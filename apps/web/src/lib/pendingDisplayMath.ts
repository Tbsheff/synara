import katex from "katex";

const TRAILING_LINE_BREAK_REGEX = /\\\\$/;
const TRAILING_PARTIAL_COMMAND_REGEX = /\\[a-zA-Z]*$/;
const TRAILING_PARTIAL_ENVIRONMENT_REGEX = /\\(?:begin|end)(?:\{[^}]*)?$/;
const TRAILING_SCRIPT_MARKER_REGEX = /[_^]$/;
const COMMAND_REGEX = /^\\(?:[a-zA-Z]+|.)/;
const ENVIRONMENT_NAME_REGEX = /^\{([^}]*)\}/;

const KATEX_DISPLAY_OPTIONS = {
  displayMode: true,
  output: "htmlAndMathml",
  strict: false,
  throwOnError: true,
} as const;

function tryRenderDisplayMath(source: string): string | null {
  try {
    return katex.renderToString(source, KATEX_DISPLAY_OPTIONS);
  } catch {
    return null;
  }
}

type OpenGroup =
  | { readonly kind: "brace" }
  | { readonly kind: "left" }
  | { readonly kind: "environment"; readonly name: string };

function popIfTop(stack: OpenGroup[], matches: (group: OpenGroup) => boolean) {
  const top = stack.at(-1);
  if (top !== undefined && matches(top)) stack.pop();
}

function openGroups(source: string): OpenGroup[] {
  const stack: OpenGroup[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "{") stack.push({ kind: "brace" });
    if (char === "}") popIfTop(stack, (group) => group.kind === "brace");
    if (char !== "\\") {
      index += 1;
      continue;
    }
    const command = COMMAND_REGEX.exec(source.slice(index))?.[0] ?? "\\";
    index += command.length;
    if (command === "\\left") stack.push({ kind: "left" });
    if (command === "\\right") popIfTop(stack, (group) => group.kind === "left");
    if (command !== "\\begin" && command !== "\\end") continue;
    const environment = ENVIRONMENT_NAME_REGEX.exec(source.slice(index));
    if (!environment) continue;
    index += environment[0].length;
    const name = environment[1] ?? "";
    if (command === "\\begin") stack.push({ kind: "environment", name });
    else popIfTop(stack, (group) => group.kind === "environment" && group.name === name);
  }
  return stack;
}

function closingFor(group: OpenGroup): string {
  if (group.kind === "brace") return "}";
  if (group.kind === "left") return "\\right.";
  return `\n\\end{${group.name}}`;
}

function dropIncompleteTail(source: string): string {
  let current = source.trimEnd();
  for (;;) {
    const next = current
      .replace(TRAILING_LINE_BREAK_REGEX, "")
      .replace(TRAILING_PARTIAL_ENVIRONMENT_REGEX, "")
      .replace(TRAILING_PARTIAL_COMMAND_REGEX, "")
      .replace(TRAILING_SCRIPT_MARKER_REGEX, "")
      .trimEnd();
    if (next === current) return current;
    current = next;
  }
}

export function closePartialTex(source: string): string {
  const trimmed = dropIncompleteTail(source);
  const closers = openGroups(trimmed).toReversed().map(closingFor).join("");
  return `${trimmed}${closers}`;
}

function withoutLastLine(source: string): string | null {
  const trimmed = source.trimEnd();
  const lastBreak = trimmed.lastIndexOf("\n");
  return lastBreak === -1 ? null : trimmed.slice(0, lastBreak);
}

export function renderPendingDisplayMath(source: string): string | null {
  if (source.trim().length === 0) return null;
  const completeLines = withoutLastLine(source);
  const candidates = [
    source,
    closePartialTex(source),
    ...(completeLines === null ? [] : [closePartialTex(completeLines)]),
  ];
  for (const candidate of candidates) {
    if (candidate.trim().length === 0) continue;
    const html = tryRenderDisplayMath(candidate);
    if (html !== null) return html;
  }
  return null;
}
