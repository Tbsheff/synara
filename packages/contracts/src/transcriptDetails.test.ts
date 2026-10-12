import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { OrchestrationThreadStreamItem } from "./orchestration";
import { ProviderRuntimeEvent } from "./providerRuntime";
import {
  CommandExecutionDetails,
  FileChangeDetails,
  ToolActivityPayload,
  ToolCallDetails,
  TranscriptNotice,
  TurnCompletedActivityHints,
} from "./transcriptDetails";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const decodeToolActivityPayload = Schema.decodeUnknownSync(ToolActivityPayload);
const decodeStreamItem = Schema.decodeUnknownSync(OrchestrationThreadStreamItem);

const baseEvent = {
  eventId: "event-1",
  provider: "codex",
  threadId: "thread-1",
  turnId: "turn-1",
  itemId: "item-1",
  createdAt: "2026-10-10T00:00:00.000Z",
};

describe("transcript details contracts", () => {
  it("decodes a legacy item.completed payload without the new fields", () => {
    const parsed = decodeRuntimeEvent({
      ...baseEvent,
      type: "item.completed",
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Ran command",
        detail: "ls",
        data: { item: { type: "commandExecution" } },
      },
    });
    if (parsed.type !== "item.completed") throw new Error("expected item.completed");
    expect(parsed.payload.command).toBeUndefined();
    expect(parsed.payload.phase).toBeUndefined();
  });

  it("keeps leading and trailing whitespace in command output", () => {
    const output = "\n  total 0\n\t\n";
    const parsed = decodeRuntimeEvent({
      ...baseEvent,
      type: "item.completed",
      payload: {
        itemType: "command_execution",
        status: "failed",
        command: {
          command: "  ls -la ",
          cwd: "/tmp",
          exitCode: 2,
          durationMs: 12.5,
          output,
          stderr: " ",
          outputTruncated: false,
          outputTotalChars: output.length,
          parsedActions: [{ type: "list_files", path: "." }],
        },
      },
    });
    if (parsed.type !== "item.completed") throw new Error("expected item.completed");
    expect(parsed.payload.command?.output).toBe(output);
    expect(parsed.payload.command?.command).toBe("  ls -la ");
  });

  it("accepts null and negative exit codes and rejects non-finite durations", () => {
    const decode = Schema.decodeUnknownSync(CommandExecutionDetails);
    expect(decode({ exitCode: null }).exitCode).toBeNull();
    expect(decode({ exitCode: -9 }).exitCode).toBe(-9);
    expect(() => decode({ durationMs: Number.POSITIVE_INFINITY })).toThrow();
  });

  it("decodes per-file changes and rejects an unknown change kind", () => {
    const decode = Schema.decodeUnknownSync(FileChangeDetails);
    const parsed = decode({
      changes: [
        {
          path: "a.ts",
          kind: "update",
          unifiedDiff: "@@ -1 +1 @@\n-a\n+b\n",
          additions: 1,
          deletions: 1,
        },
        { path: "b.ts", kind: "move", movePath: "c.ts" },
      ],
      totalFiles: 2,
    });
    expect(parsed.changes).toHaveLength(2);
    expect(() => decode({ changes: [{ path: "a.ts", kind: "rename" }] })).toThrow();
  });

  it("decodes tool call details with image file refs and omitted images", () => {
    const parsed = Schema.decodeUnknownSync(ToolCallDetails)({
      toolName: "mcp__synara__browser_screenshot",
      server: "synara",
      arguments: { url: "http://localhost" },
      resultText: "",
      images: [
        { source: "file", path: "/tmp/shot.png", mediaType: "image/png", byteLength: 10 },
        { source: "omitted", mediaType: "image/png", reason: "too large" },
      ],
      otherBlocks: [{ blockType: "document", title: "spec.pdf" }],
    });
    expect(parsed.images?.[0]?.source).toBe("file");
    expect(parsed.images?.[1]?.source).toBe("omitted");
  });

  it("decodes a transcript.notice runtime event and requires a non-empty title", () => {
    const parsed = decodeRuntimeEvent({
      ...baseEvent,
      provider: "claudeAgent",
      type: "transcript.notice",
      payload: {
        noticeKind: "hook",
        severity: "info",
        title: "Ran PreToolUse hook",
        status: "completed",
        body: "  hook output\n",
        dedupeKey: "hook:abc",
      },
    });
    expect(parsed.type).toBe("transcript.notice");
    expect(() =>
      Schema.decodeUnknownSync(TranscriptNotice)({
        noticeKind: "hook",
        severity: "info",
        title: "  ",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(TranscriptNotice)({
        noticeKind: "warning",
        severity: "info",
        title: "x",
      }),
    ).toThrow();
  });

  it("carries message phase, turn origin, and the final assistant item id", () => {
    const item = decodeRuntimeEvent({
      ...baseEvent,
      type: "item.completed",
      payload: { itemType: "assistant_message", phase: "final_answer" },
    });
    if (item.type !== "item.completed") throw new Error("expected item.completed");
    expect(item.payload.phase).toBe("final_answer");

    const started = decodeRuntimeEvent({
      ...baseEvent,
      type: "turn.started",
      payload: { origin: "provider" },
    });
    if (started.type !== "turn.started") throw new Error("expected turn.started");
    expect(started.payload.origin).toBe("provider");

    const completed = decodeRuntimeEvent({
      ...baseEvent,
      type: "turn.completed",
      payload: { state: "completed", finalAssistantItemId: "item-9" },
    });
    if (completed.type !== "turn.completed") throw new Error("expected turn.completed");
    expect(completed.payload.finalAssistantItemId).toBe("item-9");

    expect(
      Schema.decodeUnknownSync(TurnCompletedActivityHints)({
        finalAssistantMessageId: "assistant:item-9",
      }).finalAssistantMessageId,
    ).toBe("assistant:item-9");
  });

  it("decodes an old tool activity payload and a new one with typed details", () => {
    expect(
      decodeToolActivityPayload({ itemType: "web_search", title: "Web search" }).webSearch,
    ).toBeUndefined();
    const parsed = decodeToolActivityPayload({
      itemType: "web_search",
      webSearch: { query: "effect schema", action: { type: "search", query: "effect schema" } },
    });
    expect(parsed.webSearch?.query).toBe("effect schema");
  });

  it("decodes a live tool-output stream item and its clear item", () => {
    const live = decodeStreamItem({
      kind: "live",
      live: {
        kind: "tool-output",
        threadId: "thread-1",
        turnId: null,
        itemId: "item-1",
        streamKind: "command_output",
        tail: "[output truncated]\n line\n",
        truncated: true,
        totalChars: 30000,
        updatedAt: "2026-10-10T00:00:01.000Z",
      },
    });
    expect(live.kind).toBe("live");
    const cleared = decodeStreamItem({
      kind: "live",
      live: {
        kind: "tool-output-cleared",
        threadId: "thread-1",
        itemId: "item-1",
        updatedAt: "2026-10-10T00:00:02.000Z",
      },
    });
    expect(cleared.kind).toBe("live");
  });
  it("decodes the runtime fields added for progress type, refusals, retries and option previews", () => {
    const progress = decodeRuntimeEvent({
      ...baseEvent,
      provider: "claudeAgent",
      type: "tool.progress",
      payload: { toolUseId: "toolu_1", toolName: "Bash", itemType: "command_execution" },
    });
    if (progress.type !== "tool.progress") throw new Error("expected tool.progress");
    expect(progress.payload.itemType).toBe("command_execution");

    const rerouted = decodeRuntimeEvent({
      ...baseEvent,
      provider: "claudeAgent",
      type: "model.rerouted",
      payload: {
        fromModel: "a",
        toModel: "b",
        reason: "refusal",
        refusalCategory: "cyber",
        retractedItemIds: ["item-2"],
      },
    });
    if (rerouted.type !== "model.rerouted") throw new Error("expected model.rerouted");
    expect(rerouted.payload.retractedItemIds).toEqual(["item-2"]);

    const retry = decodeRuntimeEvent({
      ...baseEvent,
      type: "runtime.warning",
      payload: {
        message: "Reconnecting 2/5",
        willRetry: true,
        retryAttempt: 2,
        retryMaxAttempts: 5,
      },
    });
    if (retry.type !== "runtime.warning") throw new Error("expected runtime.warning");
    expect(retry.payload.retryAttempt).toBe(2);

    const question = decodeRuntimeEvent({
      ...baseEvent,
      type: "user-input.requested",
      payload: {
        questions: [
          {
            id: "q-0",
            header: "Layout",
            question: "Which layout?",
            options: [{ label: "A", description: "Grid", preview: "  <grid/>\n" }],
          },
        ],
      },
    });
    if (question.type !== "user-input.requested") throw new Error("expected user-input.requested");
    expect(question.payload.questions[0]?.options[0]?.preview).toBe("  <grid/>\n");
  });
});
