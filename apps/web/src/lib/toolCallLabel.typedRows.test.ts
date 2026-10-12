import { describe, expect, it } from "vitest";

import {
  commandRowDisplayCommand,
  deriveCommandRowLabel,
  deriveReasoningRowLabel,
  deriveToolCallRowLabel,
  deriveWebSearchRowLabel,
  fileChangeRowVerb,
  formatCommandDuration,
  humanizeToolNameSentence,
  toolRowLabelText,
} from "./toolCallLabel";

function text(label: Parameters<typeof toolRowLabelText>[0]) {
  return toolRowLabelText(label);
}

describe("formatCommandDuration", () => {
  it.each([
    [undefined, null],
    [999, null],
    [1_000, "1s"],
    [12_400, "12s"],
    [125_000, "2m 5s"],
    [3_605_000, "1h 0m 5s"],
  ])("formats %s as %s", (ms, expected) => {
    expect(formatCommandDuration(ms)).toBe(expected);
  });
});

describe("deriveCommandRowLabel", () => {
  it("shows the raw command with its duration once finished", () => {
    expect(
      text(
        deriveCommandRowLabel({ command: "bun run test", status: "completed", durationMs: 12_000 }),
      ),
    ).toBe("Ran bun run test in 12s");
  });

  it("hides sub-second durations", () => {
    expect(
      text(deriveCommandRowLabel({ command: "ls", status: "completed", durationMs: 300 })),
    ).toBe("Ran ls");
  });

  it("uses running and stopped verbs", () => {
    expect(text(deriveCommandRowLabel({ command: "sleep 10", status: "running" }))).toBe(
      "Running sleep 10",
    );
    expect(
      text(
        deriveCommandRowLabel({
          command: "sleep 10",
          status: "completed",
          interrupted: true,
          durationMs: 4_000,
        }),
      ),
    ).toBe("Stopped sleep 10 after 4s");
  });

  it("unwraps shell wrappers and collapses whitespace", () => {
    expect(commandRowDisplayCommand("/bin/zsh -lc 'git status'")).toBe("git status");
    expect(commandRowDisplayCommand("cat <<EOF\nhello\nEOF")).toBe("cat <<EOF hello EOF");
  });

  it("reads parsed actions", () => {
    expect(
      text(
        deriveCommandRowLabel({
          command: "sed -n 1,20p src/app.ts",
          status: "completed",
          parsedActions: [{ type: "read", name: "app.ts", path: "src/app.ts" }],
        }),
      ),
    ).toBe("Read app.ts");
    expect(
      text(
        deriveCommandRowLabel({
          command: "rg foo src",
          status: "completed",
          parsedActions: [{ type: "search", query: "foo", path: "src" }],
        }),
      ),
    ).toBe("Searched for foo in src");
    expect(
      text(
        deriveCommandRowLabel({
          command: "ls src",
          status: "completed",
          parsedActions: [{ type: "list_files", path: "src" }],
        }),
      ),
    ).toBe("Listed files in src");
  });

  it("names a failed command by its raw text and leaves the duration to the outcome meta", () => {
    expect(
      text(
        deriveCommandRowLabel({
          command: "ls /nonexistent; echo done",
          status: "failed",
          durationMs: 4_000,
          parsedActions: [{ type: "list_files", path: "nonexistent" }],
        }),
      ),
    ).toBe("Ran ls /nonexistent; echo done");
  });

  it("treats a non-zero exit code as a failure even when the status says completed", () => {
    expect(
      text(
        deriveCommandRowLabel({
          command: "ls missing",
          status: "completed",
          exitCode: 2,
          durationMs: 3_000,
          parsedActions: [{ type: "list_files", path: "missing" }],
        }),
      ),
    ).toBe("Ran ls missing");
    expect(
      text(
        deriveCommandRowLabel({
          command: "ls src",
          status: "failed",
          exitCode: null,
          parsedActions: [{ type: "list_files", path: "src" }],
        }),
      ),
    ).toBe("Ran ls src");
    expect(
      text(
        deriveCommandRowLabel({
          command: "ls src",
          status: "completed",
          exitCode: 0,
          parsedActions: [{ type: "list_files", path: "src" }],
        }),
      ),
    ).toBe("Listed files in src");
  });

  it("labels description-only shell tools by their description", () => {
    expect(
      text(
        deriveCommandRowLabel({
          command: undefined,
          description: "read output of background shell bash_1",
          status: "completed",
        }),
      ),
    ).toBe("Read output of background shell bash_1");
  });

  it("falls back to the command when any parsed action is unknown", () => {
    expect(
      text(
        deriveCommandRowLabel({
          command: "cat a && make",
          status: "completed",
          parsedActions: [{ type: "read", path: "a" }, { type: "unknown" }],
        }),
      ),
    ).toBe("Ran cat a && make");
  });
});

describe("fileChangeRowVerb", () => {
  it.each([
    ["update", "completed", "Edited"],
    ["add", "completed", "Created"],
    ["delete", "completed", "Deleted"],
    ["update", "running", "Editing"],
    ["add", "cancelled", "Stopped creating"],
  ] as const)("%s/%s → %s", (kind, status, verb) => {
    expect(fileChangeRowVerb(kind, status)).toBe(verb);
  });
});

describe("deriveWebSearchRowLabel", () => {
  it("covers search, open page and find in page", () => {
    expect(text(deriveWebSearchRowLabel({ query: "effect schema" }, false))).toBe(
      "Searched the web for effect schema",
    );
    expect(text(deriveWebSearchRowLabel({ query: "effect schema" }, true))).toBe(
      "Searching the web for effect schema",
    );
    expect(
      text(deriveWebSearchRowLabel({ action: { type: "open_page", url: "https://a.dev" } }, false)),
    ).toBe("Opened https://a.dev");
    expect(
      text(
        deriveWebSearchRowLabel(
          { action: { type: "find_in_page", url: "https://a.dev", pattern: "install" } },
          false,
        ),
      ),
    ).toBe("Searched for 'install' in https://a.dev");
    expect(text(deriveWebSearchRowLabel({}, false))).toBe("Searched the web");
    expect(text(deriveWebSearchRowLabel({ queries: ["a", "b"] }, false))).toBe(
      "Searched the web for a …",
    );
  });
});

describe("deriveReasoningRowLabel", () => {
  it("uses the heading, the redacted marker, or a generic verb", () => {
    expect(text(deriveReasoningRowLabel({ heading: "**Planning the fix**" }, false))).toBe(
      "Planning the fix",
    );
    expect(text(deriveReasoningRowLabel({ redacted: true, heading: "x" }, false))).toBe(
      "Reasoning redacted",
    );
    expect(text(deriveReasoningRowLabel({}, true))).toBe("Thinking");
    expect(text(deriveReasoningRowLabel({ durationMs: 5_000 }, false))).toBe("Thought for 5s");
  });
});

describe("deriveToolCallRowLabel", () => {
  const completed = "completed" as const;
  it.each([
    ["Read", { file_path: "/repo/src/app.ts", offset: 10, limit: 20 }, "Read app.ts (lines 10-29)"],
    ["Read", { file_path: "/repo/doc.pdf", pages: "1-3" }, "Read doc.pdf (pages 1-3)"],
    ["Grep", { pattern: "useTheme", path: "src" }, "Searched for useTheme in src"],
    ["Glob", { pattern: "**/*.ts" }, "Searched for files **/*.ts"],
    ["WebFetch", { url: "https://effect.website", prompt: "x" }, "Fetched https://effect.website"],
    ["WebSearch", { query: "vitest browser" }, "Searched the web for vitest browser"],
    ["Skill", { skill: "verify" }, "Used verify skill"],
    ["ToolSearch", { query: "select:Read" }, "Searched tools for select:Read"],
    ["SendMessage", { to: "worker-1", message: "hi" }, "Sent message to worker-1"],
    ["LSP", { operation: "hover", filePath: "/repo/a.ts" }, "LSP hover a.ts"],
    [
      "Monitor",
      { description: "dev server logs", command: "tail -f" },
      "Monitored dev server logs",
    ],
    ["CronCreate", { cron: "0 9 * * *", prompt: "standup" }, "Scheduled 0 9 * * *: standup"],
    ["CronDelete", { id: "job-1" }, "Deleted schedule job-1"],
    ["ListAgents", {}, "Listed agents"],
    ["TaskOutput", { task_id: "t1" }, "Read output of t1"],
    ["TaskStop", { task_id: "t1" }, "Stopped t1"],
    ["EnterPlanMode", {}, "Entered plan mode"],
    ["ListMcpResourcesTool", { server: "linear" }, "Listed resources from linear"],
    ["ReadMcpResourceTool", { uri: "file:///a" }, "Read file:///a"],
  ])("%s", (toolName, args, expected) => {
    expect(text(deriveToolCallRowLabel({ toolName, arguments: args, status: completed })!)).toBe(
      expected,
    );
  });

  it("uses present tense while running", () => {
    expect(
      text(
        deriveToolCallRowLabel({
          toolName: "Read",
          arguments: { file_path: "a.ts" },
          status: "running",
        })!,
      ),
    ).toBe("Reading a.ts");
  });

  it("labels server tools by kind", () => {
    expect(
      text(
        deriveToolCallRowLabel({
          toolName: "advisor",
          serverToolKind: "advisor",
          status: completed,
        })!,
      ),
    ).toBe("Asked the advisor");
    expect(
      text(
        deriveToolCallRowLabel({
          toolName: "tool_search_tool_regex",
          serverToolKind: "tool_search",
          arguments: { query: "slack" },
          status: completed,
        })!,
      ),
    ).toBe("Searched tools for slack");
  });

  it("humanizes MCP tools in sentence case with the key argument", () => {
    expect(
      text(
        deriveToolCallRowLabel({
          toolName: "mcp__linear__search_issues",
          arguments: { query: "parity" },
          status: completed,
        })!,
      ),
    ).toBe("Search issues parity");
    expect(humanizeToolNameSentence("listPullRequests")).toBe("List pull requests");
  });

  it("matches tool names exactly", () => {
    expect(
      text(deriveToolCallRowLabel({ toolName: "ReadThing", arguments: {}, status: completed })!),
    ).toBe("Read thing");
  });

  it("accepts JSON string arguments", () => {
    expect(
      text(
        deriveToolCallRowLabel({
          toolName: "Grep",
          arguments: JSON.stringify({ pattern: "foo" }),
          status: completed,
        })!,
      ),
    ).toBe("Searched for foo");
  });

  it("returns null without a tool name", () => {
    expect(deriveToolCallRowLabel({ status: completed })).toBeNull();
  });
});
