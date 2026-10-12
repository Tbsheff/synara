import type { CSSProperties } from "react";

export interface ShikiHtmlLine {
  readonly attributes: Readonly<Record<string, string>>;
  readonly html: string;
}

export interface ParsedShikiHtml {
  readonly preAttributes: Readonly<Record<string, string>>;
  readonly codeAttributes: Readonly<Record<string, string>>;
  readonly lines: readonly ShikiHtmlLine[];
}

const SHIKI_DOCUMENT_PATTERN = /^<pre(\s[^>]*)?><code(\s[^>]*)?>([\s\S]*)<\/code><\/pre>\s*$/;
const SHIKI_LINE_PATTERN = /^<span(\s[^>]*)?>([\s\S]*)<\/span>$/;
const HTML_ATTRIBUTE_PATTERN = /([^\s="'>/]+)="([^"]*)"/g;
const HTML_ENTITY_PATTERN = /&(amp|lt|gt|quot|#39|#x27);/g;
const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  "#x27": "'",
};
const REACT_ATTRIBUTE_NAMES: Readonly<Record<string, string>> = {
  class: "className",
  tabindex: "tabIndex",
};

function decodeAttributeValue(value: string): string {
  return value.replace(
    HTML_ENTITY_PATTERN,
    (_match, entity: string) => HTML_ENTITIES[entity] ?? "",
  );
}

function parseAttributes(source: string | undefined): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of (source ?? "").matchAll(HTML_ATTRIBUTE_PATTERN)) {
    attributes[match[1]!.toLowerCase()] = decodeAttributeValue(match[2]!);
  }
  return attributes;
}

export function parseShikiHtml(html: string): ParsedShikiHtml | null {
  const document = SHIKI_DOCUMENT_PATTERN.exec(html);
  if (!document) return null;
  const body = document[3] ?? "";
  const lines: ShikiHtmlLine[] = [];
  for (const rawLine of body.length === 0 ? [] : body.split("\n")) {
    const line = SHIKI_LINE_PATTERN.exec(rawLine);
    if (!line || line[2]!.includes("\n")) return null;
    lines.push({ attributes: parseAttributes(line[1]), html: line[2]! });
  }
  return {
    preAttributes: parseAttributes(document[1]),
    codeAttributes: parseAttributes(document[2]),
    lines,
  };
}

function cssPropertyName(name: string): string {
  return name.startsWith("--")
    ? name
    : name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function parseInlineStyle(style: string): CSSProperties {
  const properties: Record<string, string> = {};
  for (const declaration of style.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator <= 0) continue;
    const name = declaration.slice(0, separator).trim();
    const value = declaration.slice(separator + 1).trim();
    if (name && value) properties[cssPropertyName(name)] = value;
  }
  return properties as CSSProperties;
}

export function htmlAttributesToReactProps(
  attributes: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "style") props.style = parseInlineStyle(value);
    else props[REACT_ATTRIBUTE_NAMES[name] ?? name] = value;
  }
  return props;
}

function escapeHtmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function appendPlainTextToHighlightedHtml(html: string, plainText: string): string {
  if (plainText.length === 0) return html;
  const insertAt = html.lastIndexOf("</code>");
  if (insertAt === -1) return html;
  return `${html.slice(0, insertAt)}${escapeHtmlText(plainText)}${html.slice(insertAt)}`;
}
