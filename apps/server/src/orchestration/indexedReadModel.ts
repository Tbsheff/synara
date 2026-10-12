import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationThread,
  ThreadId,
} from "@synara/contracts";
import { Effect, HashMap, Option } from "effect";

type Header = Omit<OrchestrationReadModel, "threads">;
interface ThreadEntry {
  readonly thread: OrchestrationThread;
  readonly position: number;
}
interface IndexedState {
  readonly header: Header;
  readonly threads: HashMap.HashMap<ThreadId, ThreadEntry>;
  readonly nextPosition: number;
}

const indexedStates = new WeakMap<OrchestrationReadModel, IndexedState>();

function fromState(state: IndexedState): OrchestrationReadModel {
  let orderedThreads: OrchestrationThread[] | undefined;
  const model: OrchestrationReadModel = {
    ...state.header,
    get threads() {
      orderedThreads ??= Array.from(HashMap.values(state.threads))
        .sort((left, right) => left.position - right.position)
        .map((entry) => entry.thread);
      return orderedThreads;
    },
  };
  indexedStates.set(model, state);
  return model;
}

export function indexReadModel(model: OrchestrationReadModel): OrchestrationReadModel {
  if (indexedStates.has(model)) return model;
  const { threads, ...header } = model;
  return fromState({
    header,
    threads: HashMap.fromIterable(
      threads.map((thread, position) => [thread.id, { thread, position }] as const),
    ),
    nextPosition: threads.length,
  });
}

export function findReadModelThread(
  model: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  const state = indexedStates.get(model);
  return state
    ? Option.getOrUndefined(HashMap.get(state.threads, threadId))?.thread
    : model.threads.find((thread) => thread.id === threadId);
}

export function replaceReadModelThread(
  model: OrchestrationReadModel,
  thread: OrchestrationThread,
): OrchestrationReadModel {
  const state = indexedStates.get(model);
  if (!state) {
    return {
      ...model,
      threads: model.threads.some((entry) => entry.id === thread.id)
        ? model.threads.map((entry) => (entry.id === thread.id ? thread : entry))
        : [...model.threads, thread],
    };
  }
  const existing = Option.getOrUndefined(HashMap.get(state.threads, thread.id));
  return fromState({
    ...state,
    threads: HashMap.set(state.threads, thread.id, {
      thread,
      position: existing?.position ?? state.nextPosition,
    }),
    nextPosition: state.nextPosition + (existing ? 0 : 1),
  });
}

export function projectIndexedEvent<E>(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
  project: (
    model: OrchestrationReadModel,
    event: OrchestrationEvent,
  ) => Effect.Effect<OrchestrationReadModel, E>,
): Effect.Effect<OrchestrationReadModel, E> | undefined {
  const state = indexedStates.get(model);
  if (!state) return undefined;
  if (
    event.aggregateKind !== "thread" ||
    (typeof event.payload === "object" &&
      event.payload !== null &&
      "threadId" in event.payload &&
      event.payload.threadId !== event.aggregateId)
  ) {
    return project({ ...model }, event).pipe(Effect.map(indexReadModel));
  }
  const thread = findReadModelThread(model, event.aggregateId as ThreadId);
  return project({ ...state.header, threads: thread ? [thread] : [] }, event).pipe(
    Effect.map(({ threads, ...header }) => {
      const next = fromState({ ...state, header });
      return threads[0] ? replaceReadModelThread(next, threads[0]) : next;
    }),
  );
}
