import {
  EventId,
  type ProviderEvent,
  ProviderRuntimeEvent,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  CODEX_ITEM_LIFECYCLE_METHODS,
  CODEX_ITEM_TYPE_DISPOSITIONS,
  CODEX_NOTIFICATION_DISPOSITIONS,
  CODEX_REQUEST_DISPOSITIONS,
  codexItemTypeDisposition,
  codexNotificationDisposition,
  codexRequestDisposition,
  resolveCodexItemType,
} from "./codexMethodDispositions.ts";
import {
  type CodexRuntimeEventMapper,
  makeCodexRuntimeEventMapper,
} from "./Layers/CodexAdapter.ts";

const PROTOCOL_NOTIFICATION_METHODS = [
  "account/gatewayOAuth/changed",
  "account/login/completed",
  "account/rateLimits/updated",
  "account/updated",
  "app/list/updated",
  "autoApprovalReview/strictReviewRequired",
  "command/exec/outputDelta",
  "configWarning",
  "deprecationNotice",
  "error",
  "externalAgentConfig/import/completed",
  "externalAgentConfig/import/progress",
  "fs/changed",
  "fuzzyFileSearch/sessionCompleted",
  "fuzzyFileSearch/sessionUpdated",
  "guardianWarning",
  "hook/completed",
  "hook/started",
  "item/agentMessage/delta",
  "item/autoApprovalReview/completed",
  "item/autoApprovalReview/started",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/plan/delta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "mcpServer/event/stream/notification",
  "mcpServer/oauthLogin/completed",
  "mcpServer/startupStatus/updated",
  "model/rerouted",
  "model/safetyBuffering/updated",
  "model/verification",
  "modelProvider/authRecoveryCompleted",
  "modelProvider/authRecoveryStarted",
  "process/exited",
  "process/outputDelta",
  "project/changed",
  "rawResponse/completed",
  "rawResponseItem/completed",
  "remoteControl/status/changed",
  "serverRequest/resolved",
  "skills/changed",
  "thread/archived",
  "thread/attachment/updated",
  "thread/closed",
  "thread/compacted",
  "thread/deleted",
  "thread/environment/connected",
  "thread/environment/disconnected",
  "thread/goal/cleared",
  "thread/goal/updated",
  "thread/name/updated",
  "thread/prediction/updated",
  "thread/project/updated",
  "thread/queue/changed",
  "thread/realtime/closed",
  "thread/realtime/error",
  "thread/realtime/item/completed",
  "thread/realtime/item/started",
  "thread/realtime/item/transcript/delta",
  "thread/realtime/itemAdded",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/sdp",
  "thread/realtime/started",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "thread/reverted",
  "thread/settings/updated",
  "thread/started",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "thread/unarchived",
  "turn/completed",
  "turn/diff/updated",
  "turn/moderationMetadata",
  "turn/plan/updated",
  "turn/started",
  "warning",
  "windows/worldWritableWarning",
  "windowsSandbox/setupCompleted",
];

const PROTOCOL_REQUEST_METHODS = [
  "account/chatgptAuthTokens/refresh",
  "applyPatchApproval",
  "attestation/generate",
  "execCommandApproval",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/call",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
];

const PROTOCOL_ITEM_TYPES = [
  "agentMessage",
  "collabAgentToolCall",
  "commandExecution",
  "contextCompaction",
  "dynamicToolCall",
  "enteredReviewMode",
  "exitedReviewMode",
  "fileChange",
  "functionCallOutput",
  "hookPrompt",
  "imageGeneration",
  "imageView",
  "mcpToolCall",
  "plan",
  "reasoning",
  "sleep",
  "subAgentActivity",
  "userMessage",
  "webSearch",
];

const threadId = ThreadId.makeUnsafe("thread-dispositions");
const turnId = TurnId.makeUnsafe("turn-dispositions");
const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

let sequence = 0;
function nativeEvent(
  method: string,
  kind: ProviderEvent["kind"],
  payload: Record<string, unknown>,
  itemId?: string,
): ProviderEvent {
  sequence += 1;
  return {
    id: EventId.makeUnsafe(`evt-${sequence}`),
    kind,
    provider: "codex",
    threadId,
    createdAt: "2026-10-10T00:00:00.000Z",
    method,
    turnId,
    lifecycleGeneration: "generation-1",
    ...(itemId ? { itemId: ProviderItemId.makeUnsafe(itemId) } : {}),
    payload: { threadId: "provider-thread", turnId, ...payload },
  };
}

function mapAndDecode(mapper: CodexRuntimeEventMapper, event: ProviderEvent) {
  const events = mapper(event, threadId);
  for (const runtimeEvent of events) {
    expect(() => decodeRuntimeEvent(runtimeEvent)).not.toThrow();
  }
  return events;
}

function primedMapper(): CodexRuntimeEventMapper {
  const mapper = makeCodexRuntimeEventMapper();
  mapper(
    nativeEvent("turn/started", "notification", { turn: { id: turnId }, synaraTurnOrigin: "user" }),
    threadId,
  );
  return mapper;
}

const reviewAction = { type: "command", source: "shell", command: "ls", cwd: "/repo" };

const NOTIFICATION_FIXTURES: Record<string, Record<string, unknown>> = {
  error: { error: { message: "boom", codexErrorInfo: null }, willRetry: false },
  "thread/started": { thread: { id: "provider-thread" } },
  "thread/status/changed": { status: { type: "idle" } },
  "thread/archived": {},
  "thread/unarchived": {},
  "thread/closed": {},
  "thread/reverted": {},
  "skills/changed": {},
  "thread/name/updated": { threadName: "Renamed" },
  "thread/environment/connected": { environmentId: "env-1" },
  "thread/environment/disconnected": { environmentId: "env-1" },
  "thread/tokenUsage/updated": {
    tokenUsage: {
      total: { totalTokens: 20, inputTokens: 15, outputTokens: 5 },
      last: { totalTokens: 10, inputTokens: 8, outputTokens: 2 },
      modelContextWindow: 1000,
    },
  },
  "turn/started": { turn: { id: turnId }, synaraTurnOrigin: "user" },
  "hook/started": { run: { id: "hook-1", eventName: "PreToolUse", status: "running" } },
  "turn/completed": { turn: { id: turnId, status: "completed" } },
  "hook/completed": {
    run: { id: "hook-1", eventName: "PreToolUse", status: "completed", durationMs: 4 },
  },
  "turn/diff/updated": { diff: "@@ -1 +1 @@\n-a\n+b" },
  "turn/plan/updated": { plan: [{ step: "Read", status: "pending" }] },
  "item/autoApprovalReview/started": {
    reviewId: "review-1",
    targetItemId: "cmd-1",
    startedAtMs: 1,
    review: { status: "inProgress", rationale: null },
    action: reviewAction,
  },
  "item/autoApprovalReview/completed": {
    reviewId: "review-1",
    targetItemId: "cmd-1",
    startedAtMs: 1,
    completedAtMs: 2,
    decisionSource: "agent",
    review: { status: "approved", rationale: "Read only" },
    action: reviewAction,
  },
  "autoApprovalReview/strictReviewRequired": { startedAtMs: 1 },
  "item/agentMessage/delta": { itemId: "msg-1", delta: "Hello" },
  "item/plan/delta": { itemId: "plan-1", delta: "Step" },
  "item/commandExecution/outputDelta": { itemId: "cmd-1", delta: "out" },
  "item/commandExecution/terminalInteraction": {
    itemId: "cmd-1",
    processId: "p-1",
    stdin: "y\n",
  },
  "item/fileChange/outputDelta": { itemId: "patch-1", delta: "applied" },
  "item/fileChange/patchUpdated": {
    itemId: "patch-1",
    changes: [{ path: "a.ts", kind: { type: "add" }, diff: "x\n" }],
  },
  "serverRequest/resolved": { requestId: "request-1" },
  "item/mcpToolCall/progress": { itemId: "mcp-1", message: "Fetching" },
  "mcpServer/oauthLogin/completed": { name: "github", success: true, error: null },
  "mcpServer/startupStatus/updated": {
    threadId: null,
    name: "github",
    status: "ready",
    error: null,
    failureReason: null,
  },
  "account/updated": { authMode: "chatgpt", planType: "pro" },
  "account/rateLimits/updated": { rateLimits: { primary: null, secondary: null } },
  "item/reasoning/summaryTextDelta": { itemId: "reasoning-1", delta: "Think", summaryIndex: 0 },
  "item/reasoning/textDelta": { itemId: "reasoning-1", delta: "Raw", contentIndex: 0 },
  "thread/compacted": {},
  "model/rerouted": { fromModel: "a", toModel: "b", reason: "highRiskCyberActivity" },
  "model/verification": { verifications: ["trustedAccessForCyber"] },
  "modelProvider/authRecoveryStarted": { provider: "openai", message: "Refreshing" },
  "modelProvider/authRecoveryCompleted": { provider: "openai", message: "Done" },
  "turn/moderationMetadata": { metadata: { flagged: true } },
  "model/safetyBuffering/updated": {
    model: "gpt",
    useCases: [],
    reasons: [],
    showBufferingUi: true,
    fasterModel: null,
  },
  warning: { message: "Heads up" },
  guardianWarning: { message: "Guardian heads up" },
  deprecationNotice: { summary: "Old flag", details: null },
  configWarning: { summary: "Bad config", details: null, path: null, range: null },
  "windows/worldWritableWarning": { samplePaths: [], extraCount: 0, failedScan: false },
  "windowsSandbox/setupCompleted": { mode: "elevated", success: false, error: "denied" },
};

const ITEM_FIXTURES: Record<string, Record<string, unknown>> = {
  userMessage: { clientId: null, content: [{ type: "text", text: "Hi", text_elements: [] }] },
  hookPrompt: { fragments: [{ text: "Run tests first", hookRunId: "hook-1" }] },
  agentMessage: { text: "Done", phase: "final_answer", memoryCitation: null, delivery: null },
  functionCallOutput: { name: "lookup", namespace: null, output: "ok" },
  plan: { text: "1. Read" },
  reasoning: { summary: ["Checking"], content: [] },
  commandExecution: {
    command: "ls",
    cwd: "/repo",
    status: "completed",
    commandActions: [],
    aggregatedOutput: "a.ts\n",
    exitCode: 0,
    durationMs: 3,
  },
  fileChange: {
    status: "completed",
    changes: [
      { path: "a.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b" },
    ],
  },
  mcpToolCall: {
    server: "github",
    tool: "get_issue",
    status: "completed",
    arguments: {},
    result: { content: [{ type: "text", text: "ok" }], structuredContent: null, _meta: null },
    error: null,
    durationMs: 1,
  },
  dynamicToolCall: {
    tool: "lookup",
    namespace: null,
    arguments: {},
    status: "completed",
    contentItems: [{ type: "inputText", text: "ok" }],
    success: true,
    durationMs: 1,
  },
  collabAgentToolCall: {
    tool: "spawnAgent",
    status: "completed",
    senderThreadId: "provider-thread",
    receiverThreadIds: [],
    prompt: "Explore",
    model: null,
    reasoningEffort: null,
    agentsStates: {},
  },
  subAgentActivity: {
    kind: "completed",
    agentThreadId: "child",
    agentPath: "root/explorer",
    model: null,
    reasoningEffort: null,
  },
  webSearch: {
    query: "effect",
    action: { type: "search", query: "effect", queries: null },
    results: null,
  },
  imageView: { path: "/tmp/image.png" },
  sleep: { durationMs: 5000 },
  imageGeneration: {},
  enteredReviewMode: { review: "current changes" },
  exitedReviewMode: { review: "Looks good" },
  contextCompaction: {},
};

const ITEM_TYPES_WITHOUT_RUNTIME_EVENT_WHEN_UNRESOLVED = new Set(["imageGeneration"]);

describe("codexMethodDispositions", () => {
  it("lists exactly the generated Codex protocol names", () => {
    expect(Object.keys(CODEX_NOTIFICATION_DISPOSITIONS).toSorted()).toEqual(
      PROTOCOL_NOTIFICATION_METHODS,
    );
    expect(Object.keys(CODEX_REQUEST_DISPOSITIONS).toSorted()).toEqual(PROTOCOL_REQUEST_METHODS);
    expect(Object.keys(CODEX_ITEM_TYPE_DISPOSITIONS).toSorted()).toEqual(PROTOCOL_ITEM_TYPES);
    expect(PROTOCOL_NOTIFICATION_METHODS).toHaveLength(84);
    expect(PROTOCOL_REQUEST_METHODS).toHaveLength(10);
    expect(PROTOCOL_ITEM_TYPES).toHaveLength(19);
    for (const method of CODEX_ITEM_LIFECYCLE_METHODS) {
      expect(codexNotificationDisposition(method)).toBeUndefined();
    }
  });

  it("resolves exact protocol item types and explicit legacy aliases only", () => {
    expect(resolveCodexItemType("commandExecution")).toBe("commandExecution");
    expect(resolveCodexItemType("command_execution")).toBe("commandExecution");
    expect(resolveCodexItemType("collabToolCall")).toBe("collabAgentToolCall");
    expect(resolveCodexItemType("Plan")).toBe("plan");
    expect(resolveCodexItemType("commandExecutionV2")).toBeUndefined();
    expect(resolveCodexItemType("userMessageEcho")).toBeUndefined();
    expect(codexItemTypeDisposition("hookPrompt")?.presentation).toBe("notice");
    expect(codexRequestDisposition("item/tool/call")).toBe("ignored-gated");
    expect(codexRequestDisposition("item/fileRead/requestApproval")).toBeUndefined();
    expect(codexNotificationDisposition("thread/goal/updated")).toBe("ignored-state");
  });

  it.each(PROTOCOL_NOTIFICATION_METHODS)(
    "notification %s maps by its disposition and never reaches event.unmapped",
    (method) => {
      const fixture = NOTIFICATION_FIXTURES[method] ?? { message: "minimal" };
      const events = mapAndDecode(primedMapper(), nativeEvent(method, "notification", fixture));
      expect(events.map((event) => event.type)).not.toContain("event.unmapped");
      if (codexNotificationDisposition(method) === "mapped") {
        expect(events.length).toBeGreaterThan(0);
      } else {
        expect(events).toEqual([]);
      }
      const bare = mapAndDecode(
        makeCodexRuntimeEventMapper(),
        nativeEvent(method, "notification", {}),
      );
      expect(bare.map((event) => event.type)).not.toContain("event.unmapped");
    },
  );

  it.each(PROTOCOL_REQUEST_METHODS)(
    "request %s maps by its disposition and never reaches event.unmapped",
    (method) => {
      const events = mapAndDecode(
        makeCodexRuntimeEventMapper(),
        nativeEvent(method, "request", {
          command: "ls",
          questions: [
            {
              id: "q1",
              header: "Pick",
              question: "Which?",
              options: [{ label: "A", description: "First" }],
            },
          ],
        }),
      );
      expect(events.map((event) => event.type)).not.toContain("event.unmapped");
      if (codexRequestDisposition(method) === "mapped") {
        expect(events.length).toBeGreaterThan(0);
      } else {
        expect(events).toEqual([]);
      }
    },
  );

  it.each(PROTOCOL_ITEM_TYPES)("item type %s maps and never reaches event.unmapped", (itemType) => {
    const mapper = primedMapper();
    const item = { type: itemType, id: `item-${itemType}`, ...ITEM_FIXTURES[itemType] };
    const started = mapAndDecode(
      mapper,
      nativeEvent("item/started", "notification", { item }, item.id),
    );
    const completed = mapAndDecode(
      mapper,
      nativeEvent("item/completed", "notification", { item }, item.id),
    );
    const types = [...started, ...completed].map((event) => event.type);
    expect(types).not.toContain("event.unmapped");
    if (!ITEM_TYPES_WITHOUT_RUNTIME_EVENT_WHEN_UNRESOLVED.has(itemType)) {
      expect(completed.length).toBeGreaterThan(0);
    }
    const bare = mapAndDecode(
      makeCodexRuntimeEventMapper(),
      nativeEvent("item/completed", "notification", { item: { type: itemType, id: "bare" } }),
    );
    expect(bare.map((event) => event.type)).not.toContain("event.unmapped");
  });

  it("still surfaces unknown future methods as event.unmapped", () => {
    const events = mapAndDecode(
      makeCodexRuntimeEventMapper(),
      nativeEvent("item/future/completed", "notification", {}),
    );
    expect(events.map((event) => event.type)).toEqual(["event.unmapped"]);
  });
});
