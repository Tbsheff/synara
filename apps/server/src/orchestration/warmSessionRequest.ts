import { isDeepStrictEqual } from "node:util";
import type { OrchestrationThread, ThreadSessionWarmRequestedPayload } from "@synara/contracts";

export function isCurrentWarmSessionRequest(
  thread:
    | Pick<
        OrchestrationThread,
        | "modelSelection"
        | "runtimeMode"
        | "interactionMode"
        | "archivedAt"
        | "session"
        | "latestTurn"
        | "claudeCacheReview"
        | "parentThreadId"
        | "sidechatExpiredAt"
      >
    | undefined,
  request: ThreadSessionWarmRequestedPayload,
  now: number,
): boolean {
  return (
    thread !== undefined &&
    thread.archivedAt === null &&
    !thread.parentThreadId &&
    !thread.sidechatExpiredAt &&
    !thread.claudeCacheReview &&
    thread.latestTurn?.state !== "running" &&
    thread.session?.activeTurnId == null &&
    thread.session?.status !== "error" &&
    !(thread.session?.status === "stopped" && thread.session.updatedAt >= request.createdAt) &&
    now - Date.parse(request.createdAt) <= 30_000 &&
    isDeepStrictEqual(thread.modelSelection, request.modelSelection) &&
    thread.runtimeMode === request.runtimeMode &&
    thread.interactionMode === request.interactionMode
  );
}
