import type { CloudApplyResult, CloudProvider, CloudTaskId, ProjectId } from "@synara/contracts";
import { buildTemporaryWorktreeBranchName } from "@synara/shared/git";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";

import { cloudApplyToWorktreeMutationOptions } from "~/lib/cloudReactQuery";
import { gitCreateDetachedWorktreeMutationOptions } from "~/lib/gitReactQuery";
import { serverQueryKeys, serverWorktreesQueryOptions } from "~/lib/serverReactQuery";
import type { Project } from "~/types";
import { SettingsSelectControl } from "../settings/SettingControls";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  dialogFieldLabelClassName,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { SelectItem } from "../ui/select";
import { cloudErrorMessage } from "./cloud.logic";
import { CloudProjectSelect } from "./CloudSubmitDialog";

const NEW_WORKTREE = "new";

const APPLY_RESULT_PRESENTATION: Record<
  CloudApplyResult["outcome"],
  { variant: "success" | "warning" | "error"; title: string }
> = {
  applied: { variant: "success", title: "Patch applied" },
  partial: { variant: "warning", title: "Applied with conflicts" },
  failed: { variant: "error", title: "Patch not applied" },
};

export function CloudApplyDialog({
  open,
  onOpenChange,
  provider,
  taskId,
  defaultRef,
  projects,
  initialProjectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: CloudProvider;
  taskId: CloudTaskId;
  defaultRef: string | null;
  projects: ReadonlyArray<Project>;
  initialProjectId: ProjectId | null;
}) {
  const refInputId = useId();
  const queryClient = useQueryClient();
  const createWorktreeMutation = useMutation(
    gitCreateDetachedWorktreeMutationOptions({ queryClient }),
  );
  const applyMutation = useMutation(cloudApplyToWorktreeMutationOptions());
  const [projectId, setProjectId] = useState(initialProjectId);
  const [target, setTarget] = useState(NEW_WORKTREE);
  const [ref, setRef] = useState(defaultRef ?? "");
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<CloudApplyResult | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setProjectId(initialProjectId);
      setTarget(NEW_WORKTREE);
      setRef(defaultRef ?? "");
      setConfirming(false);
      setResult(null);
      setErrorText(null);
    }
  }

  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const worktreesQuery = useQuery({ ...serverWorktreesQueryOptions(), enabled: open });
  const worktrees = (worktreesQuery.data?.worktrees ?? []).filter(
    (worktree) => project !== null && worktree.workspaceRoot === project.cwd,
  );
  const pending = createWorktreeMutation.isPending || applyMutation.isPending;
  const usesNewWorktree = target === NEW_WORKTREE;
  const canContinue =
    project !== null && !pending && (usesNewWorktree ? ref.trim().length > 0 : true);
  const targetLabel = usesNewWorktree ? `a new worktree from ${ref.trim()}` : target;

  const runApply = () => {
    if (!project) return;
    setErrorText(null);
    setResult(null);
    const worktreePath = usesNewWorktree
      ? createWorktreeMutation
          .mutateAsync({
            cwd: project.cwd,
            ref: ref.trim(),
            newBranch: buildTemporaryWorktreeBranchName(),
          })
          .then(async (created) => {
            await queryClient.invalidateQueries({ queryKey: serverQueryKeys.worktrees() });
            setTarget(created.worktree.path);
            return created.worktree.path;
          })
      : Promise.resolve(target);
    void worktreePath
      .then((path) => applyMutation.mutateAsync({ provider, taskId, worktreePath: path }))
      .then(setResult)
      .catch((error: unknown) => setErrorText(cloudErrorMessage(error)));
  };

  const resultPresentation = result ? APPLY_RESULT_PRESENTATION[result.outcome] : null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Apply to worktree</DialogTitle>
            <DialogDescription>
              Apply this task&apos;s patch to a Synara worktree of the project.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-3">
              {projects.length > 1 ? (
                <CloudProjectSelect
                  projects={projects}
                  value={projectId}
                  onValueChange={(next) => {
                    setProjectId(next);
                    setTarget(NEW_WORKTREE);
                  }}
                />
              ) : null}
              <div className="space-y-1">
                <span className={dialogFieldLabelClassName}>Worktree</span>
                <SettingsSelectControl
                  value={target}
                  onValueChange={setTarget}
                  ariaLabel="Worktree"
                  triggerClassName="w-full"
                  valueContent={
                    <span className="truncate">{usesNewWorktree ? "New worktree" : target}</span>
                  }
                >
                  <SelectItem hideIndicator value={NEW_WORKTREE}>
                    New worktree
                  </SelectItem>
                  {worktrees.map((worktree) => (
                    <SelectItem hideIndicator key={worktree.path} value={worktree.path}>
                      <span className="truncate">{worktree.path}</span>
                    </SelectItem>
                  ))}
                </SettingsSelectControl>
              </div>
              {usesNewWorktree ? (
                <div className="space-y-1">
                  <label htmlFor={refInputId} className={dialogFieldLabelClassName}>
                    Start from
                  </label>
                  <Input
                    id={refInputId}
                    size="sm"
                    className="font-mono"
                    value={ref}
                    onChange={(event) => setRef(event.target.value)}
                    placeholder="Branch or commit"
                    spellCheck={false}
                  />
                  <span className="block text-ui-sm text-muted-foreground">
                    The branch the cloud task started from, so the patch applies cleanly.
                  </span>
                </div>
              ) : null}
              {resultPresentation && result ? (
                <Alert variant={resultPresentation.variant} size="sm">
                  <AlertTitle>{resultPresentation.title}</AlertTitle>
                  <AlertDescription>
                    <span>{result.detail}</span>
                    {result.outcome === "partial" ? (
                      <span>Synara did not reset the worktree. Resolve the conflicts there.</span>
                    ) : null}
                    <span className="font-mono text-ui-sm">{result.worktreePath}</span>
                  </AlertDescription>
                </Alert>
              ) : null}
              {errorText ? (
                <Alert variant="error" size="sm">
                  <AlertDescription>{errorText}</AlertDescription>
                </Alert>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {result ? "Done" : "Cancel"}
            </Button>
            {result ? null : (
              <Button type="button" disabled={!canContinue} onClick={() => setConfirming(true)}>
                {pending ? "Applying…" : "Apply…"}
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply the cloud patch?</AlertDialogTitle>
            <AlertDialogDescription>
              Synara applies the patch with git apply --3way to {targetLabel}. The worktree must be
              clean. A partial result can leave conflicts for you to resolve.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </AlertDialogClose>
            <Button
              size="sm"
              disabled={pending}
              onClick={() => {
                setConfirming(false);
                runApply();
              }}
            >
              Apply
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
