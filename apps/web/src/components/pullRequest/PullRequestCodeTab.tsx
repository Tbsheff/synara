// FILE: PullRequestCodeTab.tsx
// Purpose: The Code tab of the pull request detail surface — owns the diff query and the
//          patch viewport. Lazy-loaded by PullRequestDetailPanel so the diff renderer and its
//          worker infrastructure never ship to users who only read the list or Summary.
// Layer: Pull request presentation
// Exports: PullRequestCodeTab (default export for React.lazy)

import type { PullRequestDetail, PullRequestDetailInput } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";

import { PatchDiffBody } from "~/components/PatchDiffBody";
import { pullRequestDiffQueryOptions } from "~/lib/pullRequestReactQuery";

export function PullRequestCodeTab({
  input,
  detail,
}: {
  input: PullRequestDetailInput;
  detail: PullRequestDetail;
}) {
  const diffQuery = useQuery(pullRequestDiffQueryOptions(input));

  return (
    <PatchDiffBody
      patch={diffQuery.data?.patch}
      cacheKey={`pull-request:${input.projectId}:${input.number}`}
      truncatedLabel={diffQuery.data?.truncated ? "Diff exceeded 8 MiB and was truncated." : null}
      isPending={diffQuery.isPending}
      isFetching={diffQuery.isFetching}
      isSuccess={diffQuery.isSuccess}
      error={
        diffQuery.isError
          ? diffQuery.error instanceof Error
            ? diffQuery.error.message
            : "Could not load diff."
          : null
      }
      workspaceRoot={detail.workspaceRoot}
      loadingLabel="Loading pull request diff…"
      emptyLabel="This pull request has no file changes."
      unavailableLabel="The pull request diff is unavailable."
    />
  );
}

export default PullRequestCodeTab;
