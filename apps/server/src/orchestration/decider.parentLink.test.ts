import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-10-01T10:00:00.000Z";
const PROJECT_ID = ProjectId.makeUnsafe("project-main");
const OTHER_PROJECT_ID = ProjectId.makeUnsafe("project-other");

type ReadModelThread = OrchestrationReadModel["threads"][number];

function makeThread(input: {
  readonly id: string;
  readonly projectId?: ProjectId;
  readonly parentThreadId?: string;
  readonly deletedAt?: string;
}): ReadModelThread {
  return {
    id: ThreadId.makeUnsafe(input.id),
    projectId: input.projectId ?? PROJECT_ID,
    title: `Thread ${input.id}`,
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
    updatedAt: NOW,
    latestTurn: null,
    handoff: null,
    messages: [],
    session: null,
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    deletedAt: input.deletedAt ?? null,
    ...(input.parentThreadId !== undefined
      ? { parentThreadId: ThreadId.makeUnsafe(input.parentThreadId) }
      : {}),
  };
}

async function readModelWith(threads: ReadonlyArray<ReadModelThread>) {
  let model = createEmptyReadModel(NOW);
  for (const [index, projectId] of [PROJECT_ID, OTHER_PROJECT_ID].entries()) {
    model = await Effect.runPromise(
      projectEvent(model, {
        sequence: index + 1,
        eventId: EventId.makeUnsafe(`evt-project-${projectId}`),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.created",
        occurredAt: NOW,
        commandId: CommandId.makeUnsafe(`cmd-project-${projectId}`),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          projectId,
          kind: "project",
          title: projectId,
          workspaceRoot: `/tmp/${projectId}`,
          defaultModelSelection: null,
          scripts: [],
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    );
  }
  return { ...model, threads: [...threads] };
}

function createCommand(threadId: string, parentThreadId: string | null): OrchestrationCommand {
  return {
    type: "thread.create",
    commandId: CommandId.makeUnsafe(`cmd-create-${threadId}`),
    threadId: ThreadId.makeUnsafe(threadId),
    projectId: PROJECT_ID,
    title: "New thread",
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    envMode: "local",
    branch: null,
    worktreePath: null,
    createBranchFlowCompleted: false,
    isPinned: false,
    parentThreadId: parentThreadId === null ? null : ThreadId.makeUnsafe(parentThreadId),
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: null,
    lastKnownPr: null,
    createdAt: NOW,
  };
}

function metaUpdateCommand(threadId: string, parentThreadId: string | null): OrchestrationCommand {
  return {
    type: "thread.meta.update",
    commandId: CommandId.makeUnsafe(`cmd-meta-${threadId}`),
    threadId: ThreadId.makeUnsafe(threadId),
    parentThreadId: parentThreadId === null ? null : ThreadId.makeUnsafe(parentThreadId),
  };
}

function decide(readModel: OrchestrationReadModel, command: OrchestrationCommand) {
  return Effect.runPromise(
    decideOrchestrationCommand({ readModel, command }).pipe(
      Effect.match({
        onFailure: (error) => ({ ok: false as const, detail: String(error.message) }),
        onSuccess: () => ({ ok: true as const, detail: "" }),
      }),
    ),
  );
}

describe("decider parent thread links", () => {
  it("rejects a thread that names itself as its parent", async () => {
    const readModel = await readModelWith([makeThread({ id: "thread-a" })]);
    const result = await decide(readModel, metaUpdateCommand("thread-a", "thread-a"));
    expect(result).toMatchObject({ ok: false });
    expect(result.detail).toContain("cannot be its own parent");
  });

  it("rejects a parent link that closes a cycle", async () => {
    const readModel = await readModelWith([
      makeThread({ id: "thread-a" }),
      makeThread({ id: "thread-b", parentThreadId: "thread-a" }),
      makeThread({ id: "thread-c", parentThreadId: "thread-b" }),
    ]);
    const result = await decide(readModel, metaUpdateCommand("thread-a", "thread-c"));
    expect(result).toMatchObject({ ok: false });
    expect(result.detail).toContain("is a descendant of thread 'thread-a'");
  });

  it("rejects a parent whose stored ancestor chain is already cyclic", async () => {
    const readModel = await readModelWith([
      makeThread({ id: "thread-a" }),
      makeThread({ id: "thread-x", parentThreadId: "thread-y" }),
      makeThread({ id: "thread-y", parentThreadId: "thread-x" }),
    ]);
    const result = await decide(readModel, metaUpdateCommand("thread-a", "thread-x"));
    expect(result).toMatchObject({ ok: false });
    expect(result.detail).toContain("cyclic ancestor chain");
  });

  it("rejects missing, deleted, and cross-project parents on create", async () => {
    const readModel = await readModelWith([
      makeThread({ id: "thread-deleted", deletedAt: NOW }),
      makeThread({ id: "thread-foreign", projectId: OTHER_PROJECT_ID }),
    ]);
    const missing = await decide(readModel, createCommand("thread-new", "thread-missing"));
    const deleted = await decide(readModel, createCommand("thread-new", "thread-deleted"));
    const foreign = await decide(readModel, createCommand("thread-new", "thread-foreign"));
    expect(missing.detail).toContain("does not exist");
    expect(deleted.detail).toContain("does not exist");
    expect(foreign.detail).toContain("different project");
  });

  it("accepts valid links, clearing a link, and re-sending an unchanged link", async () => {
    const readModel = await readModelWith([
      makeThread({ id: "thread-a" }),
      makeThread({ id: "thread-b", parentThreadId: "thread-a" }),
      makeThread({ id: "thread-legacy", parentThreadId: "thread-gone" }),
    ]);
    expect(await decide(readModel, createCommand("thread-new", "thread-b"))).toMatchObject({
      ok: true,
    });
    expect(await decide(readModel, createCommand("thread-new", null))).toMatchObject({ ok: true });
    expect(await decide(readModel, metaUpdateCommand("thread-b", null))).toMatchObject({
      ok: true,
    });
    expect(
      await decide(readModel, metaUpdateCommand("thread-legacy", "thread-gone")),
    ).toMatchObject({ ok: true });
  });
});
