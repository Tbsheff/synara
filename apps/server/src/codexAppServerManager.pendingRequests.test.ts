import { describe, expect, it, vi } from "vitest";

import { CodexAppServerManager } from "./codexAppServerManager";

function createRequestHarness(options: { discovery?: boolean } = {}) {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "running",
      threadId: "thread_pending",
      runtimeMode: "approval-required",
      activeTurnId: "turn_1",
      resumeCursor: { threadId: "provider_thread" },
      createdAt: "2026-10-11T00:00:00.000Z",
      updatedAt: "2026-10-11T00:00:00.000Z",
    },
    account: { type: "unknown", planType: null, sparkEnabled: true },
    pending: new Map(),
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    collabReceiverTurns: new Map<string, string>(),
    collabReceiverParents: new Map<string, string>(),
    reviewTurnIds: new Set<string>(),
    nextRequestId: 1,
    stopping: false,
    ...(options.discovery ? { discovery: true } : {}),
  };
  const internals = manager as unknown as {
    emitEvent: (...args: unknown[]) => void;
    writeMessage: (...args: unknown[]) => Promise<void>;
    handleServerRequest: (context: unknown, request: Record<string, unknown>) => Promise<void>;
  };
  const emitEvent = vi.spyOn(internals, "emitEvent").mockImplementation(() => {});
  const writeMessage = vi.spyOn(internals, "writeMessage").mockResolvedValue(undefined);
  const commandApproval = (id: number | string) =>
    internals.handleServerRequest(context, {
      id,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "provider_thread",
        turnId: "turn_1",
        itemId: `call_${id}`,
        command: "ls",
      },
    });
  const question = (id: number) =>
    internals.handleServerRequest(context, {
      id,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "provider_thread",
        turnId: "turn_1",
        itemId: `tool_${id}`,
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which scope?",
            options: [{ label: "repo", description: "Whole repo" }],
          },
        ],
      },
    });
  return { context, emitEvent, writeMessage, commandApproval, question };
}

describe("Codex pending human-response requests", () => {
  it("keeps one entry when the provider repeats a request id", async () => {
    const { context, emitEvent, writeMessage, commandApproval } = createRequestHarness();

    await commandApproval(7);
    await commandApproval(7);

    expect(context.pendingApprovals.size).toBe(1);
    expect(emitEvent).toHaveBeenCalledTimes(1);
    expect(writeMessage).not.toHaveBeenCalled();
  });

  it("refuses requests beyond the per-session cap on their own id", async () => {
    const { context, emitEvent, writeMessage, commandApproval, question } = createRequestHarness();

    for (let id = 1; id <= 63; id += 1) await commandApproval(id);
    await question(64);
    expect(context.pendingApprovals.size + context.pendingUserInputs.size).toBe(64);

    await commandApproval(65);
    await question(66);

    expect(context.pendingApprovals.size + context.pendingUserInputs.size).toBe(64);
    expect(emitEvent).toHaveBeenCalledTimes(64);
    expect(writeMessage).toHaveBeenCalledTimes(2);
    expect(writeMessage).toHaveBeenNthCalledWith(
      1,
      context,
      expect.objectContaining({ id: 65, error: expect.objectContaining({ code: -32000 }) }),
    );
    expect(writeMessage).toHaveBeenNthCalledWith(
      2,
      context,
      expect.objectContaining({ id: 66, error: expect.objectContaining({ code: -32000 }) }),
    );
  });

  it("refuses approvals and questions on discovery sessions instead of parking them", async () => {
    const { context, emitEvent, writeMessage, commandApproval, question } = createRequestHarness({
      discovery: true,
    });

    await commandApproval(1);
    await question(2);

    expect(context.pendingApprovals.size).toBe(0);
    expect(context.pendingUserInputs.size).toBe(0);
    expect(emitEvent).not.toHaveBeenCalled();
    expect(writeMessage).toHaveBeenCalledTimes(2);
  });
});
