import { ApprovalRequestId, ThreadId } from "@synara/contracts";
import { APPROVAL_ALREADY_ANSWERED_INVARIANT_MARKER } from "@synara/shared/errorMessages";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchCommand: vi.fn(),
  subscribeThread: vi.fn(),
  setRuntimeMode: vi.fn(),
  setError: vi.fn(),
}));

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: {
      dispatchCommand: mocks.dispatchCommand,
      subscribeThread: mocks.subscribeThread,
    },
  }),
}));

vi.mock("../../composerDraftStore", () => ({
  useComposerDraftStore: { getState: () => ({ setRuntimeMode: mocks.setRuntimeMode }) },
}));

vi.mock("../../store", () => ({
  useStore: { getState: () => ({ setError: mocks.setError }) },
}));

import { respondToThreadApproval } from "./respondToThreadApproval";

const THREAD_ID = ThreadId.makeUnsafe("thread-approval");
const REQUEST_ID = ApprovalRequestId.makeUnsafe("request-approval");

function respondForSession() {
  return respondToThreadApproval({
    threadId: THREAD_ID,
    requestId: REQUEST_ID,
    decision: "acceptForSession",
    requestKind: "command",
    runtimeMode: "approval-required",
  });
}

describe("respondToThreadApproval session grants", () => {
  beforeEach(() => {
    mocks.dispatchCommand.mockReset();
    mocks.subscribeThread.mockReset().mockResolvedValue(undefined);
    mocks.setRuntimeMode.mockReset();
    mocks.setError.mockReset();
  });

  it("keeps the saved policy after the server accepts a session grant", async () => {
    let accept: ((value: { sequence: number }) => void) | undefined;
    mocks.dispatchCommand.mockReturnValue(
      new Promise((resolve) => {
        accept = resolve;
      }),
    );
    const pending = respondForSession();
    await Promise.resolve();
    expect(mocks.setRuntimeMode).not.toHaveBeenCalled();
    accept?.({ sequence: 1 });
    await pending;
    expect(mocks.setRuntimeMode).not.toHaveBeenCalled();
  });

  it("sends only the selected provider rule without changing the saved mode", async () => {
    mocks.dispatchCommand.mockResolvedValue(undefined);
    const approvalRule = { type: "command-prefix" as const, prefix: ["git", "status"] };
    await respondToThreadApproval({
      threadId: THREAD_ID,
      requestId: REQUEST_ID,
      decision: "accept",
      approvalRule,
      runtimeMode: "approval-required",
    });
    expect(mocks.dispatchCommand).toHaveBeenCalledWith(expect.objectContaining({ approvalRule }));
    expect(mocks.setRuntimeMode).not.toHaveBeenCalled();
  });

  it("keeps the saved mode when the dispatch fails", async () => {
    mocks.dispatchCommand.mockRejectedValue(new Error("Provider session is gone."));
    await expect(respondForSession()).rejects.toThrow("Provider session is gone.");
    expect(mocks.setRuntimeMode).not.toHaveBeenCalled();
    expect(mocks.setError).toHaveBeenCalledOnce();
  });

  it("keeps the saved mode when another surface already answered", async () => {
    mocks.dispatchCommand.mockRejectedValue(
      new Error(`Approval request ${REQUEST_ID} ${APPROVAL_ALREADY_ANSWERED_INVARIANT_MARKER}`),
    );
    await expect(respondForSession()).resolves.toBeUndefined();
    expect(mocks.setRuntimeMode).not.toHaveBeenCalled();
    expect(mocks.subscribeThread).toHaveBeenCalledOnce();
  });
});
