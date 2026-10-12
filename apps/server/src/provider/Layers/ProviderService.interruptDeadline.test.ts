import type {
  ProviderSendTurnInput,
  ProviderSession,
  ProviderTurnStartResult,
} from "@synara/contracts";
import { ThreadId, TurnId } from "@synara/contracts";
import { it, assert, vi } from "@effect/vitest";
import { describe } from "vitest";
import { Effect, Exit, Fiber, Layer, Option, PubSub, Stream } from "effect";
import { TestClock } from "effect/testing";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { ProviderAdapterSessionNotFoundError, type ProviderAdapterError } from "../Errors.ts";
import type {
  ProviderAdapterSessionStartInput,
  ProviderAdapterShape,
} from "../Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const PROVIDER = "antigravity" as const;

function makeFakeAdapter() {
  const sessions = new Map<ThreadId, ProviderSession>();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<never>());
  const startSession = vi.fn(
    (
      input: ProviderAdapterSessionStartInput,
    ): Effect.Effect<ProviderSession, ProviderAdapterError> =>
      Effect.sync(() => {
        const now = new Date().toISOString();
        const session: ProviderSession = {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId: input.threadId,
          resumeCursor: input.resumeCursor ?? {
            opaque: `resume-${String(input.threadId)}`,
          },
          cwd: input.cwd ?? process.cwd(),
          createdAt: now,
          updatedAt: now,
        };
        sessions.set(session.threadId, session);
        return session;
      }),
  );
  const sendTurn = vi.fn(
    (input: ProviderSendTurnInput): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> =>
      sessions.has(input.threadId)
        ? Effect.succeed({
            threadId: input.threadId,
            turnId: TurnId.makeUnsafe(`turn-${String(input.threadId)}`),
          })
        : Effect.fail(
            new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId: input.threadId,
            }),
          ),
  );
  const interruptTurn = vi.fn(
    (
      _threadId: ThreadId,
      _turnId?: TurnId,
      _providerThreadId?: string,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );
  const stopSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.delete(threadId);
      }),
  );
  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      supportsTurnSteering: true,
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest: () => Effect.void,
    respondToUserInput: () => Effect.void,
    stopSession,
    listSessions: () => Effect.sync(() => Array.from(sessions.values())),
    hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
    readThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
    rollbackThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
    stopAll: () =>
      Effect.sync(() => {
        sessions.clear();
      }),
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
  };
  return { adapter, sendTurn, interruptTurn, stopSession };
}

const fake = makeFakeAdapter();
const registryLayer = Layer.succeed(ProviderAdapterRegistry, {
  getByProvider: () => Effect.succeed(fake.adapter),
  listProviders: () => Effect.succeed([PROVIDER] as const),
});
const secretStoreLayer = Layer.succeed(ServerSecretStore, {
  get: () => Effect.succeed(null),
  set: () => Effect.void,
  getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes)),
  remove: () => Effect.void,
});
const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
  Layer.provide(SqlitePersistenceMemory),
);
const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
const settingsLayer = ServerSettingsService.layerTest({});
const layer = Layer.mergeAll(
  makeProviderServiceLive().pipe(
    Layer.provide(secretStoreLayer),
    Layer.provide(registryLayer),
    Layer.provide(directoryLayer),
    Layer.provide(settingsLayer),
  ),
  NodeServices.layer,
);

const sleep = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const waitUntil = (predicate: () => boolean, timeoutMs: number, description: string) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
      yield* sleep(10);
    }
    if (!predicate()) {
      assert.fail(`Timed out waiting for ${description}`);
    }
  });

describe("ProviderService interrupt deadline", () => {
  it.effect.each(["provider interrupt", "runtime retirement"] as const)(
    "lets a caller deadline cancel a hung %s and keeps the thread fenced until exit is proven",
    (hang) =>
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const threadId = ThreadId.makeUnsafe(`thread-interrupt-deadline-${hang.replace(" ", "-")}`);
        yield* provider.startSession(threadId, {
          provider: PROVIDER,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        yield* provider.sendTurn({ threadId, input: "hello", attachments: [] });

        let hangStarted = false;
        const hangForever = () =>
          Effect.sync(() => {
            hangStarted = true;
          }).pipe(Effect.andThen(Effect.never));
        if (hang === "provider interrupt") {
          fake.interruptTurn.mockImplementationOnce(hangForever);
        } else {
          fake.stopSession.mockImplementationOnce(hangForever);
        }

        let settled: Exit.Exit<Option.Option<void>, unknown> | undefined;
        yield* provider.interruptTurn({ threadId }).pipe(
          Effect.timeoutOption("1 second"),
          Effect.exit,
          Effect.tap((exit) =>
            Effect.sync(() => {
              settled = exit;
            }),
          ),
          Effect.forkDetach,
        );
        yield* waitUntil(() => hangStarted, 2_000, `the ${hang} to start`);
        yield* TestClock.adjust("1 second");
        yield* waitUntil(() => settled !== undefined, 2_000, "the caller deadline to fire");
        assert.isTrue(settled !== undefined && Exit.isSuccess(settled));
        assert.isTrue(Exit.isSuccess(settled!) && Option.isNone(settled.value));

        const fencedTurn = yield* provider
          .sendTurn({ threadId, input: "while fenced", attachments: [] })
          .pipe(Effect.exit, Effect.forkDetach);
        yield* sleep(50);
        assert.isUndefined(fencedTurn.pollUnsafe());

        yield* TestClock.adjust("9 seconds");
        const fencedExit = yield* Fiber.join(fencedTurn);
        assert.isTrue(Exit.isFailure(fencedExit));
        assert.include(String(Exit.isFailure(fencedExit) && fencedExit.cause), "retired safely");

        const sendsBeforeRecovery = fake.sendTurn.mock.calls.length;
        yield* provider.stopRuntimeSession!({ threadId });
        yield* provider.sendTurn({
          threadId,
          input: "after recovery",
          attachments: [],
        });
        assert.equal(fake.sendTurn.mock.calls.length, sendsBeforeRecovery + 1);
        yield* provider.stopSession({ threadId });
      }).pipe(Effect.provide(layer)),
  );

  it.effect.each(["provider interrupt", "runtime retirement"] as const)(
    "releases the fence when an escalated stop queues behind a hung %s",
    (hang) =>
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const threadId = ThreadId.makeUnsafe(
          `thread-interrupt-escalation-${hang.replace(" ", "-")}`,
        );
        yield* provider.startSession(threadId, {
          provider: PROVIDER,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        yield* provider.sendTurn({ threadId, input: "hello", attachments: [] });

        let hangStarted = false;
        const hangForever = () =>
          Effect.sync(() => {
            hangStarted = true;
          }).pipe(Effect.andThen(Effect.never));
        if (hang === "provider interrupt") {
          fake.interruptTurn.mockImplementationOnce(hangForever);
        } else {
          fake.stopSession.mockImplementationOnce(hangForever);
        }

        let settled = false;
        yield* provider.interruptTurn({ threadId }).pipe(
          Effect.timeoutOption("1 second"),
          Effect.exit,
          Effect.tap(() =>
            Effect.sync(() => {
              settled = true;
            }),
          ),
          Effect.forkDetach,
        );
        yield* waitUntil(() => hangStarted, 2_000, `the ${hang} to start`);
        yield* TestClock.adjust("1 second");
        yield* waitUntil(() => settled, 2_000, "the caller deadline to fire");

        const escalation = yield* provider.stopRuntimeSession!({ threadId }).pipe(
          Effect.exit,
          Effect.forkDetach,
        );
        yield* sleep(50);
        yield* TestClock.adjust("9 seconds");
        const escalationExit = yield* Fiber.join(escalation);
        assert.isTrue(Exit.isSuccess(escalationExit));

        const sendsBeforeRecovery = fake.sendTurn.mock.calls.length;
        yield* provider.sendTurn({ threadId, input: "after escalation", attachments: [] });
        assert.equal(fake.sendTurn.mock.calls.length, sendsBeforeRecovery + 1);
        yield* provider.stopSession({ threadId });
      }).pipe(Effect.provide(layer)),
  );
});
