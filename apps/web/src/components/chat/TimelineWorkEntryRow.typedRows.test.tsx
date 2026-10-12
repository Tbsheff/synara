import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { WorkLogEntry } from "../../workLog";
import { TimelineWorkEntryRow, workEntryDisplayText } from "./TimelineWorkEntryRow";

function entry(overrides: Partial<WorkLogEntry>): WorkLogEntry {
  return {
    id: "work-1",
    createdAt: new Date(0).toISOString(),
    label: "Tool call",
    tone: "tool",
    activityKind: "tool.completed",
    toolStatus: "completed",
    ...overrides,
  };
}

function renderRow(
  workEntry: WorkLogEntry,
  options: { markdownCwd?: string; onOpenAgentActivity?: (id: string) => void } = {},
): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <TimelineWorkEntryRow
        workEntry={workEntry}
        chatMetaFontSizePx={12}
        density="compact"
        markdownCwd={options.markdownCwd}
        onImageExpand={() => undefined}
        timestampFormat="locale"
        {...(options.onOpenAgentActivity
          ? { onOpenAgentActivity: options.onOpenAgentActivity }
          : {})}
      />
    </QueryClientProvider>,
  );
}

function liveMeta(markup: string): string | null {
  const match = /data-live-activity-meta="true">([^<]*)</u.exec(markup);
  return match ? match[1]!.replace(/^ · /u, "") : null;
}

describe("typed command rows", () => {
  it("renders the Codex collapsed label with duration", () => {
    const row = entry({
      itemType: "command_execution",
      command: "bun run test",
      commandExecution: { command: "bun run test", exitCode: 0, durationMs: 65_000 },
    });
    expect(workEntryDisplayText(row)).toBe("Ran bun run test in 1m 5s");
    const markup = renderRow(row);
    expect(markup).toContain("Ran bun run test in 1m 5s");
    expect(markup).toContain('data-tool-detail-trigger="true"');
  });

  it("renders running and parsed-action labels", () => {
    expect(
      workEntryDisplayText(
        entry({
          itemType: "command_execution",
          toolStatus: "running",
          activityKind: "tool.updated",
          commandExecution: { command: "sleep 5" },
        }),
      ),
    ).toBe("Running sleep 5");
    expect(
      workEntryDisplayText(
        entry({
          itemType: "command_execution",
          commandExecution: {
            command: "cat src/a.ts",
            parsedActions: [{ type: "read", path: "src/a.ts" }],
          },
        }),
      ),
    ).toBe("Read a.ts");
  });
});

describe("live output without typed details", () => {
  it("still opens a shell card for a legacy running command", () => {
    const row = entry({
      itemType: "command_execution",
      toolStatus: "running",
      activityKind: "tool.updated",
      command: "npm test",
      liveOutput: {
        tail: "ok",
        truncated: false,
        totalChars: 2,
        updatedAt: "2026-10-10T00:00:00Z",
      },
    });
    expect(workEntryDisplayText(row)).toBe("Running npm test");
    expect(renderRow(row)).toContain('data-tool-detail-trigger="true"');
  });
});

describe("image view rows", () => {
  it("counts viewed images", () => {
    expect(
      workEntryDisplayText(
        entry({
          itemType: "image_view",
          toolCall: {
            images: [
              { source: "file", path: "/tmp/a.png" },
              { source: "file", path: "/tmp/b.png" },
            ],
          },
        }),
      ),
    ).toBe("Viewed 2 images");
  });
});

describe("typed file rows", () => {
  it("renders one row per file with verb and stats", () => {
    const markup = renderRow(
      entry({
        itemType: "file_change",
        changedFiles: ["src/a.ts", "src/b.ts"],
        fileChanges: {
          changes: [
            { path: "src/a.ts", kind: "update", additions: 3, deletions: 1, unifiedDiff: "+x" },
            { path: "src/b.ts", kind: "add", additions: 10 },
            { path: "src/c.ts", kind: "delete", deletions: 4 },
          ],
          totalFiles: 5,
        },
      }),
    );
    expect(markup.match(/data-file-change-row="true"/g)).toHaveLength(3);
    expect(markup).toContain(">Edited<");
    expect(markup).toContain(">Created<");
    expect(markup).toContain(">Deleted<");
    expect(markup).toContain("a.ts");
    expect(markup).toContain("2 more files");
  });
});

describe("typed tool rows", () => {
  it("labels a Claude Read with its line range", () => {
    expect(
      workEntryDisplayText(
        entry({
          itemType: "dynamic_tool_call",
          toolName: "Read",
          toolCall: { toolName: "Read", arguments: { file_path: "/r/a.ts", offset: 1, limit: 5 } },
        }),
      ),
    ).toBe("Read a.ts (lines 1-5)");
  });

  it("labels an MCP tool in sentence case and keeps the key argument for failed calls too", () => {
    const row = entry({
      itemType: "mcp_tool_call",
      toolStatus: "failed",
      toolName: "mcp__linear__search_issues",
      toolCall: {
        toolName: "mcp__linear__search_issues",
        arguments: { query: "parity" },
        error: "rate limited",
      },
    });
    expect(workEntryDisplayText(row)).toBe("Search issues parity");
    expect(renderRow(row)).toContain('data-tool-detail-trigger="true"');
  });

  it("labels the advisor server tool", () => {
    expect(
      workEntryDisplayText(
        entry({
          itemType: "dynamic_tool_call",
          toolName: "advisor",
          toolCall: { toolName: "advisor", serverToolKind: "advisor", resultText: "Do X" },
        }),
      ),
    ).toBe("Asked the advisor");
  });

  it("labels web searches", () => {
    expect(
      workEntryDisplayText(
        entry({ itemType: "web_search", webSearch: { query: "vitest browser mode" } }),
      ),
    ).toBe("Searched the web for vitest browser mode");
  });
});

describe("notice rows", () => {
  it("renders a compact notice with severity tone", () => {
    const markup = renderRow(
      entry({
        tone: "info",
        activityKind: "transcript.notice" as NonNullable<WorkLogEntry["activityKind"]>,
        notice: {
          noticeKind: "config-warning",
          severity: "warning",
          title: "Unknown key in config.toml",
          body: "line 3",
        },
      }),
    );
    expect(markup).toContain("Unknown key in config.toml");
    expect(markup).toContain('data-transcript-notice-tone="warning"');
    expect(markup).toContain('data-tool-detail-trigger="true"');
  });

  it("summarizes grouped hooks", () => {
    const markup = renderRow(
      entry({
        tone: "info",
        notice: {
          noticeKind: "hook",
          severity: "info",
          title: "Hooks",
          status: "completed",
          data: { grouped: true, count: 4, hookIds: ["a", "b", "c", "d"] },
        },
      }),
    );
    expect(markup).toContain("4 hooks ran");
  });

  it("shows a failed status suffix", () => {
    const markup = renderRow(
      entry({
        notice: { noticeKind: "hook", severity: "info", title: "Ran Stop hook", status: "failed" },
      }),
    );
    expect(markup).toContain("Ran Stop hook");
    expect(markup).toContain(" · Failed");
  });
});

describe("reasoning rows", () => {
  it("uses the heading as the title", () => {
    expect(
      workEntryDisplayText(
        entry({
          label: "Reasoning update",
          tone: "thinking",
          reasoning: { heading: "**Checking the comparator**", summary: "body" },
        }),
      ),
    ).toBe("Checking the comparator");
  });

  it("marks redacted reasoning", () => {
    expect(
      workEntryDisplayText(
        entry({ label: "Reasoning update", tone: "thinking", reasoning: { redacted: true } }),
      ),
    ).toBe("Reasoning redacted");
  });
});

describe("legacy unmapped rows", () => {
  it("keeps the stored message next to the readable title", () => {
    const row = entry({
      label: "warning",
      detail: "Model is overloaded, retrying",
      tone: "info",
      activityKind: "provider.event.unmapped" as NonNullable<WorkLogEntry["activityKind"]>,
      unmappedMethod: "warning",
    });
    expect(workEntryDisplayText(row)).toBe("Provider warning: Model is overloaded, retrying");
  });

  it.each(["thread/goal/updated", "warning"])(
    "never titles a row with the raw method %s",
    (method) => {
      const row = entry({
        label: method,
        tone: "info",
        activityKind: "provider.event.unmapped" as NonNullable<WorkLogEntry["activityKind"]>,
        unmappedMethod: method,
      });
      const text = workEntryDisplayText(row);
      expect(text).not.toBe(method);
      expect(text).not.toContain("/");
      const markup = renderRow(row);
      expect(markup).not.toContain(`>${method}<`);
    },
  );
});

describe("failed rows", () => {
  const startedAt = "2026-10-10T10:00:00.000Z";
  const failedActivity = {
    state: "failed" as const,
    label: "Bash",
    startedAt,
    lastActivityAt: "2026-10-10T10:00:00.300Z",
  };

  it("reads a failed Claude command as `Ran {cmd}` with the outcome and its time", () => {
    const row = entry({
      itemType: "command_execution",
      command: "ls /nonexistent",
      commandExecution: { command: "ls /nonexistent", exitCode: 1 },
      liveActivity: failedActivity,
    });
    expect(workEntryDisplayText(row)).toBe("Ran ls /nonexistent");
    expect(liveMeta(renderRow(row))).toBe("Failed in 0s");
  });

  it("drops the parsed-action verb on a failed Codex command and prefers its duration", () => {
    const row = entry({
      itemType: "command_execution",
      toolStatus: "failed",
      command: "ls /nonexistent; echo done",
      commandExecution: {
        command: "ls /nonexistent; echo done",
        durationMs: 4_200,
        parsedActions: [{ type: "list_files", path: "nonexistent" }],
      },
      liveActivity: failedActivity,
    });
    expect(workEntryDisplayText(row)).toBe("Ran ls /nonexistent; echo done");
    expect(liveMeta(renderRow(row))).toBe("Failed in 4s");
  });

  it("shows the failure on a failed command without live activity", () => {
    const row = entry({
      itemType: "command_execution",
      toolStatus: "failed",
      commandExecution: { command: "false", durationMs: 2_000 },
    });
    expect(liveMeta(renderRow(row))).toBe("Failed in 2s");
  });

  it("does not repeat the stop on a stopped command", () => {
    const row = entry({
      itemType: "command_execution",
      toolStatus: "cancelled",
      commandExecution: { command: "sleep 9", durationMs: 3_000, interrupted: true },
      liveActivity: { ...failedActivity, state: "cancelled" },
    });
    expect(workEntryDisplayText(row)).toBe("Stopped sleep 9 after 3s");
    expect(liveMeta(renderRow(row))).toBeNull();
  });

  it("states the outcome time on a failed generic tool", () => {
    const row = entry({
      itemType: "dynamic_tool_call",
      toolName: "Grep",
      toolCall: { toolName: "Grep", arguments: { pattern: "beta", path: "/proj" } },
      liveActivity: { ...failedActivity, label: "Grep" },
    });
    expect(liveMeta(renderRow(row))).toBe("Failed in 0s");
  });
});

describe("live output activity time", () => {
  it("counts the newest live output as activity", () => {
    const now = Date.now();
    const row = entry({
      itemType: "command_execution",
      toolStatus: "running",
      activityKind: "tool.updated",
      commandExecution: { command: "for i in 1 2 3; do echo $i; sleep 1; done" },
      liveActivity: {
        state: "running_tool",
        label: "Bash",
        startedAt: new Date(now - 20_000).toISOString(),
        lastActivityAt: new Date(now - 20_000).toISOString(),
      },
      liveOutput: {
        tail: "1\n2\n",
        truncated: false,
        totalChars: 4,
        updatedAt: new Date(now + 5_000).toISOString(),
      },
    });
    expect(liveMeta(renderRow(row))).toMatch(/^Active now · /u);
  });
});

describe("file rows", () => {
  it("shows deletions with the minus sign used by the Changes panel", () => {
    const markup = renderRow(
      entry({
        itemType: "file_change",
        fileChanges: {
          changes: [{ path: "src/a.ts", kind: "update", additions: 2, deletions: 1 }],
          totalFiles: 1,
        },
      }),
    );
    expect(markup).toContain("\u22121");
    expect(markup).not.toMatch(/>-1</u);
  });

  it("reads an in-place Codex edit as an edit, not a move", () => {
    const markup = renderRow(
      entry({
        itemType: "file_change",
        fileChanges: {
          changes: [
            {
              path: "/private/tmp/proj/scratch.txt",
              kind: "move",
              movePath: "scratch.txt",
              additions: 2,
              deletions: 1,
            },
          ],
          totalFiles: 1,
        },
      }),
      { markdownCwd: "/tmp/proj" },
    );
    expect(markup).toContain(">Edited<");
    expect(markup).not.toContain("→");
  });
});

describe("derived work log fields", () => {
  it("renders a model reroute as a divider with the refusal", () => {
    const markup = renderRow(
      entry({
        tone: "info",
        activityKind: "model.rerouted",
        label: "Model switched: fable -> opus",
        modelReroute: {
          fromModel: "fable",
          toModel: "opus",
          refusalCategory: "cyber",
          refusalExplanation: "<b>flagged</b>",
          retractedMessageCount: 2,
        },
      }),
    );
    expect(markup).toContain('data-model-reroute-divider="true"');
    expect(markup).toContain("Switched from fable to opus");
    expect(markup).toContain("Refusal: cyber: &lt;b&gt;flagged&lt;/b&gt;");
    expect(markup).toContain("2 earlier replies were withdrawn");
  });

  it("shows the message delivered to a subagent", () => {
    const row = entry({
      tone: "info",
      activityKind: "turn.steered",
      label: "Message delivered to subagent",
      detail: "Also check the tests",
      steeredMessage: "Also check the tests",
    });
    expect(workEntryDisplayText(row)).toBe("Message delivered to subagent");
    const markup = renderRow(row);
    expect(markup).toContain('data-steered-message="true"');
    expect(markup).toContain("Also check the tests");
  });

  it("links the output file of a finished task", () => {
    const markup = renderRow(
      entry({
        tone: "info",
        activityKind: "task.completed",
        label: "Subagent finished: Run background sleep",
        outputFile: "/tmp/tasks/a1.output",
        backgroundTaskCompletion: { taskId: "a1", taskType: "local_agent", description: null },
      }),
    );
    expect(markup).toContain('data-task-output-file="true"');
    expect(markup).toContain('href="/tmp/tasks/a1.output"');
  });

  it("names automatic and manual compaction", () => {
    const compacted = entry({
      tone: "info",
      activityKind: "context-compaction",
      label: "Context compacted",
      compactionTrigger: "automatic",
    });
    expect(workEntryDisplayText(compacted)).toBe("Automatically compacted context");
    expect(workEntryDisplayText({ ...compacted, compactionTrigger: "manual" })).toBe(
      "Compacted context",
    );
  });
});

describe("agent launch rows", () => {
  it("expands inline even when the agent activity panel is available", () => {
    const markup = renderRow(
      entry({
        itemType: "collab_agent_tool_call",
        label: "Run background sleep",
        toolTitle: "Run background sleep",
        subagentAction: {
          tool: "spawnAgent",
          status: "in_progress",
          summaryText: "Spawned 1 agent",
          model: "sonnet",
          prompt: "Sleep 75 seconds",
        },
      }),
      { onOpenAgentActivity: () => undefined },
    );
    expect(markup).toContain('data-tool-detail-trigger="true"');
  });
});

describe("command outcome from the exit code", () => {
  it("reads a non-zero exit as a failure even when the lifecycle completed", () => {
    const row = entry({
      itemType: "command_execution",
      commandExecution: {
        command: "ls missing",
        exitCode: 2,
        durationMs: 3_000,
        parsedActions: [{ type: "list_files", path: "missing" }],
      },
    });
    expect(workEntryDisplayText(row)).toBe("Ran ls missing");
    expect(liveMeta(renderRow(row))).toBe("Failed in 3s");
  });

  it("labels BashOutput by its description", () => {
    const row = entry({
      itemType: "command_execution",
      toolName: "BashOutput",
      commandExecution: { description: "Read output of background shell bash_1" },
    });
    expect(workEntryDisplayText(row)).toBe("Read output of background shell bash_1");
  });
});
