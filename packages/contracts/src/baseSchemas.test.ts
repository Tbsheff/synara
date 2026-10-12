import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ProjectId, ThreadId } from "./baseSchemas";

const decodeProjectId = Schema.decodeUnknownExit(ProjectId);

describe("ProjectId", () => {
  it.each([
    "3f2b8c1e-6a4d-4e2f-9b7a-1c2d3e4f5a6b",
    "project-1",
    "request-identity:alpha",
    "Project_With.Dots",
    ".hidden",
  ])("decodes generated and persisted id %j", (value) => {
    expect(decodeProjectId(value)._tag).toBe("Success");
  });

  it.each([
    "../x",
    "../other-directory",
    "a/b",
    "a\\b",
    "..\\x",
    "/abs",
    "..",
    ".",
    "...",
    "trailing.",
    " .. ",
    "a\u0000b",
    "a\nb",
  ])("rejects path-unsafe id %j", (value) => {
    expect(decodeProjectId(value)._tag).toBe("Failure");
  });

  it("leaves other entity ids unrestricted", () => {
    expect(Schema.decodeUnknownExit(ThreadId)("a/b")._tag).toBe("Success");
  });
});
