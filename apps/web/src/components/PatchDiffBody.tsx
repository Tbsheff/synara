import { useMemo, useState } from "react";

import { DiffPanelPatchViewport } from "~/components/DiffPanelPatchViewport";
import { DiffPanelLoadingState } from "~/components/DiffPanelShell";
import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";
import { useTheme } from "~/hooks/useTheme";
import {
  getRenderablePatch,
  sortFileDiffsByPath,
  summarizeRenderablePatchStats,
} from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import { PullRequestDiffStat } from "./pullRequest/PullRequestDiffStat";
import { PullRequestMetaLine } from "./pullRequest/PullRequestMetaLine";
import { PR_META_TEXT_CLASS_NAME } from "./pullRequest/pullRequestText";
import { PullRequestWarningNote } from "./pullRequest/PullRequestWarningNote";

export function PatchDiffBody({
  patch,
  cacheKey,
  truncatedLabel,
  isPending,
  isFetching,
  isSuccess,
  error,
  workspaceRoot,
  loadingLabel,
  emptyLabel,
  unavailableLabel,
}: {
  patch: string | undefined;
  cacheKey: string;
  truncatedLabel: string | null;
  isPending: boolean;
  isFetching: boolean;
  isSuccess: boolean;
  error: string | null;
  workspaceRoot: string | null;
  loadingLabel: string;
  emptyLabel: string;
  unavailableLabel: string;
}) {
  const { resolvedTheme } = useTheme();
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(() => new Set());
  const renderablePatch = useMemo(() => getRenderablePatch(patch, cacheKey), [cacheKey, patch]);
  const renderableFiles = useMemo(
    () => (renderablePatch?.kind === "files" ? sortFileDiffsByPath(renderablePatch.files) : []),
    [renderablePatch],
  );
  const patchTotals = useMemo(
    () => summarizeRenderablePatchStats(renderablePatch),
    [renderablePatch],
  );

  return (
    <DiffWorkerPoolProvider
      enabled={!isPending && renderableFiles.length > 0}
      fileCount={renderableFiles.length}
    >
      <div className="flex h-full min-h-0 flex-col">
        {truncatedLabel ? (
          <PullRequestWarningNote shape="banner">{truncatedLabel}</PullRequestWarningNote>
        ) : null}
        {patchTotals ? (
          <PullRequestMetaLine
            className={cn(
              PR_META_TEXT_CLASS_NAME,
              "border-b border-border/60 px-3 py-2 text-muted-foreground",
            )}
          >
            <span>{patchTotals.fileCount} files</span>
            <PullRequestDiffStat
              additions={patchTotals.additions}
              deletions={patchTotals.deletions}
              tone="diff"
            />
          </PullRequestMetaLine>
        ) : null}
        {isPending ? (
          <DiffPanelLoadingState label={loadingLabel} />
        ) : (
          <DiffPanelPatchViewport
            renderablePatch={renderablePatch}
            renderableFiles={renderableFiles}
            resolvedTheme={resolvedTheme}
            diffRenderMode="split"
            diffWordWrap
            workspaceRoot={workspaceRoot}
            collapsedFiles={collapsedFiles}
            onToggleFileCollapsed={(key) =>
              setCollapsedFiles((current) => {
                const next = new Set(current);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })
            }
            isLoading={isFetching}
            hasNoChanges={isSuccess && !renderablePatch}
            error={error}
            loadingLabel={loadingLabel}
            emptyLabel={emptyLabel}
            unavailableLabel={unavailableLabel}
            viewKind="repo"
          />
        )}
      </div>
    </DiffWorkerPoolProvider>
  );
}
