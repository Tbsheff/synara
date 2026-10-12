import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderApprovalRule,
  ProviderRequestKind,
  RuntimeMode,
  ThreadId,
} from "@synara/contracts";
import {
  APPROVAL_ALREADY_ANSWERED_INVARIANT_MARKER,
  collectErrorMessages,
  describeErrorMessage,
} from "@synara/shared/errorMessages";

import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "../../store";
import {
  buildThreadSubscribeInput,
  clearThreadDetailResumeCursor,
} from "../../threadDetailResumeCursors";

/**
 * Sends the decision. Resolves when it was recorded — including when another surface
 * answered first — and rejects (after surfacing the error on the thread) otherwise.
 */
export async function respondToThreadApproval(input: {
  threadId: ThreadId;
  requestId: ApprovalRequestId;
  decision: ProviderApprovalDecision;
  approvalRule?: ProviderApprovalRule;
  lifecycleGeneration?: string | undefined;
  requestKind?: ProviderRequestKind | undefined;
  runtimeMode: RuntimeMode;
}): Promise<void> {
  const api = readNativeApi();
  if (!api) return;
  const { threadId, requestId, decision, lifecycleGeneration } = input;
  const setThreadError = useStore.getState().setError;
  await api.orchestration
    .dispatchCommand({
      type: "thread.approval.respond",
      commandId: newCommandId(),
      threadId,
      requestId,
      decision,
      ...(input.approvalRule ? { approvalRule: input.approvalRule } : {}),
      ...(lifecycleGeneration !== undefined ? { lifecycleGeneration } : {}),
      createdAt: new Date().toISOString(),
    })
    .then(
      () => true,
      async (err: unknown) => {
        if (
          collectErrorMessages(err).some((message) =>
            message.includes(APPROVAL_ALREADY_ANSWERED_INVARIANT_MARKER),
          )
        ) {
          clearThreadDetailResumeCursor(threadId);
          await api.orchestration.subscribeThread(buildThreadSubscribeInput(threadId)).catch(() => {
            setThreadError(
              threadId,
              "Approval was already recorded, but the conversation could not be refreshed.",
            );
          });
          return false;
        }
        setThreadError(threadId, describeErrorMessage(err, "Failed to submit approval decision."));
        throw err;
      },
    );
}
