import type {
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@synara/contracts";
import { useEffect, useRef } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { addWsTransportStateListener } from "~/wsTransportEvents";
import type { Thread } from "~/types";

export function useWarmProviderSession(input: {
  thread: Thread | undefined;
  enabled: boolean;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  persistSettings: (input: {
    threadId: ThreadId;
    createdAt: string;
    modelSelection: ModelSelection;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  }) => Promise<void>;
}) {
  const key = JSON.stringify([
    input.thread?.id,
    input.enabled,
    input.modelSelection,
    input.runtimeMode,
    input.interactionMode,
  ]);
  const savedInstance =
    input.thread?.modelSelection.instanceId ?? input.thread?.modelSelection.provider;
  const lastRequest = useRef<{ key: string; at: number } | null>(null);
  const requestWarmSession = useStableCallback(() => {
    const { thread, modelSelection, runtimeMode, interactionMode } = input;
    const api = readNativeApi();
    if (
      !api ||
      !input.enabled ||
      !thread ||
      thread.archivedAt ||
      thread.sidechatExpiredAt ||
      thread.parentThreadId ||
      thread.claudeCacheReview ||
      thread.latestTurn?.state === "running" ||
      thread.session?.activeTurnId ||
      thread.session?.status === "error" ||
      modelSelection.provider !== thread.modelSelection.provider ||
      (modelSelection.instanceId ?? modelSelection.provider) !==
        (thread.modelSelection.instanceId ?? thread.modelSelection.provider)
    )
      return;
    const now = Date.now();
    if (lastRequest.current?.key === key && now - lastRequest.current.at < 30_000) return;
    lastRequest.current = { key, at: now };
    const createdAt = new Date(now).toISOString();
    void input
      .persistSettings({
        threadId: thread.id,
        createdAt,
        modelSelection,
        runtimeMode,
        interactionMode,
      })
      .then(() =>
        api.orchestration.dispatchCommand({
          type: "thread.session.warm",
          commandId: newCommandId(),
          threadId: thread.id,
          modelSelection,
          runtimeMode,
          interactionMode,
          createdAt,
        }),
      )
      .catch(() => {
        lastRequest.current = null;
      });
  });
  useEffect(() => {
    const timer = window.setTimeout(requestWarmSession, 250);
    return () => window.clearTimeout(timer);
  }, [key, savedInstance, requestWarmSession]);
  useEffect(
    () =>
      addWsTransportStateListener((state) => {
        if (state !== "open") return;
        lastRequest.current = null;
        requestWarmSession();
      }),
    [requestWarmSession],
  );
  return requestWarmSession;
}
