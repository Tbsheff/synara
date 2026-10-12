import type { CloudGetDiffInput } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";

import { PatchDiffBody } from "~/components/PatchDiffBody";
import { cloudDiffQueryOptions } from "~/lib/cloudReactQuery";
import { cn } from "~/lib/utils";
import { PR_META_TEXT_CLASS_NAME } from "../pullRequest/pullRequestText";
import { cloudErrorMessage, cloudNoDiffLabel, cloudNoDiffReason } from "./cloud.logic";

export function CloudTaskDiff({ input }: { input: CloudGetDiffInput }) {
  const diffQuery = useQuery(cloudDiffQueryOptions(input, true));
  const noDiffReason = diffQuery.isError ? cloudNoDiffReason(diffQuery.error) : null;

  if (noDiffReason) {
    return (
      <p className={cn(PR_META_TEXT_CLASS_NAME, "px-3 py-6 text-center text-muted-foreground")}>
        {cloudNoDiffLabel(noDiffReason)}
      </p>
    );
  }

  return (
    <PatchDiffBody
      patch={diffQuery.data?.patch}
      cacheKey={`cloud:${input.provider}:${input.taskId}`}
      truncatedLabel={
        diffQuery.data?.truncated ? "The diff was too large and was truncated." : null
      }
      isPending={diffQuery.isPending}
      isFetching={diffQuery.isFetching}
      isSuccess={diffQuery.isSuccess}
      error={diffQuery.isError ? cloudErrorMessage(diffQuery.error) : null}
      workspaceRoot={null}
      loadingLabel="Loading cloud diff…"
      emptyLabel="This task has no file changes."
      unavailableLabel="The cloud diff is unavailable."
    />
  );
}
