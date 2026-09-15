import type { ComponentType } from "react";
import { describe, expect, it } from "vitest";

import type { PluginMessageDirectiveProps } from "@synara/plugin-sdk/app";

import {
  buildPluginMessageDirectiveRegistry,
  createPluginMessageDirectiveRemarkPlugin,
  parsePluginMessageDirective,
  PLUGIN_MESSAGE_DIRECTIVE_TAG_NAME,
} from "./PluginMessageDirective";

describe("parsePluginMessageDirective", () => {
  it("parses a lower-kebab leaf directive without treating attributes as DOM props", () => {
    expect(
      parsePluginMessageDirective('::review-card{file="demo.html" onClick="alert(1)"}'),
    ).toEqual({
      attributes: { file: "demo.html", onClick: "alert(1)" },
      name: "review-card",
      source: '::review-card{file="demo.html" onClick="alert(1)"}',
    });
  });

  it("decodes quoted escapes and rejects malformed or incomplete input", () => {
    expect(parsePluginMessageDirective('::review-card{label="a\\\"b\\nline"}')).toMatchObject({
      attributes: { label: 'a"b\nline' },
    });
    expect(parsePluginMessageDirective('::ReviewCard{file="x"}')).toBeNull();
    expect(parsePluginMessageDirective('::review-card{file="x" extra}')).toBeNull();
    expect(parsePluginMessageDirective('::review-card{file="still streaming')).toBeNull();
    expect(parsePluginMessageDirective('prefix ::review-card{file="x"}')).toBeNull();
  });
});

describe("buildPluginMessageDirectiveRegistry", () => {
  it("keeps one claimant", () => {
    const Component = (() => null) as ComponentType<PluginMessageDirectiveProps>;
    const contribution = {
      id: "review-card",
      component: Component,
      plugin: {
        id: "example",
        displayName: "Example",
        version: "1.0.0",
        apiVersion: 1,
        generation: 1,
        enabled: true,
        source: "local" as const,
      },
    };
    const registry = buildPluginMessageDirectiveRegistry([contribution]);
    expect(registry.get("review-card")).toEqual(contribution);
  });

  it("does not choose a winner when plugins claim the same directive", () => {
    const Component = (() => <div>mounted</div>) as ComponentType<PluginMessageDirectiveProps>;
    const descriptor = {
      displayName: "Plugin",
      version: "1.0.0",
      apiVersion: 1,
      generation: 1,
      enabled: true,
      source: "local" as const,
    };
    const registry = buildPluginMessageDirectiveRegistry([
      { id: "review-card", component: Component, plugin: { ...descriptor, id: "one" } },
      { id: "review-card", component: Component, plugin: { ...descriptor, id: "two" } },
    ]);

    expect(registry.get("review-card")).toBeNull();
  });
});

describe("createPluginMessageDirectiveRemarkPlugin", () => {
  it("replaces only a complete registered directive paragraph", () => {
    const Component = (() => null) as ComponentType<PluginMessageDirectiveProps>;
    const registry = buildPluginMessageDirectiveRegistry([
      {
        id: "review-card",
        component: Component,
        plugin: {
          id: "example",
          displayName: "Example",
          version: "1.0.0",
          apiVersion: 1,
          generation: 1,
          enabled: true,
          source: "local",
        },
      },
    ]);
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", value: '::review-card{file="demo.html"}' }],
        },
        {
          type: "paragraph",
          children: [{ type: "inlineCode", value: '::review-card{file="inline.html"}' }],
        },
        { type: "code", value: '::review-card{file="fenced.html"}' },
        {
          type: "paragraph",
          children: [{ type: "text", value: '::unknown-card{file="plain.html"}' }],
        },
      ],
    };

    createPluginMessageDirectiveRemarkPlugin(registry)()(tree);

    expect(tree.children[0]?.data?.hName).toBe(PLUGIN_MESSAGE_DIRECTIVE_TAG_NAME);
    expect(tree.children[1]?.children?.[0]?.value).toContain("inline.html");
    expect(tree.children[2]?.value).toContain("fenced.html");
    expect(tree.children[3]?.children?.[0]?.value).toContain("plain.html");
  });
});
