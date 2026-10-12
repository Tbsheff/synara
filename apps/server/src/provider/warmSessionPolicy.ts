import type { ThreadId } from "@synara/contracts";

export function selectWarmSessionEvictions(input: {
  readonly idleThreadIds: ReadonlyArray<ThreadId>;
  readonly threadId: ThreadId;
  readonly limit: number;
  readonly reserving: boolean;
}): ReadonlyArray<ThreadId> | null {
  if (input.limit <= 0 && input.reserving) return null;
  const others = input.reserving
    ? input.idleThreadIds.filter((id) => id !== input.threadId)
    : input.idleThreadIds;
  const required = Math.max(0, others.length + (input.reserving ? 1 : 0) - input.limit);
  return others.slice(0, required);
}
