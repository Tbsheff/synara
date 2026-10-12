import type { TranscriptNotice } from "@synara/contracts";
import { TranscriptNoticeKind } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  isDroppedLegacyUnmappedMethod,
  LEGACY_UNMAPPED_FALLBACK_TITLE,
  legacyUnmappedMethodTitle,
} from "./legacyUnmappedEventLabels";
import {
  contextCompactionTitle,
  isMcpAuthenticationNotice,
  readGroupedHookNoticeData,
  transcriptNoticePresentation,
  transcriptNoticeStatusLabel,
  transcriptNoticeTitle,
  transcriptNoticeTone,
} from "./transcriptNoticeLabels";

function notice(overrides: Partial<TranscriptNotice> = {}): TranscriptNotice {
  return {
    noticeKind: "hook",
    severity: "info",
    title: "Ran PostToolUse hook",
    ...overrides,
  } as TranscriptNotice;
}

describe("transcriptNoticePresentation", () => {
  it("has an icon and a label for every notice kind", () => {
    for (const kind of TranscriptNoticeKind.literals) {
      const presentation = transcriptNoticePresentation(kind);
      expect(presentation.icon).toBeTypeOf("function");
      expect(presentation.label.length).toBeGreaterThan(0);
      expect(presentation.label).not.toBe(kind);
    }
  });
});

describe("transcriptNoticeTone", () => {
  it.each([
    ["info", undefined, "info"],
    ["info", "failed", "warning"],
    ["info", "blocked", "warning"],
    ["warning", "completed", "warning"],
    ["error", undefined, "error"],
  ] as const)("maps %s/%s to %s", (severity, status, tone) => {
    expect(transcriptNoticeTone(severity, status)).toBe(tone);
  });

  it("labels only terminal problem states", () => {
    expect(transcriptNoticeStatusLabel("failed")).toBe("Failed");
    expect(transcriptNoticeStatusLabel("blocked")).toBe("Blocked");
    expect(transcriptNoticeStatusLabel("completed")).toBeNull();
    expect(transcriptNoticeStatusLabel(undefined)).toBeNull();
  });
});

describe("transcriptNoticeTitle", () => {
  it("uses the producer title", () => {
    expect(transcriptNoticeTitle(notice())).toBe("Ran PostToolUse hook");
  });

  it("summarizes a grouped hook row", () => {
    const grouped = notice({
      data: {
        grouped: true,
        count: 3,
        hookIds: ["a", "b", "c"],
        hookEvents: ["PreToolUse", "PostToolUse", "PreToolUse"],
      },
    });
    expect(transcriptNoticeTitle(grouped)).toBe("3 hooks ran");
    expect(readGroupedHookNoticeData(grouped)?.hookEvents).toEqual(["PreToolUse", "PostToolUse"]);
  });

  it("counts hook ids when the count is missing", () => {
    expect(transcriptNoticeTitle(notice({ data: { grouped: true, hookIds: ["a"] } }))).toBe(
      "1 hook ran",
    );
  });

  it("ignores grouping data on other notice kinds", () => {
    const other = notice({
      noticeKind: "notification",
      title: "Build done",
      data: { grouped: true, count: 2 },
    });
    expect(readGroupedHookNoticeData(other)).toBeNull();
    expect(transcriptNoticeTitle(other)).toBe("Build done");
  });
});

describe("legacy unmapped methods", () => {
  it.each([
    ["thread/goal/updated", "Thread goal updated"],
    ["warning", "Provider warning"],
    ["configWarning", "Configuration warning"],
    ["mcpServer/startupStatus/updated", "MCP server status"],
    ["system:memory_recall", "Recalled from memory"],
  ])("titles %s as %s", (method, title) => {
    expect(legacyUnmappedMethodTitle(method)).toBe(title);
  });

  it("never returns the raw method for an unknown method", () => {
    expect(legacyUnmappedMethodTitle("future/thing/changed")).toBe(LEGACY_UNMAPPED_FALLBACK_TITLE);
  });

  it("drops methods the disposition marks as drop", () => {
    expect(isDroppedLegacyUnmappedMethod("thread/status/changed")).toBe(true);
    expect(isDroppedLegacyUnmappedMethod("thread/realtime/item/started")).toBe(true);
    expect(isDroppedLegacyUnmappedMethod("system:thinking_tokens")).toBe(true);
    expect(isDroppedLegacyUnmappedMethod("thread/goal/updated")).toBe(false);
    expect(isDroppedLegacyUnmappedMethod("warning")).toBe(false);
  });

  it("titles every non-dropped method with readable words", () => {
    for (const method of ["hook/completed", "model/rerouted", "skills/changed"]) {
      const title = legacyUnmappedMethodTitle(method);
      expect(title).not.toContain("/");
      expect(title).not.toBe(method);
    }
  });
});

describe("contextCompactionTitle", () => {
  it.each([
    ["Context compacted", "automatic", "Automatically compacted context"],
    ["Context compacted", "manual", "Compacted context"],
    ["Context compacted manually", "manual", "Compacted context"],
    ["Compacting context", "automatic", null],
    ["Context compaction failed", "automatic", null],
    ["Context compacted", undefined, null],
  ] as const)("%s (%s) → %s", (label, compactionTrigger, title) => {
    expect(
      contextCompactionTitle({ activityKind: "context-compaction", label, compactionTrigger }),
    ).toBe(title);
  });

  it("ignores other activity kinds", () => {
    expect(
      contextCompactionTitle({
        activityKind: "tool.completed",
        label: "Context compacted",
        compactionTrigger: "automatic",
      }),
    ).toBeNull();
  });
});

describe("hook and MCP notice titles", () => {
  it.each([
    { title: "MCP server claude.ai Linear needs authentication" },
    { detail: "Authentication required" },
    { body: "MCP error: auth_required" },
    { detail: "MCP status: needs-auth" },
  ])("recognizes MCP authentication notices in %j", (fields) => {
    expect(
      isMcpAuthenticationNotice(
        notice({
          noticeKind: "mcp-server-status",
          title: "MCP server Linear failed to start",
          status: "failed",
          ...fields,
        }),
      ),
    ).toBe(true);
  });

  it("keeps other MCP failures, ready rows, and non-MCP authentication notices", () => {
    for (const entry of [
      notice({
        noticeKind: "mcp-server-status",
        title: "MCP server github failed to start",
        detail: "Connection closed",
        status: "failed",
      }),
      notice({
        noticeKind: "mcp-server-status",
        title: "MCP server auth_required failed to start",
        status: "failed",
      }),
      notice({
        noticeKind: "mcp-server-status",
        title: "MCP servers ready: auth_required",
        status: "completed",
      }),
      notice({ noticeKind: "mcp-server-status", title: "MCP servers ready: needs-auth" }),
      notice({ noticeKind: "provider-warning", title: "Provider needs authentication" }),
      notice({ noticeKind: "mcp-oauth", title: "MCP sign-in completed" }),
    ]) {
      expect(isMcpAuthenticationNotice(entry)).toBe(false);
    }
  });

  it("names a hook by its event or name and never as a lifecycle hook", () => {
    expect(
      transcriptNoticeTitle(
        notice({
          title: "Ran Lifecycle hook",
          status: "completed",
          data: { hookEvent: "PostToolUse", hookName: "lint", matcher: "Bash" },
        }),
      ),
    ).toBe("Ran PostToolUse hook");
    expect(
      transcriptNoticeTitle(
        notice({ title: "Running Lifecycle hook", status: "running", data: { hookName: "lint" } }),
      ),
    ).toBe("Running lint hook");
    expect(
      transcriptNoticeTitle(notice({ title: "Ran Lifecycle hook", status: "completed" })),
    ).toBe("Ran hook");
    expect(transcriptNoticeTitle(notice({ title: "Ran Stop hook" }))).toBe("Ran Stop hook");
  });

  it("never says ready for a failed MCP server", () => {
    const failed = notice({
      noticeKind: "mcp-server-status",
      severity: "warning",
      status: "failed",
      title: "MCP servers ready",
    });
    expect(transcriptNoticeTitle(failed)).toBe("MCP server unavailable");
    expect(transcriptNoticeTone(failed.severity, failed.status)).toBe("warning");
    expect(transcriptNoticeStatusLabel(failed.status)).toBe("Failed");
    expect(transcriptNoticeTitle({ ...failed, title: "MCP server neon failed to start" })).toBe(
      "MCP server neon failed to start",
    );
  });

  it("drops the session open event from old threads", () => {
    expect(isDroppedLegacyUnmappedMethod("session/threadOpenResolved")).toBe(true);
  });
});
