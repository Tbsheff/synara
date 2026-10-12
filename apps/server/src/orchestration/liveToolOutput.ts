import {
  type EventId,
  type RuntimeItemId,
  type ThreadId,
  type ThreadLiveToolOutput,
  type ThreadLiveToolOutputCleared,
  type ThreadLiveUpdate,
  TRANSCRIPT_LIVE_OUTPUT_MIN_INTERVAL_MS,
  TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS,
  type TurnId,
  ORCHESTRATION_STREAM_OVERFLOW_CODE,
  WsRpcError,
} from "@synara/contracts";
import { Effect, Queue, ServiceMap, Stream } from "effect";

export const OUTPUT_TRUNCATION_PREFIX = "[output truncated]\n";

export interface OutputTail {
  readonly text: string;
  readonly truncated: boolean;
  readonly totalChars: number;
}

export function appendOutputTail(
  existing: OutputTail | undefined,
  delta: string,
  maxChars: number = TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS,
): OutputTail {
  const limit = Math.max(0, Math.floor(maxChars));
  const combined = `${existing?.text ?? ""}${delta}`;
  const overflow = combined.length > limit;
  return {
    text: overflow ? combined.slice(combined.length - limit) : combined,
    truncated: existing?.truncated === true || overflow,
    totalChars: (existing?.totalChars ?? 0) + delta.length,
  };
}

export function renderOutputTail(tail: OutputTail): string {
  return tail.truncated ? `${OUTPUT_TRUNCATION_PREFIX}${tail.text}` : tail.text;
}

export function outputTailFromText(
  text: string,
  maxChars: number = TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS,
): OutputTail {
  return appendOutputTail(undefined, text, maxChars);
}

export type LiveToolOutputStreamKind = ThreadLiveToolOutput["streamKind"];

export interface LiveToolOutputDelta {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
  readonly itemId: RuntimeItemId;
  readonly activityId?: EventId;
  readonly streamKind: LiveToolOutputStreamKind;
  readonly delta: string;
}

export type LiveToolOutputListener = (update: ThreadLiveUpdate) => void;

export interface LiveToolOutputHubShape {
  readonly append: (input: LiveToolOutputDelta) => void;
  readonly markBackground: (threadId: ThreadId, itemId: RuntimeItemId) => void;
  readonly clearItem: (threadId: ThreadId, itemId: RuntimeItemId) => void;
  readonly clearTurn: (threadId: ThreadId, turnId: TurnId) => void;
  readonly clearThread: (threadId: ThreadId) => void;
  readonly current: (threadId: ThreadId) => ReadonlyArray<ThreadLiveToolOutput>;
  readonly subscribe: (threadId: ThreadId, listener: LiveToolOutputListener) => () => void;
}

export interface LiveToolOutputHubOptions {
  readonly minIntervalMs?: number;
  readonly tailMaxChars?: number;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => () => void;
}

interface LiveItemState {
  readonly threadId: ThreadId;
  turnId: TurnId | null;
  readonly itemId: RuntimeItemId;
  activityId: EventId | undefined;
  streamKind: LiveToolOutputStreamKind;
  tail: OutputTail;
  lastPublishedAt: number | undefined;
  dirty: boolean;
  cancelTimer: (() => void) | undefined;
}

function deliverIsolated(listener: LiveToolOutputListener, update: ThreadLiveUpdate) {
  try {
    listener(update);
  } catch {
    return;
  }
}

const defaultSetTimer = (callback: () => void, delayMs: number) => {
  const handle = setTimeout(callback, delayMs);
  handle.unref?.();
  return () => clearTimeout(handle);
};

export function makeLiveToolOutputHub(
  options: LiveToolOutputHubOptions = {},
): LiveToolOutputHubShape {
  const minIntervalMs = Math.max(
    0,
    options.minIntervalMs ?? TRANSCRIPT_LIVE_OUTPUT_MIN_INTERVAL_MS,
  );
  const tailMaxChars = options.tailMaxChars ?? TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? defaultSetTimer;
  const itemsByThread = new Map<string, Map<string, LiveItemState>>();
  const listenersByThread = new Map<string, Set<LiveToolOutputListener>>();
  const backgroundItemsByThread = new Map<string, Set<string>>();

  const isBackground = (threadId: ThreadId, itemId: RuntimeItemId) =>
    backgroundItemsByThread.get(threadId)?.has(itemId) === true;

  const forgetBackground = (threadId: ThreadId, itemId: RuntimeItemId) => {
    const background = backgroundItemsByThread.get(threadId);
    if (!background?.delete(itemId)) return;
    if (background.size === 0) backgroundItemsByThread.delete(threadId);
  };

  const toUpdate = (state: LiveItemState): ThreadLiveToolOutput => ({
    kind: "tool-output",
    threadId: state.threadId,
    turnId: state.turnId,
    itemId: state.itemId,
    ...(state.activityId !== undefined ? { activityId: state.activityId } : {}),
    streamKind: state.streamKind,
    tail: renderOutputTail(state.tail),
    truncated: state.tail.truncated,
    totalChars: state.tail.totalChars,
    updatedAt: new Date(now()).toISOString(),
  });

  const notify = (threadId: ThreadId, update: ThreadLiveUpdate) => {
    const listeners = listenersByThread.get(threadId);
    if (!listeners) return;
    for (const listener of Array.from(listeners)) {
      deliverIsolated(listener, update);
    }
  };

  const publish = (state: LiveItemState) => {
    state.dirty = false;
    state.lastPublishedAt = now();
    notify(state.threadId, toUpdate(state));
  };

  const schedule = (state: LiveItemState) => {
    if (state.cancelTimer !== undefined) return;
    const elapsed =
      state.lastPublishedAt === undefined ? minIntervalMs : now() - state.lastPublishedAt;
    if (elapsed >= minIntervalMs) {
      publish(state);
      return;
    }
    state.cancelTimer = setTimer(() => {
      state.cancelTimer = undefined;
      if (state.dirty && itemsByThread.get(state.threadId)?.get(state.itemId) === state) {
        publish(state);
      }
    }, minIntervalMs - elapsed);
  };

  const removeItem = (items: Map<string, LiveItemState>, state: LiveItemState) => {
    state.cancelTimer?.();
    state.cancelTimer = undefined;
    items.delete(state.itemId);
    const cleared: ThreadLiveToolOutputCleared = {
      kind: "tool-output-cleared",
      threadId: state.threadId,
      itemId: state.itemId,
      updatedAt: new Date(now()).toISOString(),
    };
    notify(state.threadId, cleared);
  };

  const dropEmptyThread = (threadId: ThreadId) => {
    if (itemsByThread.get(threadId)?.size === 0) itemsByThread.delete(threadId);
  };

  return {
    append: (input) => {
      if (input.delta.length === 0) return;
      let items = itemsByThread.get(input.threadId);
      if (!items) {
        items = new Map();
        itemsByThread.set(input.threadId, items);
      }
      let state = items.get(input.itemId);
      if (!state) {
        state = {
          threadId: input.threadId,
          turnId: input.turnId,
          itemId: input.itemId,
          activityId: input.activityId,
          streamKind: input.streamKind,
          tail: appendOutputTail(undefined, input.delta, tailMaxChars),
          lastPublishedAt: undefined,
          dirty: true,
          cancelTimer: undefined,
        };
        items.set(input.itemId, state);
      } else {
        state.tail = appendOutputTail(state.tail, input.delta, tailMaxChars);
        state.turnId = input.turnId ?? state.turnId;
        state.activityId = input.activityId ?? state.activityId;
        state.streamKind = input.streamKind;
        state.dirty = true;
      }
      schedule(state);
    },
    markBackground: (threadId, itemId) => {
      let background = backgroundItemsByThread.get(threadId);
      if (!background) {
        background = new Set();
        backgroundItemsByThread.set(threadId, background);
      }
      background.add(itemId);
    },
    clearItem: (threadId, itemId) => {
      forgetBackground(threadId, itemId);
      const items = itemsByThread.get(threadId);
      const state = items?.get(itemId);
      if (!items || !state) return;
      removeItem(items, state);
      dropEmptyThread(threadId);
    },
    clearTurn: (threadId, turnId) => {
      const items = itemsByThread.get(threadId);
      if (!items) return;
      for (const state of Array.from(items.values())) {
        if (isBackground(threadId, state.itemId)) continue;
        if (state.turnId === null || state.turnId === turnId) removeItem(items, state);
      }
      dropEmptyThread(threadId);
    },
    clearThread: (threadId) => {
      backgroundItemsByThread.delete(threadId);
      const items = itemsByThread.get(threadId);
      if (!items) return;
      for (const state of Array.from(items.values())) removeItem(items, state);
      itemsByThread.delete(threadId);
    },
    current: (threadId) => [...(itemsByThread.get(threadId)?.values() ?? [])].map(toUpdate),
    subscribe: (threadId, listener) => {
      let listeners = listenersByThread.get(threadId);
      if (!listeners) {
        listeners = new Set();
        listenersByThread.set(threadId, listeners);
      }
      listeners.add(listener);
      return () => {
        const current = listenersByThread.get(threadId);
        current?.delete(listener);
        if (current?.size === 0) listenersByThread.delete(threadId);
      };
    },
  };
}

export const LiveToolOutputHub = ServiceMap.Reference<LiveToolOutputHubShape>(
  "synara/orchestration/LiveToolOutputHub",
  { defaultValue: () => makeLiveToolOutputHub() },
);

export interface LiveUpdateBufferLimits {
  readonly maxItems: number;
  readonly maxTailChars: number;
}

export const DEFAULT_LIVE_UPDATE_BUFFER_LIMITS: LiveUpdateBufferLimits = {
  maxItems: 1_024,
  maxTailChars: 8 * 1024 * 1024,
};

const liveUpdateTailChars = (update: ThreadLiveUpdate): number =>
  update.kind === "tool-output" ? update.tail.length : 0;

export function liveUpdateBufferOverflowError(threadId: ThreadId): WsRpcError {
  return new WsRpcError({
    message: `Live tool output for thread ${threadId} exceeded its buffer; resume from the last received sequence.`,
    code: ORCHESTRATION_STREAM_OVERFLOW_CODE,
    retryable: true,
  });
}

export class LatestLiveUpdates {
  private readonly updates = new Map<string, ThreadLiveUpdate>();
  private tailChars = 0;

  constructor(private readonly limits: LiveUpdateBufferLimits) {}

  get size(): number {
    return this.updates.size;
  }

  trySet(update: ThreadLiveUpdate): boolean {
    const previous = this.updates.get(update.itemId);
    const nextTailChars =
      this.tailChars - (previous ? liveUpdateTailChars(previous) : 0) + liveUpdateTailChars(update);
    const nextSize = previous ? this.updates.size : this.updates.size + 1;
    if (nextSize > this.limits.maxItems || nextTailChars > this.limits.maxTailChars) return false;
    this.updates.delete(update.itemId);
    this.updates.set(update.itemId, update);
    this.tailChars = nextTailChars;
    return true;
  }

  takeAll(): ThreadLiveUpdate[] {
    const updates = [...this.updates.values()];
    this.updates.clear();
    this.tailChars = 0;
    return updates;
  }
}

export function coalescedLiveToolOutputStream(
  hub: LiveToolOutputHubShape,
  threadId: ThreadId,
  limits: LiveUpdateBufferLimits = DEFAULT_LIVE_UPDATE_BUFFER_LIMITS,
): Stream.Stream<ThreadLiveUpdate, WsRpcError> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const pending = new LatestLiveUpdates(limits);
      let overflowed = false;
      const wake = yield* Queue.sliding<void>(1);
      let unsubscribe = () => {};
      const offer = (update: ThreadLiveUpdate) => {
        if (overflowed) return;
        if (!pending.trySet(update)) {
          overflowed = true;
          pending.takeAll();
          unsubscribe();
        }
        Queue.offerUnsafe(wake, undefined);
      };
      for (const update of hub.current(threadId)) offer(update);
      if (!overflowed) unsubscribe = hub.subscribe(threadId, offer);
      yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribe()));
      return Stream.fromQueue(wake).pipe(
        Stream.flatMap(() =>
          overflowed
            ? Stream.fail(liveUpdateBufferOverflowError(threadId))
            : Stream.fromIterable(pending.takeAll()),
        ),
      );
    }),
  );
}
