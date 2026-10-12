import { formatRelativeTime } from "~/lib/relativeTime";
import { cn } from "~/lib/utils";
import { SIDEBAR_ROW_HOVER_CLASS_NAME } from "~/sidebarRowStyles";
import { PullRequestDiffStat } from "../pullRequest/PullRequestDiffStat";
import { PullRequestMetaLine } from "../pullRequest/PullRequestMetaLine";
import {
  PR_BODY_TEXT_CLASS_NAME,
  PR_FINE_TEXT_CLASS_NAME,
  PR_QUIET_INK_CLASS_NAME,
} from "../pullRequest/pullRequestText";
import { TaskStatusChip } from "../tasks/TaskGlyphs";
import type { CloudListEntry } from "./cloud.logic";

export function CloudTaskRow({
  entry,
  selected,
  onSelect,
}: {
  entry: CloudListEntry;
  selected: boolean;
  onSelect: (entry: CloudListEntry) => void;
}) {
  return (
    <button
      type="button"
      data-cloud-task-row={entry.key}
      aria-current={selected ? "true" : undefined}
      title={entry.title}
      onClick={() => onSelect(entry)}
      className={cn(
        "flex w-full min-w-0 flex-col gap-1 rounded-lg py-2 pr-2 pl-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        selected
          ? "bg-[color-mix(in_srgb,var(--color-text-foreground)_7%,transparent)]"
          : SIDEBAR_ROW_HOVER_CLASS_NAME,
      )}
    >
      <span className="flex min-w-0 items-start gap-2">
        <span
          className={cn(
            PR_BODY_TEXT_CLASS_NAME,
            "line-clamp-2 min-w-0 flex-1 break-words font-medium leading-snug text-foreground",
          )}
        >
          {entry.title}
        </span>
        <TaskStatusChip kind={entry.status.kind} label={entry.status.label} />
      </span>
      <PullRequestMetaLine className={cn(PR_FINE_TEXT_CLASS_NAME, PR_QUIET_INK_CLASS_NAME)}>
        {entry.environmentLabel ? (
          <span key="environment" className="min-w-0 truncate">
            {entry.environmentLabel}
          </span>
        ) : null}
        {entry.diffSummary && entry.diffSummary.filesChanged > 0 ? (
          <span key="diff" className="flex shrink-0 items-center gap-1.5">
            <span>
              {entry.diffSummary.filesChanged}{" "}
              {entry.diffSummary.filesChanged === 1 ? "file" : "files"}
            </span>
            <PullRequestDiffStat
              additions={entry.diffSummary.linesAdded}
              deletions={entry.diffSummary.linesRemoved}
              tone="diff"
            />
          </span>
        ) : null}
        {entry.updatedAt ? (
          <time key="updated" dateTime={entry.updatedAt} className="shrink-0 tabular-nums">
            {formatRelativeTime(entry.updatedAt)}
          </time>
        ) : null}
      </PullRequestMetaLine>
      {entry.problem ? (
        <span className={cn(PR_FINE_TEXT_CLASS_NAME, "line-clamp-2 text-muted-foreground")}>
          {entry.problem}
        </span>
      ) : null}
    </button>
  );
}
