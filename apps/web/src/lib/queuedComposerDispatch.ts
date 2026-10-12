// FILE: queuedComposerDispatch.ts
// Purpose: Dispatch a snapshotted QueuedComposerTurn against a thread without ChatView.
// Layer: Web orchestration helper
// Exports: dispatchQueuedComposerTurnHeadless

import type { AssistantDeliveryMode, CommandId, MessageId, ThreadId } from "@synara/contracts";
import { resolveComputerInvocationMode } from "@synara/shared/computerInvocation";

import {
  persistModelSelectionBeforeRuntimeMode,
  resolveQueuedTurnDispatchSettings,
  turnStartDispatchFields,
  type TurnDispatchSettings,
} from "../components/ChatView.logic";
import { useComputerStateStore } from "../computerStateStore";
import {
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type PersistedComposerImageAttachment,
  type QueuedComposerChatTurn,
  type QueuedComposerTurn,
} from "../composerDraftStore";
import { hydrateImagesFromPersisted } from "../composerDraftAttachments";
import type { PersistedComposerFileAttachment } from "../composerDraftDomain";
import { toastManager } from "../components/ui/toast";
import { readNativeApi } from "../nativeApi";
import { clearPendingTurnDispatch, markPendingTurnDispatch } from "../pendingTurnDispatch";
import {
  buildSourceProposedPlanReference,
  findLatestProposedPlan,
  hasActionableProposedPlan,
} from "../session-logic";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";
import { appendAssistantSelectionsToPrompt } from "./assistantSelections";
import { appendBrowserAnnotationsToPrompt } from "./browserAnnotations";
import {
  filterPromptProviderMentionReferences,
  filterPromptSkillReferences,
} from "./composerMentions";
import { appendPastedTextsToPrompt, filterPastedTextsWithText } from "./composerPastedText";
import { appendPullRequestContextsToPrompt } from "./pullRequestContext";
import { persistComposerImageBlob, readComposerImageBlob } from "./composerImageBlobStore";
import {
  formatOutgoingComposerPrompt,
  hydratePendingBlobComposerAttachments,
  stageUploadComposerAttachments,
  type StagedComposerAttachments,
} from "./composerSend";
import {
  prepareComputerPermissionGuide,
  readLocalComputerPermissionBridge,
} from "./computerProvisioning";
import { appendFileCommentsToPrompt } from "./fileComments";
import {
  appendTerminalContextsToPrompt,
  filterTerminalContextsWithText,
  IMAGE_ONLY_BOOTSTRAP_PROMPT,
} from "./terminalContext";
import { runComposerSendOnce } from "./composerSendOwnership";
import { waitForDraftThreadDispatchToSettle } from "./draftThreadDispatch";
import { isRequestOutcomeUnknown } from "./requestOutcome";
import { newCommandId, newMessageId } from "./utils";

type NativeApi = NonNullable<ReturnType<typeof readNativeApi>>;
type OrchestrationCommand = Parameters<NativeApi["orchestration"]["dispatchCommand"]>[0];

interface UncertainTurnStart {
  readonly command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
  readonly staged: Promise<StagedComposerAttachments> | null;
}

const uncertainTurnStartByCommandId = new Map<CommandId, UncertainTurnStart>();

export function releaseQueuedComposerDispatchAttempt(commandId: CommandId): void {
  const uncertain = uncertainTurnStartByCommandId.get(commandId);
  if (!uncertain) {
    return;
  }
  uncertainTurnStartByCommandId.delete(commandId);
  void uncertain.staged?.then(
    (attachments) => attachments.cleanup(),
    () => undefined,
  );
}

async function sendQueuedTurnStart(input: {
  api: NativeApi;
  threadId: ThreadId;
  turnStart: UncertainTurnStart;
  onOutcomeUnknown: (() => void) | undefined;
}): Promise<boolean> {
  const { command, staged } = input.turnStart;
  try {
    await input.api.orchestration.dispatchCommand(command).catch((error: unknown) => {
      if (
        getThreadFromState(useStore.getState(), input.threadId)?.claudeCacheReview?.messageId !==
        command.message.messageId
      ) {
        throw error;
      }
    });
    (await staged)?.commit();
    return true;
  } catch (error) {
    if (isRequestOutcomeUnknown(error)) {
      uncertainTurnStartByCommandId.set(command.commandId, input.turnStart);
      input.onOutcomeUnknown?.();
    } else {
      await staged?.then(
        (attachments) => attachments.cleanup(),
        () => undefined,
      );
    }
    clearPendingTurnDispatch(input.threadId);
    return false;
  }
}

export async function persistQueuedComposerAttachments(input: {
  threadId: ThreadId;
  queuedTurnId: string;
  images: ReadonlyArray<ComposerImageAttachment>;
  files: ReadonlyArray<ComposerFileAttachment>;
}): Promise<{
  persistedImages: PersistedComposerImageAttachment[];
  persistedFiles: PersistedComposerFileAttachment[];
}> {
  const storeBlob = (attachmentId: string, file: File) =>
    persistComposerImageBlob({
      threadId: input.threadId,
      imageId: `queued:${input.queuedTurnId}:${attachmentId}`,
      file,
    }).catch((error: unknown) => {
      console.warn("[composer-queue] Could not store a queued attachment", error);
      return null;
    });
  const [persistedImages, persistedFiles] = await Promise.all([
    Promise.all(
      input.images.map(async (image): Promise<PersistedComposerImageAttachment> => {
        const blobKey = await storeBlob(image.id, image.file);
        return {
          id: image.id,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          ...(blobKey
            ? { blobKey }
            : image.previewUrl.startsWith("data:")
              ? { dataUrl: image.previewUrl }
              : {}),
          ...(image.source ? { source: image.source } : {}),
        };
      }),
    ),
    Promise.all(
      input.files.map(async (file): Promise<PersistedComposerFileAttachment> => {
        const blobKey = await storeBlob(file.id, file.file);
        return {
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          ...(blobKey ? { blobKey } : {}),
        };
      }),
    ),
  ]);
  return { persistedImages, persistedFiles };
}

async function restoreQueuedImage(
  persisted: PersistedComposerImageAttachment,
): Promise<ComposerImageAttachment | null> {
  if (persisted.blobKey) {
    return (await hydratePendingBlobComposerAttachments([persisted]))[0] ?? null;
  }
  return hydrateImagesFromPersisted([persisted])[0] ?? null;
}

async function restoreQueuedFile(
  persisted: PersistedComposerFileAttachment,
): Promise<ComposerFileAttachment | null> {
  if (!persisted.blobKey) {
    return null;
  }
  const file = await readComposerImageBlob(persisted.blobKey).catch(() => null);
  return file
    ? {
        type: "file",
        id: persisted.id,
        name: persisted.name,
        mimeType: persisted.mimeType,
        sizeBytes: persisted.sizeBytes,
        file,
      }
    : null;
}

export function hasUnrestoredQueuedComposerAttachments(
  queuedTurn: QueuedComposerChatTurn,
): boolean {
  const liveImageIds = new Set(queuedTurn.images.map((image) => image.id));
  const liveFileIds = new Set(queuedTurn.files.map((file) => file.id));
  return (
    (queuedTurn.persistedImages ?? []).some((image) => !liveImageIds.has(image.id)) ||
    (queuedTurn.persistedFiles ?? []).some((file) => !liveFileIds.has(file.id))
  );
}

export async function restoreQueuedComposerChatTurnAttachments(
  queuedTurn: QueuedComposerChatTurn,
): Promise<{ turn: QueuedComposerChatTurn; missingAttachmentNames: string[] }> {
  if (!hasUnrestoredQueuedComposerAttachments(queuedTurn)) {
    return { turn: queuedTurn, missingAttachmentNames: [] };
  }
  const liveImageById = new Map(queuedTurn.images.map((image) => [image.id, image]));
  const liveFileById = new Map(queuedTurn.files.map((file) => [file.id, file]));
  const persistedImages = queuedTurn.persistedImages ?? [];
  const persistedFiles = queuedTurn.persistedFiles ?? [];
  const missingAttachmentNames: string[] = [];
  const [restoredImages, restoredFiles] = await Promise.all([
    Promise.all(
      persistedImages.map(
        async (persisted) => liveImageById.get(persisted.id) ?? restoreQueuedImage(persisted),
      ),
    ),
    Promise.all(
      persistedFiles.map(
        async (persisted) => liveFileById.get(persisted.id) ?? restoreQueuedFile(persisted),
      ),
    ),
  ]);
  const images = restoredImages.flatMap((image, index) => {
    if (image) return [image];
    missingAttachmentNames.push(persistedImages[index]!.name);
    return [];
  });
  const files = restoredFiles.flatMap((file, index) => {
    if (file) return [file];
    missingAttachmentNames.push(persistedFiles[index]!.name);
    return [];
  });
  return { turn: { ...queuedTurn, images, files }, missingAttachmentNames };
}

const notifiedMissingAttachmentTurnIds = new Set<string>();

export function notifyQueuedComposerAttachmentsMissing(
  queuedTurnId: string,
  missingAttachmentNames: ReadonlyArray<string>,
): void {
  if (notifiedMissingAttachmentTurnIds.has(queuedTurnId)) {
    return;
  }
  notifiedMissingAttachmentTurnIds.add(queuedTurnId);
  toastManager.add({
    type: "error",
    title: "A queued message is missing attachments",
    description: `${missingAttachmentNames.join(", ")} could not be restored. Edit the queued message to attach them again, or delete it.`,
  });
}

export async function dispatchQueuedComposerTurnHeadless(input: {
  threadId: ThreadId;
  queuedTurn: QueuedComposerTurn;
  dispatchMode: "queue" | "steer";
  assistantDeliveryMode: AssistantDeliveryMode;
  computerControlEnabled?: boolean;
  messageId?: MessageId;
  commandId?: CommandId;
  createdAt?: string;
  onOutcomeUnknown?: () => void;
}): Promise<boolean> {
  return runComposerSendOnce(input.threadId, async () => {
    await waitForDraftThreadDispatchToSettle(input.threadId);
    return dispatchQueuedComposerTurnOnce(input);
  });
}

async function dispatchQueuedComposerTurnOnce(
  input: Parameters<typeof dispatchQueuedComposerTurnHeadless>[0],
): Promise<boolean> {
  const api = readNativeApi();
  if (!api) {
    return false;
  }

  const thread = getThreadFromState(useStore.getState(), input.threadId);
  if (!thread || thread.claudeCacheReview != null) {
    return false;
  }

  const uncertainTurnStart =
    input.commandId === undefined ? undefined : uncertainTurnStartByCommandId.get(input.commandId);
  if (uncertainTurnStart) {
    uncertainTurnStartByCommandId.delete(uncertainTurnStart.command.commandId);
    markPendingTurnDispatch(input.threadId);
    return sendQueuedTurnStart({
      api,
      threadId: input.threadId,
      turnStart: uncertainTurnStart,
      onOutcomeUnknown: input.onOutcomeUnknown,
    });
  }

  const createdAt = input.createdAt ?? new Date().toISOString();
  const messageId = input.messageId ?? newMessageId();
  const commandId = input.commandId ?? newCommandId();
  let queuedTurn = input.queuedTurn;
  if (queuedTurn.kind === "chat") {
    const restored = await restoreQueuedComposerChatTurnAttachments(queuedTurn);
    if (restored.missingAttachmentNames.length > 0) {
      notifyQueuedComposerAttachmentsMissing(queuedTurn.id, restored.missingAttachmentNames);
      return false;
    }
    queuedTurn = restored.turn;
  }
  const dispatchSettings = resolveHeadlessDispatchSettings({
    threadId: input.threadId,
    queuedTurn,
    assistantDeliveryMode: input.assistantDeliveryMode,
    computerControlEnabled: input.computerControlEnabled === true,
    threadInteractionMode: thread.interactionMode,
  });
  if (
    dispatchSettings.computerControlMode === "request" &&
    !(await isHeadlessComputerPermissionReady())
  ) {
    return false;
  }

  if (queuedTurn.kind === "plan-follow-up") {
    const trimmed = queuedTurn.text.trim();
    if (!trimmed) {
      return false;
    }
    const outgoingMessageText = formatOutgoingComposerPrompt({
      provider: queuedTurn.selectedProvider,
      model: queuedTurn.selectedModel,
      effort: queuedTurn.selectedPromptEffort,
      text: trimmed,
    });
    const latestProposedPlan = findLatestProposedPlan(
      thread.proposedPlans,
      thread.latestTurn?.turnId,
    );
    const sourceProposedPlan =
      queuedTurn.interactionMode === "default"
        ? buildSourceProposedPlanReference({
            threadId: input.threadId,
            proposedPlan: hasActionableProposedPlan(latestProposedPlan, thread.latestTurn)
              ? latestProposedPlan
              : null,
          })
        : undefined;

    markPendingTurnDispatch(input.threadId);
    try {
      await persistQueuedTurnThreadSettings({
        api,
        thread,
        queuedTurn,
        createdAt,
      });
      useComposerDraftStore
        .getState()
        .setInteractionMode(input.threadId, queuedTurn.interactionMode);
    } catch {
      clearPendingTurnDispatch(input.threadId);
      return false;
    }
    return sendQueuedTurnStart({
      api,
      threadId: input.threadId,
      turnStart: {
        command: {
          type: "thread.turn.start",
          commandId,
          threadId: input.threadId,
          message: {
            messageId,
            role: "user",
            text: outgoingMessageText,
            attachments: [],
          },
          ...turnStartDispatchFields(dispatchSettings, input.dispatchMode),
          ...(sourceProposedPlan ? { sourceProposedPlan } : {}),
          createdAt,
        },
        staged: null,
      },
      onOutcomeUnknown: input.onOutcomeUnknown,
    });
  }

  const sendableTerminalContexts = filterTerminalContextsWithText(queuedTurn.terminalContexts);
  const sendablePastedTexts = filterPastedTextsWithText(queuedTurn.pastedTexts);
  const messageText = appendBrowserAnnotationsToPrompt(
    appendPullRequestContextsToPrompt(
      appendPastedTextsToPrompt(
        appendFileCommentsToPrompt(
          appendTerminalContextsToPrompt(
            appendAssistantSelectionsToPrompt(queuedTurn.prompt, queuedTurn.assistantSelections),
            sendableTerminalContexts,
          ),
          queuedTurn.fileComments,
        ),
        sendablePastedTexts,
      ),
      queuedTurn.pullRequestContexts,
    ),
    queuedTurn.browserAnnotations,
    messageId,
  );
  const outgoingTextSeed =
    messageText || (queuedTurn.images.length > 0 ? IMAGE_ONLY_BOOTSTRAP_PROMPT : "");
  if (!outgoingTextSeed.trim() && queuedTurn.images.length === 0) {
    return false;
  }
  const outgoingMessageText = formatOutgoingComposerPrompt({
    provider: queuedTurn.selectedProvider,
    model: queuedTurn.selectedModel,
    effort: queuedTurn.selectedPromptEffort,
    text: outgoingTextSeed,
  });
  const mentionedSkills = filterPromptSkillReferences(
    outgoingMessageText,
    queuedTurn.skills,
    queuedTurn.selectedProvider,
  );
  const mentionedMentions = filterPromptProviderMentionReferences(
    outgoingMessageText,
    queuedTurn.mentions,
  );
  const turnAttachmentsPromise = stageUploadComposerAttachments({
    threadId: input.threadId,
    images: queuedTurn.images,
    files: queuedTurn.files,
    assistantSelections: queuedTurn.assistantSelections,
  });

  markPendingTurnDispatch(input.threadId);
  let stagedTurnAttachments: StagedComposerAttachments;
  try {
    await persistQueuedTurnThreadSettings({
      api,
      thread,
      queuedTurn,
      createdAt,
    });
    stagedTurnAttachments = await turnAttachmentsPromise;
  } catch {
    await turnAttachmentsPromise.then(
      (staged) => staged.cleanup(),
      () => undefined,
    );
    clearPendingTurnDispatch(input.threadId);
    return false;
  }
  return sendQueuedTurnStart({
    api,
    threadId: input.threadId,
    turnStart: {
      command: {
        type: "thread.turn.start",
        commandId,
        threadId: input.threadId,
        message: {
          messageId,
          role: "user",
          text: outgoingMessageText,
          attachments: stagedTurnAttachments.attachments,
          ...(mentionedSkills.length > 0 ? { skills: mentionedSkills } : {}),
          ...(mentionedMentions.length > 0 ? { mentions: mentionedMentions } : {}),
        },
        ...turnStartDispatchFields(dispatchSettings, input.dispatchMode),
        ...(queuedTurn.sourceProposedPlan
          ? { sourceProposedPlan: queuedTurn.sourceProposedPlan }
          : {}),
        createdAt,
      },
      staged: turnAttachmentsPromise,
    },
    onOutcomeUnknown: input.onOutcomeUnknown,
  });
}

function resolveHeadlessDispatchSettings(input: {
  threadId: ThreadId;
  queuedTurn: QueuedComposerTurn;
  assistantDeliveryMode: AssistantDeliveryMode;
  computerControlEnabled: boolean;
  threadInteractionMode: TurnDispatchSettings["interactionMode"];
}): TurnDispatchSettings {
  const draft = useComposerDraftStore.getState().draftsByThreadId[input.threadId];
  const liveComputerControlMode = resolveComputerInvocationMode({
    messageText: draft?.prompt ?? "",
    enableComputerControl: input.computerControlEnabled,
  });
  const liveSettings: TurnDispatchSettings = {
    modelSelection: input.queuedTurn.modelSelection,
    providerOptions: input.queuedTurn.providerOptionsForDispatch,
    enableComputerControl: liveComputerControlMode !== "off",
    computerControlMode: liveComputerControlMode,
    computerControlGeneration:
      useComputerStateStore.getState().threadStatesByThreadId[input.threadId]?.controlGeneration,
    assistantDeliveryMode: input.assistantDeliveryMode,
    runtimeMode: input.queuedTurn.runtimeMode,
    interactionMode: input.threadInteractionMode,
    envMode: input.queuedTurn.kind === "chat" ? input.queuedTurn.envMode : "local",
  };
  return resolveQueuedTurnDispatchSettings(liveSettings, input.queuedTurn);
}

async function isHeadlessComputerPermissionReady(): Promise<boolean> {
  const appSnap = readLocalComputerPermissionBridge();
  return prepareComputerPermissionGuide({
    ...(appSnap
      ? {
          getPermissionState: appSnap.getState,
          startPermissionSetup: async () => undefined,
        }
      : {}),
    isCurrent: () => true,
  }).catch(() => false);
}

async function persistQueuedTurnThreadSettings(input: {
  api: NonNullable<ReturnType<typeof readNativeApi>>;
  thread: NonNullable<ReturnType<typeof getThreadFromState>>;
  queuedTurn: QueuedComposerTurn;
  createdAt: string;
}): Promise<void> {
  await persistModelSelectionBeforeRuntimeMode({
    currentModelSelection: input.thread.modelSelection,
    nextModelSelection: input.queuedTurn.modelSelection,
    currentRuntimeMode: input.thread.runtimeMode,
    nextRuntimeMode: input.queuedTurn.runtimeMode,
    persistModelSelection: (modelSelection) =>
      input.api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: input.thread.id,
        modelSelection,
      }),
    persistRuntimeMode: (runtimeMode) =>
      input.api.orchestration.dispatchCommand({
        type: "thread.runtime-mode.set",
        commandId: newCommandId(),
        threadId: input.thread.id,
        runtimeMode,
        createdAt: input.createdAt,
      }),
  });

  if (input.queuedTurn.interactionMode !== input.thread.interactionMode) {
    await input.api.orchestration.dispatchCommand({
      type: "thread.interaction-mode.set",
      commandId: newCommandId(),
      threadId: input.thread.id,
      interactionMode: input.queuedTurn.interactionMode,
      createdAt: input.createdAt,
    });
  }
}
