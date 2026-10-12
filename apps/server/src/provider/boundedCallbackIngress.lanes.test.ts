import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeBoundedCallbackIngress } from "./boundedCallbackIngress.ts";

type LaneItem = { readonly id: string; readonly lane: string; readonly origin: object };

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferredChecks() {
  const releases = new Map<object, Array<() => void>>();
  return {
    prepare: (item: LaneItem) =>
      new Promise<void>((resolve) => {
        const list = releases.get(item.origin) ?? [];
        list.push(resolve);
        releases.set(item.origin, list);
      }),
    release: (origin: object) => {
      for (const resolve of releases.get(origin) ?? []) resolve();
      releases.delete(origin);
    },
  };
}

describe("makeBoundedCallbackIngress lanes", () => {
  it("publishes a validated lane while another lane's check is still pending", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const slow = { name: "slow" };
          const fast = { name: "fast" };
          const checks = deferredChecks();
          const published: string[] = [];
          const ingress = yield* makeBoundedCallbackIngress<LaneItem, never, never, void>(
            (item) => Effect.sync(() => published.push(item.id)),
            {
              capacity: 64,
              maxBufferedBytes: 10_000,
              terminalReserve: 1,
              sizeOf: () => 1,
              isTerminal: () => false,
              prepareConcurrency: 8,
              prepareKey: (item) => item.origin,
              prepare: checks.prepare,
              laneKey: (item) => item.lane,
            },
          );

          ingress.offer({ id: "a1", lane: "a", origin: slow });
          ingress.offer({ id: "b1", lane: "b", origin: fast });
          yield* Effect.promise(settle);
          checks.release(fast);
          yield* Effect.promise(settle);
          expect(published).toEqual(["b1"]);

          ingress.offer({ id: "a2", lane: "a", origin: slow });
          ingress.offer({ id: "b2", lane: "b", origin: fast });
          yield* Effect.promise(settle);
          checks.release(fast);
          yield* Effect.promise(settle);
          expect(published).toEqual(["b1", "b2"]);

          checks.release(slow);
          yield* Effect.promise(settle);
          checks.release(slow);
          yield* ingress.stop;
          expect(published).toEqual(["b1", "b2", "a1", "a2"]);
          expect(ingress.status().queued).toBe(0);
        }),
      ),
    );
  });

  it("never lets a later item of the same lane pass an unsettled earlier one", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const first = { name: "first" };
          const trusted = { name: "trusted" };
          const checks = deferredChecks();
          const published: string[] = [];
          const ingress = yield* makeBoundedCallbackIngress<LaneItem, never, never, void>(
            (item) => Effect.sync(() => published.push(item.id)),
            {
              capacity: 64,
              maxBufferedBytes: 10_000,
              terminalReserve: 1,
              sizeOf: () => 1,
              isTerminal: () => false,
              prepareConcurrency: 8,
              prepareKey: (item) => item.origin,
              prepare: checks.prepare,
              laneKey: (item) => item.lane,
            },
          );

          ingress.offer({ id: "a1", lane: "a", origin: first });
          ingress.offer({ id: "a2-close", lane: "a", origin: trusted });
          yield* Effect.promise(settle);
          checks.release(trusted);
          yield* Effect.promise(settle);
          expect(published).toEqual([]);

          checks.release(first);
          yield* ingress.stop;
          expect(published).toEqual(["a1", "a2-close"]);
        }),
      ),
    );
  });

  it("keeps strict admission order without lanes", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const slow = { name: "slow" };
          const fast = { name: "fast" };
          const checks = deferredChecks();
          const published: string[] = [];
          const ingress = yield* makeBoundedCallbackIngress<LaneItem, never, never, void>(
            (item) => Effect.sync(() => published.push(item.id)),
            {
              capacity: 64,
              maxBufferedBytes: 10_000,
              terminalReserve: 1,
              sizeOf: () => 1,
              isTerminal: () => false,
              prepareConcurrency: 8,
              prepareKey: (item) => item.origin,
              prepare: checks.prepare,
            },
          );

          ingress.offer({ id: "a1", lane: "a", origin: slow });
          ingress.offer({ id: "b1", lane: "b", origin: fast });
          yield* Effect.promise(settle);
          checks.release(fast);
          yield* Effect.promise(settle);
          expect(published).toEqual([]);

          checks.release(slow);
          yield* ingress.stop;
          expect(published).toEqual(["a1", "b1"]);
        }),
      ),
    );
  });
});
