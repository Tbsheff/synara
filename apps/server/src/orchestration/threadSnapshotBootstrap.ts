import { Effect, Option, Stream, type Scope } from "effect";

export function loadThreadSnapshotWithBootstrapWait<A, E>(input: {
  readSnapshot: Effect.Effect<Option.Option<A>, E>;
  subscribeReady: Effect.Effect<Stream.Stream<unknown>, never, Scope.Scope>;
  timeoutMs: number;
}) {
  return Effect.scoped(
    Effect.gen(function* () {
      const ready = yield* input.subscribeReady;
      const snapshot = yield* input.readSnapshot;
      if (Option.isSome(snapshot)) return snapshot;
      const committed = yield* ready.pipe(
        Stream.mapEffect(() => input.readSnapshot),
        Stream.filter(Option.isSome),
        Stream.runHead,
        Effect.timeoutOption(input.timeoutMs),
      );
      return Option.flatten(Option.flatten(committed));
    }),
  );
}
