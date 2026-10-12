import { describe, expect, it } from "vitest";

import {
  resolveCommitDialogDefaultSelection,
  resolveCommitDialogFileSubmission,
} from "./GitCommitDialog";

const file = (path: string, staged?: boolean) => ({ path, insertions: 1, deletions: 0, staged });

describe("commit dialog file submission", () => {
  it("commits the index as-is when the user keeps the staged-only default", () => {
    const files = [file("src/a.ts", true), file("src/b.ts", false)];
    expect(resolveCommitDialogDefaultSelection(files)).toEqual(["src/a.ts"]);
    expect(resolveCommitDialogFileSubmission({ files, selectedPaths: null })).toEqual({
      filePaths: null,
      commitScope: "staged",
    });
    expect(
      resolveCommitDialogFileSubmission({ files, selectedPaths: new Set(["src/a.ts"]) }),
    ).toEqual({ filePaths: null, commitScope: "staged" });
  });

  it("sends the explicit list once the user edits a staged selection", () => {
    const files = [file("src/a.ts", true), file("src/b.ts", false)];
    expect(
      resolveCommitDialogFileSubmission({
        files,
        selectedPaths: new Set(["src/a.ts", "src/b.ts"]),
      }),
    ).toEqual({ filePaths: ["src/a.ts", "src/b.ts"] });
  });

  it("sends the shown files explicitly so files that appear later are not committed", () => {
    const files = [file("src/a.ts"), file("src/b.ts")];
    expect(resolveCommitDialogDefaultSelection(files)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(resolveCommitDialogFileSubmission({ files, selectedPaths: null })).toEqual({
      filePaths: ["src/a.ts", "src/b.ts"],
    });
    expect(
      resolveCommitDialogFileSubmission({
        files,
        selectedPaths: new Set(["src/b.ts", "src/gone.ts"]),
      }),
    ).toEqual({ filePaths: ["src/b.ts"] });
  });

  it("sends no paths for a pure push with nothing to commit", () => {
    expect(resolveCommitDialogFileSubmission({ files: [], selectedPaths: null })).toEqual({
      filePaths: null,
    });
  });
});
