import type { CloudCapabilities, CloudProvider, ProjectId } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { cloudTaskQueryOptions } from "~/lib/cloudReactQuery";
import { ExternalLinkIcon } from "~/lib/icons";
import { formatRelativeTime } from "~/lib/relativeTime";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import type { Project } from "~/types";
import { PullRequestMetaLine } from "../pullRequest/PullRequestMetaLine";
import { PR_META_TEXT_CLASS_NAME, PR_QUIET_INK_CLASS_NAME } from "../pullRequest/pullRequestText";
import { TaskStatusChip } from "../tasks/TaskGlyphs";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  cloudErrorMessage,
  isCloudTaskTerminal,
  shouldLoadCloudDiff,
  withLatestTask,
  type CloudListEntry,
} from "./cloud.logic";
import { CloudApplyDialog } from "./CloudApplyDialog";
import { CloudTaskDiff } from "./CloudTaskDiff";

function diffPlaceholder(entry: CloudListEntry, canDiff: boolean): string | null {
  if (entry.taskId === null) return null;
  if (!canDiff) return "This CLI cannot read cloud diffs.";
  if (entry.taskStatus === "pending") return "The task is still running.";
  if (entry.taskStatus === "ready" && entry.diffSummary?.filesChanged === 0) return "No changes.";
  if (entry.taskStatus !== "ready") return "This task has no diff to show.";
  return null;
}

export function CloudTaskDetail({
  provider,
  entry: listEntry,
  capabilities,
  projects,
  initialProjectId,
}: {
  provider: CloudProvider;
  entry: CloudListEntry;
  capabilities: CloudCapabilities;
  projects: ReadonlyArray<Project>;
  initialProjectId: ProjectId | null;
}) {
  const [applyOpen, setApplyOpen] = useState(false);
  const taskRef = listEntry.taskId ? { provider, taskId: listEntry.taskId } : null;
  const taskQuery = useQuery(
    cloudTaskQueryOptions(
      taskRef,
      capabilities.canStatus && !isCloudTaskTerminal(listEntry.taskStatus),
    ),
  );
  const entry = withLatestTask(listEntry, taskQuery.data);
  const loadsDiff = shouldLoadCloudDiff(entry, capabilities.canDiff);
  const placeholder = loadsDiff ? null : diffPlaceholder(entry, capabilities.canDiff);
  const canApply = capabilities.canApply && entry.taskId !== null && entry.taskStatus === "ready";
  const projectId = (entry.submission?.projectId as ProjectId | null | undefined) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border/60 px-4 py-3">
        <div className="flex min-w-0 items-start gap-2">
          <h2 className="min-w-0 flex-1 break-words text-ui-lg font-medium text-foreground">
            {entry.title}
          </h2>
          <TaskStatusChip kind={entry.status.kind} label={entry.status.label} />
        </div>
        <PullRequestMetaLine className={cn(PR_META_TEXT_CLASS_NAME, PR_QUIET_INK_CLASS_NAME)}>
          {entry.environmentLabel ? (
            <span key="environment" className="min-w-0 truncate">
              {entry.environmentLabel}
            </span>
          ) : null}
          {entry.branch ? (
            <span key="branch" className="min-w-0 truncate font-mono">
              {entry.branch}
            </span>
          ) : null}
          {entry.updatedAt ? (
            <time key="updated" dateTime={entry.updatedAt} className="shrink-0 tabular-nums">
              Updated {formatRelativeTime(entry.updatedAt)}
            </time>
          ) : null}
          {entry.attemptTotal && entry.attemptTotal > 1 ? (
            <span key="attempts" className="shrink-0">
              {entry.attemptTotal} attempts
            </span>
          ) : null}
        </PullRequestMetaLine>
        <div className="flex flex-wrap items-center gap-2">
          {provider === "codex" && entry.url ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                if (entry.url) void ensureNativeApi().shell.openExternal(entry.url);
              }}
            >
              <ExternalLinkIcon />
              Open in ChatGPT
            </Button>
          ) : null}
          {canApply ? (
            <Button size="xs" variant="outline" onClick={() => setApplyOpen(true)}>
              Apply to worktree
            </Button>
          ) : null}
        </div>
        {entry.problem ? (
          <Alert variant={entry.submission?.state === "failed" ? "error" : "warning"} size="sm">
            <AlertTitle>{entry.status.label}</AlertTitle>
            <AlertDescription>{entry.problem}</AlertDescription>
          </Alert>
        ) : null}
        {taskQuery.isError ? (
          <Alert variant="error" size="sm">
            <AlertDescription>{cloudErrorMessage(taskQuery.error)}</AlertDescription>
          </Alert>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {loadsDiff && entry.taskId ? (
          <CloudTaskDiff input={{ provider, taskId: entry.taskId }} />
        ) : placeholder ? (
          <p className={cn(PR_META_TEXT_CLASS_NAME, "px-4 py-6 text-center text-muted-foreground")}>
            {placeholder}
          </p>
        ) : null}
      </div>
      {entry.taskId ? (
        <CloudApplyDialog
          open={applyOpen}
          onOpenChange={setApplyOpen}
          provider={provider}
          taskId={entry.taskId}
          defaultRef={entry.branch}
          projects={projects}
          initialProjectId={
            projects.some((project) => project.id === projectId) ? projectId : initialProjectId
          }
        />
      ) : null}
    </div>
  );
}
