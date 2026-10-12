import type { TerminalEvent, WsRpcError } from "@synara/contracts";
import { Effect, Queue, Stream } from "effect";

import { bufferLiveUiStream } from "./wsStreamBackpressure";

export const TERMINAL_EVENT_STREAM_CAPACITY = 4_096;

const liveEventBytesExcludingSnapshot = (event: { readonly type: string }): number =>
  event.type === "snapshot" ? 0 : Buffer.byteLength(JSON.stringify(event));

export function boundedTerminalEventStream(
  subscribe: (listener: (event: TerminalEvent) => void) => Effect.Effect<() => void>,
  options?: { readonly capacity?: number; readonly maxSerializedBytes?: number },
): Stream.Stream<TerminalEvent, WsRpcError> {
  return bufferLiveUiStream(
    Stream.callback<TerminalEvent>((queue) =>
      Effect.gen(function* () {
        const unsubscribe = yield* subscribe((event) => {
          Queue.offerUnsafe(queue, event);
        });
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      }),
    ),
    {
      capacity: options?.capacity ?? TERMINAL_EVENT_STREAM_CAPACITY,
      ...(options?.maxSerializedBytes === undefined
        ? {}
        : { maxSerializedBytes: options.maxSerializedBytes }),
      overflowStrategy: "fail",
      label: "terminal.events",
    },
  );
}

export function boundedSnapshotEventStream<A extends { readonly type: string }, E, R>(
  stream: Stream.Stream<A, E, R>,
  options: {
    readonly label: string;
    readonly capacity?: number;
    readonly maxSerializedBytes?: number;
  },
): Stream.Stream<A, E | WsRpcError, R> {
  return bufferLiveUiStream(stream, {
    ...options,
    overflowStrategy: "fail",
    serializedBytes: liveEventBytesExcludingSnapshot,
  });
}
