import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-10-10T12:00:00.000Z";
const PROJECT_ID = ProjectId.makeUnsafe("project-stream");
const SOURCE_THREAD_ID = ThreadId.makeUnsafe("thread-stream-source");
const TARGET_THREAD_ID = ThreadId.makeUnsafe("thread-stream-target");

async function sourceThreadReadModel() {
  const withProject = await Effect.runPromise(
    projectEvent(createEmptyReadModel(NOW), {
      sequence: 1,
      eventId: EventId.makeUnsafe("evt-project"),
      aggregateKind: "project",
      aggregateId: PROJECT_ID,
      type: "project.created",
      occurredAt: NOW,
      commandId: CommandId.makeUnsafe("cmd-project"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("cmd-project"),
      metadata: {},
      payload: {
        projectId: PROJECT_ID,
        kind: "project",
        title: "Project",
        workspaceRoot: "/tmp/project-stream",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
  );
  return Effect.runPromise(
    projectEvent(withProject, {
      sequence: 2,
      eventId: EventId.makeUnsafe("evt-source-thread"),
      aggregateKind: "thread",
      aggregateId: SOURCE_THREAD_ID,
      type: "thread.created",
      occurredAt: NOW,
      commandId: CommandId.makeUnsafe("cmd-source-thread"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("cmd-source-thread"),
      metadata: {},
      payload: {
        threadId: SOURCE_THREAD_ID,
        projectId: PROJECT_ID,
        title: "Source",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        envMode: "local",
        branch: null,
        worktreePath: null,
        parentThreadId: null,
        subagentAgentId: null,
        subagentNickname: null,
        subagentRole: null,
        forkSourceThreadId: null,
        sidechatSourceThreadId: null,
        handoff: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
  );
}

const importedMessages = [
  {
    messageId: MessageId.makeUnsafe("message-imported-user"),
    role: "user" as const,
    text: "carry this over",
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    messageId: MessageId.makeUnsafe("message-imported-assistant"),
    role: "assistant" as const,
    text: "carried",
    createdAt: NOW,
    updatedAt: NOW,
  },
];

const crossThreadCommands: ReadonlyArray<OrchestrationCommand> = [
  {
    type: "thread.fork.create",
    commandId: CommandId.makeUnsafe("cmd-fork"),
    threadId: TARGET_THREAD_ID,
    sourceThreadId: SOURCE_THREAD_ID,
    sidechatSourceThreadId: SOURCE_THREAD_ID,
    projectId: PROJECT_ID,
    title: "Fork",
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    envMode: "local",
    branch: null,
    worktreePath: null,
    importedMessages,
    createdAt: NOW,
  },
  {
    type: "thread.handoff.create",
    commandId: CommandId.makeUnsafe("cmd-handoff"),
    threadId: TARGET_THREAD_ID,
    sourceThreadId: SOURCE_THREAD_ID,
    projectId: PROJECT_ID,
    title: "Handoff",
    modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    envMode: "local",
    branch: null,
    worktreePath: null,
    importedMessages,
    createdAt: NOW,
  },
] as ReadonlyArray<OrchestrationCommand>;

describe("decider keeps payload.threadId on its own stream so purge-by-stream is complete", () => {
  for (const command of crossThreadCommands) {
    it(`${command.type} appends every event to the stream its payload names`, async () => {
      const result = await Effect.runPromise(
        decideOrchestrationCommand({ command, readModel: await sourceThreadReadModel() }),
      );
      const events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">> = Array.isArray(result)
        ? result
        : [result];
      const threadEvents = events.filter((event) => event.aggregateKind === "thread");

      expect(threadEvents.length).toBeGreaterThan(1);
      for (const event of threadEvents) {
        expect(event.aggregateId).toBe(TARGET_THREAD_ID);
        expect((event.payload as { readonly threadId?: unknown }).threadId).toBe(event.aggregateId);
      }
    });
  }
});
