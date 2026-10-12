// FILE: useComposerVoiceController.ts
// Purpose: Own the composer voice-note state machine for recording, cancellation, and transcription.
// Layer: Chat composer hook
// Depends on: useVoiceRecorder, ChatView voice helper logic, and the native API voice endpoint.

import {
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProviderStatus,
  type ThreadId,
} from "@synara/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Project } from "../../types";
import {
  formatVoiceRecordingDuration,
  isVoiceRecordingCancelledError,
  useVoiceRecorder,
  type VoiceRecordingPayload,
} from "../../lib/voiceRecorder";
import { readNativeApi } from "../../nativeApi";
import type { NativeApi } from "@synara/contracts";
import type { RefreshProviderStatusesNow } from "../../hooks/useProviderStatusRefresh";
import { toastManager, reportToastIssue } from "../ui/toast";
import { diagnosticIssueReason } from "../../lib/rendererErrorDiagnostics";
import {
  deriveComposerVoiceState,
  describeVoiceRecordingStartError,
  isVoiceAuthExpiredMessage,
  sanitizeVoiceErrorMessage,
} from "../ChatView.logic";

export interface ComposerVoiceFailureCopy {
  transcriptionFailedTitle: string;
  fallbackDescription: string;
  authExpiredTitle: string;
  authExpiredDescription: string;
  refreshActionLabel: string;
  retryActionLabel: string;
  discardActionLabel: string;
}

interface FailedVoiceNote {
  readonly payload: VoiceRecordingPayload;
  readonly threadId: ThreadId;
  readonly toastId: string;
}

interface ComposerVoiceGuardDetails {
  readonly [key: string]: unknown;
}

export interface UseComposerVoiceControllerOptions {
  activeProject: Project | undefined;
  activeThreadId: ThreadId | null;
  threadId: ThreadId;
  selectedProvider: ProviderKind;
  selectedProviderInstanceId: ProviderInstanceId;
  voiceProviderInstanceId: ProviderInstanceId;
  activeProviderStatus: ServerProviderStatus | null;
  pendingUserInputCount: number;
  onTranscriptReady: (transcript: string) => void;
  refreshVoiceStatus: RefreshProviderStatusesNow;
  actionArmDelayMs?: number;
  failureCopy?: Partial<ComposerVoiceFailureCopy>;
  onGuardWarning?: (message: string, details: ComposerVoiceGuardDetails) => void;
}

export interface UseComposerVoiceControllerResult {
  isVoiceRecording: boolean;
  // The microphone is opening; nothing is recording yet.
  isVoiceStarting: boolean;
  // Recording, but the device has not delivered real audio yet.
  isVoiceWaitingForAudio: boolean;
  isVoiceTranscribing: boolean;
  voiceWaveformLevels: readonly number[];
  voiceRecordingDurationLabel: string;
  showVoiceNotesControl: boolean;
  startComposerVoiceRecording: () => Promise<void>;
  // Resolves true only when a current transcript reached onTranscriptReady.
  submitComposerVoiceRecording: () => Promise<boolean>;
  cancelComposerVoiceRecording: () => void;
}

const DEFAULT_FAILURE_COPY: ComposerVoiceFailureCopy = {
  transcriptionFailedTitle: "Voice transcription failed",
  fallbackDescription: "The voice note could not be transcribed.",
  authExpiredTitle: "Sign in to ChatGPT again",
  authExpiredDescription:
    "Voice transcription uses your ChatGPT session in Codex. That session was rejected, so sign in again there and retry.",
  refreshActionLabel: "Refresh status",
  retryActionLabel: "Retry",
  discardActionLabel: "Discard",
};

function releaseFailedVoiceNote(failedVoiceNoteRef: { current: FailedVoiceNote | null }) {
  const failedVoiceNote = failedVoiceNoteRef.current;
  if (!failedVoiceNote) {
    return;
  }
  failedVoiceNoteRef.current = null;
  toastManager.close(failedVoiceNote.toastId);
}

// Keeps the async transcription lifecycle out of ChatView so the component can stay UI-focused.
export function useComposerVoiceController(
  options: UseComposerVoiceControllerOptions,
): UseComposerVoiceControllerResult {
  const {
    activeProject,
    activeThreadId,
    threadId,
    selectedProvider,
    selectedProviderInstanceId,
    voiceProviderInstanceId,
    activeProviderStatus,
    pendingUserInputCount,
    onTranscriptReady,
    refreshVoiceStatus,
    actionArmDelayMs: actionArmDelayMsProp,
    failureCopy: failureCopyOverrides,
    onGuardWarning,
  } = options;
  const actionArmDelayMs = actionArmDelayMsProp ?? 0;
  const {
    isRecording: isVoiceRecording,
    isStarting: isVoiceStarting,
    hasAudioSignal: hasVoiceAudioSignal,
    durationMs: voiceRecordingDurationMs,
    waveformLevels: voiceWaveformLevels,
    startRecording: startVoiceRecording,
    stopRecording: stopVoiceRecording,
    cancelRecording: cancelVoiceRecording,
  } = useVoiceRecorder();
  const [isVoiceTranscribing, setIsVoiceTranscribing] = useState(false);
  const voiceTranscriptionRequestIdRef = useRef(0);
  const voiceThreadIdRef = useRef(threadId);
  const voiceProviderRef = useRef<ProviderKind>(selectedProvider);
  const composerProviderInstanceRef = useRef<ProviderInstanceId>(selectedProviderInstanceId);
  const voiceProviderInstanceRef = useRef<ProviderInstanceId>(voiceProviderInstanceId);
  const voiceRecordingStartedAtRef = useRef<number | null>(null);
  const failedVoiceNoteRef = useRef<FailedVoiceNote | null>(null);
  const failureCopy = {
    ...DEFAULT_FAILURE_COPY,
    ...failureCopyOverrides,
  };
  // A transcription can resolve immediately after navigation commits, so stamp
  // its identity before passive effects and browser events can observe it.
  useLayoutEffect(() => {
    voiceThreadIdRef.current = threadId;
    voiceProviderRef.current = selectedProvider;
    composerProviderInstanceRef.current = selectedProviderInstanceId;
    voiceProviderInstanceRef.current = voiceProviderInstanceId;
  }, [threadId, selectedProvider, selectedProviderInstanceId, voiceProviderInstanceId]);

  const voiceRecordingDurationLabel = formatVoiceRecordingDuration(voiceRecordingDurationMs);
  const { canStartVoiceNotes, showVoiceNotesControl } = deriveComposerVoiceState({
    enabled: activeProviderStatus?.enabled,
    available: activeProviderStatus?.available === true,
    authStatus: activeProviderStatus?.authStatus,
    voiceTranscriptionAvailable: activeProviderStatus?.voiceTranscriptionAvailable,
    isRecording: isVoiceRecording,
    isTranscribing: isVoiceTranscribing,
  });

  useEffect(() => {
    const invalidatedRequestId = voiceTranscriptionRequestIdRef.current + 1;
    voiceTranscriptionRequestIdRef.current = invalidatedRequestId;
    voiceRecordingStartedAtRef.current = null;
    releaseFailedVoiceNote(failedVoiceNoteRef);
    // The spinner reset rides the cancel promise so no state is written
    // synchronously inside the effect (keeps the hook compiler-eligible).
    void cancelVoiceRecording().finally(() => {
      if (voiceTranscriptionRequestIdRef.current === invalidatedRequestId) {
        setIsVoiceTranscribing(false);
      }
    });
  }, [
    cancelVoiceRecording,
    selectedProvider,
    selectedProviderInstanceId,
    threadId,
    voiceProviderInstanceId,
  ]);

  useEffect(
    () => () => {
      voiceTranscriptionRequestIdRef.current += 1;
      voiceRecordingStartedAtRef.current = null;
      releaseFailedVoiceNote(failedVoiceNoteRef);
    },
    [],
  );

  useEffect(() => {
    if (canStartVoiceNotes || !isVoiceRecording) {
      return;
    }
    onGuardWarning?.("cancelled active voice recording because voice became unavailable", {
      authStatus: activeProviderStatus?.authStatus ?? null,
      voiceTranscriptionAvailable: activeProviderStatus?.voiceTranscriptionAvailable ?? null,
      isVoiceRecording,
    });
    const invalidatedRequestId = voiceTranscriptionRequestIdRef.current + 1;
    voiceTranscriptionRequestIdRef.current = invalidatedRequestId;
    voiceRecordingStartedAtRef.current = null;
    void cancelVoiceRecording().finally(() => {
      if (voiceTranscriptionRequestIdRef.current === invalidatedRequestId) {
        setIsVoiceTranscribing(false);
      }
    });
  }, [
    activeProviderStatus?.authStatus,
    activeProviderStatus?.voiceTranscriptionAvailable,
    canStartVoiceNotes,
    cancelVoiceRecording,
    isVoiceRecording,
    onGuardWarning,
  ]);

  const isVoiceActionArmed = () => {
    if (actionArmDelayMs <= 0 || voiceRecordingStartedAtRef.current === null) {
      return true;
    }
    const recordedForMs = Math.round(performance.now() - voiceRecordingStartedAtRef.current);
    if (recordedForMs < 0 || recordedForMs >= actionArmDelayMs) {
      return true;
    }
    onGuardWarning?.("ignored recorder action immediately after start", {
      recordedForMs,
    });
    return false;
  };

  const startComposerVoiceRecording = async () => {
    if (!activeProject) {
      return;
    }
    if (activeProviderStatus?.authStatus === "unauthenticated") {
      toastManager.add({
        type: "error",
        title: "Sign in to ChatGPT in Codex before using voice notes.",
      });
      return;
    }
    if (!canStartVoiceNotes) {
      toastManager.add({
        type: "error",
        title: "Voice notes require a ChatGPT-authenticated Codex session.",
      });
      return;
    }
    if (pendingUserInputCount > 0) {
      toastManager.add({
        type: "error",
        title: "Answer plan questions before recording a voice note.",
      });
      return;
    }

    releaseFailedVoiceNote(failedVoiceNoteRef);
    try {
      await startVoiceRecording();
      voiceRecordingStartedAtRef.current = performance.now();
      const api = readNativeApi();
      void api?.server
        .prewarmVoice?.({
          provider: "codex",
          providerInstanceId: voiceProviderInstanceId,
          cwd: activeProject.cwd,
          ...(activeThreadId ? { threadId: activeThreadId } : {}),
        })
        .catch(() => undefined);
    } catch (error) {
      if (isVoiceRecordingCancelledError(error)) {
        return;
      }
      const toastId = toastManager.add({
        type: "error",
        title: "Could not start recording",
        description: describeVoiceRecordingStartError(error),
      });
      reportToastIssue(toastId, {
        code: "voice.record.failed",
        reason: diagnosticIssueReason(error),
      });
    }
  };

  const beginVoiceTranscriptionRequest = () => {
    setIsVoiceTranscribing(true);
    const requestId = voiceTranscriptionRequestIdRef.current + 1;
    voiceTranscriptionRequestIdRef.current = requestId;
    const requestThreadId = threadId;
    const requestProvider = selectedProvider;
    const requestProviderInstanceId = selectedProviderInstanceId;
    const requestVoiceProviderInstanceId = voiceProviderInstanceId;
    return () =>
      voiceTranscriptionRequestIdRef.current === requestId &&
      voiceThreadIdRef.current === requestThreadId &&
      voiceProviderRef.current === requestProvider &&
      composerProviderInstanceRef.current === requestProviderInstanceId &&
      voiceProviderInstanceRef.current === requestVoiceProviderInstanceId;
  };

  const transcribeVoicePayload = (
    api: NativeApi,
    cwd: string,
    payload: VoiceRecordingPayload,
    isCurrentVoiceRequest: () => boolean,
  ) =>
    api.server
      .transcribeVoice({
        provider: "codex",
        providerInstanceId: voiceProviderInstanceId,
        cwd,
        ...(activeThreadId ? { threadId: activeThreadId } : {}),
        ...payload,
      })
      .then((result) => {
        if (!isCurrentVoiceRequest()) {
          return false;
        }
        onTranscriptReady(result.text);
        return true;
      });

  const settleVoiceTranscriptionRequest = (isCurrentVoiceRequest: () => boolean) => {
    if (isCurrentVoiceRequest()) {
      voiceRecordingStartedAtRef.current = null;
      setIsVoiceTranscribing(false);
    }
  };

  const retryFailedVoiceNote = (failedVoiceNote: FailedVoiceNote): Promise<boolean> => {
    if (failedVoiceNoteRef.current !== failedVoiceNote) {
      return Promise.resolve(false);
    }
    releaseFailedVoiceNote(failedVoiceNoteRef);
    const api = readNativeApi();
    if (!activeProject || !api || voiceThreadIdRef.current !== failedVoiceNote.threadId) {
      return Promise.resolve(false);
    }
    const startedAt = performance.now();
    const isCurrentVoiceRequest = beginVoiceTranscriptionRequest();
    return transcribeVoicePayload(
      api,
      activeProject.cwd,
      failedVoiceNote.payload,
      isCurrentVoiceRequest,
    )
      .catch((error: unknown) =>
        reportVoiceTranscriptionFailure(error, {
          isCurrentVoiceRequest,
          startedAt,
          failedPayload: failedVoiceNote.payload,
        }),
      )
      .finally(() => settleVoiceTranscriptionRequest(isCurrentVoiceRequest));
  };

  const reportVoiceTranscriptionFailure = (
    error: unknown,
    request: {
      isCurrentVoiceRequest: () => boolean;
      startedAt: number;
      failedPayload: VoiceRecordingPayload | null;
    },
  ): false => {
    if (!request.isCurrentVoiceRequest()) {
      return false;
    }

    const description =
      error instanceof Error
        ? sanitizeVoiceErrorMessage(error.message)
        : failureCopy.fallbackDescription;
    const authExpired = isVoiceAuthExpiredMessage(description);
    if (authExpired) {
      void refreshVoiceStatus();
    }
    const failedPayload = request.failedPayload;
    const failedVoiceNoteHolder: { current: FailedVoiceNote | null } = { current: null };
    const retryAction = {
      children: failureCopy.retryActionLabel,
      onClick: () => {
        if (failedVoiceNoteHolder.current) {
          void retryFailedVoiceNote(failedVoiceNoteHolder.current);
        }
      },
    };
    const discardFailedVoiceNote = () => {
      if (failedVoiceNoteRef.current === failedVoiceNoteHolder.current) {
        releaseFailedVoiceNote(failedVoiceNoteRef);
      }
    };
    const refreshAction = {
      children: failureCopy.refreshActionLabel,
      onClick: () => {
        void refreshVoiceStatus();
      },
    };
    const discardAction = {
      children: failureCopy.discardActionLabel,
      onClick: discardFailedVoiceNote,
    };
    const retryData = {
      secondaryActionProps: authExpired ? retryAction : discardAction,
      onClose: discardFailedVoiceNote,
    };
    const primaryAction = authExpired ? refreshAction : failedPayload ? retryAction : null;
    const toastId = toastManager.add({
      type: "error",
      title: authExpired ? failureCopy.authExpiredTitle : failureCopy.transcriptionFailedTitle,
      description: authExpired ? failureCopy.authExpiredDescription : description,
      ...(primaryAction ? { actionProps: primaryAction } : {}),
      ...(failedPayload ? { data: retryData } : {}),
    });
    if (failedPayload) {
      releaseFailedVoiceNote(failedVoiceNoteRef);
      failedVoiceNoteHolder.current = { payload: failedPayload, threadId, toastId };
      failedVoiceNoteRef.current = failedVoiceNoteHolder.current;
    }
    reportToastIssue(toastId, {
      code: failedPayload ? "voice.transcribe.failed" : "voice.record.failed",
      reason: authExpired ? "auth" : diagnosticIssueReason(error),
      durationMs: performance.now() - request.startedAt,
    });
    return false;
  };

  const submitComposerVoiceRecording = (): Promise<boolean> => {
    if (!activeProject || !isVoiceRecording) {
      return Promise.resolve(false);
    }
    if (!isVoiceActionArmed()) {
      return Promise.resolve(false);
    }

    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Voice transcription is unavailable right now.",
      });
      void cancelVoiceRecording();
      return Promise.resolve(false);
    }

    releaseFailedVoiceNote(failedVoiceNoteRef);
    const startedAt = performance.now();
    let transcribedPayload: VoiceRecordingPayload | null = null;
    const isCurrentVoiceRequest = beginVoiceTranscriptionRequest();

    // Promise chain instead of async/try-catch-finally: React Compiler does
    // not yet support try/finally, and it would skip optimizing this hook.
    return stopVoiceRecording()
      .then((payload): Promise<boolean> | boolean => {
        if (!isCurrentVoiceRequest()) {
          return false;
        }
        if (!payload) {
          toastManager.add({
            type: "warning",
            title: "No audio was captured.",
          });
          return false;
        }
        transcribedPayload = payload;
        return transcribeVoicePayload(api, activeProject.cwd, payload, isCurrentVoiceRequest);
      })
      .catch((error: unknown) =>
        reportVoiceTranscriptionFailure(error, {
          isCurrentVoiceRequest,
          startedAt,
          failedPayload: transcribedPayload,
        }),
      )
      .finally(() => settleVoiceTranscriptionRequest(isCurrentVoiceRequest));
  };

  const cancelComposerVoiceRecording = () => {
    if (!isVoiceActionArmed()) {
      return;
    }
    voiceTranscriptionRequestIdRef.current += 1;
    voiceRecordingStartedAtRef.current = null;
    setIsVoiceTranscribing(false);
    void cancelVoiceRecording();
  };

  return {
    isVoiceRecording,
    isVoiceStarting,
    isVoiceWaitingForAudio: isVoiceRecording && !hasVoiceAudioSignal,
    isVoiceTranscribing,
    voiceWaveformLevels,
    voiceRecordingDurationLabel,
    showVoiceNotesControl,
    startComposerVoiceRecording,
    submitComposerVoiceRecording,
    cancelComposerVoiceRecording,
  };
}
