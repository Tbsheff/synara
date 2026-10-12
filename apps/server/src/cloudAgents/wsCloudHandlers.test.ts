import {
  CLOUD_AGENTS_BETA_ONLY_MESSAGE,
  CLOUD_AGENTS_UNAVAILABLE_ERROR_CODE,
  CLOUD_AGENTS_WS_METHODS,
  CloudTaskNotFoundError,
  type CloudTaskId,
  type CloudTaskRefInput,
} from "@synara/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { CloudAgentsGatewayShape } from "./CloudAgentsGateway";
import {
  makeCloudWatchTaskStream,
  makeWsCloudHandlers,
  toCloudWsRpcError,
} from "./wsCloudHandlers";

const TASK_REF: CloudTaskRefInput = {
  provider: "codex",
  taskId: "task_e_0123456789abcdef0123456789abcdef" as CloudTaskId,
};

function spyGateway() {
  const calls: string[] = [];
  const record =
    (name: string) =>
    (..._args: ReadonlyArray<unknown>) => {
      calls.push(name);
      return Effect.die(new Error(`gateway ${name} must not run`));
    };
  const gateway = {
    getCapabilities: record("getCapabilities"),
    listEnvironments: record("listEnvironments"),
    listTasks: record("listTasks"),
    getTask: record("getTask"),
    submit: record("submit"),
    listSubmissions: record("listSubmissions"),
    getDiff: record("getDiff"),
    applyToWorktree: record("applyToWorktree"),
    sendFollowUp: record("sendFollowUp"),
    watchTask: vi.fn(() => {
      calls.push("watchTask");
      return Stream.empty;
    }),
  } as unknown as CloudAgentsGatewayShape;
  return { gateway, calls };
}

const requestMethods = Object.values(CLOUD_AGENTS_WS_METHODS).filter(
  (method) => method !== CLOUD_AGENTS_WS_METHODS.watchTask,
);

describe("makeWsCloudHandlers", () => {
  it("answers every request method of the cloud group", () => {
    const handlers = makeWsCloudHandlers({ enabled: true, gateway: spyGateway().gateway });
    expect(Object.keys(handlers).toSorted()).toEqual(requestMethods.toSorted());
  });

  it("refuses every method on Stable before the gateway runs", async () => {
    const { gateway, calls } = spyGateway();
    const handlers = makeWsCloudHandlers({ enabled: false, gateway });
    for (const method of requestMethods) {
      const handler = handlers[method] as (input: unknown) => Effect.Effect<unknown, unknown>;
      const error = await Effect.runPromise(Effect.flip(handler(TASK_REF)));
      expect(error).toMatchObject({
        message: CLOUD_AGENTS_BETA_ONLY_MESSAGE,
        code: CLOUD_AGENTS_UNAVAILABLE_ERROR_CODE,
        retryable: false,
      });
    }
    const watchError = await Effect.runPromise(
      Effect.flip(Stream.runDrain(makeCloudWatchTaskStream({ enabled: false, gateway }, TASK_REF))),
    );
    expect(watchError.code).toBe(CLOUD_AGENTS_UNAVAILABLE_ERROR_CODE);
    expect(calls).toEqual([]);
  });

  it("refuses when the gateway layer is absent", async () => {
    const handlers = makeWsCloudHandlers({ enabled: true, gateway: undefined });
    const error = await Effect.runPromise(
      Effect.flip(handlers[CLOUD_AGENTS_WS_METHODS.listSubmissions]({})),
    );
    expect(error.code).toBe(CLOUD_AGENTS_UNAVAILABLE_ERROR_CODE);
  });

  it("forwards cloud errors with their tag as the code", async () => {
    const gateway = {
      ...spyGateway().gateway,
      getTask: () =>
        Effect.fail(new CloudTaskNotFoundError({ provider: "codex", taskId: TASK_REF.taskId })),
    } as CloudAgentsGatewayShape;
    const handlers = makeWsCloudHandlers({ enabled: true, gateway });
    const error = await Effect.runPromise(
      Effect.flip(handlers[CLOUD_AGENTS_WS_METHODS.getTask](TASK_REF)),
    );
    expect(error.code).toBe("CloudTaskNotFoundError");
    expect(error.message).toContain(TASK_REF.taskId);
  });

  it("keeps unknown failures without a cloud code", () => {
    const error = toCloudWsRpcError(new Error("disk full"), "fallback");
    expect(error.message).toBe("disk full");
    expect(error.code).toBeUndefined();
    expect(toCloudWsRpcError("weird", "fallback").message).toBe("fallback");
  });
});
