import type { SynaraPluginAppContext } from "@synara/plugin-sdk/app";
import { memo, type ComponentType } from "react";

import type { ActivePluginContribution } from "./frontendRuntime";
import { PluginContributionErrorBoundary } from "./runtime";

const DIRECTIVE_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ATTRIBUTE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const MAX_DIRECTIVE_SOURCE_LENGTH = 16_384;
const MAX_DIRECTIVE_ATTRIBUTES = 32;

export const PLUGIN_MESSAGE_DIRECTIVE_TAG_NAME = "synara-plugin-message-directive";
export const PLUGIN_MESSAGE_DIRECTIVE_NAME_ATTRIBUTE = "data-plugin-directive-name";
export const PLUGIN_MESSAGE_DIRECTIVE_ATTRIBUTES_ATTRIBUTE = "data-plugin-directive-attributes";
export const PLUGIN_MESSAGE_DIRECTIVE_SOURCE_ATTRIBUTE = "data-plugin-directive-source";

export interface ParsedPluginMessageDirective {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly source: string;
}

type ActivePluginMessageDirective = ActivePluginContribution<"messageDirectives">;
export type PluginMessageDirectiveRegistry = ReadonlyMap<
  string,
  ActivePluginMessageDirective | null
>;

function readJsonString(source: string, start: number): { value: string; end: number } | null {
  if (source[start] !== '"') return null;
  let cursor = start + 1;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === '"') {
      const raw = source.slice(start, cursor + 1);
      try {
        const value: unknown = JSON.parse(raw);
        return typeof value === "string" ? { value, end: cursor + 1 } : null;
      } catch {
        return null;
      }
    }
    cursor += 1;
  }
  return null;
}

export function parsePluginMessageDirective(source: string): ParsedPluginMessageDirective | null {
  if (source.length === 0 || source.length > MAX_DIRECTIVE_SOURCE_LENGTH) return null;
  if (!source.startsWith("::")) return null;
  const openBrace = source.indexOf("{", 2);
  if (openBrace < 3 || source.at(-1) !== "}") return null;
  const name = source.slice(2, openBrace);
  if (!DIRECTIVE_NAME_PATTERN.test(name)) return null;

  const attributes: Record<string, string> = {};
  let cursor = openBrace + 1;
  const end = source.length - 1;
  while (cursor < end) {
    while (cursor < end && /\s/.test(source[cursor] ?? "")) cursor += 1;
    if (cursor === end) break;

    const nameStart = cursor;
    while (cursor < end && /[A-Za-z0-9_.:-]/.test(source[cursor] ?? "")) cursor += 1;
    const attributeName = source.slice(nameStart, cursor);
    if (!ATTRIBUTE_NAME_PATTERN.test(attributeName) || Object.hasOwn(attributes, attributeName)) {
      return null;
    }
    if (source[cursor] !== "=") return null;
    cursor += 1;
    const parsedValue = readJsonString(source, cursor);
    if (!parsedValue) return null;
    attributes[attributeName] = parsedValue.value;
    cursor = parsedValue.end;
    if (Object.keys(attributes).length > MAX_DIRECTIVE_ATTRIBUTES) return null;
    if (cursor < end && !/\s/.test(source[cursor] ?? "")) return null;
  }

  return { name, attributes, source };
}

export function buildPluginMessageDirectiveRegistry(
  contributions: readonly ActivePluginMessageDirective[],
): PluginMessageDirectiveRegistry {
  const registry = new Map<string, ActivePluginMessageDirective | null>();
  for (const contribution of contributions) {
    registry.set(contribution.id, registry.has(contribution.id) ? null : contribution);
  }
  return registry;
}

export const PluginMessageDirectiveMount = memo(function PluginMessageDirectiveMount(props: {
  readonly directive: ParsedPluginMessageDirective;
  readonly registry: PluginMessageDirectiveRegistry;
  readonly context: SynaraPluginAppContext;
}) {
  const contribution = props.registry.get(props.directive.name);
  if (!contribution) return <>{props.directive.source}</>;
  const Component = contribution.component;
  return (
    <PluginContributionErrorBoundary
      plugin={contribution.plugin}
      contributionId={contribution.id}
      fallback={props.directive.source}
    >
      <Component
        context={props.context}
        plugin={contribution.plugin}
        attributes={props.directive.attributes}
        source={props.directive.source}
      />
    </PluginContributionErrorBoundary>
  );
});

type MarkdownNode = {
  type?: string;
  value?: string;
  children?: MarkdownNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, string>;
  };
};

function transformDirectiveParagraphs(
  node: MarkdownNode,
  registry: PluginMessageDirectiveRegistry,
): void {
  for (const child of node.children ?? []) transformDirectiveParagraphs(child, registry);
  if (node.type !== "paragraph" || node.children?.length !== 1) return;
  const text = node.children[0];
  if (text?.type !== "text" || typeof text.value !== "string") return;
  const directive = parsePluginMessageDirective(text.value);
  if (!directive || !registry.get(directive.name)) return;
  node.children = [];
  node.data = {
    hName: PLUGIN_MESSAGE_DIRECTIVE_TAG_NAME,
    hProperties: {
      [PLUGIN_MESSAGE_DIRECTIVE_NAME_ATTRIBUTE]: directive.name,
      [PLUGIN_MESSAGE_DIRECTIVE_ATTRIBUTES_ATTRIBUTE]: JSON.stringify(directive.attributes),
      [PLUGIN_MESSAGE_DIRECTIVE_SOURCE_ATTRIBUTE]: directive.source,
    },
  };
}

export function createPluginMessageDirectiveRemarkPlugin(
  registry: PluginMessageDirectiveRegistry,
) {
  return () => (tree: MarkdownNode): void => transformDirectiveParagraphs(tree, registry);
}

export function readPluginMessageDirectiveElement(props: {
  readonly [PLUGIN_MESSAGE_DIRECTIVE_NAME_ATTRIBUTE]?: string;
  readonly [PLUGIN_MESSAGE_DIRECTIVE_ATTRIBUTES_ATTRIBUTE]?: string;
  readonly [PLUGIN_MESSAGE_DIRECTIVE_SOURCE_ATTRIBUTE]?: string;
}): ParsedPluginMessageDirective | null {
  const name = props[PLUGIN_MESSAGE_DIRECTIVE_NAME_ATTRIBUTE];
  const source = props[PLUGIN_MESSAGE_DIRECTIVE_SOURCE_ATTRIBUTE];
  const serializedAttributes = props[PLUGIN_MESSAGE_DIRECTIVE_ATTRIBUTES_ATTRIBUTE];
  if (!name || !source || serializedAttributes === undefined) return null;
  try {
    const attributes: unknown = JSON.parse(serializedAttributes);
    if (typeof attributes !== "object" || attributes === null || Array.isArray(attributes)) {
      return null;
    }
    if (
      Object.entries(attributes).some(
        ([key, value]) => !ATTRIBUTE_NAME_PATTERN.test(key) || typeof value !== "string",
      )
    ) {
      return null;
    }
    return { name, source, attributes: attributes as Record<string, string> };
  } catch {
    return null;
  }
}

export type PluginMessageDirectiveElementComponent = ComponentType<{
  readonly [PLUGIN_MESSAGE_DIRECTIVE_NAME_ATTRIBUTE]?: string;
  readonly [PLUGIN_MESSAGE_DIRECTIVE_ATTRIBUTES_ATTRIBUTE]?: string;
  readonly [PLUGIN_MESSAGE_DIRECTIVE_SOURCE_ATTRIBUTE]?: string;
}>;
