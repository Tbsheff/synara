import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  GitReadWorkingTreeDiffInput,
  GitRunStackedActionInput,
  GitStageFilesInput,
  GitUnstageFilesInput,
} from "./git";

describe("GitReadWorkingTreeDiffInput", () => {
  it("preserves the optional literal file path through the RPC schema", () => {
    const decode = Schema.decodeUnknownSync(GitReadWorkingTreeDiffInput);
    expect(decode({ cwd: "/repo", scope: "workingTree", filePath: "src/[name].ts" })).toMatchObject(
      {
        cwd: "/repo",
        scope: "workingTree",
        filePath: "src/[name].ts",
      },
    );
    expect(decode({ cwd: "/repo" })).not.toHaveProperty("filePath");
  });
});

it("preserves spaces in literal mutation paths", () => {
  const paths = [" leading.txt", "trailing.txt "];
  for (const schema of [GitStageFilesInput, GitUnstageFilesInput]) {
    expect(Schema.decodeUnknownSync(schema)({ cwd: "/repo", paths }).paths).toEqual(paths);
  }
  expect(
    Schema.decodeUnknownSync(GitRunStackedActionInput)({
      cwd: "/repo",
      action: "commit",
      actionId: "test",
      filePaths: paths,
    }).filePaths,
  ).toEqual(paths);
});
