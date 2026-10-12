import type { OrchestrationThreadActivity, ProviderRuntimeEvent } from "@synara/contracts";
import {
  ApprovalRequestId,
  CommandId,
  EventId,
  OrchestrationCommand,
  RuntimeItemId,
  ThreadId,
  TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS,
  TranscriptNoticeKind,
  TurnId,
} from "@synara/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  hookActivityDedupeKey,
  hookNoticeActivityId,
  isQuietSuccessfulHook,
  projectProviderRuntimeActivities,
  providerActivityUpdateDedupeKey,
  providerActivityUpdateFingerprint,
  quietHookGroupActivity,
  sessionStatusActivity,
  userFacingStatusReason,
} from "./providerRuntimeActivityProjection.ts";

const CREATED_AT = "2026-07-20T10:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-activity-projection");
const TURN_ID = TurnId.makeUnsafe("turn-activity-projection");

function runtimeEvent(input: Record<string, unknown> & { eventId: string }): ProviderRuntimeEvent {
  return {
    provider: "codex",
    createdAt: CREATED_AT,
    threadId: THREAD_ID,
    ...input,
    eventId: EventId.makeUnsafe(input.eventId),
  } as ProviderRuntimeEvent;
}

/**
 * The single invariant that matters: every activity this projection emits has to
 * survive the schema of the command that carries it. Server-built commands never
 * cross the WebSocket decode boundary, so nothing else enforces the schema-only
 * refinements (`TrimmedNonEmptyString`, `Schema.Json`) that TypeScript cannot express.
 */
function decodeActivityAppendCommand(activity: OrchestrationThreadActivity): unknown {
  return Schema.decodeUnknownSync(OrchestrationCommand)({
    type: "thread.activity.append",
    commandId: CommandId.makeUnsafe("cmd-activity-append"),
    threadId: THREAD_ID,
    activity,
    createdAt: CREATED_AT,
  });
}

function expectSchemaValidActivities(event: ProviderRuntimeEvent, sessionSequence?: number): void {
  const activities = projectProviderRuntimeActivities(event, sessionSequence);
  expect(activities.length).toBeGreaterThan(0);
  for (const activity of activities) {
    expect(() => decodeActivityAppendCommand(activity)).not.toThrow();
  }
}

it("persists terminal error identity and announced retry state in chat activities", () => {
  const error = projectProviderRuntimeActivities(
    runtimeEvent({
      type: "runtime.error",
      eventId: "error",
      turnId: TURN_ID,
      payload: {
        message: "Temporarily unavailable",
        class: "provider_error",
        errorCode: "server_overloaded",
      },
    }),
  )[0]!;
  expect(error.payload).toMatchObject({
    errorCode: "server_overloaded",
    message: "Temporarily unavailable",
  });
  const completion = projectProviderRuntimeActivities(
    runtimeEvent({
      type: "turn.completed",
      eventId: "completion",
      turnId: TURN_ID,
      payload: {
        state: "failed",
        errorMessage: "Temporarily unavailable",
        errorCode: "server_overloaded",
      },
    }),
  )[0]!;
  expect(completion.payload).toMatchObject({ errorCode: "server_overloaded", state: "failed" });
  const warning = projectProviderRuntimeActivities(
    runtimeEvent({
      type: "runtime.warning",
      eventId: "retry",
      turnId: TURN_ID,
      payload: { message: "Temporarily unavailable", willRetry: true },
    }),
  )[0]!;
  expect(warning).toMatchObject({
    summary: "Provider retrying",
    turnId: TURN_ID,
    payload: { willRetry: true },
  });
  for (const activity of [error, completion, warning]) {
    expect(() => decodeActivityAppendCommand(activity)).not.toThrow();
  }
});

it("projects only the allowlisted runtime error detail, capped", () => {
  const event = runtimeEvent({
    provider: "claudeAgent",
    type: "runtime.error",
    eventId: "error-detail",
    turnId: TURN_ID,
    payload: {
      message: "Reached maximum number of turns (8)",
      class: "provider_error",
      errorCode: "error_max_turns",
      detail: {
        errors: ["  ", "x".repeat(900), ...Array.from({ length: 12 }, (_, i) => `error ${i}`)],
        permissionDenials: 2,
        terminalReason: "max_turns",
        apiKey: "secret",
        stack: "Error: at foo",
      },
    },
  });
  const [activity] = projectProviderRuntimeActivities(event);
  const detail = (activity!.payload as { detail: Record<string, unknown> }).detail;
  expect(Object.keys(detail).toSorted()).toEqual([
    "errors",
    "errorsTruncated",
    "permissionDenials",
    "terminalReason",
  ]);
  const errors = detail.errors as string[];
  expect(errors).toHaveLength(10);
  expect(errors[0]).toHaveLength(500);
  expect(errors[1]).toBe("error 0");
  expect(detail).toMatchObject({
    errorsTruncated: true,
    permissionDenials: 2,
    terminalReason: "max_turns",
  });
  expectSchemaValidActivities(event);
});

it("omits runtime error detail that carries no allowlisted field", () => {
  const [activity] = projectProviderRuntimeActivities(
    runtimeEvent({
      type: "runtime.error",
      eventId: "error-cause",
      turnId: TURN_ID,
      payload: { message: "Boom", detail: { stack: "Error: Boom", errors: [42] } },
    }),
  );
  expect(activity!.payload).not.toHaveProperty("detail");
});

it("projects tool summaries with stable group identity and no empty rows", () => {
  const event = runtimeEvent({
    provider: "claudeAgent",
    type: "tool.summary",
    eventId: "summary-1",
    turnId: TURN_ID,
    payload: {
      summary: "Reviewed the provider.\n\nCancellation is covered.",
      precedingToolUseIds: ["read-1", "test-1"],
    },
  });
  const [activity] = projectProviderRuntimeActivities(event);
  expect(activity).toMatchObject({
    kind: "tool.summary",
    tone: "info",
    summary: "Tool summary",
    payload: { detail: "Reviewed the provider.\n\nCancellation is covered." },
  });
  expect(() => decodeActivityAppendCommand(activity!)).not.toThrow();
  expect(
    projectProviderRuntimeActivities({
      ...event,
      eventId: EventId.makeUnsafe("summary-repeated"),
    })[0]?.id,
  ).toBe(activity?.id);
  expect(
    projectProviderRuntimeActivities(
      runtimeEvent({
        provider: "claudeAgent",
        type: "tool.summary",
        eventId: "empty",
        payload: { summary: "  " },
      }),
    ),
  ).toEqual([]);
});

it.each([
  [{ isAuthenticating: true }, "Claude authentication started", "info"],
  [{ isAuthenticating: false }, "Claude authentication finished", "info"],
  [
    { isAuthenticating: false, error: "secret-login-token" },
    "Claude authentication needs attention.",
    "error",
  ],
] as const)("projects safe authentication status %j", (status, summary, tone) => {
  const [activity] = projectProviderRuntimeActivities(
    runtimeEvent({
      provider: "claudeAgent",
      type: "auth.status",
      eventId: "auth-status",
      payload: { ...status, output: ["https://login.example/?token=secret-login-token"] },
    }),
  );
  expect(activity).toMatchObject({ kind: "auth.status", summary, tone, turnId: null });
  expect(JSON.stringify(activity)).not.toContain("secret-login-token");
  expect(() => decodeActivityAppendCommand(activity!)).not.toThrow();
});

it.each(["info", "warning"])("projects Pi %s notifications as notices", (type) => {
  const [activity] = projectProviderRuntimeActivities(
    runtimeEvent({
      provider: "pi",
      type: "runtime.warning",
      eventId: "pi-notification",
      turnId: TURN_ID,
      payload: { message: "Extension notification", detail: { type } },
      raw: { source: "pi.sdk.event", method: "extension/ui/notify", payload: { type } },
    }),
  );

  expect(activity).toMatchObject({
    tone: "info",
    kind: "runtime.warning",
    summary: type === "info" ? "Pi extension" : "Runtime warning",
    payload: { message: "Extension notification", detail: "Extension notification" },
  });
  expect(() => decodeActivityAppendCommand(activity!)).not.toThrow();
});

it("keeps the full runtime warning message so the row's hover card can reveal it", () => {
  // The work-log row clips the notice to one line with CSS `truncate`; the hover
  // card can only show what the server stored, so the payload must carry the full
  // text (e.g. Claude's ~190-char token-usage warning) rather than a row-sized cut.
  const claudeWarning =
    "Claude is processing ~201k logical prompt tokens per request (~200k cached reads, ~1k new/cache-write). Large active contexts can consume usage faster; cached reads cost less than fresh input.";
  const [activity] = projectProviderRuntimeActivities(
    runtimeEvent({
      provider: "claudeAgent",
      type: "runtime.warning",
      eventId: "runtime-warning-full-message",
      turnId: TURN_ID,
      payload: { message: claudeWarning },
    }),
  );

  expect(activity).toMatchObject({
    kind: "runtime.warning",
    summary: "Runtime warning",
    payload: { message: claudeWarning, detail: claudeWarning },
  });
  expect(() => decodeActivityAppendCommand(activity!)).not.toThrow();

  // The shared activity-data cap still bounds oversized warnings.
  const oversized = `prefix-${"x".repeat(2_100)}`;
  const [capped] = projectProviderRuntimeActivities(
    runtimeEvent({
      type: "runtime.warning",
      eventId: "runtime-warning-oversized",
      turnId: TURN_ID,
      payload: { message: oversized },
    }),
  );
  const cappedPayload = capped?.payload as { message: string; detail: string };
  expect(cappedPayload.message).toHaveLength(2_000);
  expect(cappedPayload.message.endsWith("...")).toBe(true);
});

it("keeps the full approval detail so the pending-approval panel shows the whole command", () => {
  // The Claude adapter deliberately allows ~400 chars of command text in the
  // approval detail; the panel can only render what the server stored, so the
  // payload must carry the full string rather than a 180-char row-sized cut.
  const approvalDetail =
    `Bash: ${"git -C /workspace status && ".repeat(14)}git push origin main`.slice(0, 400);
  const [activity] = projectProviderRuntimeActivities(
    runtimeEvent({
      type: "request.opened",
      eventId: "approval-full-detail",
      turnId: TURN_ID,
      requestId: ApprovalRequestId.makeUnsafe("request-full-detail"),
      payload: { requestType: "command_execution_approval", detail: approvalDetail },
    }),
  );

  expect(activity).toMatchObject({
    kind: "approval.requested",
    payload: { detail: approvalDetail },
  });
  expect(() => decodeActivityAppendCommand(activity!)).not.toThrow();

  // The shared activity-data cap still bounds oversized details.
  const oversized = `prefix-${"x".repeat(2_100)}`;
  const [capped] = projectProviderRuntimeActivities(
    runtimeEvent({
      type: "request.opened",
      eventId: "approval-oversized-detail",
      turnId: TURN_ID,
      payload: { requestType: "command_execution_approval", detail: oversized },
    }),
  );
  const cappedPayload = capped?.payload as { detail: string };
  expect(cappedPayload.detail).toHaveLength(2_000);
  expect(cappedPayload.detail.endsWith("...")).toBe(true);
});

it("keeps the full tool progress summary so the hover card can reveal it", () => {
  // The work-log row clips the progress detail to one line with CSS `truncate`;
  // the hover card can only show what the server stored, so the payload must
  // carry the full summary rather than a 180-char row-sized cut.
  const progressSummary = `mcp__long-runner__sync: fetched 1,204 records across 17 pages; last checkpoint at offset 9,216 (page 14 of 17) — resuming pagination for shard eu-west after the rate-limit window resets`;
  expect(progressSummary.length).toBeGreaterThan(180);
  const [activity] = projectProviderRuntimeActivities(
    runtimeEvent({
      type: "tool.progress",
      eventId: "tool-progress-full-summary",
      turnId: TURN_ID,
      payload: {
        toolUseId: "tool-progress-full",
        toolName: "mcp__long-runner__sync",
        summary: progressSummary,
        elapsedSeconds: 4.8,
      },
    }),
  );

  expect(activity).toMatchObject({
    kind: "tool.updated",
    payload: { detail: progressSummary },
  });
  expect(() => decodeActivityAppendCommand(activity!)).not.toThrow();

  // The shared activity-data cap still bounds oversized summaries.
  const oversized = `prefix-${"y".repeat(2_100)}`;
  const [capped] = projectProviderRuntimeActivities(
    runtimeEvent({
      type: "tool.progress",
      eventId: "tool-progress-oversized",
      turnId: TURN_ID,
      payload: { toolUseId: "tool-oversized", toolName: "mcp__x", summary: oversized },
    }),
  );
  const cappedPayload = capped?.payload as { detail: string };
  expect(cappedPayload.detail).toHaveLength(2_000);
  expect(cappedPayload.detail.endsWith("...")).toBe(true);
});

it("keeps the full task failure summary so the work-log reveal can show it", () => {
  // A failed background/subagent task's summary is exactly what the operator
  // needs to read in full; provider-authored failure text (rate-limit bodies,
  // unsupported-version messages) routinely runs past 180 chars.
  const failureSummary = `Subagent run failed after 3 retries: provider returned 429 rate_limit_error — "request exceeds the per-minute token budget for claude-opus-4-1; reduce context or wait for the current window to reset" (request id req_01JX4K9VF0Q8M2W7ABCDE)`;
  expect(failureSummary.length).toBeGreaterThan(180);
  const [activity] = projectProviderRuntimeActivities(
    runtimeEvent({
      type: "task.completed",
      eventId: "task-completed-full-summary",
      turnId: TURN_ID,
      payload: { taskId: "task-failed-1", status: "failed", summary: failureSummary },
    }),
  );

  expect(activity).toMatchObject({
    kind: "task.completed",
    tone: "error",
    payload: { detail: failureSummary },
  });
  expect(() => decodeActivityAppendCommand(activity!)).not.toThrow();

  // The shared activity-data cap still bounds oversized summaries.
  const oversized = `prefix-${"z".repeat(2_100)}`;
  const [capped] = projectProviderRuntimeActivities(
    runtimeEvent({
      type: "task.completed",
      eventId: "task-completed-oversized",
      turnId: TURN_ID,
      payload: { taskId: "task-failed-2", status: "failed", summary: oversized },
    }),
  );
  const cappedPayload = capped?.payload as { detail: string };
  expect(cappedPayload.detail).toHaveLength(2_000);
  expect(cappedPayload.detail.endsWith("...")).toBe(true);
});

it("keeps the full task update error so the work-log reveal can show it", () => {
  // The task.updated error is the provider's own failure text; the row's CSS
  // `truncate` does the one-line clip, so the payload must carry the full
  // string rather than a 180-char row-sized cut.
  const taskError = `Task crashed while streaming the provider response: socket hang up after 42s without a delta — the CLI reported "unsupported client version 0.31.x; server requires >= 0.40.0" and refused the reconnect attempt (attempt 3 of 3)`;
  expect(taskError.length).toBeGreaterThan(180);
  const [activity] = projectProviderRuntimeActivities(
    runtimeEvent({
      type: "task.updated",
      eventId: "task-updated-full-error",
      turnId: TURN_ID,
      payload: { taskId: "task-failed-3", status: "failed", error: taskError },
    }),
  );

  expect(activity).toMatchObject({
    kind: "task.updated",
    tone: "error",
    payload: { detail: taskError },
  });
  expect(() => decodeActivityAppendCommand(activity!)).not.toThrow();

  // The shared activity-data cap still bounds oversized errors.
  const oversized = `prefix-${"e".repeat(2_100)}`;
  const [capped] = projectProviderRuntimeActivities(
    runtimeEvent({
      type: "task.updated",
      eventId: "task-updated-oversized",
      turnId: TURN_ID,
      payload: { taskId: "task-failed-4", status: "failed", error: oversized },
    }),
  );
  const cappedPayload = capped?.payload as { detail: string };
  expect(cappedPayload.detail).toHaveLength(2_000);
  expect(cappedPayload.detail.endsWith("...")).toBe(true);
});

describe("projected activities satisfy the orchestration command schema", () => {
  it("omits an absent approval request id instead of emitting an explicit undefined", () => {
    expectSchemaValidActivities(
      runtimeEvent({
        type: "request.opened",
        eventId: "approval-without-request-id",
        turnId: TURN_ID,
        payload: { requestType: "command_execution_approval", detail: "rm -rf build" },
      }),
    );
    expectSchemaValidActivities(
      runtimeEvent({
        type: "request.resolved",
        eventId: "approval-resolved-without-request-id",
        turnId: TURN_ID,
        payload: { requestType: "command_execution_approval", decision: "approved" },
      }),
    );
    const [opened] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "request.opened",
        eventId: "approval-without-request-id",
        turnId: TURN_ID,
        payload: { requestType: "command_execution_approval" },
      }),
    );
    expect(Object.keys(opened?.payload as Record<string, unknown>)).not.toContain("requestId");

    // `ApprovalRequestId.makeUnsafe` rejects untrimmed input instead of trimming it.
    const [padded] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "request.opened",
        eventId: "approval-padded-request-id",
        turnId: TURN_ID,
        requestId: "  approval-7  ",
        payload: { requestType: "command_execution_approval" },
      }),
    );
    expect(padded?.payload).toMatchObject({ requestId: "approval-7" });
  });

  it("never derives a blank summary from a blank tool name or title", () => {
    expectSchemaValidActivities(
      runtimeEvent({
        type: "tool.progress",
        eventId: "tool-progress-blank-name",
        turnId: TURN_ID,
        payload: { toolUseId: "tool-blank", toolName: "   ", summary: "" },
      }),
    );
    expectSchemaValidActivities(
      runtimeEvent({
        type: "item.completed",
        eventId: "item-completed-blank-title",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("tool-item"),
        payload: { itemType: "command_execution", status: "completed", title: "" },
      }),
    );
    expectSchemaValidActivities(
      runtimeEvent({
        type: "item.updated",
        eventId: "item-updated-blank-title",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("tool-item"),
        payload: { itemType: "command_execution", status: "inProgress", title: "  " },
      }),
    );
  });

  // `TurnId.makeUnsafe` validates: it rejects "" *and* untrimmed input rather than
  // normalizing it, so an unnormalized runtime turn id throws inside the projection
  // itself before it can even reach the command schema.
  it("normalizes a blank or untrimmed runtime turn id instead of throwing", () => {
    expectSchemaValidActivities(
      runtimeEvent({
        type: "turn.completed",
        eventId: "turn-blank-turn-id",
        turnId: "",
        payload: { state: "completed" },
      }),
    );
    const [padded] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "turn.completed",
        eventId: "turn-padded-turn-id",
        turnId: "  turn-padded  ",
        payload: { state: "completed" },
      }),
    );
    expect(padded?.turnId).toBe("turn-padded");
  });

  it("drops a fractional runtime sequence rather than emitting a non-integer", () => {
    expectSchemaValidActivities(
      runtimeEvent({
        type: "turn.steered",
        eventId: "turn-steered-fractional-sequence",
        turnId: TURN_ID,
        payload: { message: "keep going" },
      }),
      12.5,
    );
  });

  it("projects a subagent steer but not a steer of the thread's own turn", () => {
    expect(
      projectProviderRuntimeActivities(
        runtimeEvent({
          type: "turn.steered",
          eventId: "turn-steered-own-turn",
          turnId: TURN_ID,
          payload: { message: "dimmi ciao subito", target: "turn" },
        }),
      ),
    ).toEqual([]);
    expectSchemaValidActivities(
      runtimeEvent({
        type: "turn.steered",
        eventId: "turn-steered-subagent",
        turnId: TURN_ID,
        payload: { message: "dimmi ciao subito", target: "subagent" },
      }),
    );
  });

  it("keeps raw provider payloads inside what Schema.Json admits", () => {
    const cyclic: Record<string, unknown> = { window: "5h" };
    cyclic.self = cyclic;
    const rateLimitsEvent = runtimeEvent({
      type: "account.rate-limits.updated",
      eventId: "rate-limits-hostile",
      payload: {
        rateLimits: {
          status: "rejected",
          utilization: 0.9,
          resetsAt: undefined,
          planTier: undefined,
          requestCount: 42n,
          onReset: () => undefined,
          observedAt: new Date("2026-07-27T00:00:00.000Z"),
          cyclic,
        },
      },
    });
    expectSchemaValidActivities(rateLimitsEvent);
    const rateLimitsActivity = projectProviderRuntimeActivities(rateLimitsEvent).find(
      (activity) => activity.kind === "account.rate-limits.updated",
    );
    expect(rateLimitsActivity?.payload).toMatchObject({
      observedAt: "2026-07-27T00:00:00.000Z",
    });
    expectSchemaValidActivities(
      runtimeEvent({
        type: "thread.token-usage.updated",
        eventId: "token-usage-explicit-undefined",
        turnId: TURN_ID,
        payload: { usage: { usedTokens: 1_000, maxTokens: 200_000, usedPercent: undefined } },
      }),
    );
    expectSchemaValidActivities(
      runtimeEvent({
        type: "task.progress",
        eventId: "task-progress-raw-usage",
        turnId: TURN_ID,
        payload: {
          taskId: "task-1",
          description: "Working",
          usage: { inputTokens: 10, outputTokens: undefined, costUsd: Number.NaN },
        },
      }),
    );
  });
});

describe("provider runtime activity projection", () => {
  it("keeps assistant text and assistant lifecycle events out of work activity", () => {
    const events = [
      runtimeEvent({
        type: "content.delta",
        eventId: "assistant-delta",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("assistant-item"),
        payload: { streamKind: "assistant_text", delta: "hello" },
      }),
      runtimeEvent({
        type: "item.started",
        eventId: "assistant-started",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("assistant-item"),
        payload: { itemType: "assistant_message", status: "inProgress" },
      }),
      runtimeEvent({
        type: "item.completed",
        eventId: "assistant-completed",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("assistant-item"),
        payload: { itemType: "assistant_message", status: "completed" },
      }),
    ];

    expect(events.map((event) => projectProviderRuntimeActivities(event))).toEqual([[], [], []]);
  });

  it("projects only readable completed Codex-family reasoning summaries", () => {
    const absent = [
      runtimeEvent({
        type: "content.delta",
        eventId: "reasoning-delta",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("reasoning-item"),
        payload: { streamKind: "reasoning_summary_text", delta: "Inspecting code" },
      }),
      runtimeEvent({
        type: "item.completed",
        eventId: "reasoning-private",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("reasoning-private"),
        payload: {
          itemType: "reasoning",
          status: "completed",
          detail: "  <!-- encrypted reasoning -->  ",
        },
      }),
      runtimeEvent({
        type: "item.completed",
        eventId: "reasoning-cursor",
        provider: "cursor",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("reasoning-cursor"),
        payload: { itemType: "reasoning", status: "completed", detail: "Readable" },
      }),
    ];
    expect(absent.map((event) => projectProviderRuntimeActivities(event))).toEqual([[], [], []]);

    for (const provider of ["codex", "antigravity"] as const) {
      const [activity] = projectProviderRuntimeActivities(
        runtimeEvent({
          type: "item.completed",
          eventId: `reasoning-${provider}`,
          provider,
          turnId: TURN_ID,
          itemId: RuntimeItemId.makeUnsafe(`reasoning-${provider}`),
          payload: {
            itemType: "reasoning",
            status: "completed",
            detail: "Read the protocol mapping",
          },
        }),
      );
      expect(activity).toMatchObject({
        id: `provider-reasoning:${THREAD_ID}:reasoning-${provider}`,
        kind: "task.progress",
        summary: "Reasoning trace",
        payload: {
          status: "completed",
          detail: "Read the protocol mapping",
          data: { toolCallId: `reasoning-${provider}` },
        },
      });
    }
  });

  it("maps tool progress without losing call identity", () => {
    const event = runtimeEvent({
      type: "tool.progress",
      eventId: "tool-progress",
      turnId: TURN_ID,
      payload: {
        toolUseId: "tool-1",
        toolName: "mcp__github__fetch_pr",
        summary: "Fetching PR",
        elapsedSeconds: 1.2,
      },
    });
    const [activity] = projectProviderRuntimeActivities(event);

    expect(activity).toMatchObject({
      kind: "tool.updated",
      tone: "tool",
      summary: "mcp__github__fetch_pr",
      payload: {
        itemType: "mcp_tool_call",
        title: "MCP tool call",
        detail: "Fetching PR",
        data: {
          toolUseId: "tool-1",
          toolName: "mcp__github__fetch_pr",
          summary: "Fetching PR",
          elapsedSeconds: 1.2,
        },
      },
    });
    expect(providerActivityUpdateDedupeKey(event, THREAD_ID, activity!)).toBe(
      `${THREAD_ID}:codex:tool.updated:tool-1`,
    );
    expect(providerActivityUpdateFingerprint(activity!)).toContain('"kind":"tool.updated"');
  });

  it.each(["antigravity"] as const)(
    "projects %s tool lifecycle events through the same canonical activities",
    (provider) => {
      const itemId = RuntimeItemId.makeUnsafe(`${provider}-tool-1`);
      const data = { toolCallId: itemId, toolName: "run_command" };
      const [started] = projectProviderRuntimeActivities(
        runtimeEvent({
          provider,
          type: "item.started",
          eventId: `${provider}-tool-started`,
          turnId: TURN_ID,
          itemId,
          payload: {
            itemType: "command_execution",
            status: "inProgress",
            title: "run_command",
            data,
          },
        }),
      );
      const [completed] = projectProviderRuntimeActivities(
        runtimeEvent({
          provider,
          type: "item.completed",
          eventId: `${provider}-tool-completed`,
          turnId: TURN_ID,
          itemId,
          payload: {
            itemType: "command_execution",
            status: "completed",
            title: "run_command",
            data,
          },
        }),
      );

      expect(started).toMatchObject({
        kind: "tool.started",
        summary: "run_command started",
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "run_command",
          data,
        },
      });
      expect(completed).toMatchObject({
        kind: "tool.completed",
        summary: "run_command",
        payload: {
          itemType: "command_execution",
          status: "completed",
          title: "run_command",
          data,
        },
      });
      expect(() => decodeActivityAppendCommand(started!)).not.toThrow();
      expect(() => decodeActivityAppendCommand(completed!)).not.toThrow();
    },
  );

  it("maps canonical approvals and structured user input", () => {
    const approval = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "request.opened",
        eventId: "approval-request",
        lifecycleGeneration: "generation-1",
        requestId: ApprovalRequestId.makeUnsafe("request-1"),
        payload: {
          requestType: "command_execution_approval",
          detail: "pwd",
          args: { sessionApprovalAvailable: false },
        },
      }),
    )[0];
    expect(approval).toMatchObject({
      kind: "approval.requested",
      summary: "Command approval requested",
      payload: {
        requestId: "request-1",
        lifecycleGeneration: "generation-1",
        requestKind: "command",
        requestType: "command_execution_approval",
        detail: "pwd",
        sessionApprovalAvailable: false,
      },
    });
    const [resolvedApproval] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "request.resolved",
        eventId: "approval-resolved",
        lifecycleGeneration: "generation-1",
        requestId: ApprovalRequestId.makeUnsafe("request-1"),
        payload: { requestType: "command_execution_approval", decision: "accept" },
      }),
    );
    expect(resolvedApproval).toMatchObject({
      kind: "approval.resolved",
      payload: {
        requestKind: "command",
        requestType: "command_execution_approval",
        lifecycleGeneration: "generation-1",
      },
    });

    const permissionApproval = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "request.opened",
        eventId: "permission-approval-request",
        requestId: ApprovalRequestId.makeUnsafe("permission-request-1"),
        payload: {
          requestType: "permissions_approval",
          detail: "Needs package metadata",
          args: {
            permissions: {
              network: { enabled: true },
              fileSystem: { read: ["/tmp/example"] },
            },
          },
        },
      }),
    )[0];
    expect(permissionApproval).toMatchObject({
      kind: "approval.requested",
      summary: "Permission approval requested",
      payload: {
        requestKind: "permissions",
        detail: "Needs package metadata",
        permissionProfile: {
          network: { enabled: true },
          fileSystem: { read: ["/tmp/example"] },
        },
      },
    });

    const toolApproval = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "request.opened",
        eventId: "tool-approval-request",
        requestId: ApprovalRequestId.makeUnsafe("tool-request-1"),
        payload: {
          requestType: "tool_approval",
          detail: "Allow Synara to launch the calculator?",
          args: {
            _meta: {
              tool_name: "computer_launch_app",
              tool_title: "Open Calculator",
              tool_params_display: [{ name: "app", value: "kcalc", display_name: "app" }],
            },
          },
        },
      }),
    )[0];
    expect(toolApproval).toMatchObject({
      kind: "approval.requested",
      summary: "Tool approval requested",
      payload: {
        requestKind: "tool",
        requestType: "tool_approval",
        detail: "Allow Synara to launch the calculator?",
        title: "Open Calculator",
        toolName: "computer_launch_app",
        toolParamsDisplay: [{ name: "app", value: "kcalc", display_name: "app" }],
      },
    });

    const userInput = [
      runtimeEvent({
        type: "user-input.requested",
        eventId: "user-input-requested",
        turnId: TURN_ID,
        lifecycleGeneration: "generation-2",
        requestId: ApprovalRequestId.makeUnsafe("request-2"),
        payload: {
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode?",
              options: [{ label: "workspace-write", description: "Workspace writes" }],
            },
          ],
        },
      }),
      runtimeEvent({
        type: "user-input.resolved",
        eventId: "user-input-resolved",
        turnId: TURN_ID,
        lifecycleGeneration: "generation-2",
        requestId: ApprovalRequestId.makeUnsafe("request-2"),
        payload: { answers: { sandbox_mode: "workspace-write" } },
      }),
    ].flatMap((event) => projectProviderRuntimeActivities(event));

    expect(userInput).toMatchObject([
      {
        kind: "user-input.requested",
        payload: {
          requestId: "request-2",
          lifecycleGeneration: "generation-2",
          questions: [{ id: "sandbox_mode" }],
        },
      },
      {
        kind: "user-input.resolved",
        payload: {
          requestId: "request-2",
          lifecycleGeneration: "generation-2",
          answers: { sandbox_mode: "workspace-write" },
        },
      },
    ]);
  });

  it.each(["tool_approval", "dynamic_tool_call"] as const)(
    "renders Claude-shaped %s approvals as tool approvals with parameter rows",
    (requestType) => {
      const [approval] = projectProviderRuntimeActivities(
        runtimeEvent({
          type: "request.opened",
          provider: "claudeAgent",
          eventId: `claude-${requestType}-request`,
          requestId: ApprovalRequestId.makeUnsafe(`claude-${requestType}-1`),
          payload: {
            requestType,
            detail: "mcp__synara__computer_launch_app: {}",
            args: {
              toolName: "mcp__synara__computer_launch_app",
              input: { app: "kcalc", args: ["--hidpi"], headless: false },
              sessionApprovalAvailable: true,
              toolUseId: "toolu_01",
            },
          },
        }),
      );

      expect(approval).toMatchObject({
        kind: "approval.requested",
        summary: "Tool approval requested",
        payload: {
          requestKind: "tool",
          requestType,
          toolName: "mcp__synara__computer_launch_app",
          toolParamsDisplay: [
            { name: "app", value: "kcalc" },
            { name: "args", value: '["--hidpi"]' },
            { name: "headless", value: "false" },
          ],
          sessionApprovalAvailable: true,
        },
      });
      expect(() => decodeActivityAppendCommand(approval!)).not.toThrow();
    },
  );

  it("redacts credential-named tool parameters before they reach the approval card", () => {
    const [claudeApproval] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "request.opened",
        provider: "claudeAgent",
        eventId: "claude-tool-approval-secret",
        requestId: ApprovalRequestId.makeUnsafe("claude-tool-approval-secret"),
        payload: {
          requestType: "tool_approval",
          detail: "mcp__github__create_issue",
          args: {
            toolName: "mcp__github__create_issue",
            input: {
              repo: "synara",
              token: "ghp_live_secret",
              headers: { Authorization: "Bearer live-secret", Accept: "application/json" },
              max_tokens: 5,
            },
          },
        },
      }),
    );
    const [codexApproval] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "request.opened",
        eventId: "codex-tool-approval-secret",
        requestId: ApprovalRequestId.makeUnsafe("codex-tool-approval-secret"),
        payload: {
          requestType: "tool_approval",
          detail: "Allow the deploy tool?",
          args: {
            _meta: {
              tool_name: "deploy",
              tool_params_display: [
                { name: "api_key", value: "sk-live-secret" },
                { name: "target", value: "staging", display_name: "Target" },
                { name: "options", value: { clientSecret: "live-secret", dryRun: true } },
                {
                  name: "headers",
                  value: '{"Authorization":"Bearer live-secret","Accept":"application/json"}',
                },
                { name: "config", value: '{ "dryRun": true }' },
              ],
            },
          },
        },
      }),
    );

    expect(claudeApproval?.payload).toMatchObject({
      toolParamsDisplay: [
        { name: "repo", value: "synara" },
        { name: "token", value: "[redacted]" },
        {
          name: "headers",
          value: '{"Authorization":"[redacted]","Accept":"application/json"}',
        },
        { name: "max_tokens", value: "5" },
      ],
    });
    expect(codexApproval?.payload).toMatchObject({
      toolParamsDisplay: [
        { name: "api_key", value: "[redacted]" },
        { name: "target", value: "staging", display_name: "Target" },
        { name: "options", value: '{"clientSecret":"[redacted]","dryRun":true}' },
        {
          name: "headers",
          value: '{"Authorization":"[redacted]","Accept":"application/json"}',
        },
        { name: "config", value: '{ "dryRun": true }' },
      ],
    });
    expect(JSON.stringify([claudeApproval, codexApproval])).not.toMatch(/live-secret|ghp_live/);
  });

  it("omits tool presentation when a Claude tool approval carries no input", () => {
    const [approval] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "request.opened",
        provider: "claudeAgent",
        eventId: "claude-tool-approval-empty-input",
        requestId: ApprovalRequestId.makeUnsafe("claude-tool-approval-empty"),
        payload: {
          requestType: "tool_approval",
          detail: "Agent: {}",
          args: { toolName: "Agent", input: {}, sessionApprovalAvailable: false },
        },
      }),
    );

    expect(approval?.payload).toMatchObject({ requestKind: "tool", toolName: "Agent" });
    expect(approval?.payload).not.toHaveProperty("toolParamsDisplay");
  });

  it("bounds pathological tool payloads before persistence", () => {
    const data = Object.fromEntries(
      Array.from({ length: 120 }, (_, index) => [
        `field-${index.toString().padStart(3, "0")}`,
        "x".repeat(3_000),
      ]),
    );
    const [activity] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "item.completed",
        eventId: "large-tool-payload",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("large-tool"),
        payload: {
          itemType: "command_execution",
          status: "completed",
          title: "Large command",
          data,
        },
      }),
    );
    const payload = activity?.payload as { data?: Record<string, unknown> };

    expect(JSON.stringify(payload.data).length).toBeLessThanOrEqual(16_000);
    expect(payload.data?.__synaraTruncated).toBe(true);
    expect(payload.data?.originalJsonChars).toBeGreaterThan(300_000);
  });

  it("compacts context and per-model usage into stable activity payloads", () => {
    const [usage] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "thread.token-usage.updated",
        eventId: "context-usage",
        provider: "claudeAgent",
        payload: { usage: { usedTokens: 1_200, maxTokens: 200_000, usedPercent: 0.6 } },
      }),
    );
    expect(usage).toMatchObject({
      kind: "context-window.updated",
      payload: {
        usedTokens: 1_200,
        maxTokens: 200_000,
        usedPercent: 0.6,
        provider: "claudeAgent",
      },
    });

    const [accountingOnlyUsage] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "thread.token-usage.updated",
        eventId: "context-usage-accounting-only",
        provider: "claudeAgent",
        payload: { usage: { usedTokens: 0, totalProcessedTokens: 340_000 } },
      }),
    );
    expect(accountingOnlyUsage).toMatchObject({
      kind: "context-window.updated",
      payload: {
        usedTokens: 0,
        totalProcessedTokens: 340_000,
        provider: "claudeAgent",
      },
    });

    const [configured] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "session.configured",
        eventId: "context-configured",
        provider: "claudeAgent",
        payload: { config: { autoCompactWindow: "1m" } },
      }),
    );
    expect(configured).toMatchObject({
      kind: "context-window.configured",
      payload: { maxTokens: 1_000_000, contextWindow: "1m" },
    });

    const [legacyConfigured] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "session.configured",
        eventId: "legacy-context-configured",
        provider: "claudeAgent",
        payload: { config: { contextWindow: "200k" } },
      }),
    );
    expect(legacyConfigured).toMatchObject({
      kind: "context-window.configured",
      payload: { maxTokens: 200_000, contextWindow: "200k" },
    });

    const [clearedConfigured] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "session.configured",
        eventId: "cleared-context-configured",
        provider: "claudeAgent",
        payload: { config: { autoCompactWindow: null } },
      }),
    );
    expect(clearedConfigured).toMatchObject({
      kind: "context-window.configured",
      payload: { cleared: true },
    });

    const [turn] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "turn.completed",
        eventId: "turn-usage",
        provider: "claudeAgent",
        turnId: TURN_ID,
        payload: {
          state: "completed",
          tokenAccountingVersion: 1,
          mainLoopTokens: 1_000,
          modelUsage: {
            "claude-fable-5": {
              inputTokens: 100,
              outputTokens: 40,
              cacheReadInputTokens: 800,
              cacheCreationInputTokens: 60,
            },
            unused: { inputTokens: 0, outputTokens: 0 },
          },
        },
      }),
    );
    expect(turn).toMatchObject({
      kind: "turn.completed",
      payload: {
        state: "completed",
        provider: "claudeAgent",
        tokenAccountingVersion: 1,
        mainLoopTokens: 1_000,
        modelUsage: {
          "claude-fable-5": {
            inputTokens: 960,
            outputTokens: 40,
            totalTokens: 1_000,
            cacheReadInputTokens: 800,
            cacheCreationInputTokens: 60,
          },
        },
      },
    });
    expect(
      Object.keys((turn?.payload as { modelUsage?: Record<string, unknown> }).modelUsage ?? {}),
    ).toEqual(["claude-fable-5"]);
  });

  it("projects unmapped passthrough events instead of dropping them", () => {
    const oversizedDiagnostic = "x".repeat(64_000);
    const [activity] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "event.unmapped",
        eventId: "unmapped-native-event",
        turnId: TURN_ID,
        payload: {
          nativeType: "item/agentMessage/completed",
          detail: "Finished the refactor",
          data: {
            secretKey: "must-not-reach-the-activity-snapshot",
            note: "api_key=another-secret",
            output: oversizedDiagnostic,
          },
        },
      }),
    );
    expect(activity).toMatchObject({
      tone: "info",
      kind: "provider.event.unmapped",
      // Raw native type/label is the row title.
      summary: "item/agentMessage/completed",
      turnId: TURN_ID,
      payload: {
        nativeEventType: "item/agentMessage/completed",
        detail: "Finished the refactor",
        data: expect.objectContaining({ __synaraTruncated: true }),
      },
    });
    const serializedPayload = JSON.stringify(activity?.payload);
    expect(serializedPayload.length).toBeLessThan(17_000);
    expect(serializedPayload).not.toContain("must-not-reach-the-activity-snapshot");
    expect(serializedPayload).not.toContain("another-secret");
    // The activity must survive the schema of the command that carries it.
    expect(() => decodeActivityAppendCommand(activity!)).not.toThrow();

    // A passthrough event without a native type is the one case still dropped.
    expect(
      projectProviderRuntimeActivities(
        runtimeEvent({
          type: "event.unmapped",
          eventId: "unmapped-without-type",
          payload: { detail: "no type" },
        }),
      ),
    ).toEqual([]);
  });

  it("projects hook lifecycle as one notice row per hook that upserts in place", () => {
    const projectHook = (input: Record<string, unknown> & { eventId: string }) =>
      projectProviderRuntimeActivities(runtimeEvent({ turnId: TURN_ID, ...input }));
    expect(
      projectHook({
        type: "hook.started",
        eventId: "hook-started",
        payload: {
          hookId: "hook-run-1",
          hookName: "/Users/example/.codex/hooks.json",
          hookEvent: "preToolUse",
        },
      }),
    ).toEqual([]);
    expect(
      projectHook({
        type: "hook.progress",
        eventId: "hook-progress-empty",
        payload: { hookId: "hook-run-1", stdout: "  " },
      }),
    ).toEqual([]);
    const [progress] = projectHook({
      type: "hook.progress",
      eventId: "hook-progress",
      payload: { hookId: "hook-run-1", stdout: "Still running." },
    });
    const [succeeded] = projectHook({
      type: "hook.completed",
      eventId: "hook-success",
      payload: {
        hookId: "hook-run-1",
        hookName: "/Users/example/.codex/hooks.json",
        hookEvent: "preToolUse",
        outcome: "success",
        status: "completed",
        stdout: "Checked.",
        durationMs: 8,
      },
    });
    expect(progress).toMatchObject({
      kind: "transcript.notice",
      tone: "info",
      payload: { noticeKind: "hook", status: "running", body: "Still running." },
    });
    expect(succeeded).toMatchObject({
      summary: "Ran preToolUse hook",
      payload: {
        noticeKind: "hook",
        severity: "info",
        status: "completed",
        body: "Event: preToolUse\nHook: /Users/example/.codex/hooks.json\nOutcome: success\n\nOutput:\nChecked.",
      },
    });
    expect(progress!.id).toBe(succeeded!.id);
    expect(succeeded!.id).toBe(`transcript-notice:${THREAD_ID}:hook:turn:${TURN_ID}:hook-run-1`);

    const [cancelled] = projectHook({
      type: "hook.completed",
      eventId: "hook-cancelled",
      payload: { hookId: "hook-run-2", outcome: "cancelled" },
    });
    expect(cancelled?.payload).toMatchObject({ status: "cancelled", severity: "info" });

    const [failed] = projectHook({
      type: "hook.completed",
      eventId: "hook-failed",
      payload: {
        hookId: "hook-run-3",
        hookName: "/Users/example/.codex/hooks.json",
        hookEvent: "postToolUse",
        outcome: "error",
        status: "failed",
        statusMessage: "Hook process exited with code 1.",
        stderr: "boom\n",
        durationMs: 20,
      },
    });
    expect(failed).toMatchObject({
      kind: "transcript.notice",
      summary: "postToolUse hook failed",
      payload: {
        noticeKind: "hook",
        severity: "warning",
        status: "failed",
        detail: "Hook process exited with code 1.",
        body: "Event: postToolUse\nHook: /Users/example/.codex/hooks.json\nOutcome: failed\n\nOutput:\nboom",
        data: { hookId: "hook-run-3", hookEvent: "postToolUse", outcome: "error", durationMs: 20 },
      },
    });
    expect(() => decodeActivityAppendCommand(failed!)).not.toThrow();

    const [blocked] = projectHook({
      type: "hook.completed",
      eventId: "hook-blocked",
      payload: {
        hookId: "hook-run-4",
        hookEvent: "preToolUse",
        outcome: "cancelled",
        status: "blocked",
        statusMessage: "Policy blocked the command.",
      },
    });
    expect(blocked).toMatchObject({
      tone: "info",
      kind: "transcript.notice",
      summary: "preToolUse hook blocked an action",
      payload: { noticeKind: "hook-blocked", status: "blocked", severity: "warning" },
    });
    expect(() => decodeActivityAppendCommand(blocked!)).not.toThrow();
  });
});

function payloadOf(activity: OrchestrationThreadActivity | undefined): Record<string, unknown> {
  return activity?.payload as Record<string, unknown>;
}

function jsonChars(activity: OrchestrationThreadActivity | undefined): number {
  return JSON.stringify(activity?.payload).length;
}

function sampleDiff(name: string): string {
  return `--- a/${name}\n+++ b/${name}\n${"+".repeat(19_970)}`.slice(0, 20_000);
}

describe("quiet hook grouping", () => {
  it("folds successful hooks without output into one counted row per turn", () => {
    const completed = (hookId: string, extra: Record<string, unknown> = {}) =>
      runtimeEvent({
        type: "hook.completed",
        eventId: `quiet-${hookId}`,
        turnId: TURN_ID,
        payload: { hookId, hookEvent: "PreToolUse", outcome: "success", ...extra },
      }) as Extract<ProviderRuntimeEvent, { type: "hook.completed" }>;
    expect(isQuietSuccessfulHook(completed("a"))).toBe(true);
    expect(isQuietSuccessfulHook(completed("b", { stdout: "note" }))).toBe(false);
    expect(isQuietSuccessfulHook(completed("c", { status: "blocked" }))).toBe(false);
    expect(isQuietSuccessfulHook(completed("d", { outcome: "error" }))).toBe(false);
    expect(isQuietSuccessfulHook(completed("e", { exitCode: 0 }))).toBe(true);
    expect(isQuietSuccessfulHook(completed("f", { exitCode: 1 }))).toBe(false);

    const first = quietHookGroupActivity({
      event: completed("a"),
      threadId: THREAD_ID,
      turnId: TURN_ID,
      previous: undefined,
    });
    const second = quietHookGroupActivity({
      event: completed("e"),
      threadId: THREAD_ID,
      turnId: TURN_ID,
      previous: first,
    });
    expect(first).toMatchObject({ summary: "Ran 1 hook", payload: { data: { count: 1 } } });
    expect(second).toMatchObject({
      id: first!.id,
      summary: "Ran 2 hooks",
      payload: {
        data: { grouped: true, count: 2, hookIds: ["a", "e"], hookEvents: ["PreToolUse"] },
      },
    });
    expect(
      quietHookGroupActivity({
        event: completed("e"),
        threadId: THREAD_ID,
        turnId: TURN_ID,
        previous: second,
      }),
    ).toBeUndefined();
    expect(hookNoticeActivityId(THREAD_ID, completed("a"))).toBe(
      `transcript-notice:${THREAD_ID}:hook:turn:${TURN_ID}:a`,
    );
  });
});

describe("typed transcript payloads", () => {
  const ITEM_ID = RuntimeItemId.makeUnsafe("item-typed");

  it("keeps a 20k command output tail intact next to bounded data", () => {
    const output = `${"x".repeat(19_990)}\n  done  `;
    const [activity] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "item.completed",
        eventId: "typed-command",
        turnId: TURN_ID,
        itemId: ITEM_ID,
        payload: {
          itemType: "command_execution",
          status: "completed",
          title: "Ran command",
          toolName: "Bash",
          command: {
            command: "bun run test",
            cwd: "/repo",
            exitCode: null,
            durationMs: 1_200,
            output,
            parsedActions: [{ type: "read", path: "src/index.ts" }],
          },
          data: { item: { aggregatedOutput: "y".repeat(40_000) } },
        },
      }),
    );
    const payload = payloadOf(activity);
    expect(payload.toolName).toBe("Bash");
    expect(payload.command).toMatchObject({
      command: "bun run test",
      cwd: "/repo",
      exitCode: null,
      durationMs: 1_200,
      output,
      parsedActions: [{ type: "read", path: "src/index.ts" }],
    });
    expect(JSON.stringify(payload.data).length).toBeLessThanOrEqual(16_100);
    expect(jsonChars(activity)).toBeLessThanOrEqual(64_000);
    expect(() => decodeActivityAppendCommand(activity!)).not.toThrow();
  });

  it("caps an oversized command output to the last 20k characters", () => {
    const output = `${"head".repeat(5_000)}${"t".repeat(20_000)}`;
    const [activity] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "item.completed",
        eventId: "typed-command-long",
        turnId: TURN_ID,
        itemId: ITEM_ID,
        payload: { itemType: "command_execution", status: "completed", command: { output } },
      }),
    );
    expect(payloadOf(activity).command).toMatchObject({
      output: `[output truncated]\n${"t".repeat(20_000)}`,
      outputTruncated: true,
      outputTotalChars: output.length,
    });
  });

  it("keeps three 20k file diffs intact", () => {
    const changes = ["a.ts", "b.ts", "c.ts"].map((path) => ({
      path,
      kind: "update" as const,
      unifiedDiff: sampleDiff(path),
      additions: 1,
      deletions: 0,
    }));
    const [activity] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "item.completed",
        eventId: "typed-diffs",
        turnId: TURN_ID,
        itemId: ITEM_ID,
        payload: { itemType: "file_change", status: "completed", fileChanges: { changes } },
      }),
    );
    const fileChanges = payloadOf(activity).fileChanges as {
      changes: Array<{ unifiedDiff: string }>;
    };
    expect(fileChanges.changes.map((change) => change.unifiedDiff)).toEqual(
      changes.map((change) => change.unifiedDiff),
    );
    expect(jsonChars(activity)).toBeLessThanOrEqual(64_000);
  });

  it("trims data first, then arguments and structured content, then the output head", () => {
    const [activity] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "item.completed",
        eventId: "typed-overflow",
        turnId: TURN_ID,
        itemId: ITEM_ID,
        payload: {
          itemType: "mcp_tool_call",
          status: "completed",
          command: { output: "o".repeat(20_000) },
          toolCall: {
            toolName: "search",
            server: "docs",
            arguments: { query: "q".repeat(7_000) },
            resultText: "r".repeat(20_000),
            structuredContent: { rows: Array.from({ length: 200 }, (_, index) => `row-${index}`) },
          },
          fileChanges: {
            changes: [
              { path: "a.ts", kind: "update", unifiedDiff: "d".repeat(20_000) },
              { path: "b.ts", kind: "update", unifiedDiff: "e".repeat(10_000) },
            ],
          },
          data: { blob: "z".repeat(15_000) },
        },
      }),
    );
    const payload = payloadOf(activity);
    expect(jsonChars(activity)).toBeLessThanOrEqual(64_000);
    expect(payload.data).toMatchObject({ __synaraTruncated: true });
    const toolCall = payload.toolCall as Record<string, unknown>;
    expect(toolCall.arguments).toBeUndefined();
    expect(toolCall.argumentsTruncated).toBe(true);
    expect(toolCall.resultText).toBe("r".repeat(20_000));
    const command = payload.command as Record<string, unknown>;
    expect(
      typeof command.output === "string" && command.output.startsWith("[output truncated]\n"),
    ).toBe(true);
    expect(command.outputTruncated).toBe(true);
    const fileChanges = payload.fileChanges as { changes: Array<{ unifiedDiff: string }> };
    expect(fileChanges.changes[0]!.unifiedDiff).toBe("d".repeat(20_000));
    expect(() => decodeActivityAppendCommand(activity!)).not.toThrow();
  });

  it("keeps the tool type of a progress update instead of forcing an MCP row", () => {
    const progress = (provider: string, itemType?: string) =>
      projectProviderRuntimeActivities(
        runtimeEvent({
          provider,
          type: "tool.progress",
          eventId: `progress-${provider}-${itemType ?? "none"}`,
          turnId: TURN_ID,
          payload: {
            toolUseId: "toolu_1",
            toolName: "Bash",
            elapsedSeconds: 3,
            ...(itemType ? { itemType } : {}),
          },
        }),
      )[0];
    expect(payloadOf(progress("claudeAgent", "command_execution")).itemType).toBe(
      "command_execution",
    );
    expect(payloadOf(progress("claudeAgent", "collab_agent_tool_call")).itemType).toBe(
      "collab_agent_tool_call",
    );
    const fromStartedRow = projectProviderRuntimeActivities(
      runtimeEvent({
        provider: "claudeAgent",
        type: "tool.progress",
        eventId: "progress-started-row",
        turnId: TURN_ID,
        payload: { toolUseId: "toolu_1", toolName: "Bash" },
      }),
      undefined,
      { startedItemType: "command_execution" },
    )[0];
    expect(payloadOf(fromStartedRow).itemType).toBe("command_execution");
    expect(payloadOf(progress("claudeAgent")).itemType).toBeUndefined();
    expect(payloadOf(progress("codex")).itemType).toBe("mcp_tool_call");
  });

  it("projects Codex reasoning previews with a heading and no 2k cut", () => {
    const summary = `**Inspecting the store**\n\n${"a".repeat(5_000)}`;
    const [preview] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "item.updated",
        eventId: "codex-reasoning-preview",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("reasoning-1"),
        payload: { itemType: "reasoning", status: "inProgress", detail: summary },
      }),
    );
    expect(preview).toMatchObject({
      id: `provider-reasoning:${THREAD_ID}:reasoning-1`,
      kind: "task.progress",
      payload: { detail: summary, reasoning: { heading: "Inspecting the store", summary } },
    });
    const [redacted] = projectProviderRuntimeActivities(
      runtimeEvent({
        provider: "claudeAgent",
        type: "item.completed",
        eventId: "claude-redacted",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("reasoning-2"),
        payload: { itemType: "reasoning", status: "completed", reasoning: { redacted: true } },
      }),
    );
    expect(redacted?.payload).toMatchObject({ reasoning: { redacted: true } });
    expect(() => decodeActivityAppendCommand(redacted!)).not.toThrow();
  });
});

describe("transcript notices", () => {
  it("derives one stable id per dedupe key and per thread", () => {
    const notice = (eventId: string, threadId?: ThreadId) =>
      projectProviderRuntimeActivities(
        runtimeEvent({
          type: "transcript.notice",
          eventId,
          turnId: TURN_ID,
          payload: {
            noticeKind: "skills-changed",
            severity: "info",
            title: "Skills updated",
            dedupeKey: "skills:generation-1",
            data: { count: 3 },
          },
        }),
        undefined,
        threadId ? { threadId } : undefined,
      )[0];
    const first = notice("skills-1");
    const repeat = notice("skills-2");
    const child = notice("skills-3", ThreadId.makeUnsafe("subagent:thread:child"));
    expect(first).toMatchObject({
      kind: "transcript.notice",
      tone: "info",
      summary: "Skills updated",
      payload: { noticeKind: "skills-changed", severity: "info", dedupeKey: "skills:generation-1" },
    });
    expect(repeat!.id).toBe(first!.id);
    expect(child!.id).not.toBe(first!.id);
    expect(
      providerActivityUpdateDedupeKey(
        runtimeEvent({ type: "transcript.notice", eventId: "x", payload: {} }),
        THREAD_ID,
        first!,
      ),
    ).toBe(`${THREAD_ID}:codex:transcript.notice:${first!.id}`);
    expect(providerActivityUpdateFingerprint(first!)).toBe(
      providerActivityUpdateFingerprint(repeat!),
    );
  });

  it("projects every notice kind to a schema-valid activity", () => {
    for (const noticeKind of TranscriptNoticeKind.literals) {
      const activities = projectProviderRuntimeActivities(
        runtimeEvent({
          type: "transcript.notice",
          eventId: `notice-${noticeKind}`,
          turnId: TURN_ID,
          itemId: RuntimeItemId.makeUnsafe("target-command-item"),
          payload: { noticeKind, severity: "warning", title: `Notice ${noticeKind}` },
        }),
      );
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({
        id: `notice-${noticeKind}`,
        kind: "transcript.notice",
        payload: { noticeKind },
      });
      expect(() => decodeActivityAppendCommand(activities[0]!)).not.toThrow();
    }
  });

  it("hashes long dedupe keys and caps notice bodies", () => {
    const [activity] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "transcript.notice",
        eventId: "long-notice",
        turnId: TURN_ID,
        payload: {
          noticeKind: "provider-warning",
          severity: "warning",
          title: "Provider warning",
          body: "b".repeat(9_000),
          dedupeKey: `warning:${"m".repeat(500)}`,
        },
      }),
    );
    expect(activity!.id.length).toBeLessThan(200);
    expect(activity!.payload).toMatchObject({ bodyTruncated: true });
    expect((activity!.payload as { body: string }).body.length).toBe(8_000);
    expect(() => decodeActivityAppendCommand(activity!)).not.toThrow();
  });

  it("projects config, deprecation, MCP sign-in and saved-file events as notices", () => {
    const project = (input: Record<string, unknown> & { eventId: string }) =>
      projectProviderRuntimeActivities(runtimeEvent({ lifecycleGeneration: "gen-1", ...input }))[0];
    const config = project({
      type: "config.warning",
      eventId: "config",
      payload: { summary: "Unknown key", details: "model_x", path: "~/.codex/config.toml" },
    });
    expect(config).toMatchObject({
      kind: "transcript.notice",
      summary: "Unknown key",
      payload: {
        noticeKind: "config-warning",
        severity: "warning",
        detail: "~/.codex/config.toml",
        body: "model_x",
        dedupeKey: "config-warning:gen-1:Unknown key",
      },
    });
    expect(
      project({
        type: "deprecation.notice",
        eventId: "deprecation",
        payload: { summary: "Old flag" },
      }),
    ).toMatchObject({
      payload: { noticeKind: "deprecation", dedupeKey: "deprecation:gen-1:Old flag" },
    });
    expect(
      project({
        type: "mcp.oauth.completed",
        eventId: "oauth",
        payload: { success: false, name: "github", error: "denied" },
      }),
    ).toMatchObject({
      summary: "Sign-in to github failed",
      payload: { noticeKind: "mcp-oauth", severity: "warning", detail: "denied" },
    });
    expect(
      project({
        type: "files.persisted",
        eventId: "files",
        payload: {
          files: [{ filename: "a.txt", fileId: "f1" }],
          failed: [{ filename: "b.txt", error: "too large" }],
        },
      }),
    ).toMatchObject({
      summary: "Saved 1 file, 1 failed",
      payload: { noticeKind: "files-persisted", severity: "warning", body: "b.txt: too large" },
    });
  });
});

describe("turn and retry hints", () => {
  it("writes the final answer and origin hints on the turn activity", () => {
    const [activity] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "turn.completed",
        eventId: "turn-done",
        turnId: TURN_ID,
        payload: { state: "completed", finalAssistantItemId: "msg-final" },
      }),
      undefined,
      {
        finalAssistantMessageId: "assistant:msg-final" as never,
        turnOrigin: "provider",
      },
    );
    expect(activity?.payload).toMatchObject({
      state: "completed",
      finalAssistantMessageId: "assistant:msg-final",
      origin: "provider",
    });
  });

  it("upserts one retry row per turn with the attempt counter", () => {
    const retry = (eventId: string, attempt: number) =>
      projectProviderRuntimeActivities(
        runtimeEvent({
          type: "runtime.warning",
          eventId,
          turnId: TURN_ID,
          payload: {
            message: `Reconnecting... ${attempt}/5`,
            willRetry: true,
            retryAttempt: attempt,
            retryMaxAttempts: 5,
          },
        }),
      )[0];
    const first = retry("retry-1", 1);
    const second = retry("retry-2", 2);
    expect(first!.id).toBe(`provider-retry:${THREAD_ID}:${TURN_ID}`);
    expect(second!.id).toBe(first!.id);
    expect(second).toMatchObject({
      summary: "Reconnecting 2/5",
      payload: { retryAttempt: 2, retryMaxAttempts: 5, willRetry: true },
    });
  });

  it("carries refusal fields and retracted message ids on reroutes", () => {
    const [activity] = projectProviderRuntimeActivities(
      runtimeEvent({
        provider: "claudeAgent",
        type: "model.rerouted",
        eventId: "reroute",
        turnId: TURN_ID,
        payload: {
          fromModel: "claude-opus",
          toModel: "claude-sonnet",
          reason: "refusal",
          refusalCategory: "cyber",
          refusalExplanation: "Declined",
          retractedItemIds: ["msg-1"],
        },
      }),
    );
    expect(activity?.payload).toMatchObject({
      refusalCategory: "cyber",
      refusalExplanation: "Declined",
      retractedMessageIds: ["assistant:msg-1"],
    });
  });

  it("labels a subagent steer and stops calling Claude task progress a reasoning update", () => {
    const [steer] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "turn.steered",
        eventId: "steer",
        turnId: TURN_ID,
        payload: { message: "Also check tests", target: "subagent" },
      }),
    );
    expect(steer?.summary).toBe("Message delivered to subagent");
    const [progress] = projectProviderRuntimeActivities(
      runtimeEvent({
        provider: "claudeAgent",
        type: "task.progress",
        eventId: "task-progress",
        turnId: TURN_ID,
        payload: { taskId: "task-1", description: "Reading files" },
      }),
    );
    expect(progress).toMatchObject({ kind: "task.progress", summary: "Task progress" });
    expect(progress?.payload).toMatchObject({ taskId: "task-1" });
  });
});

describe("approval prompt fields", () => {
  it("copies Claude prompt fields and keeps the SDK title out of the tool title", () => {
    const event = runtimeEvent({
      type: "request.opened",
      provider: "claudeAgent",
      eventId: "claude-approval-prompt",
      requestId: ApprovalRequestId.makeUnsafe("claude-approval-prompt"),
      payload: {
        requestType: "command_execution_approval",
        detail: "bun run test",
        args: {
          toolName: "Bash",
          input: { command: "bun run test" },
          toolUseId: "toolu_approval",
          title: "  Claude wants to run bun run test  ",
          description: "Run the tests",
          displayName: "Bash",
          blockedPath: "/etc/hosts",
          decisionReason: "Command is not in the allow list",
        },
      },
    });
    expectSchemaValidActivities(event);
    const [approval] = projectProviderRuntimeActivities(event);
    expect(approval?.payload).toMatchObject({
      promptTitle: "Claude wants to run bun run test",
      description: "Run the tests",
      displayName: "Bash",
      blockedPath: "/etc/hosts",
      decisionReason: "Command is not in the allow list",
      itemId: "toolu_approval",
    });
    expect(approval?.payload).not.toHaveProperty("title");
  });

  it("copies Codex command approval context and normalizes command actions", () => {
    const event = runtimeEvent({
      type: "request.opened",
      eventId: "codex-command-approval",
      requestId: ApprovalRequestId.makeUnsafe("codex-command-approval"),
      payload: {
        requestType: "command_execution_approval",
        detail: "ls src && cat src/a.ts",
        args: {
          itemId: "call_cmd",
          command: "ls src && cat src/a.ts",
          cwd: "/repo",
          reason: "Needs to read outside the sandbox",
          title: "not a prompt title",
          commandActions: [
            { type: "listFiles", command: "ls src", path: "src" },
            { type: "read", command: "cat src/a.ts", name: "a.ts", path: "src/a.ts" },
            { type: "somethingNew", command: "weird" },
            "not an action",
          ],
        },
      },
    });
    expectSchemaValidActivities(event);
    const [approval] = projectProviderRuntimeActivities(event);
    expect(approval?.payload).toMatchObject({
      requestKind: "command",
      itemId: "call_cmd",
      cwd: "/repo",
      reason: "Needs to read outside the sandbox",
      parsedActions: [
        { type: "list_files", command: "ls src", path: "src" },
        { type: "read", command: "cat src/a.ts", name: "a.ts", path: "src/a.ts" },
        { type: "unknown", command: "weird" },
      ],
    });
    expect(approval?.payload).not.toHaveProperty("promptTitle");
  });

  it("keeps valid approval file changes bounded and drops a foreign shape", () => {
    const diff = "x".repeat(20_000);
    const valid = runtimeEvent({
      type: "request.opened",
      eventId: "codex-file-approval",
      requestId: ApprovalRequestId.makeUnsafe("codex-file-approval"),
      payload: {
        requestType: "file_change_approval",
        args: {
          itemId: "call_patch",
          fileChanges: {
            changes: Array.from({ length: 6 }, (_, index) => ({
              path: `src/file-${index}.ts`,
              kind: "update",
              unifiedDiff: diff,
            })),
          },
        },
      },
    });
    expectSchemaValidActivities(valid);
    const [approval] = projectProviderRuntimeActivities(valid);
    const payload = approval?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ requestKind: "file-change", itemId: "call_patch" });
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(64_000);
    expect((payload.fileChanges as { changes: unknown[] }).changes).toHaveLength(6);

    const [legacy] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "request.opened",
        eventId: "codex-legacy-file-approval",
        requestId: ApprovalRequestId.makeUnsafe("codex-legacy-file-approval"),
        payload: {
          requestType: "apply_patch_approval",
          args: { fileChanges: { "src/a.ts": { type: "update", unified_diff: "@@" } } },
        },
      }),
    );
    expect(legacy?.payload).not.toHaveProperty("fileChanges");
  });
});

describe("task progress", () => {
  it("projects the tool use id and does not repeat the Claude description as detail", () => {
    const event = runtimeEvent({
      provider: "claudeAgent",
      type: "task.progress",
      eventId: "task-progress-tool-use",
      turnId: TURN_ID,
      payload: { taskId: "task-1", description: "Review the parser", toolUseId: "toolu_task" },
    });
    expectSchemaValidActivities(event);
    const [progress] = projectProviderRuntimeActivities(event);
    expect(progress?.payload).toMatchObject({
      taskId: "task-1",
      description: "Review the parser",
      data: { toolUseId: "toolu_task" },
    });
    expect(progress?.payload).not.toHaveProperty("detail");

    const [withSummary] = projectProviderRuntimeActivities(
      runtimeEvent({
        provider: "claudeAgent",
        type: "task.progress",
        eventId: "task-progress-summary",
        turnId: TURN_ID,
        payload: { taskId: "task-1", description: "Review the parser", summary: "Using Read" },
      }),
    );
    expect(withSummary?.payload).toMatchObject({ detail: "Using Read", summary: "Using Read" });
    expect(withSummary?.payload).not.toHaveProperty("data");
  });

  it("keeps the Codex reasoning update text as detail", () => {
    const [progress] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "task.progress",
        eventId: "codex-task-progress",
        turnId: TURN_ID,
        payload: { taskId: "task-codex", description: "Thinking about the parser" },
      }),
    );
    expect(progress?.payload).toMatchObject({ detail: "Thinking about the parser" });
  });
});

describe("session status reasons", () => {
  it("shows human reasons and hides machine reasons", () => {
    const statusEvent = (reason: string) =>
      runtimeEvent({
        type: "session.state.changed",
        provider: "claudeAgent",
        eventId: `status-${reason}`,
        turnId: TURN_ID,
        payload: { state: "running", reason },
      }) as Extract<ProviderRuntimeEvent, { type: "session.state.changed" }>;
    const human = sessionStatusActivity({
      event: statusEvent("Running safety checks"),
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    expect(human).toMatchObject({
      summary: "Running safety checks",
      payload: { reason: "Running safety checks" },
    });
    for (const machineReason of ["task:running", "status:active", "status:compacting"]) {
      expect(userFacingStatusReason(machineReason)).toBeUndefined();
      const machine = sessionStatusActivity({
        event: statusEvent(machineReason),
        threadId: THREAD_ID,
        turnId: TURN_ID,
      });
      expect(machine).toMatchObject({ summary: "Working", payload: { reason: null } });
    }
    expect(userFacingStatusReason("Error: socket closed")).toBe("Error: socket closed");
    expect(userFacingStatusReason("  ")).toBeUndefined();
  });
});

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

describe("hook row keys", () => {
  const hookCompleted = (input: {
    eventId: string;
    hookId: string;
    turnId?: TurnId;
    lifecycleGeneration?: string;
    stdout?: string;
  }) =>
    runtimeEvent({
      type: "hook.completed",
      eventId: input.eventId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.lifecycleGeneration ? { lifecycleGeneration: input.lifecycleGeneration } : {}),
      payload: {
        hookId: input.hookId,
        hookEvent: "PreToolUse",
        outcome: "success",
        stdout: input.stdout ?? "visible",
      },
    }) as Extract<ProviderRuntimeEvent, { type: "hook.completed" }>;

  it("gives the same hook id in two turns two rows and updates one row within a turn", () => {
    const otherTurn = TurnId.makeUnsafe("turn-activity-projection-2");
    const [firstTurn] = projectProviderRuntimeActivities(
      hookCompleted({ eventId: "hook-t1", hookId: "repeat", turnId: TURN_ID }),
    );
    const [firstTurnAgain] = projectProviderRuntimeActivities(
      hookCompleted({ eventId: "hook-t1-again", hookId: "repeat", turnId: TURN_ID }),
    );
    const [secondTurn] = projectProviderRuntimeActivities(
      hookCompleted({ eventId: "hook-t2", hookId: "repeat", turnId: otherTurn }),
    );
    expect(firstTurn!.id).toBe(firstTurnAgain!.id);
    expect(secondTurn!.id).not.toBe(firstTurn!.id);
    expect(firstTurn!.id).toBe(
      hookNoticeActivityId(
        THREAD_ID,
        hookCompleted({ eventId: "x", hookId: "repeat", turnId: TURN_ID }),
      ),
    );
  });

  it("scopes turnless hook rows and the session group to the lifecycle generation", () => {
    expect(hookActivityDedupeKey({ hookId: "h", lifecycleGeneration: "gen-1" })).toBe(
      "hook:session:gen-1:h",
    );
    expect(hookActivityDedupeKey({ lifecycleGeneration: "gen-1" })).toBe("hooks:session:gen-1");
    expect(hookActivityDedupeKey({ turnId: "t-1" })).toBe("hooks:turn:t-1");
    const [first] = projectProviderRuntimeActivities(
      hookCompleted({ eventId: "s1", hookId: "start", lifecycleGeneration: "gen-1" }),
    );
    const [second] = projectProviderRuntimeActivities(
      hookCompleted({ eventId: "s2", hookId: "start", lifecycleGeneration: "gen-2" }),
    );
    expect(first!.id).not.toBe(second!.id);
    const groupOne = quietHookGroupActivity({
      event: hookCompleted({
        eventId: "g1",
        hookId: "q",
        lifecycleGeneration: "gen-1",
        stdout: "",
      }),
      threadId: THREAD_ID,
      turnId: undefined,
      previous: undefined,
    });
    const groupTwo = quietHookGroupActivity({
      event: hookCompleted({
        eventId: "g2",
        hookId: "q",
        lifecycleGeneration: "gen-2",
        stdout: "",
      }),
      threadId: THREAD_ID,
      turnId: undefined,
      previous: undefined,
    });
    expect(groupOne!.id).not.toBe(groupTwo!.id);
  });
});

describe("readable hook rows", () => {
  const claudeHook = (payload: Record<string, unknown>) =>
    runtimeEvent({
      provider: "claudeAgent",
      type: "hook.completed",
      eventId: `claude-hook-${String(payload.hookId)}`,
      turnId: TURN_ID,
      payload: {
        hookName: "PreToolUse:Bash",
        hookEvent: "PreToolUse",
        matcher: "Bash",
        outcome: "success",
        exitCode: 0,
        ...payload,
      },
    }) as Extract<ProviderRuntimeEvent, { type: "hook.completed" }>;

  it("titles the row with the hook event and renders JSON output as readable lines", () => {
    const output = JSON.stringify({
      systemMessage: "Formatted 2 files",
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "use rg" },
    });
    const event = claudeHook({ hookId: "fmt", output, stdout: output });
    expect(isQuietSuccessfulHook(event)).toBe(false);
    const [row] = projectProviderRuntimeActivities(event);
    expect(row).toMatchObject({
      summary: "Ran PreToolUse hook",
      payload: {
        noticeKind: "hook",
        detail: "Bash",
        body: "Event: PreToolUse\nMatcher: Bash\nOutcome: success (exit code 0)\n\nOutput:\nMessage: Formatted 2 files\nAdded context: use rg",
        data: { hookName: "PreToolUse:Bash", hookEvent: "PreToolUse", matcher: "Bash" },
      },
    });
    expect(String(payloadOf(row).body)).not.toContain("{");
  });

  it("folds hooks whose JSON only talks to the model into the group count", () => {
    const contextOnly = JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "tip" },
    });
    expect(isQuietSuccessfulHook(claudeHook({ hookId: "ctx", stdout: contextOnly }))).toBe(true);
    expect(isQuietSuccessfulHook(claudeHook({ hookId: "cont", stdout: '{"continue":true}' }))).toBe(
      true,
    );
    const denied = JSON.stringify({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "no rm" },
    });
    expect(isQuietSuccessfulHook(claudeHook({ hookId: "deny", stdout: denied }))).toBe(false);
    expect(isQuietSuccessfulHook(claudeHook({ hookId: "text", stdout: "plain note" }))).toBe(false);
  });

  it("names a hook.progress row from its hook event", () => {
    const [row] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "hook.progress",
        eventId: "hook-progress-named",
        turnId: TURN_ID,
        payload: {
          hookId: "p",
          hookName: "PreToolUse:Bash",
          hookEvent: "PreToolUse",
          matcher: "Bash",
          stdout: "linting",
        },
      }),
    );
    expect(row).toMatchObject({
      summary: "Running PreToolUse hook",
      payload: { detail: "Bash", body: "linting" },
    });
  });
});

describe("bounded text edges", () => {
  const ITEM_ID = RuntimeItemId.makeUnsafe("item-bounds");

  it("keeps a tool error up to the tool result cap", () => {
    const error = "e".repeat(5_000);
    const [activity] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "item.completed",
        eventId: "tool-error-cap",
        turnId: TURN_ID,
        itemId: ITEM_ID,
        payload: {
          itemType: "mcp_tool_call",
          status: "failed",
          toolCall: { toolName: "lookup", error },
        },
      }),
    );
    expect((payloadOf(activity).toolCall as { error?: string }).error).toBe(error);
  });

  it("does not split an emoji at the tool error cut", () => {
    const error = `${"e".repeat(19_999)}\u{1F600}tail`;
    const [activity] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "item.completed",
        eventId: "tool-error-emoji",
        turnId: TURN_ID,
        itemId: ITEM_ID,
        payload: {
          itemType: "mcp_tool_call",
          status: "failed",
          toolCall: { toolName: "lookup", error },
        },
      }),
    );
    const capped = (payloadOf(activity).toolCall as { error: string }).error;
    expect(capped).toBe("e".repeat(19_999));
    expect(LONE_SURROGATE.test(capped)).toBe(false);
  });

  it("does not split an emoji at the command output tail cut", () => {
    const output = `\u{1F600}${"x".repeat(TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS - 1)}`;
    const [activity] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "item.completed",
        eventId: "command-tail-emoji",
        turnId: TURN_ID,
        itemId: ITEM_ID,
        payload: {
          itemType: "command_execution",
          status: "completed",
          command: { command: "cat emoji.txt", output },
        },
      }),
    );
    const command = payloadOf(activity).command as { output: string; outputTruncated?: boolean };
    expect(command.outputTruncated).toBe(true);
    expect(LONE_SURROGATE.test(command.output)).toBe(false);
    expect(command.output.endsWith("x".repeat(TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS - 1))).toBe(true);
  });

  it("keeps a 20k tool error inside the payload budget next to a 20k result and output", () => {
    const [activity] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "item.completed",
        eventId: "tool-error-budget",
        turnId: TURN_ID,
        itemId: ITEM_ID,
        payload: {
          itemType: "mcp_tool_call",
          status: "failed",
          command: { output: "o".repeat(20_000) },
          toolCall: {
            toolName: "lookup",
            arguments: { query: "q".repeat(20_000) },
            resultText: "r".repeat(20_000),
            error: "e".repeat(20_000),
          },
        },
      }),
    );
    expect(jsonChars(activity)).toBeLessThanOrEqual(64_000);
    expect(() => decodeActivityAppendCommand(activity!)).not.toThrow();
    expect((payloadOf(activity).toolCall as { error?: string }).error?.startsWith("eee")).toBe(
      true,
    );
  });

  it("does not split an emoji when the payload budget shrinks output and result", () => {
    for (const prefix of ["", "a"]) {
      const emojis = (count: number) => `${prefix}${"\u{1F600}".repeat(count)}`;
      const [activity] = projectProviderRuntimeActivities(
        runtimeEvent({
          type: "item.completed",
          eventId: `emoji-budget-${prefix.length}`,
          turnId: TURN_ID,
          itemId: ITEM_ID,
          payload: {
            itemType: "mcp_tool_call",
            status: "completed",
            command: { output: emojis(9_999), stdout: emojis(9_999), stderr: emojis(9_999) },
            toolCall: { toolName: "lookup", resultText: emojis(9_999), error: emojis(9_999) },
          },
        }),
      );
      const command = payloadOf(activity).command as Record<string, string>;
      const toolCall = payloadOf(activity).toolCall as Record<string, string>;
      expect(command.outputTruncated).toBe(true);
      for (const text of [
        command.output,
        command.stdout,
        command.stderr,
        toolCall.resultText,
        toolCall.error,
      ]) {
        expect(LONE_SURROGATE.test(text ?? "")).toBe(false);
      }
      expect(jsonChars(activity)).toBeLessThanOrEqual(64_000);
    }
  });

  it("lets the provider reasoning heading win over the derived heading", () => {
    const [activity] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "item.updated",
        eventId: "reasoning-provider-heading",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("reasoning-heading"),
        payload: {
          itemType: "reasoning",
          status: "inProgress",
          detail: "**Derived heading**\n\nbody",
          reasoning: { heading: "Provider heading" },
        },
      }),
    );
    expect(payloadOf(activity).reasoning).toMatchObject({ heading: "Provider heading" });
  });
});
