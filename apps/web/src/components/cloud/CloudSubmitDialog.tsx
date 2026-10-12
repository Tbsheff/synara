import {
  CLOUD_SUBMIT_PROMPT_MAX_LENGTH,
  type CloudCapabilities,
  type CloudProvider,
  type CloudSubmission,
  type CloudRequestId,
  type ProjectId,
} from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";

import { cloudEnvironmentsQueryOptions, cloudSubmitMutationOptions } from "~/lib/cloudReactQuery";
import { gitBranchesQueryOptions } from "~/lib/gitReactQuery";
import type { Project } from "~/types";
import { SettingsSelectControl } from "../settings/SettingControls";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  cloudAttemptOptions,
  cloudEnvironmentSuggestions,
  cloudErrorMessage,
  currentBranchName,
} from "./cloud.logic";

function newRequestId(): CloudRequestId {
  return crypto.randomUUID() as CloudRequestId;
}

export function CloudProjectSelect({
  projects,
  value,
  onValueChange,
}: {
  projects: ReadonlyArray<Project>;
  value: ProjectId | null;
  onValueChange: (projectId: ProjectId) => void;
}) {
  const selected = projects.find((project) => project.id === value) ?? null;
  return (
    <div className="space-y-1">
      <span className={dialogFieldLabelClassName}>Project</span>
      <SettingsSelectControl
        value={value}
        onValueChange={(next) => onValueChange(next as ProjectId)}
        ariaLabel="Project"
        triggerClassName="w-full"
        valueContent={<span className="truncate">{selected?.name ?? "Choose a project"}</span>}
      >
        {projects.map((project) => (
          <SelectItem hideIndicator key={project.id} value={project.id}>
            <span className="truncate">{project.name}</span>
          </SelectItem>
        ))}
      </SettingsSelectControl>
    </div>
  );
}

export function CloudSubmitDialog({
  open,
  onOpenChange,
  provider,
  capabilities,
  projects,
  initialProjectId,
  hasUncertainSubmission,
  submitInFlight,
  onSubmitted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: CloudProvider;
  capabilities: CloudCapabilities;
  projects: ReadonlyArray<Project>;
  initialProjectId: ProjectId | null;
  hasUncertainSubmission: boolean;
  submitInFlight: boolean;
  onSubmitted: (submission: CloudSubmission) => void;
}) {
  const formId = useId();
  const environmentListId = useId();
  const queryClient = useQueryClient();
  const submitMutation = useMutation(cloudSubmitMutationOptions(queryClient));
  const [requestId, setRequestId] = useState(newRequestId);
  const [projectId, setProjectId] = useState(initialProjectId);
  const [environment, setEnvironment] = useState("");
  const [branchOverride, setBranchOverride] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [attempts, setAttempts] = useState(1);
  const [outcome, setOutcome] = useState<CloudSubmission | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [duplicateConfirmed, setDuplicateConfirmed] = useState(false);

  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setRequestId(newRequestId());
      setProjectId(initialProjectId);
      setEnvironment("");
      setBranchOverride(null);
      setPrompt("");
      setAttempts(1);
      setOutcome(null);
      setErrorText(null);
      setDuplicateConfirmed(false);
    }
  }

  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const branchesQuery = useQuery(gitBranchesQueryOptions(open ? (project?.cwd ?? null) : null));
  const environmentsQuery = useQuery(
    cloudEnvironmentsQueryOptions(provider, open && capabilities.canListEnvironments),
  );
  const environmentSuggestions = cloudEnvironmentSuggestions(
    environmentsQuery.data?.environments ?? [],
  );
  const branch = branchOverride ?? currentBranchName(branchesQuery.data?.branches ?? []);
  const attemptOptions = cloudAttemptOptions(capabilities.maxAttempts);
  const lockedByUncertain = outcome?.state === "uncertain";
  const needsDuplicateConfirm = hasUncertainSubmission && !duplicateConfirmed;
  const canSubmit =
    capabilities.canSubmit &&
    !submitMutation.isPending &&
    !submitInFlight &&
    !lockedByUncertain &&
    !needsDuplicateConfirm &&
    environment.trim().length > 0 &&
    branch.trim().length > 0 &&
    prompt.trim().length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    const submitRequestId = outcome?.state === "failed" ? newRequestId() : requestId;
    if (submitRequestId !== requestId) setRequestId(submitRequestId);
    setErrorText(null);
    setOutcome(null);
    void submitMutation
      .mutateAsync({
        provider,
        requestId: submitRequestId,
        environment: environment.trim(),
        branch: branch.trim(),
        prompt: prompt.trim(),
        ...(attempts > 1 ? { attempts } : {}),
        ...(projectId ? { projectId } : {}),
      })
      .then((submission) => {
        setOutcome(submission);
        if (submission.state === "submitted" || submission.state === "submitting") {
          toastManager.add({ type: "success", title: "Cloud task submitted" });
          onSubmitted(submission);
          onOpenChange(false);
        }
      })
      .catch((error: unknown) => {
        setErrorText(cloudErrorMessage(error));
      });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New cloud task</DialogTitle>
          <DialogDescription>
            Codex runs the task in its cloud environment on the branch you choose.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form id={formId} className="space-y-3" onSubmit={submit} noValidate>
            {projects.length > 1 ? (
              <CloudProjectSelect
                projects={projects}
                value={projectId}
                onValueChange={(next) => {
                  setProjectId(next);
                  setBranchOverride(null);
                }}
              />
            ) : null}
            <label className="block space-y-1">
              <span className={dialogFieldLabelClassName}>Environment</span>
              <Input
                size="sm"
                value={environment}
                onChange={(event) => setEnvironment(event.target.value)}
                list={environmentListId}
                placeholder="Environment ID or label"
                spellCheck={false}
                autoFocus
              />
              <datalist id={environmentListId}>
                {environmentSuggestions.map((suggestion) => (
                  <option key={suggestion} value={suggestion} />
                ))}
              </datalist>
              <span className="block text-ui-sm text-muted-foreground">
                The Codex cloud environment, as its ID or label.
              </span>
            </label>
            <label className="block space-y-1">
              <span className={dialogFieldLabelClassName}>Branch</span>
              <Input
                size="sm"
                className="font-mono"
                value={branch}
                onChange={(event) => setBranchOverride(event.target.value)}
                placeholder="main"
                spellCheck={false}
              />
            </label>
            <label className="block space-y-1">
              <span className={dialogFieldLabelClassName}>Task</span>
              <Textarea
                value={prompt}
                maxLength={CLOUD_SUBMIT_PROMPT_MAX_LENGTH}
                placeholder="Describe the task"
                aria-label="Task"
                className="[&_[data-slot=textarea]]:min-h-32 [&_[data-slot=textarea]]:resize-y"
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>
            {attemptOptions.length > 1 ? (
              <div className="space-y-1">
                <span className={dialogFieldLabelClassName}>Attempts</span>
                <SettingsSelectControl
                  value={String(attempts)}
                  onValueChange={(next) => setAttempts(Number(next))}
                  ariaLabel="Attempts"
                  triggerClassName="w-full"
                  valueContent={<span>{attempts}</span>}
                >
                  {attemptOptions.map((option) => (
                    <SelectItem hideIndicator key={option} value={String(option)}>
                      {option}
                    </SelectItem>
                  ))}
                </SettingsSelectControl>
              </div>
            ) : null}
            {hasUncertainSubmission && !lockedByUncertain ? (
              <label className="flex items-start gap-2 text-ui-sm text-muted-foreground">
                <Checkbox
                  checked={duplicateConfirmed}
                  onCheckedChange={(checked) => setDuplicateConfirmed(checked === true)}
                />
                <span>
                  An earlier submit has an unknown outcome. I understand this may create a duplicate
                  task.
                </span>
              </label>
            ) : null}
            {!capabilities.canSubmit ? (
              <Alert variant="warning" size="sm">
                <AlertDescription>
                  {capabilities.unavailableReason ?? "This CLI cannot submit cloud tasks."}
                </AlertDescription>
              </Alert>
            ) : null}
            {lockedByUncertain ? (
              <Alert variant="warning" size="sm">
                <AlertTitle>Outcome unknown</AlertTitle>
                <AlertDescription>
                  {outcome?.errorDetail ??
                    "Synara could not confirm whether Codex created the task."}{" "}
                  Check Codex before you submit again. Close and reopen this dialog to submit again.
                </AlertDescription>
              </Alert>
            ) : null}
            {outcome?.state === "failed" ? (
              <Alert variant="error" size="sm">
                <AlertTitle>Submit failed</AlertTitle>
                <AlertDescription>{outcome.errorDetail ?? "The submit failed."}</AlertDescription>
              </Alert>
            ) : null}
            {errorText ? (
              <Alert variant="error" size="sm">
                <AlertDescription>{errorText}</AlertDescription>
              </Alert>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {lockedByUncertain ? "Close" : "Cancel"}
          </Button>
          <Button type="submit" form={formId} disabled={!canSubmit}>
            {submitMutation.isPending
              ? "Submitting…"
              : outcome?.state === "failed"
                ? "Submit again"
                : "Submit"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
