import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { PluginEditInput, PluginListResult } from "./plugins";

describe("PluginListResult", () => {
  it.each([1, 2] as const)("accepts plugin API version %i", (apiVersion) => {
    expect(
      Schema.decodeUnknownSync(PluginListResult)([
        {
          id: "@acme/plugin",
          displayName: "Acme",
          version: "0.1.0",
          apiVersion,
          generation: 1,
        },
      ])[0]?.apiVersion,
    ).toBe(apiVersion);
  });
});

describe("PluginEditInput", () => {
  it("keeps the operation timestamp in the retry payload", () => {
    expect(
      Schema.decodeUnknownSync(PluginEditInput)({
        pluginId: "@acme/plugin",
        generation: 1,
        projectId: "project-1",
        operationId: "operation-1",
        createdAt: "2026-09-15T00:00:00.000Z",
      }).createdAt,
    ).toBe("2026-09-15T00:00:00.000Z");
  });
});
