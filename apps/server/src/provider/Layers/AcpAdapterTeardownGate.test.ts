import { ThreadId } from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as OfficialAcp from "@agentclientprotocol/sdk";
import { Cause, Effect, Exit, Layer, Queue, ServiceMap, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { DroidAdapter } from "../Services/DroidAdapter.ts";
import { OmpAdapter } from "../Services/OmpAdapter.ts";
import { makeDroidAdapterLive } from "./DroidAdapter.ts";
import { makeOmpAdapterLive } from "./OmpAdapter.ts";

const makeInMemoryAcpSpawner = () => {
  const connections: Array<{ close(error?: unknown): void }> = [];
  const queues: Array<Queue.Queue<Uint8Array>> = [];
  let spawnCount = 0;
  const agentApp = OfficialAcp.agent({ name: "acp-teardown-test" })
    .onRequest(OfficialAcp.methods.agent.initialize, () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      authMethods: [{ id: "agent", name: "Agent authentication" }],
    }))
    .onRequest(OfficialAcp.methods.agent.authenticate, () => ({}))
    .onRequest(OfficialAcp.methods.agent.session.new, () => ({
      sessionId: `acp-session-${spawnCount}`,
    }));
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.sync(() => {
        spawnCount += 1;
        const clientToAgent = Effect.runSync(Queue.unbounded<Uint8Array>());
        const agentToClient = Effect.runSync(Queue.unbounded<Uint8Array>());
        queues.push(clientToAgent, agentToClient);
        const input = new ReadableStream<Uint8Array>({
          pull: (controller) =>
            Effect.runPromise(Queue.take(clientToAgent))
              .then((chunk) => {
                try {
                  controller.enqueue(chunk);
                } catch {
                  return;
                }
              })
              .catch(() => undefined),
        });
        const output = new WritableStream<Uint8Array>({
          write: (chunk) =>
            Effect.runPromise(Queue.offer(agentToClient, chunk)).then(() => undefined),
        });
        connections.push(agentApp.connect(OfficialAcp.ndJsonStream(output, input)));
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(0x7fff_fffe),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.forEach((chunk: Uint8Array) => Queue.offer(clientToAgent, chunk)),
          stdout: Stream.fromQueue(agentToClient),
          stderr: Stream.never,
          all: Stream.never,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.never,
        });
      }),
    ),
  );
  return {
    layer,
    spawnCount: () => spawnCount,
    close: async () => {
      for (const connection of connections) connection.close();
      for (const queue of queues) await Effect.runPromise(Queue.shutdown(queue));
    },
  };
};

type TeardownSeam = () => Promise<{ escalated: boolean; signalErrors: Error[] }>;
type TeardownTestAdapter = Pick<
  ProviderAdapterShape<ProviderAdapterError>,
  "startSession" | "stopSession"
>;

class TeardownTestAdapterTag extends ServiceMap.Service<
  TeardownTestAdapterTag,
  TeardownTestAdapter
>()("test/TeardownTestAdapter") {}

const adapters = [
  {
    provider: "droid" as const,
    layer: (teardownProcessTree: TeardownSeam) =>
      Layer.effect(
        TeardownTestAdapterTag,
        Effect.gen(function* () {
          const adapter: TeardownTestAdapter = yield* DroidAdapter;
          return adapter;
        }),
      ).pipe(
        Layer.provide(
          makeDroidAdapterLive({ binaryPath: "droid-in-memory" }, { teardownProcessTree }),
        ),
      ),
  },
  {
    provider: "omp" as const,
    layer: (teardownProcessTree: TeardownSeam) =>
      Layer.effect(
        TeardownTestAdapterTag,
        Effect.gen(function* () {
          const adapter: TeardownTestAdapter = yield* OmpAdapter;
          return adapter;
        }),
      ).pipe(
        Layer.provide(makeOmpAdapterLive({ binaryPath: "omp-in-memory" }, { teardownProcessTree })),
      ),
  },
];

const runWithAdapter = async (
  adapterSpec: (typeof adapters)[number],
  teardownProcessTree: TeardownSeam,
  run: (adapter: TeardownTestAdapter, spawnCount: () => number) => Effect.Effect<void, unknown>,
) => {
  const spawner = makeInMemoryAcpSpawner();
  const configLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: `synara-${adapterSpec.provider}-teardown-`,
  }).pipe(Layer.provide(NodeServices.layer));
  const layer = adapterSpec
    .layer(teardownProcessTree)
    .pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, configLayer, spawner.layer)));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* TeardownTestAdapterTag;
        yield* run(adapter, spawner.spawnCount);
      }).pipe(Effect.provide(layer), Effect.scoped),
    );
  } finally {
    await spawner.close();
  }
};

describe.each(adapters)("$provider adapter teardown gate", (adapterSpec) => {
  const startInput = (threadId: ThreadId) => ({
    provider: adapterSpec.provider,
    threadId,
    cwd: process.cwd(),
    runtimeMode: "full-access" as const,
  });

  it("surfaces a failed teardown to Stop and retries it before a replacement starts", async () => {
    let teardownCalls = 0;
    await runWithAdapter(
      adapterSpec,
      async () => {
        teardownCalls += 1;
        if (teardownCalls === 1) throw new Error("process exit unproven");
        return { escalated: false, signalErrors: [] };
      },
      (adapter, spawnCount) =>
        Effect.gen(function* () {
          const threadId = ThreadId.makeUnsafe(`${adapterSpec.provider}-teardown-retry`);
          yield* adapter.startSession(startInput(threadId));
          expect(spawnCount()).toBe(1);

          const stop = yield* Effect.exit(adapter.stopSession(threadId));
          expect(Exit.isFailure(stop)).toBe(true);
          if (Exit.isFailure(stop)) {
            expect(Cause.pretty(stop.cause)).toContain("process exit unproven");
          }
          expect(teardownCalls).toBe(1);

          yield* adapter.startSession(startInput(threadId));
          expect(teardownCalls).toBe(2);
          expect(spawnCount()).toBe(2);
          yield* adapter.stopSession(threadId);
          expect(teardownCalls).toBe(3);
        }),
    );
  }, 20_000);

  it("keeps the replacement gate closed until a retried teardown proves exit", async () => {
    let teardownCalls = 0;
    let exitProvable = false;
    await runWithAdapter(
      adapterSpec,
      async () => {
        teardownCalls += 1;
        if (exitProvable) return { escalated: true, signalErrors: [] };
        throw new Error(`process exit unproven (${teardownCalls})`);
      },
      (adapter, spawnCount) =>
        Effect.gen(function* () {
          const threadId = ThreadId.makeUnsafe(`${adapterSpec.provider}-teardown-persistent`);
          yield* adapter.startSession(startInput(threadId));

          const stop = yield* Effect.exit(adapter.stopSession(threadId));
          expect(Exit.isFailure(stop)).toBe(true);

          const replacement = yield* Effect.exit(adapter.startSession(startInput(threadId)));
          expect(Exit.isFailure(replacement)).toBe(true);
          if (Exit.isFailure(replacement)) {
            expect(Cause.pretty(replacement.cause)).toContain("process exit unproven (2)");
          }
          expect(spawnCount()).toBe(1);

          const retriedStop = yield* Effect.exit(adapter.stopSession(threadId));
          expect(Exit.isFailure(retriedStop)).toBe(true);
          expect(teardownCalls).toBe(3);

          exitProvable = true;
          yield* adapter.stopSession(threadId);
          expect(teardownCalls).toBe(4);
          yield* adapter.startSession(startInput(threadId));
          expect(spawnCount()).toBe(2);
          yield* adapter.stopSession(threadId);
        }),
    );
  }, 20_000);
});
