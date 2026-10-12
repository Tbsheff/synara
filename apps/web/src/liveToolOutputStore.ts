import type {
  OrchestrationEvent,
  OrchestrationThreadActivity,
  ThreadId,
  ThreadLiveUpdate,
} from "@synara/contracts";
import { create } from "zustand";

import { providerItemIdFromToolActivity, type WorkLogLiveOutput } from "./workLog";

export interface LiveToolOutputEntry extends WorkLogLiveOutput {
  threadId: string;
  turnId: string | null;
  itemId: string;
}

interface LiveToolOutputState {
  byThreadItemKey: Readonly<Record<string, LiveToolOutputEntry>>;
}

export const useLiveToolOutputStore = create<LiveToolOutputState>(() => ({
  byThreadItemKey: {},
}));

export function liveToolOutputKey(threadId: ThreadId | string, itemId: string): string {
  return `${threadId}:${itemId}`;
}

function removeWhere(predicate: (entry: LiveToolOutputEntry) => boolean): void {
  const current = useLiveToolOutputStore.getState().byThreadItemKey;
  let next: Record<string, LiveToolOutputEntry> | null = null;
  for (const [key, entry] of Object.entries(current)) {
    if (!predicate(entry)) continue;
    next ??= { ...current };
    delete next[key];
  }
  if (next) {
    useLiveToolOutputStore.setState({ byThreadItemKey: next });
  }
}

export function applyLiveToolOutputUpdate(update: ThreadLiveUpdate): void {
  if (update.kind === "tool-output-cleared") {
    clearLiveToolOutputItem(update.threadId, update.itemId);
    return;
  }
  const key = liveToolOutputKey(update.threadId, update.itemId);
  const current = useLiveToolOutputStore.getState().byThreadItemKey;
  const previous = current[key];
  if (previous !== undefined && previous.updatedAt > update.updatedAt) {
    return;
  }
  useLiveToolOutputStore.setState({
    byThreadItemKey: {
      ...current,
      [key]: {
        threadId: update.threadId,
        turnId: update.turnId,
        itemId: update.itemId,
        streamKind: update.streamKind,
        tail: update.tail,
        truncated: update.truncated,
        totalChars: update.totalChars,
        updatedAt: update.updatedAt,
      },
    },
  });
}

export function clearLiveToolOutputItem(threadId: ThreadId | string, itemId: string): void {
  const key = liveToolOutputKey(threadId, itemId);
  const current = useLiveToolOutputStore.getState().byThreadItemKey;
  if (current[key] === undefined) return;
  const next = { ...current };
  delete next[key];
  useLiveToolOutputStore.setState({ byThreadItemKey: next });
}

export function clearLiveToolOutputForCompletedTools(
  threadId: ThreadId | string,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): void {
  for (const activity of activities) {
    if (activity.kind !== "tool.completed") continue;
    const itemId = providerItemIdFromToolActivity(activity);
    if (itemId) clearLiveToolOutputItem(threadId, itemId);
  }
}

export function clearLiveToolOutputForEvents(events: ReadonlyArray<OrchestrationEvent>): void {
  for (const event of events) {
    if (event.type !== "thread.activity-appended") continue;
    clearLiveToolOutputForCompletedTools(event.payload.threadId, [event.payload.activity]);
  }
}

export function clearLiveToolOutputThread(threadId: ThreadId | string): void {
  removeWhere((entry) => entry.threadId === threadId);
}

export function clearAllLiveToolOutput(): void {
  if (Object.keys(useLiveToolOutputStore.getState().byThreadItemKey).length === 0) return;
  useLiveToolOutputStore.setState({ byThreadItemKey: {} });
}

export function useLiveToolOutput(
  threadId: ThreadId | string | null | undefined,
  providerItemId: string | undefined,
): WorkLogLiveOutput | undefined {
  return useLiveToolOutputStore((state) =>
    threadId == null || providerItemId === undefined
      ? undefined
      : state.byThreadItemKey[liveToolOutputKey(threadId, providerItemId)],
  );
}
