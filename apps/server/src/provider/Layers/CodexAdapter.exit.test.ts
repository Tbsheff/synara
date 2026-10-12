import {
  EventId,
  ProviderRuntimeEvent as ProviderRuntimeEventSchema,
  ThreadId,
  type ProviderEvent,
  type ProviderRuntimeEvent,
} from "@synara/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { makeCodexRuntimeEventMapper } from "./CodexAdapter.ts";

const threadId = ThreadId.makeUnsafe("thread-exit");
const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEventSchema);

function exitedEvent(payload: unknown, method = "session/exited"): ProviderEvent {
  return {
    id: EventId.makeUnsafe(`evt-${method}`),
    kind: "session",
    provider: "codex",
    threadId,
    createdAt: "2026-10-11T00:00:00.000Z",
    method,
    message: "codex app-server exited (code=1, signal=null).",
    ...(payload !== undefined ? { payload } : {}),
  };
}

function mapExit(event: ProviderEvent): ReadonlyArray<ProviderRuntimeEvent> {
  const events = makeCodexRuntimeEventMapper()(event, threadId);
  for (const runtimeEvent of events) decodeRuntimeEvent(runtimeEvent);
  return events;
}

describe("Codex session exit mapping", () => {
  it("surfaces a crash as a turn-scoped runtime error before an error exit", () => {
    const events = mapExit(
      exitedEvent({ exitCode: 1, signal: null, exitKind: "error", turnId: "turn-live" }),
    );

    expect(events.map((event) => event.type)).toEqual(["runtime.error", "session.exited"]);
    const [error, exited] = events;
    expect(error).toMatchObject({
      turnId: "turn-live",
      payload: {
        message: "codex app-server exited (code=1, signal=null).",
        class: "transport_error",
        detail: { exitCode: 1, signal: null },
      },
    });
    expect(exited?.turnId).toBeUndefined();
    expect(exited?.payload).toMatchObject({ exitKind: "error" });
  });

  it("does not repeat a transport failure that already reported the cause", () => {
    const events = mapExit(
      exitedEvent({
        exitCode: null,
        signal: "SIGTERM",
        exitKind: "error",
        causeAlreadyReported: true,
      }),
    );

    expect(events.map((event) => event.type)).toEqual(["session.exited"]);
    expect(events[0]?.payload).toMatchObject({ exitKind: "error" });
  });

  it("keeps clean exits and stops graceful", () => {
    const clean = mapExit(exitedEvent({ exitCode: 0, signal: null, exitKind: "graceful" }));
    const stopped = mapExit(exitedEvent(undefined, "session/closed"));

    expect(clean.map((event) => event.type)).toEqual(["session.exited"]);
    expect(clean[0]?.payload).toMatchObject({ exitKind: "graceful" });
    expect(stopped[0]?.payload).toMatchObject({ exitKind: "graceful" });
  });
});
