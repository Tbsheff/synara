// FILE: threadHierarchy.ts

interface HierarchyThread {
  readonly id: string;
  readonly parentThreadId?: string | null | undefined;
  readonly sourceThreadId?: string | null | undefined;
  readonly creationSource?: string | null | undefined;
  readonly projectId?: string | undefined;
  readonly deletedAt?: string | null | undefined;
}

export function ownedThreadParentId<T extends HierarchyThread>(thread: T): T["id"] | null {
  return (
    thread.parentThreadId ??
    (thread.creationSource === "synara_mcp" ||
    thread.creationSource === "external_mcp" ||
    thread.creationSource === "automation_run"
      ? (thread.sourceThreadId ?? null)
      : null)
  );
}

export function collectOwnedThreadDescendants<T extends HierarchyThread>(
  threads: readonly T[],
  rootThreadId: T["id"],
): T[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  return collectSubagentDescendants(
    threads.map((thread) => {
      const parentId = ownedThreadParentId(thread);
      const parent = parentId === null ? undefined : byId.get(parentId);
      return {
        ...thread,
        parentThreadId:
          parent && !parent.deletedAt && parent.projectId === thread.projectId ? parentId : null,
      };
    }),
    rootThreadId,
  ).map((thread) => byId.get(thread.id)!);
}

// Collects every thread reachable from `rootThreadId` through `parentThreadId`
// links, breadth-first, excluding the root itself. Subagent threads are only
// reachable through their parent thread, so lifecycle changes on a parent
// (archive, restore, delete) apply to this whole subtree. Visited tracking keeps
// corrupted self- or cyclic linkage from hanging the caller.
export function collectSubagentDescendants<T extends HierarchyThread>(
  threads: readonly T[],
  rootThreadId: T["id"],
): T[] {
  const childrenByParentId = new Map<string, T[]>();
  for (const thread of threads) {
    const parentThreadId = thread.parentThreadId ?? null;
    if (parentThreadId === null) {
      continue;
    }
    const siblings = childrenByParentId.get(parentThreadId);
    if (siblings === undefined) {
      childrenByParentId.set(parentThreadId, [thread]);
    } else {
      siblings.push(thread);
    }
  }

  const descendants: T[] = [];
  const visitedThreadIds = new Set<string>([rootThreadId]);
  const queue: string[] = [rootThreadId];
  for (let index = 0; index < queue.length; index += 1) {
    const parentThreadId = queue[index];
    if (parentThreadId === undefined) {
      break;
    }
    for (const child of childrenByParentId.get(parentThreadId) ?? []) {
      if (visitedThreadIds.has(child.id)) {
        continue;
      }
      visitedThreadIds.add(child.id);
      descendants.push(child);
      queue.push(child.id);
    }
  }
  return descendants;
}
