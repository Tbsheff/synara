import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { EventId, ThreadId, type ProviderEvent } from "@synara/contracts";
import { it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";

import { CodexAppServerManager, type CodexSessionInspection } from "../../codexAppServerManager.ts";
import { ServerConfig } from "../../config.ts";
import { CodexAdapter } from "../Services/CodexAdapter.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { makeCodexAdapterLive } from "./CodexAdapter.ts";

const slowThread = ThreadId.makeUnsafe("thread-slow-auth");
const fastThread = ThreadId.makeUnsafe("thread-fast-auth");

class SlowAuthManager extends CodexAppServerManager {
  private releaseSlow: (() => void) | undefined;
  private readonly slowOrigin = { home: "slow" };
  private readonly fastOrigin = { home: "fast" };

  release(): void {
    this.releaseSlow?.();
  }

  override getSessionEventOrigin(threadId: ThreadId) {
    const slow = threadId === slowThread;
    return {
      providerInstanceId: undefined,
      codexOptions: undefined,
      validationKey: slow ? this.slowOrigin : this.fastOrigin,
      rejectInspection: () => {},
      isAuthRejected: () => false,
      inspect: (): Promise<CodexSessionInspection | undefined> =>
        slow
          ? new Promise((resolve) => {
              this.releaseSlow = () => resolve(undefined);
            })
          : Promise.resolve(undefined),
    };
  }
}

const manager = new SlowAuthManager();

const sessionDirectoryLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () => Effect.die(new Error("unused")),
  getBinding: () => Effect.succeed(Option.none()),
  remove: () => Effect.void,
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

const layer = it.layer(
  makeCodexAdapterLive({ manager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(sessionDirectoryLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

function sessionStarted(threadId: ThreadId): ProviderEvent {
  return {
    id: EventId.makeUnsafe(`evt-started-${threadId}`),
    kind: "session",
    provider: "codex",
    threadId,
    createdAt: "2026-10-11T00:00:00.000Z",
    method: "session/started",
    message: "started",
  };
}

layer("CodexAdapterLive auth revalidation lanes", (it) => {
  it.effect("publishes a validated thread while another thread's auth read is slow", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const realTimeout = Effect.promise(
        () => new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2_000)),
      );
      const nextThreadId = Effect.race(
        Stream.runHead(adapter.streamEvents).pipe(
          Effect.map((event) => Option.getOrUndefined(event)?.threadId),
        ),
        realTimeout,
      );

      manager.emit("event", sessionStarted(slowThread));
      manager.emit("event", sessionStarted(fastThread));
      assert.equal(yield* nextThreadId, fastThread);

      manager.release();
      assert.equal(yield* nextThreadId, slowThread);
    }),
  );
});
