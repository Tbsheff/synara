// FILE: GitCreatePrDialog.tsx
// Purpose: Render the Create PR dialog: branch summary, optional PR title/description,
//          local-changes toggle with diff stats, and create/draft/browser actions.
// Layer: Header action control
// Depends on: GitActionsControl.logic resolvers and the shared git dialog chrome.

import type { GitStackedAction } from "@synara/contracts";
import { useEffect, useMemo, useState } from "react";
import { Checkbox } from "~/components/ui/checkbox";
import { DiffStat } from "~/components/ui/diff-stat";
import { getSubmitShortcutKeyShortcuts, SubmitShortcutKbd } from "~/components/ui/kbd";
import {
  type CreatePrBrowserPreparation,
  type GitDialogContext,
  resolveCreatePrBrowserPreparation,
  resolveCreatePrDialogExecution,
  resolveCreatePrDialogView,
} from "./GitActionsControl.logic";
import {
  GIT_DIALOG_FIELD_CLASS,
  GitDialogActionList,
  GitDialogActionRow,
  GitDialogBody,
  GitDialogHeading,
  GitDialogShell,
} from "./GitDialogChrome";
import { CreatePullRequestIcon, ExternalLinkIcon, GitPullRequestDraftIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

export interface GitCreatePrDialogSubmission {
  action: "create_pr" | "commit_push_pr";
  draft: boolean;
  includeLocalChanges: boolean;
  title: string | null;
  body: string | null;
}

export interface CreatePrCommitSelection {
  commitMessage: string | null;
  filePaths: string[] | null;
  commitScope?: "staged" | "all";
}

export function resolveCreatePrCommitFields(
  action: GitStackedAction,
  commit: CreatePrCommitSelection | null,
): { commitMessage?: string; filePaths?: string[]; commitScope?: "staged" | "all" } {
  if (!commit || (action !== "commit_push_pr" && action !== "commit_push")) return {};
  return {
    ...(commit.commitMessage ? { commitMessage: commit.commitMessage } : {}),
    ...(commit.filePaths ? { filePaths: commit.filePaths } : {}),
    ...(commit.commitScope ? { commitScope: commit.commitScope } : {}),
  };
}

function encodeBranchForCompareUrl(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

export function buildPullRequestCompareUrl(input: {
  repoUrl: string;
  baseBranch: string;
  headBranch: string;
  title?: string | null;
  body?: string | null;
}): string {
  const params = new URLSearchParams({ expand: "1" });
  if (input.title) params.set("title", input.title);
  if (input.body) params.set("body", input.body);
  return `${input.repoUrl}/compare/${encodeBranchForCompareUrl(input.baseBranch)}...${encodeBranchForCompareUrl(input.headBranch)}?${params.toString()}`;
}

export interface GitCreatePrDialogBrowserRequest {
  preparation: CreatePrBrowserPreparation;
  includeLocalChanges: boolean;
  title: string | null;
  body: string | null;
}

interface GitCreatePrDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context: GitDialogContext;
  initialDraft?: {
    title: string | null;
    body: string | null;
    includeLocalChanges?: boolean;
    draft?: boolean;
  } | null;
  onSubmit: (submission: GitCreatePrDialogSubmission) => void;
  onOpenInBrowser: (request: GitCreatePrDialogBrowserRequest) => void;
}

export function GitCreatePrDialog({
  open,
  onOpenChange,
  context,
  initialDraft,
  onSubmit,
  onOpenInBrowser,
}: GitCreatePrDialogProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [includeLocalChanges, setIncludeLocalChanges] = useState(true);
  const initialIncludeLocalChanges = initialDraft?.includeLocalChanges ?? true;
  const initialTitle = initialDraft?.title ?? "";
  const initialBody = initialDraft?.body ?? "";

  useEffect(() => {
    if (!open) return;
    setTitle(initialTitle);
    setBody(initialBody);
    setIncludeLocalChanges(initialIncludeLocalChanges);
  }, [initialBody, initialTitle, initialIncludeLocalChanges, open]);

  const view = useMemo(() => resolveCreatePrDialogView(context), [context]);
  const execution = useMemo(
    () => resolveCreatePrDialogExecution(context, includeLocalChanges),
    [context, includeLocalChanges],
  );
  const browserPreparation = useMemo(
    () => resolveCreatePrBrowserPreparation(context, includeLocalChanges),
    [context, includeLocalChanges],
  );
  const canCreate = execution.kind === "run_action";
  const canOpenInBrowser = browserPreparation.kind !== "unavailable";
  const unavailableHint = execution.kind === "unavailable" ? execution.hint : null;

  const submit = (draft: boolean) => {
    if (execution.kind !== "run_action") return;
    onSubmit({
      action: execution.action,
      draft,
      includeLocalChanges,
      title: title.trim() || null,
      body: body.trim() || null,
    });
  };

  return (
    <GitDialogShell
      open={open}
      onOpenChange={onOpenChange}
      onSubmitShortcut={() => submit(initialDraft?.draft ?? false)}
    >
      <GitDialogHeading
        eyebrow={`${view.isNewBranch ? "New branch" : "Branch"} → ${view.baseBranchName}`}
        subject={
          view.willCreateFeatureBranch
            ? "Auto-named feature branch"
            : (view.branchName ?? "(detached HEAD)")
        }
        subjectMuted={view.willCreateFeatureBranch}
      />
      <GitDialogBody>
        <input
          autoFocus
          aria-label="Pull request title"
          className={GIT_DIALOG_FIELD_CLASS}
          maxLength={300}
          placeholder="Title (leave empty to generate)"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <textarea
          aria-label="Pull request description"
          className={cn(GIT_DIALOG_FIELD_CLASS, "resize-none")}
          maxLength={60_000}
          placeholder="Description (leave empty to generate)"
          rows={2}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        {view.showCommitToggle && (
          <label className="flex cursor-pointer items-center gap-2 py-1 text-ui leading-snug">
            <Checkbox
              checked={includeLocalChanges}
              onCheckedChange={(checked) => setIncludeLocalChanges(checked === true)}
            />
            <span className="flex-1">Commit and push local changes</span>
            <DiffStat
              className="shrink-0 font-mono text-ui leading-snug"
              insertions={view.insertions}
              deletions={view.deletions}
            />
          </label>
        )}
        {unavailableHint && (
          <p className="py-1 text-warning text-ui leading-snug">{unavailableHint}</p>
        )}
      </GitDialogBody>
      <GitDialogActionList>
        <GitDialogActionRow
          disabled={!canCreate}
          icon={<GitPullRequestDraftIcon />}
          label="Create draft PR"
          onClick={() => submit(true)}
        />
        <GitDialogActionRow
          highlighted
          disabled={!canCreate}
          icon={<CreatePullRequestIcon />}
          label="Create PR"
          trailing={<SubmitShortcutKbd />}
          aria-keyshortcuts={getSubmitShortcutKeyShortcuts()}
          onClick={() => submit(false)}
        />
        <GitDialogActionRow
          disabled={!canOpenInBrowser}
          icon={<ExternalLinkIcon />}
          label="Open PR in browser"
          onClick={() =>
            onOpenInBrowser({
              preparation: browserPreparation,
              includeLocalChanges,
              title: title.trim() || null,
              body: body.trim() || null,
            })
          }
        />
      </GitDialogActionList>
    </GitDialogShell>
  );
}
