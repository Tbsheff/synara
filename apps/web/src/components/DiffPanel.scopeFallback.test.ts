import { describe, expect, it } from "vitest";

import { shouldFallBackToBranchScope } from "./DiffPanel.logic";

const emptyWorkingTreeOnAheadBranch = {
  diffOpen: true,
  diffViewKind: "repo" as const,
  repoDiffScope: "workingTree" as const,
  hasResolvedRepoPatch: true,
  hasNoRepoChanges: true,
  branchHasCommittedChanges: true,
};

describe("shouldFallBackToBranchScope", () => {
  it("shows the branch diff on the initial view of an empty working tree", () => {
    expect(
      shouldFallBackToBranchScope({ ...emptyWorkingTreeOnAheadBranch, initialScopeSettled: false }),
    ).toBe(true);
  });

  it("keeps an explicit Working tree choice once the initial view has settled", () => {
    expect(
      shouldFallBackToBranchScope({ ...emptyWorkingTreeOnAheadBranch, initialScopeSettled: true }),
    ).toBe(false);
  });
});
