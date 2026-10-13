import type { OrchestrationThread, ThreadId } from "@synara/contracts";
import { ownedThreadParentId } from "@synara/shared/threadHierarchy";
import { threadHasInFlightTurn } from "./commandInvariants";

export function archivedOwnerOfFinishedThread(
  threads: readonly OrchestrationThread[],
  threadId: ThreadId,
): ThreadId | null {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const thread = byId.get(threadId);
  if (
    !thread ||
    thread.deletedAt ||
    thread.archivedAt ||
    thread.parentThreadId ||
    threadHasInFlightTurn(thread)
  )
    return null;
  const visited = new Set<string>([threadId]);
  let parentId = ownedThreadParentId(thread);
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId as ThreadId);
    if (!parent || parent.deletedAt || parent.projectId !== thread.projectId) return null;
    if (parent.archivedAt) {
      const owner = parent.archivedByThreadId ? byId.get(parent.archivedByThreadId) : undefined;
      return owner?.archivedAt && !owner.deletedAt && owner.projectId === thread.projectId
        ? owner.id
        : parent.id;
    }
    parentId = ownedThreadParentId(parent);
  }
  return null;
}
