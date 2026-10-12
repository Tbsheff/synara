import {
  ThreadId,
  type OrchestrationThread,
  type ThreadSessionWarmRequestedPayload,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { isCurrentWarmSessionRequest } from "./warmSessionRequest.ts";

const now = Date.now();
const request: ThreadSessionWarmRequestedPayload = {
  threadId: ThreadId.makeUnsafe("warm-thread"),
  modelSelection: { provider: "codex", model: "test", instanceId: "codex" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  createdAt: new Date(now).toISOString(),
};
const thread = {
  modelSelection: request.modelSelection,
  runtimeMode: request.runtimeMode,
  interactionMode: request.interactionMode,
  archivedAt: null,
  session: null,
  latestTurn: null,
  parentThreadId: null,
  sidechatExpiredAt: null,
} satisfies Parameters<typeof isCurrentWarmSessionRequest>[0];

describe("warm request ownership", () => {
  it("admits only current saved settings", () => {
    expect(isCurrentWarmSessionRequest(thread, request, now)).toBe(true);
  });
  it.each([
    { modelSelection: { ...request.modelSelection, model: "other" } },
    { modelSelection: { ...request.modelSelection, instanceId: "codex-other" } },
    { runtimeMode: "full-access" as const },
    { interactionMode: "plan" as const },
  ])("rejects a stale selection and admits its fresh re-warm request: %j", (change) => {
    const updated = { ...thread, ...change };
    expect(isCurrentWarmSessionRequest(updated, request, now)).toBe(false);
    expect(isCurrentWarmSessionRequest(updated, { ...request, ...change }, now)).toBe(true);
  });
  it.each([
    { archivedAt: request.createdAt },
    { sidechatExpiredAt: request.createdAt },
    { parentThreadId: ThreadId.makeUnsafe("parent") },
  ])("refuses ineligible threads: %j", (change) => {
    expect(isCurrentWarmSessionRequest({ ...thread, ...change }, request, now)).toBe(false);
  });
  it("does not replay old open requests or undo a later Stop", () => {
    expect(isCurrentWarmSessionRequest(thread, request, now + 30_001)).toBe(false);
    const session: OrchestrationThread["session"] = {
      threadId: request.threadId,
      providerName: "codex",
      status: "stopped",
      runtimeMode: request.runtimeMode,
      activeTurnId: null,
      lastError: null,
      updatedAt: request.createdAt,
    };
    expect(isCurrentWarmSessionRequest({ ...thread, session }, request, now)).toBe(false);
    expect(
      isCurrentWarmSessionRequest(
        {
          ...thread,
          session: {
            ...session,
            status: "running",
            activeTurnId: "active" as NonNullable<typeof session.activeTurnId>,
          },
        },
        request,
        now,
      ),
    ).toBe(false);
  });
});
