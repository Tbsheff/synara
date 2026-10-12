import { describe, expect, it } from "vitest";
import type { WorkLogEntry } from "../../session-logic";
import {
  classifyToolCallSummaryCategory,
  formatToolCallGroupLabel,
  isSummarizableToolCallEntry,
  multiFileEditLabel,
  summarizeToolCallGroup,
} from "./toolCallGroup.logic";

function workEntry(overrides: Partial<WorkLogEntry> & Pick<WorkLogEntry, "id">): WorkLogEntry {
  return {
    createdAt: "2026-06-05T00:00:00.000Z",
    label: "Tool call",
    tone: "tool",
    ...overrides,
  };
}

const command = (id: string, cmd = "bun run build") =>
  workEntry({ id, itemType: "command_execution", command: cmd });
const edit = (id: string, files: string[]) =>
  workEntry({ id, itemType: "file_change", changedFiles: files });

describe("classifyToolCallSummaryCategory", () => {
  it("classifies file changes as edits", () => {
    expect(classifyToolCallSummaryCategory(edit("e1", ["a.ts"]))).toBe("edit");
    expect(
      classifyToolCallSummaryCategory(workEntry({ id: "e2", requestKind: "file-change" })),
    ).toBe("edit");
  });

  it("classifies search commands, structured search actions, and web searches", () => {
    expect(classifyToolCallSummaryCategory(command("s1", 'rg -n "foo" src'))).toBe("search");
    expect(
      classifyToolCallSummaryCategory(
        workEntry({ id: "s2", itemType: "command_execution", toolTitle: "Searched" }),
      ),
    ).toBe("search");
    expect(classifyToolCallSummaryCategory(workEntry({ id: "s3", itemType: "web_search" }))).toBe(
      "web",
    );
  });

  it("classifies mutating commands, agent tasks, and MCP tools", () => {
    expect(classifyToolCallSummaryCategory(command("c1"))).toBe("command");
    expect(
      classifyToolCallSummaryCategory(workEntry({ id: "a1", itemType: "collab_agent_tool_call" })),
    ).toBe("agent");
    expect(
      classifyToolCallSummaryCategory(workEntry({ id: "m1", itemType: "mcp_tool_call" })),
    ).toBe("tool");
    expect(classifyToolCallSummaryCategory(workEntry({ id: "m2", toolName: "WebFetch" }))).toBe(
      "tool",
    );
  });
});

describe("isSummarizableToolCallEntry", () => {
  it("rejects non-tool tones and rich card entries", () => {
    expect(isSummarizableToolCallEntry(workEntry({ id: "err", tone: "error" }))).toBe(false);
    expect(isSummarizableToolCallEntry(workEntry({ id: "info", tone: "info" }))).toBe(false);
    expect(
      isSummarizableToolCallEntry(
        workEntry({
          id: "sub",
          subagents: [{ threadId: "thread-1" }],
        }),
      ),
    ).toBe(false);
    expect(
      isSummarizableToolCallEntry(
        workEntry({
          id: "sub-action",
          subagentAction: { tool: "task", status: "running", summaryText: "Working" },
        }),
      ),
    ).toBe(false);
    expect(
      isSummarizableToolCallEntry(
        workEntry({
          id: "auto",
          automation: { id: "a", name: "Nightly", cadenceLabel: "daily" },
        }),
      ),
    ).toBe(false);
    expect(
      isSummarizableToolCallEntry(
        workEntry({
          id: "threads",
          synaraThreadCreation: {
            operationId: "op",
            requestedCount: 1,
            createdCount: 1,
            threads: [],
          },
        }),
      ),
    ).toBe(false);
  });
});

describe("summarizeToolCallGroup", () => {
  it("returns null below the minimum group size", () => {
    expect(summarizeToolCallGroup([])).toBeNull();
    expect(summarizeToolCallGroup([command("c1")])).toBeNull();
    // A lone tool entry next to excluded entries still does not fold.
    expect(
      summarizeToolCallGroup([command("c1"), workEntry({ id: "e", tone: "error" })]),
    ).toBeNull();
  });

  it("joins mixed categories in a fixed order", () => {
    const summary = summarizeToolCallGroup([
      command("s1", 'rg -n "alpha" src'),
      edit("e1", ["a.ts"]),
      command("c1"),
      command("s2", "grep beta lib"),
      edit("e2", ["b.ts"]),
      command("c2", "bun run lint"),
      command("s3", "rg gamma docs"),
    ]);
    expect(summary?.label).toBe("Edited files, searched files, ran commands");
  });

  it("counts distinct files for edits across entries", () => {
    const summary = summarizeToolCallGroup([
      edit("e1", ["Sidebar.tsx"]),
      edit("e2", ["Sidebar.tsx"]),
      edit("e3", ["Sidebar.tsx", "Sidebar.logic.ts"]),
    ]);
    expect(summary?.label).toBe("Edited files");
  });

  it("counts edits without file info as one unit each", () => {
    const summary = summarizeToolCallGroup([
      workEntry({ id: "e1", itemType: "file_change" }),
      workEntry({ id: "e2", itemType: "file_change" }),
      edit("e3", ["a.ts"]),
    ]);
    expect(summary?.label).toBe("Edited files");
  });

  it("dedupes reads of the same file across command and structured entries", () => {
    const summary = summarizeToolCallGroup([
      command("r1", "cat src/app.ts"),
      command("r2", "cat src/app.ts"),
      workEntry({ id: "r3", requestKind: "file-read", changedFiles: ["src/main.ts"] }),
    ]);
    expect(summary?.label).toBe("Read files");
  });

  it("labels an uncategorized-only run as plain tool calls", () => {
    const summary = summarizeToolCallGroup([
      workEntry({ id: "o1", itemType: "image_view" }),
      workEntry({ id: "o2", itemType: "image_generation" }),
    ]);
    expect(summary?.label).toBe("Called tools");
  });

  it("skips excluded entries while summarizing the rest", () => {
    const summary = summarizeToolCallGroup([
      command("c1"),
      command("c2"),
      workEntry({ id: "err", tone: "error" }),
      workEntry({ id: "sub", subagents: [{ threadId: "thread-1" }] }),
    ]);
    expect(summary?.label).toBe("Ran commands");
    expect(summary?.entryCount).toBe(2);
  });
});

describe("Codex desktop group header wording", () => {
  it("lists parts without counts and capitalizes only the first part", () => {
    const summary = summarizeToolCallGroup([
      command("c1"),
      edit("e1", ["a.ts"]),
      command("r1", "cat src/app.ts"),
      edit("e2", ["b.ts"]),
      command("r2", "cat src/main.ts"),
      command("c2", "bun run lint"),
    ]);
    expect(summary?.label).toBe("Edited files, read files, ran commands");
  });

  it("uses singular phrases for one unit", () => {
    const summary = summarizeToolCallGroup([
      edit("e1", ["Sidebar.tsx"]),
      edit("e2", ["Sidebar.tsx"]),
      command("c1"),
    ]);
    expect(summary?.label).toBe("Edited a file, ran a command");
  });

  it("keeps web searches apart from code searches", () => {
    const summary = summarizeToolCallGroup([
      command("s1", 'rg -n "alpha" src'),
      workEntry({ id: "w1", itemType: "web_search" }),
    ]);
    expect(summary?.label).toBe("Searched files, searched the web");
  });

  it("merges tool and uncategorized calls into one tool part", () => {
    const summary = summarizeToolCallGroup([
      workEntry({ id: "m1", itemType: "mcp_tool_call" }),
      workEntry({ id: "o1", itemType: "image_view" }),
      command("c1"),
    ]);
    expect(summary?.label).toBe("Called tools, ran a command");
  });

  it("falls back to Worked when there are no parts", () => {
    expect(formatToolCallGroupLabel([])).toBe("Worked");
  });

  it("labels a multi-file edit without a count", () => {
    expect(multiFileEditLabel(edit("e1", ["a.ts", "b.ts", "c.ts"]))).toBe("Edited files");
    expect(multiFileEditLabel(edit("e2", ["a.ts"]))).toBeNull();
  });
});
