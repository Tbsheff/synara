// FILE: useKanbanTaskSubmit.ts
// Purpose: Owns the kanban new-task dialog's draft/create/send lifecycle.
// Layer: Kanban UI hook
// Exports: useKanbanTaskSubmit

import type {
  AssistantDeliveryMode,
  ModelSlug,
  ProjectId,
  ProviderInteractionMode,
  ProviderInstanceId,
  ProviderKind,
  ProviderStartOptions,
  RuntimeMode,
  ServerProviderStatus,
  ThreadId,
} from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import type { ProviderInstanceOption } from "~/appSettings";
import type { DraftThreadEnvMode } from "~/composerDraftStore";
import { providerInstanceModelSelectionKey, useComposerDraftStore } from "~/composerDraftStore";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { createAndSendKanbanTask, createKanbanDraftTask } from "~/lib/kanbanTaskCreate";
import { resolveProviderSendAvailabilityWithRefresh } from "~/lib/providerAvailability";
import { buildModelSelection } from "~/providerModelOptions";
import { isRequestOutcomeUnknown } from "~/lib/requestOutcome";
import { truncateKanbanTaskPreview } from "./KanbanNewTaskDialog.logic";

interface UseKanbanTaskSubmitInput {
  readonly selectedProjectId: ProjectId | null;
  readonly hasSendableContent: boolean;
  readonly selectedProvider: ProviderKind;
  readonly selectedProviderInstanceId: ProviderInstanceId;
  readonly selectedModel: ModelSlug | null;
  readonly selectedModelSupportsAutoMode: boolean | undefined;
  readonly taskPreview: string;
  readonly trimmedPrompt: string;
  readonly scratchThreadId: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly envMode: DraftThreadEnvMode;
  readonly sendAsDraft: boolean;
  /** New-task dialog "send as goal" toggle (off by default; dialog-owned state). */
  readonly sendAsGoal?: boolean | undefined;
  readonly defaultProvider: ProviderKind;
  readonly assistantDeliveryMode: AssistantDeliveryMode;
  readonly providerOptionsForDispatch: ProviderStartOptions | undefined;
  readonly providerInstances: ReadonlyArray<
    Pick<ProviderInstanceOption, "instanceId" | "provider">
  >;
  readonly providerStatuses: readonly ServerProviderStatus[];
  readonly isPreparingImages: boolean;
  readonly waitForPendingImages: () => Promise<void>;
  readonly onOpenChange: (open: boolean) => void;
}

export function useKanbanTaskSubmit(input: UseKanbanTaskSubmitInput) {
  const {
    selectedProjectId,
    hasSendableContent,
    selectedProvider,
    selectedProviderInstanceId,
    selectedModel,
    selectedModelSupportsAutoMode,
    taskPreview,
    trimmedPrompt,
    scratchThreadId,
    runtimeMode,
    interactionMode,
    envMode,
    sendAsDraft,
    sendAsGoal = false,
    defaultProvider,
    assistantDeliveryMode,
    providerOptionsForDispatch,
    providerInstances,
    providerStatuses,
    isPreparingImages,
    waitForPendingImages,
    onOpenChange,
  } = input;
  const navigate = useNavigate();
  const [isCreating, setIsCreating] = useState(false);
  const [isSendOutcomeUnknown, setIsSendOutcomeUnknown] = useState(false);
  const refreshProviderStatuses = useRefreshProviderStatusesNow();
  // Synchronous re-entry guard: repeated Cmd+Enter can fire before React flushes
  // the loading state, and two passes here would create two tasks.
  const isCreatingRef = useRef(false);
  const createdTaskRef = useRef<ThreadId | undefined>(undefined);
  const savedTaskTargetRef = useRef<{ projectId: ProjectId; envMode: DraftThreadEnvMode } | null>(
    null,
  );
  const [savedTaskTarget, setSavedTaskTarget] = useState(savedTaskTargetRef.current);
  const taskTargetMatches =
    savedTaskTarget === null ||
    (savedTaskTarget.projectId === selectedProjectId && savedTaskTarget.envMode === envMode);
  const rememberCreatedTask = (threadId: ThreadId) => {
    createdTaskRef.current = threadId;
    if (savedTaskTargetRef.current === null && selectedProjectId !== null) {
      savedTaskTargetRef.current = { projectId: selectedProjectId, envMode };
      setSavedTaskTarget(savedTaskTargetRef.current);
    }
  };

  const canCreate =
    selectedProjectId !== null &&
    hasSendableContent &&
    selectedModel !== null &&
    !isCreating &&
    !isPreparingImages &&
    !(sendAsDraft && isSendOutcomeUnknown) &&
    taskTargetMatches;

  const handleCreate = async () => {
    if (
      !selectedProjectId ||
      !hasSendableContent ||
      selectedModel === null ||
      isCreating ||
      isCreatingRef.current ||
      (sendAsDraft && isSendOutcomeUnknown) ||
      (savedTaskTargetRef.current !== null &&
        (savedTaskTargetRef.current.projectId !== selectedProjectId ||
          savedTaskTargetRef.current.envMode !== envMode))
    ) {
      return;
    }

    isCreatingRef.current = true;
    try {
      await waitForPendingImages();
    } catch (error) {
      isCreatingRef.current = false;
      toastManager.add({
        type: "error",
        title: "Could not prepare task images",
        description: error instanceof Error ? error.message : "Try adding the images again.",
      });
      return;
    }
    const truncatedPrompt = truncateKanbanTaskPreview(taskPreview);
    // The scratch draft carries the full selection (model + reasoning effort +
    // speed) set through the picker; fall back to a bare selection otherwise.
    const scratchState = useComposerDraftStore.getState().draftsByThreadId[scratchThreadId];
    const storedModelSelection =
      scratchState?.modelSelectionByProvider[
        providerInstanceModelSelectionKey(selectedProvider, selectedProviderInstanceId)
      ];
    const storedModelSupportsAutoMode =
      storedModelSelection?.provider === "claudeAgent"
        ? storedModelSelection.supportsAutoMode
        : undefined;
    const modelSelection = buildModelSelection(
      selectedProvider,
      storedModelSelection?.model ?? selectedModel,
      storedModelSelection?.options,
      selectedProvider === "claudeAgent"
        ? (selectedModelSupportsAutoMode ?? storedModelSupportsAutoMode)
        : undefined,
      { instanceId: selectedProviderInstanceId },
    );
    const taskInput = {
      projectId: selectedProjectId,
      prompt: trimmedPrompt,
      sourceComposerThreadId: scratchThreadId,
      modelSelection,
      runtimeMode,
      interactionMode,
      envMode,
    };

    if (sendAsDraft) {
      createdTaskRef.current = createKanbanDraftTask({
        ...taskInput,
        threadId: createdTaskRef.current,
      });
      toastManager.add({
        type: "success",
        title: "Task added to Drafts",
        description: truncatedPrompt,
      });
      onOpenChange(false);
      return;
    }

    // Send now: create + promote + dispatch straight to In Progress.
    const sendAvailability = await resolveProviderSendAvailabilityWithRefresh({
      provider: modelSelection.provider,
      instanceId: modelSelection.instanceId ?? selectedProviderInstanceId,
      statuses: providerStatuses,
      refreshStatuses: () => refreshProviderStatuses({ silent: true }),
    });
    if (!sendAvailability.usable) {
      toastManager.add({
        type: "error",
        title: sendAvailability.unavailableReason,
      });
      isCreatingRef.current = false;
      return;
    }

    setIsCreating(true);
    void createAndSendKanbanTask({
      ...taskInput,
      threadId: createdTaskRef.current,
      onCreated: rememberCreatedTask,
      defaultProvider,
      assistantDeliveryMode,
      providerOptions: providerOptionsForDispatch,
      ...(sendAsGoal ? { sendAsGoal: true as const } : {}),
      providerInstances,
    })
      .then(({ threadId, result }) => {
        rememberCreatedTask(threadId);
        setIsSendOutcomeUnknown(result.kind === "error" && result.outcomeUnknown === true);
        if (result.kind === "dispatched") {
          if (result.deferred) {
            toastManager.add({
              type: "info",
              title: "Chat send in progress",
              description: "This task is already being sent from its chat.",
            });
            onOpenChange(false);
            return;
          }
          toastManager.add({
            type: result.warning ? "warning" : "success",
            title: "Task started",
            description: result.warning ?? truncatedPrompt,
          });
          onOpenChange(false);
          return;
        }
        if (result.kind === "open-thread") {
          toastManager.add({
            type: "info",
            title: "Finish this task in the chat",
            description:
              result.reason === "worktree-pending"
                ? "Open the chat to set up the worktree and send this task."
                : "The task was saved as a draft.",
          });
          onOpenChange(false);
          void navigate({ to: "/$threadId", params: { threadId } });
          return;
        }
        // Promotion/dispatch could not complete faithfully; the draft still
        // exists on the board, so surface the failure and keep the dialog open.
        toastManager.add({
          type: "error",
          title: "Couldn't start the task",
          description:
            result.kind === "error"
              ? result.message
              : "The task was saved to Drafts instead. Open it to send manually.",
        });
        isCreatingRef.current = false;
        setIsCreating(false);
      })
      .catch((error: unknown) => {
        setIsSendOutcomeUnknown(isRequestOutcomeUnknown(error));
        toastManager.add({
          type: "error",
          title: "Couldn't start the task",
          description: error instanceof Error ? error.message : "Unexpected error.",
        });
        isCreatingRef.current = false;
        setIsCreating(false);
      });
  };

  return {
    isCreating,
    canCreate,
    savedTaskTarget,
    handleCreate,
  };
}
