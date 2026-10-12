import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { findReadModelThread, indexReadModel, replaceReadModelThread } from "./indexedReadModel.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-10-01T00:00:00.000Z";
const TARGET = ThreadId.makeUnsafe("thread-target");

function event(
  type: OrchestrationEvent["type"],
  sequence: number,
  payload: unknown,
): OrchestrationEvent {
  return {
    type,
    sequence,
    eventId: EventId.makeUnsafe(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: TARGET,
    commandId: CommandId.makeUnsafe(`command-${sequence}`),
    occurredAt: NOW,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: payload as OrchestrationEvent["payload"],
  } as OrchestrationEvent;
}

async function seed(): Promise<OrchestrationReadModel> {
  const model = await Effect.runPromise(
    projectEvent(
      createEmptyReadModel(NOW),
      event("thread.created", 1, {
        threadId: TARGET,
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Target",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ),
  );
  const target = model.threads[0]!;
  return {
    ...model,
    threads: [
      ...Array.from({ length: 10_000 }, (_, index) => ({
        ...target,
        id: ThreadId.makeUnsafe(`unrelated-${index}`),
      })),
      target,
    ],
  };
}

function delta(sequence: number, text: string) {
  return event("thread.message-sent", sequence, {
    threadId: TARGET,
    messageId: "assistant-1",
    role: "assistant",
    text,
    turnId: null,
    streaming: true,
    source: "native",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

describe("indexed command read model", () => {
  it("matches plain projection for malformed or mismatched payloads", async () => {
    const plain = await seed();
    const indexed = indexReadModel(plain);
    const malformed = event("thread.message-sent", 2, null);
    const result = await Effect.runPromiseExit(projectEvent(indexed, malformed));
    const plainResult = await Effect.runPromiseExit(projectEvent(plain, malformed));
    expect(result._tag).toBe("Failure");
    expect(result._tag).toBe(plainResult._tag);
    const mismatched = {
      ...delta(2, "Owned by payload"),
      aggregateId: ThreadId.makeUnsafe("unrelated-0"),
    };
    const projected = await Effect.runPromise(projectEvent(indexed, mismatched));
    const expected = await Effect.runPromise(projectEvent(plain, mismatched));
    expect({ ...projected }).toEqual(expected);
    expect(findReadModelThread(projected, TARGET)?.messages[0]?.text).toBe("Owned by payload");
    expect(findReadModelThread(projected, ThreadId.makeUnsafe("unrelated-0"))?.messages).toEqual(
      [],
    );
  });

  it("projects streaming deltas without reading the global thread array", async () => {
    const plain = await seed();
    let indexed = indexReadModel(plain);
    const original = indexed;
    const reads = [];
    let expected = plain;
    for (const [index, text] of ["Hello", " world"].entries()) {
      const read = vi.spyOn(indexed, "threads", "get");
      reads.push(read);
      indexed = await Effect.runPromise(projectEvent(indexed, delta(index + 2, text)));
      expected = await Effect.runPromise(projectEvent(expected, delta(index + 2, text)));
      expect(read).not.toHaveBeenCalled();
    }
    expect(findReadModelThread(original, TARGET)?.messages).toEqual([]);
    expect(findReadModelThread(indexed, TARGET)?.messages[0]?.text).toBe("Hello world");
    for (const read of reads) expect(read).not.toHaveBeenCalled();
    expect({ ...indexed }).toEqual(expected);
    expect(indexed.threads[0]).toBe(plain.threads[0]);
  });

  it("validates a streaming command without reading the global thread array", async () => {
    const model = indexReadModel(await seed());
    const read = vi.spyOn(model, "threads", "get");
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: model,
        command: {
          type: "thread.message.assistant.delta",
          commandId: CommandId.makeUnsafe("command-delta"),
          threadId: TARGET,
          messageId: MessageId.makeUnsafe("assistant-1"),
          delta: "Hello",
          createdAt: NOW,
        },
      }),
    );
    expect(decided).toMatchObject({ type: "thread.message-sent" });
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps insertion order and prior states through overlays, creation, and metadata events", async () => {
    const plain = await seed();
    const original = indexReadModel(plain);
    const target = findReadModelThread(original, TARGET)!;
    const overlay = replaceReadModelThread(original, { ...target, title: "Overlay" });
    expect(findReadModelThread(original, TARGET)?.title).toBe("Target");
    expect(overlay.threads.at(-1)?.title).toBe("Overlay");
    expect(overlay.threads.map((thread) => thread.id)).toEqual(
      plain.threads.map((thread) => thread.id),
    );
    const added = replaceReadModelThread(overlay, { ...target, id: ThreadId.makeUnsafe("added") });
    expect(added.threads.at(-1)?.id).toBe("added");
    const deletedEvent = event("thread.deleted", 2, { threadId: TARGET, deletedAt: NOW });
    const deleted = await Effect.runPromise(projectEvent(added, deletedEvent));
    expect(findReadModelThread(deleted, TARGET)?.deletedAt).toBe(NOW);
    expect(findReadModelThread(added, TARGET)?.deletedAt).toBeNull();
    const projectEventInput: OrchestrationEvent = {
      ...event("project.deleted", 3, { projectId: "project-1", deletedAt: NOW }),
      aggregateKind: "project",
      aggregateId: ProjectId.makeUnsafe("project-1"),
    };
    const metadata = await Effect.runPromise(projectEvent(deleted, projectEventInput));
    const expected = await Effect.runPromise(projectEvent({ ...deleted }, projectEventInput));
    expect({ ...metadata }).toEqual(expected);
    const reads = vi.spyOn(metadata, "threads", "get");
    const streamed = await Effect.runPromise(projectEvent(metadata, delta(4, "after metadata")));
    expect(reads).not.toHaveBeenCalled();
    expect(findReadModelThread(streamed, TARGET)?.messages[0]?.text).toBe("after metadata");
  });
});
