// FILE: GitCommitDialog.tsx
// Purpose: Render the Commit dialog: branch summary, commit message, a compact
//          file selection with diff stats, and the shared git action rows
//          (commit on new branch / commit / commit & push / create PR).
// Layer: Header action control
// Depends on: GitActionsControl.logic resolvers and the shared git dialog chrome.

import { useEffect, useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { DiffStat } from "~/components/ui/diff-stat";
import { getSubmitShortcutKeyShortcuts, SubmitShortcutKbd } from "~/components/ui/kbd";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  type GitCommitDialogAction,
  type GitDialogContext,
  resolveCommitDialogActions,
} from "./GitActionsControl.logic";
import { GitActionGlyph } from "./gitActionGlyphs";
import {
  GIT_DIALOG_FIELD_CLASS,
  GitDialogActionList,
  GitDialogActionRow,
  GitDialogBody,
  GitDialogHeading,
  GitDialogShell,
} from "./GitDialogChrome";
import { cn } from "~/lib/utils";

export interface GitCommitDialogSubmission {
  action: GitCommitDialogAction["action"];
  featureBranch: boolean;
  message: string | null;
  filePaths: string[] | null;
  commitScope?: "staged" | "all";
}

interface ChangedFile {
  path: string;
  insertions: number;
  deletions: number;
  staged?: boolean | undefined;
}

function hasStagedFiles(files: readonly ChangedFile[]): boolean {
  return files.some((file) => file.staged === true);
}

export function resolveCommitDialogDefaultSelection(files: readonly ChangedFile[]): string[] {
  const staged = hasStagedFiles(files);
  return files.filter((file) => !staged || file.staged === true).map((file) => file.path);
}

function isDefaultSelection(files: readonly ChangedFile[], selectedPaths: ReadonlySet<string>) {
  const defaults = resolveCommitDialogDefaultSelection(files);
  const shownSelected = files.filter((file) => selectedPaths.has(file.path));
  return (
    shownSelected.length === defaults.length && defaults.every((path) => selectedPaths.has(path))
  );
}

export function resolveCommitDialogFileSubmission(input: {
  files: readonly ChangedFile[];
  selectedPaths: ReadonlySet<string> | null;
}): Pick<GitCommitDialogSubmission, "filePaths" | "commitScope"> {
  const { files, selectedPaths } = input;
  if (
    hasStagedFiles(files) &&
    (selectedPaths === null || isDefaultSelection(files, selectedPaths))
  ) {
    return { filePaths: null, commitScope: "staged" };
  }
  const filePaths = files
    .filter((file) => selectedPaths === null || selectedPaths.has(file.path))
    .map((file) => file.path);
  return { filePaths: filePaths.length > 0 ? filePaths : null };
}

interface GitCommitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context: GitDialogContext;
  onSubmit: (submission: GitCommitDialogSubmission) => void;
  onOpenFile: (filePath: string) => void;
}

export function GitCommitDialog({
  open,
  onOpenChange,
  context,
  onSubmit,
  onOpenFile,
}: GitCommitDialogProps) {
  const [message, setMessage] = useState("");
  const [editedSelection, setEditedSelection] = useState<ReadonlySet<string> | null>(null);
  const [isEditingFiles, setIsEditingFiles] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMessage("");
    setEditedSelection(null);
    setIsEditingFiles(false);
  }, [open]);

  const gitStatus = context.gitStatus;
  const allFiles = useMemo(() => gitStatus?.workingTree.files ?? [], [gitStatus]);
  const selectedPaths = useMemo<ReadonlySet<string>>(
    () => editedSelection ?? new Set(resolveCommitDialogDefaultSelection(allFiles)),
    [allFiles, editedSelection],
  );
  const selectedFiles = useMemo(
    () => allFiles.filter((file) => selectedPaths.has(file.path)),
    [allFiles, selectedPaths],
  );
  const allSelected = selectedFiles.length === allFiles.length;
  const noneSelected = selectedFiles.length === 0;
  const fileSubmission = resolveCommitDialogFileSubmission({
    files: allFiles,
    selectedPaths: editedSelection,
  });
  // With nothing to select the file gate is vacuous — a pure push must stay runnable.
  const hasFileSelection = allFiles.length === 0 || !noneSelected;

  const actions = useMemo(
    () => resolveCommitDialogActions({ context, hasFileSelection }),
    [context, hasFileSelection],
  );

  const submit = (action: GitCommitDialogAction) => {
    if (action.disabled) return;
    onSubmit({
      action: action.action,
      featureBranch: action.featureBranch,
      message: message.trim() || null,
      ...fileSubmission,
    });
  };

  const submitPrimary = () => {
    const primary = actions.find((action) => action.id === "commit");
    if (primary) submit(primary);
  };

  const toggleFile = (path: string) => {
    const next = new Set(selectedPaths);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    setEditedSelection(next);
  };

  return (
    <GitDialogShell open={open} onOpenChange={onOpenChange} onSubmitShortcut={submitPrimary}>
      <GitDialogHeading
        eyebrow="Commit"
        eyebrowTrailing={
          context.isDefaultBranch ? <span className="text-warning">Default branch</span> : null
        }
        subject={gitStatus?.branch ?? "(detached HEAD)"}
      />
      <GitDialogBody>
        <textarea
          autoFocus
          aria-label="Commit message"
          className={cn(GIT_DIALOG_FIELD_CLASS, "resize-none")}
          maxLength={20_000}
          placeholder="Message (leave empty to generate)"
          rows={2}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        <div className="space-y-1">
          <div className="flex items-center gap-2 py-1 text-ui leading-snug">
            {isEditingFiles && allFiles.length > 0 ? (
              <Checkbox
                checked={allSelected}
                indeterminate={!allSelected && !noneSelected}
                onCheckedChange={() => {
                  setEditedSelection(
                    allSelected ? new Set() : new Set(allFiles.map((file) => file.path)),
                  );
                }}
              />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {summarizeSelection(allFiles.length, selectedFiles.length, allSelected)}
            </span>
            <DiffStat
              className="shrink-0 font-mono text-ui leading-snug"
              insertions={selectedFiles.reduce((sum, file) => sum + file.insertions, 0)}
              deletions={selectedFiles.reduce((sum, file) => sum + file.deletions, 0)}
            />
            {allFiles.length > 0 ? (
              <Button
                variant="ghost"
                size="xs"
                className="shrink-0"
                onClick={() => setIsEditingFiles((prev) => !prev)}
              >
                {isEditingFiles ? "Done" : "Edit"}
              </Button>
            ) : null}
          </div>
          {fileSubmission.commitScope === "staged" ? (
            <p className="text-ui-sm text-muted-foreground">
              Only staged changes are committed. Edit the selection to commit whole files.
            </p>
          ) : null}
          {allFiles.length > 0 ? (
            <ScrollArea className="h-32 rounded-md border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)]">
              <div className="space-y-1 p-1">
                {allFiles.map((file) => (
                  <ChangedFileRow
                    key={file.path}
                    file={file}
                    excluded={!selectedPaths.has(file.path)}
                    selectable={isEditingFiles}
                    onToggle={() => toggleFile(file.path)}
                    onOpen={() => onOpenFile(file.path)}
                  />
                ))}
              </div>
            </ScrollArea>
          ) : null}
        </div>
      </GitDialogBody>
      <GitDialogActionList>
        {actions.map((action) => (
          <GitDialogActionRow
            key={action.id}
            highlighted={action.id === "commit"}
            disabled={action.disabled}
            disabledReason={action.disabledReason}
            icon={<GitActionGlyph name={action.icon} className="size-4" />}
            label={action.label}
            {...(action.id === "commit"
              ? {
                  trailing: <SubmitShortcutKbd />,
                  "aria-keyshortcuts": getSubmitShortcutKeyShortcuts(),
                }
              : {})}
            onClick={() => submit(action)}
          />
        ))}
      </GitDialogActionList>
    </GitDialogShell>
  );
}

function summarizeSelection(total: number, selected: number, allSelected: boolean): string {
  if (total === 0) return "No local changes";
  if (allSelected) return `${total} ${total === 1 ? "file" : "files"}`;
  return `${selected} of ${total} files`;
}

function ChangedFileRow({
  file,
  excluded,
  selectable,
  onToggle,
  onOpen,
}: {
  file: ChangedFile;
  excluded: boolean;
  selectable: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="flex w-full items-center gap-2 rounded-md px-2 py-1 font-mono text-ui leading-snug transition-colors hover:bg-[var(--color-background-button-secondary-hover)]">
      {selectable ? <Checkbox checked={!excluded} onCheckedChange={onToggle} /> : null}
      {/* Raw <button> intentionally — list-row click target, not a shadcn Button. */}
      <button
        type="button"
        className="group flex flex-1 items-center justify-between gap-3 truncate text-left"
        onClick={onOpen}
      >
        <span
          className={cn(
            "truncate underline-offset-2 group-hover:underline group-focus-visible:underline",
            excluded && "text-muted-foreground",
          )}
        >
          {file.path}
        </span>
        <span className="shrink-0">
          {excluded ? (
            <span className="text-muted-foreground">Excluded</span>
          ) : (
            <DiffStat
              insertions={file.insertions}
              deletions={file.deletions}
              separator={<span className="text-muted-foreground">/</span>}
            />
          )}
        </span>
      </button>
    </div>
  );
}
