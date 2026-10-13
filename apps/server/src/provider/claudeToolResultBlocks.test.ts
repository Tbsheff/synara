import {
  TRANSCRIPT_FILE_DIFF_MAX_CHARS,
  TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS,
  TRANSCRIPT_TOOL_ARGUMENTS_MAX_CHARS,
} from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect, FileSystem, PlatformError } from "effect";
import { describe, expect, it } from "vitest";

import {
  CLAUDE_TOOL_RESULT_IMAGE_MAX_BYTES,
  CLAUDE_TOOL_RESULT_MAX_IMAGES,
  CLAUDE_TOOL_RESULT_MAX_OMITTED_IMAGES,
  CLAUDE_TURN_IMAGE_MAX_BYTES,
  CLAUDE_TURN_IMAGE_MAX_COUNT,
  buildClaudeServerToolResultDetails,
  buildClaudeProposedFileChanges,
  buildClaudeToolResultDetails,
  buildClaudeToolStartDetails,
  capHead,
  capTail,
  capToolArguments,
  makeClaudeToolResultImageBudget,
  writeClaudeToolResultImageFile,
  type ClaudeToolIdentity,
  type ClaudeToolResultImageWriter,
} from "./claudeToolResultBlocks.ts";

const run = <A>(effect: Effect.Effect<A>) => Effect.runSync(effect);

const isWellFormed = (text: string | undefined) =>
  text !== undefined &&
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text);

const png = (data: string) => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data },
});

const bash: ClaudeToolIdentity = {
  toolName: "Bash",
  itemType: "command_execution",
  input: { command: "npm test", description: "Run tests", run_in_background: false },
};

describe("buildClaudeProposedFileChanges", () => {
  async function preview(original: string, toolName: string, input: Record<string, unknown>) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "synara-proposed-diff-"));
    writeFileSync(path.join(directory, "file.txt"), original);
    try {
      return await Effect.runPromise(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          return yield* buildClaudeProposedFileChanges(
            fileSystem,
            toolName,
            { file_path: "file.txt", notebook_path: "file.txt", ...input },
            directory,
          );
        }).pipe(Effect.provide(NodeServices.layer)),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("previews every replace_all match and sequential MultiEdit changes", async () => {
    const details = await preview("old\nold\n", "MultiEdit", {
      edits: [
        { old_string: "old", new_string: "step", replace_all: true },
        { old_string: "step", new_string: "done", replace_all: true },
      ],
    });
    expect(details?.changes[0]).toMatchObject({ additions: 2, deletions: 2 });
    expect(details?.changes[0]?.unifiedDiff).toContain("-old\n-old\n+done\n+done");
  });

  it("shows a newline-only change without inventing unchanged edits", async () => {
    const details = await preview("same", "Write", { content: "same\n" });
    expect(details?.changes[0]?.unifiedDiff).toContain(
      "-same\n\\ No newline at end of file\n+same",
    );
  });

  it("keeps changed lines visible after a long unchanged prefix", async () => {
    const details = await preview("same\n".repeat(100) + "old\n", "Edit", {
      old_string: "old",
      new_string: "new",
    });
    expect(details?.changes[0]?.unifiedDiff).toContain("@@ -98,4 +98,4 @@");
    expect(details?.changes[0]?.unifiedDiff).toContain("-old\n+new");
    expect(details?.changes[0]?.additions).toBe(1);
  });

  it("marks ambiguous matches and oversized files as unavailable previews", async () => {
    for (const original of ["old\nold\n", "old" + "x".repeat(1024 * 1024)]) {
      const details = await preview(original, "Edit", { old_string: "old", new_string: "new" });
      expect(details?.changes[0]).toEqual({
        path: "file.txt",
        kind: "update",
        diffTruncated: true,
      });
    }
  });

  it("caps proposed content without splitting an emoji", async () => {
    const details = await preview("old\n", "Write", {
      content: "😀".repeat(TRANSCRIPT_FILE_DIFF_MAX_CHARS),
    });
    const change = details?.changes[0];
    expect(change?.diffTruncated).toBe(true);
    expect(change?.unifiedDiff?.length).toBeLessThanOrEqual(TRANSCRIPT_FILE_DIFF_MAX_CHARS);
    expect(isWellFormed(change?.unifiedDiff)).toBe(true);
  });

  it("shows a partial notebook cell preview", async () => {
    const details = await preview(
      JSON.stringify({ cells: [{ id: "cell-1", source: ["old\n"] }] }),
      "NotebookEdit",
      { cell_id: "cell-1", new_source: "new\n" },
    );
    expect(details?.changes[0]?.unifiedDiff).toContain("-old\n+new");
    expect(details?.changes[0]?.diffTruncated).toBe(true);
  });

  it("keeps unreadable files from blocking approval and omits non-edit previews", () => {
    const fileSystem = FileSystem.makeNoop({
      stat: () =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "stat",
          }),
        ),
    });
    expect(
      run(
        buildClaudeProposedFileChanges(
          fileSystem,
          "Write",
          { file_path: "file.txt", content: "new" },
          "/tmp",
        ),
      ),
    ).toEqual({
      changes: [{ path: "file.txt", kind: "update", diffTruncated: true }],
      totalFiles: 1,
    });
    expect(
      run(
        buildClaudeProposedFileChanges(fileSystem, "Bash", { command: "touch file.txt" }, "/tmp"),
      ),
    ).toBeUndefined();
  });
});

describe("buildClaudeToolStartDetails", () => {
  it("sends Bash command details at start", () => {
    expect(buildClaudeToolStartDetails(bash)).toEqual({
      toolName: "Bash",
      toolCall: { toolName: "Bash", arguments: bash.input },
      command: { command: "npm test", description: "Run tests" },
    });
  });

  it("sends WebSearch query and domains", () => {
    const details = buildClaudeToolStartDetails({
      toolName: "WebSearch",
      itemType: "web_search",
      input: { query: "effect schema", allowed_domains: ["effect.website"] },
    });
    expect(details.webSearch).toEqual({
      query: "effect schema",
      action: { type: "search", query: "effect schema" },
      allowedDomains: ["effect.website"],
    });
  });

  it("caps large arguments as a truncated string", () => {
    const capped = capToolArguments({ content: "x".repeat(TRANSCRIPT_TOOL_ARGUMENTS_MAX_CHARS) });
    expect(capped.argumentsTruncated).toBe(true);
    expect((capped.arguments as string).length).toBe(TRANSCRIPT_TOOL_ARGUMENTS_MAX_CHARS);
  });
});

describe("buildClaudeToolResultDetails", () => {
  it("splits Bash stdout and stderr and keeps interrupted/background flags", () => {
    const details = run(
      buildClaudeToolResultDetails(
        {
          tool: bash,
          content: [{ type: "text", text: "ok\nwarn" }],
          text: "ok\nwarn",
          isError: false,
          structuredResult: {
            stdout: "ok",
            stderr: "warn",
            interrupted: false,
            backgroundTaskId: "bg-1",
          },
        },
        undefined,
      ),
    );
    expect(details.command).toEqual({
      command: "npm test",
      description: "Run tests",
      stdout: "ok",
      stderr: "warn",
      outputTotalChars: 6,
      interrupted: false,
      background: true,
    });
    expect(details.toolCall.resultText).toBeUndefined();
    expect(details.toolCall.success).toBe(true);
  });

  it("parses the exit code a failed Bash result states and keeps the output tail", () => {
    const body = "y".repeat(TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS + 5);
    const text = `Exit code 2\n${body}`;
    const details = run(
      buildClaudeToolResultDetails(
        { tool: bash, content: text, text, isError: true, structuredResult: undefined },
        undefined,
      ),
    );
    expect(details.command?.exitCode).toBe(2);
    expect(details.command?.outputTruncated).toBe(true);
    expect(details.command?.output?.length).toBe(TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS);
    expect(details.command?.outputTotalChars).toBe(body.length);
    expect(details.toolCall.success).toBe(false);
  });

  it("removes the leading exit code line from the output", () => {
    const failed = (text: string) =>
      run(
        buildClaudeToolResultDetails(
          { tool: bash, content: text, text, isError: true, structuredResult: undefined },
          undefined,
        ),
      ).command;
    expect(failed("Exit code 2\nls: x: No such file")).toMatchObject({
      exitCode: 2,
      output: "ls: x: No such file",
    });
    expect(failed("Exit code 1")).toMatchObject({ exitCode: 1 });
    expect(failed("Exit code 1")?.output).toBeUndefined();
  });

  it("leaves a mid-output exit code line alone", () => {
    const text = "building\nExit code 3\ndone";
    const command = run(
      buildClaudeToolResultDetails(
        { tool: bash, content: text, text, isError: true, structuredResult: undefined },
        undefined,
      ),
    ).command;
    expect(command?.exitCode).toBeUndefined();
    expect(command?.output).toBe(text);
  });

  it("converts an Edit structuredPatch into a per-file unified diff", () => {
    const details = run(
      buildClaudeToolResultDetails(
        {
          tool: {
            toolName: "Edit",
            itemType: "file_change",
            input: { file_path: "/repo/a.ts", old_string: "a", new_string: "b" },
          },
          content: "The file /repo/a.ts has been updated.",
          text: "The file /repo/a.ts has been updated.",
          isError: false,
          structuredResult: {
            filePath: "/repo/a.ts",
            originalFile: "const a = 1;\n",
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 2,
                lines: ["-const a = 1;", "+const b = 1;", "+const c = 2;"],
              },
            ],
          },
        },
        undefined,
      ),
    );
    expect(details.fileChanges).toEqual({
      changes: [
        {
          path: "/repo/a.ts",
          kind: "update",
          unifiedDiff:
            "--- /repo/a.ts\n+++ /repo/a.ts\n@@ -1,1 +1,2 @@\n-const a = 1;\n+const b = 1;\n+const c = 2;",
          additions: 2,
          deletions: 1,
        },
      ],
      totalFiles: 1,
    });
  });

  it("marks a Write with a null originalFile as an added file", () => {
    const details = run(
      buildClaudeToolResultDetails(
        {
          tool: {
            toolName: "Write",
            itemType: "file_change",
            input: { file_path: "/repo/new.ts" },
          },
          content: "File created",
          text: "File created",
          isError: false,
          structuredResult: {
            type: "create",
            filePath: "/repo/new.ts",
            content: "one\ntwo\n",
            originalFile: null,
            structuredPatch: [],
          },
        },
        undefined,
      ),
    );
    expect(details.fileChanges?.changes[0]).toEqual({
      path: "/repo/new.ts",
      kind: "add",
      unifiedDiff: "--- /dev/null\n+++ /repo/new.ts\n@@ -0,0 +1,2 @@\n+one\n+two",
      additions: 2,
      deletions: 0,
    });
  });

  it("writes image blocks through the writer and omits images over the cap", () => {
    const writes: Array<string> = [];
    const writer: ClaudeToolResultImageWriter = (input) =>
      Effect.sync(() => {
        writes.push(input.mediaType);
        return {
          source: "file" as const,
          path: "thread-1-abc.png",
          mediaType: input.mediaType,
          byteLength: input.byteLength,
        };
      });
    const overCap = "A".repeat(Math.ceil(((CLAUDE_TOOL_RESULT_IMAGE_MAX_BYTES + 4) * 4) / 3));
    const details = run(
      buildClaudeToolResultDetails(
        {
          tool: { toolName: "Read", itemType: "dynamic_tool_call", input: { file_path: "/a.png" } },
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "iVBORw==" },
            },
            { type: "image", source: { type: "base64", media_type: "image/png", data: overCap } },
            {
              type: "image",
              source: { type: "base64", media_type: "image/svg+xml", data: "PHN2Zz4=" },
            },
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf" },
              title: "Spec",
            },
            { type: "search_result", source: "https://example.com", title: "Example", content: [] },
            { type: "tool_reference", tool_name: "mcp__github__get_issue" },
          ],
          text: "",
          isError: false,
          structuredResult: undefined,
        },
        writer,
      ),
    );
    expect(writes).toEqual(["image/png"]);
    expect(details.toolCall.images).toEqual([
      { source: "file", path: "thread-1-abc.png", mediaType: "image/png", byteLength: 4 },
      {
        source: "omitted",
        reason: "too-large",
        mediaType: "image/png",
        byteLength: expect.any(Number),
      },
      {
        source: "omitted",
        reason: "unsupported-media-type",
        mediaType: "image/svg+xml",
        byteLength: 5,
      },
    ]);
    expect(details.toolCall.otherBlocks).toEqual([
      { blockType: "document", title: "Spec", mediaType: "application/pdf" },
      { blockType: "search_result", title: "Example", uri: "https://example.com" },
      { blockType: "tool_reference", title: "mcp__github__get_issue" },
    ]);
    expect(JSON.stringify(details)).not.toContain(overCap.slice(0, 64));
  });

  it("sends an omitted ref when no image writer is available or the write fails", () => {
    const content = [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw==" } },
    ];
    const tool: ClaudeToolIdentity = {
      toolName: "mcp__browser__screenshot",
      itemType: "mcp_tool_call",
      input: {},
      mcpServer: "browser",
    };
    const missing = run(
      buildClaudeToolResultDetails(
        { tool, content, text: "", isError: false, structuredResult: undefined },
        undefined,
      ),
    );
    expect(missing.toolCall.images).toEqual([
      { source: "omitted", reason: "storage-unavailable", mediaType: "image/png", byteLength: 4 },
    ]);
    const failed = run(
      buildClaudeToolResultDetails(
        { tool, content, text: "", isError: false, structuredResult: undefined },
        () => Effect.die(new Error("disk full")),
      ),
    );
    expect(failed.toolCall.images?.[0]).toMatchObject({
      source: "omitted",
      reason: "write-failed",
    });
    expect(failed.toolCall.server).toBe("browser");
  });

  it("carries result text and errors for generic tools", () => {
    const tool: ClaudeToolIdentity = {
      toolName: "Grep",
      itemType: "dynamic_tool_call",
      input: { pattern: "foo" },
    };
    const ok = run(
      buildClaudeToolResultDetails(
        { tool, content: "a.ts\nb.ts", text: "a.ts\nb.ts", isError: false, structuredResult: {} },
        undefined,
      ),
    );
    expect(ok.toolCall).toEqual({
      toolName: "Grep",
      arguments: { pattern: "foo" },
      success: true,
      resultText: "a.ts\nb.ts",
    });
    const failed = run(
      buildClaudeToolResultDetails(
        { tool, content: "bad regex", text: "bad regex", isError: true, structuredResult: {} },
        undefined,
      ),
    );
    expect(failed.toolCall.error).toBe("bad regex");
    expect(failed.toolCall.resultText).toBeUndefined();
  });

  it("reads WebSearch results from the structured result", () => {
    const details = run(
      buildClaudeToolResultDetails(
        {
          tool: { toolName: "WebSearch", itemType: "web_search", input: { query: "synara" } },
          content: "results",
          text: "results",
          isError: false,
          structuredResult: {
            query: "synara",
            results: [
              { tool_use_id: "srv-1", content: [{ title: "Synara", url: "https://synara.dev" }] },
              "summary text",
            ],
          },
        },
        undefined,
      ),
    );
    expect(details.webSearch?.results).toEqual([{ url: "https://synara.dev", title: "Synara" }]);
  });
});

describe("buildClaudeServerToolResultDetails", () => {
  it("completes an advisor call with the advisor answer", () => {
    const result = buildClaudeServerToolResultDetails(
      { toolName: "advisor", itemType: "dynamic_tool_call", input: {}, serverToolKind: "advisor" },
      {
        type: "advisor_tool_result",
        tool_use_id: "srvtoolu_1",
        content: { type: "advisor_result", text: "Ship it.", stop_reason: "end_turn" },
      },
    );
    expect(result.isError).toBe(false);
    expect(result.details.toolCall).toEqual({
      toolName: "advisor",
      serverToolKind: "advisor",
      success: true,
      resultText: "Ship it.",
    });
  });

  it("maps web search results and errors", () => {
    const tool: ClaudeToolIdentity = {
      toolName: "web_search",
      itemType: "web_search",
      input: { query: "effect" },
      serverToolKind: "web_search",
    };
    const ok = buildClaudeServerToolResultDetails(tool, {
      type: "web_search_tool_result",
      tool_use_id: "srv",
      content: [
        {
          type: "web_search_result",
          url: "https://effect.website",
          title: "Effect",
          encrypted_content: "x",
        },
      ],
    });
    expect(ok.details.webSearch?.results).toEqual([
      { url: "https://effect.website", title: "Effect" },
    ]);
    const failed = buildClaudeServerToolResultDetails(tool, {
      type: "web_search_tool_result",
      tool_use_id: "srv",
      content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
    });
    expect(failed.isError).toBe(true);
    expect(failed.details.webSearch?.error).toBe("max_uses_exceeded");
  });

  it("maps code execution output to command details", () => {
    const result = buildClaudeServerToolResultDetails(
      {
        toolName: "bash_code_execution",
        itemType: "command_execution",
        input: { command: "ls" },
        serverToolKind: "bash_code_execution",
      },
      {
        type: "bash_code_execution_tool_result",
        tool_use_id: "srv",
        content: {
          type: "bash_code_execution_result",
          stdout: "a.txt",
          stderr: "",
          return_code: 0,
          content: [{ type: "bash_code_execution_output", file_id: "file_1" }],
        },
      },
    );
    expect(result.details.command).toEqual({
      command: "ls",
      stdout: "a.txt",
      stderr: "",
      exitCode: 0,
    });
    expect(result.details.toolCall.otherBlocks).toEqual([
      { blockType: "bash_code_execution_output", title: "file_1" },
    ]);
  });

  it("maps MCP connector results and errors", () => {
    const tool: ClaudeToolIdentity = {
      toolName: "search",
      itemType: "mcp_tool_call",
      input: {},
      serverToolKind: "mcp",
      mcpServer: "docs",
    };
    const ok = buildClaudeServerToolResultDetails(tool, {
      type: "mcp_tool_result",
      tool_use_id: "mcptoolu",
      is_error: false,
      content: [{ type: "text", text: "found" }],
    });
    expect(ok.details.toolCall).toMatchObject({
      server: "docs",
      resultText: "found",
      success: true,
    });
    const failed = buildClaudeServerToolResultDetails(tool, {
      type: "mcp_tool_result",
      tool_use_id: "mcptoolu",
      is_error: true,
      content: "denied",
    });
    expect(failed.isError).toBe(true);
    expect(failed.details.toolCall.error).toBe("denied");
  });

  it("lists tool search references", () => {
    const result = buildClaudeServerToolResultDetails(
      {
        toolName: "tool_search_tool_regex",
        itemType: "dynamic_tool_call",
        input: { query: "github" },
        serverToolKind: "tool_search",
      },
      {
        type: "tool_search_tool_result",
        tool_use_id: "srv",
        content: {
          type: "tool_search_tool_search_result",
          tool_references: [{ type: "tool_reference", tool_name: "mcp__github__get_issue" }],
        },
      },
    );
    expect(result.details.toolCall.resultText).toBe("mcp__github__get_issue");
  });
});

describe("Claude command output shape", () => {
  it("sends the combined text as output when the split is empty", () => {
    const text = "Command running in background with ID: bash_1";
    const details = run(
      buildClaudeToolResultDetails(
        {
          tool: { ...bash, input: { command: "npm run dev", run_in_background: true } },
          content: text,
          text,
          isError: false,
          structuredResult: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "b" },
        },
        undefined,
      ),
    );
    expect(details.command).toEqual({
      command: "npm run dev",
      background: true,
      output: text,
      outputTotalChars: text.length,
      interrupted: false,
    });
  });

  it("never sends output next to a stdout/stderr split", () => {
    const details = run(
      buildClaudeToolResultDetails(
        {
          tool: bash,
          content: "only out",
          text: "only out",
          isError: false,
          structuredResult: { stdout: "only out", stderr: "" },
        },
        undefined,
      ),
    );
    expect(details.command?.output).toBeUndefined();
    expect(details.command?.stdout).toBe("only out");
    expect(details.command?.stderr).toBeUndefined();
    expect(details.command?.outputTotalChars).toBe(8);
  });

  it("sets durationMs on the command and the tool call", () => {
    const details = run(
      buildClaudeToolResultDetails(
        {
          tool: bash,
          content: "ok",
          text: "ok",
          isError: false,
          structuredResult: { stdout: "ok", stderr: "" },
          durationMs: 1500,
        },
        undefined,
      ),
    );
    expect(details.command?.durationMs).toBe(1500);
    expect(details.toolCall.durationMs).toBe(1500);
    const invalid = run(
      buildClaudeToolResultDetails(
        {
          tool: bash,
          content: "ok",
          text: "ok",
          isError: false,
          structuredResult: undefined,
          durationMs: -1,
        },
        undefined,
      ),
    );
    expect(invalid.command?.durationMs).toBeUndefined();
  });
});

describe("Claude shell session tools", () => {
  it("gives PowerShell the Bash command details", () => {
    const details = buildClaudeToolStartDetails({
      toolName: "PowerShell",
      itemType: "command_execution",
      input: { command: "Get-ChildItem", description: "List files", run_in_background: true },
    });
    expect(details.command).toEqual({
      command: "Get-ChildItem",
      description: "List files",
      background: true,
    });
  });

  it("labels BashOutput and KillShell by shell id without a fake command", () => {
    const start = (toolName: string, input: Record<string, unknown>) =>
      buildClaudeToolStartDetails({ toolName, itemType: "command_execution", input }).command;
    expect(start("BashOutput", { bash_id: "bash_1" })).toEqual({
      description: "Read output of shell bash_1",
    });
    expect(start("KillShell", { shell_id: "bash_1" })).toEqual({
      description: "Stop shell bash_1",
    });
    expect(start("BashOutput", {})).toEqual({ description: "Read shell output" });
    expect(start("KillShell", { shell_id: 42 })).toEqual({ description: "Stop shell" });
  });

  it("reads the BashOutput result split, command, and exit code", () => {
    const details = run(
      buildClaudeToolResultDetails(
        {
          tool: { toolName: "BashOutput", itemType: "command_execution", input: { bash_id: "b1" } },
          content: "<stdout>done</stdout>",
          text: "<stdout>done</stdout>",
          isError: false,
          structuredResult: {
            shellId: "b1",
            command: "npm run build",
            status: "completed",
            exitCode: 0,
            stdout: "done",
            stderr: "",
          },
        },
        undefined,
      ),
    );
    expect(details.command).toEqual({
      description: "Read output of shell b1",
      command: "npm run build",
      stdout: "done",
      outputTotalChars: 4,
      exitCode: 0,
    });
  });

  it("does not crash on a KillShell result without structured data", () => {
    const details = run(
      buildClaudeToolResultDetails(
        {
          tool: { toolName: "KillShell", itemType: "command_execution", input: {} },
          content: "Shell killed",
          text: "Shell killed",
          isError: false,
          structuredResult: "Shell killed",
        },
        undefined,
      ),
    );
    expect(details.command).toEqual({
      description: "Stop shell",
      output: "Shell killed",
      outputTotalChars: 12,
    });
  });
});

describe("surrogate-safe caps", () => {
  const emoji = "\u{1F600}";

  it("does not cut an emoji in half at the head cut", () => {
    const text = `ab${emoji}cd`;
    const capped = capHead(text, 3);
    expect(capped).toEqual({ text: "ab", truncated: true });
    expect(isWellFormed(capped.text)).toBe(true);
  });

  it("does not cut an emoji in half at the tail cut", () => {
    const text = `ab${emoji}cd`;
    const capped = capTail(text, 3);
    expect(capped).toEqual({ text: "cd", truncated: true });
    expect(isWellFormed(capped.text)).toBe(true);
    expect(capTail(text, 4)).toEqual({ text: `${emoji}cd`, truncated: true });
  });

  it("keeps capped tool arguments well formed", () => {
    const padding = "x".repeat(TRANSCRIPT_TOOL_ARGUMENTS_MAX_CHARS);
    for (let shift = 0; shift < 4; shift += 1) {
      const capped = capToolArguments({
        content: `${"y".repeat(shift)}${emoji.repeat(4000)}${padding}`,
      });
      const text = capped.arguments as string;
      expect(text.length).toBeLessThanOrEqual(TRANSCRIPT_TOOL_ARGUMENTS_MAX_CHARS);
      expect(isWellFormed(text)).toBe(true);
    }
  });

  it("keeps a capped command output tail well formed", () => {
    const text = `${emoji}${"z".repeat(TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS - 1)}`;
    const details = run(
      buildClaudeToolResultDetails(
        { tool: bash, content: text, text, isError: false, structuredResult: undefined },
        undefined,
      ),
    );
    expect(isWellFormed(details.command?.output)).toBe(true);
    expect(details.command?.outputTruncated).toBe(true);
  });
});

describe("Claude tool-result image budget", () => {
  const okWriter: ClaudeToolResultImageWriter = (input) =>
    Effect.succeed({
      source: "file" as const,
      path: "img.png",
      mediaType: input.mediaType,
      byteLength: input.byteLength,
    });
  const tool: ClaudeToolIdentity = {
    toolName: "mcp__browser__screenshot",
    itemType: "mcp_tool_call",
    input: {},
  };
  const resultImages = (
    content: ReadonlyArray<unknown>,
    budget: ReturnType<typeof makeClaudeToolResultImageBudget>,
    writer: ClaudeToolResultImageWriter = okWriter,
  ) =>
    run(
      buildClaudeToolResultDetails(
        {
          tool,
          content,
          text: "",
          isError: false,
          structuredResult: undefined,
          imageBudget: budget,
        },
        writer,
      ),
    ).toolCall.images ?? [];

  it("uses named per-turn limits by default", () => {
    expect(makeClaudeToolResultImageBudget()).toEqual({
      maxBytes: CLAUDE_TURN_IMAGE_MAX_BYTES,
      maxCount: CLAUDE_TURN_IMAGE_MAX_COUNT,
      usedBytes: 0,
      usedCount: 0,
    });
    expect(CLAUDE_TURN_IMAGE_MAX_BYTES).toBe(50 * 1024 * 1024);
  });

  it("omits images past the per-turn count across tool results", () => {
    const budget = makeClaudeToolResultImageBudget({ maxCount: 2 });
    expect(resultImages([png("iVBORw==")], budget).map((image) => image.source)).toEqual(["file"]);
    expect(resultImages([png("iVBORw=="), png("iVBORw==")], budget)).toEqual([
      { source: "file", path: "img.png", mediaType: "image/png", byteLength: 4 },
      { source: "omitted", reason: "turn-image-limit", mediaType: "image/png", byteLength: 4 },
    ]);
    expect(budget.usedCount).toBe(2);
  });

  it("omits images past the per-turn byte budget", () => {
    const budget = makeClaudeToolResultImageBudget({ maxBytes: 10 });
    const images = resultImages([png("iVBORw=="), png("iVBORw=="), png("iVBORw==")], budget);
    expect(images.map((image) => image.source === "omitted" && image.reason)).toEqual([
      false,
      false,
      "turn-byte-limit",
    ]);
    expect(budget.usedBytes).toBe(8);
  });

  it("gives budget back when a write fails", () => {
    const budget = makeClaudeToolResultImageBudget({ maxCount: 1 });
    const failed = resultImages([png("iVBORw==")], budget, () => Effect.succeed(undefined));
    expect(failed[0]).toMatchObject({ source: "omitted", reason: "write-failed" });
    expect(budget).toMatchObject({ usedBytes: 0, usedCount: 0 });
    expect(resultImages([png("iVBORw==")], budget)[0]?.source).toBe("file");
  });

  it("caps the omitted refs kept per result", () => {
    const budget = makeClaudeToolResultImageBudget({ maxCount: 0 });
    const content = Array.from({ length: CLAUDE_TOOL_RESULT_MAX_IMAGES * 3 }, () =>
      png("iVBORw=="),
    );
    const images = resultImages(content, budget);
    expect(images).toHaveLength(CLAUDE_TOOL_RESULT_MAX_OMITTED_IMAGES);
    expect(images.every((image) => image.source === "omitted")).toBe(true);
  });
});

describe("writeClaudeToolResultImageFile", () => {
  it("removes the partial file when the write fails", async () => {
    const removed: Array<string> = [];
    const fileSystem = FileSystem.makeNoop({
      makeDirectory: () => Effect.void,
      writeFile: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "Unknown",
            module: "FileSystem",
            method: "writeFile",
            pathOrDescriptor: path,
            description: "disk full",
          }),
        ),
      remove: (path) =>
        Effect.sync(() => {
          removed.push(path);
        }),
    });
    const exit = await Effect.runPromiseExit(
      writeClaudeToolResultImageFile(fileSystem, {
        directory: "/attachments",
        filePath: "/attachments/a.png",
        bytes: new Uint8Array([1, 2, 3]),
      }),
    );
    expect(exit._tag).toBe("Failure");
    expect(removed).toEqual(["/attachments/a.png"]);
  });

  it("keeps the file when the write succeeds", async () => {
    const removed: Array<string> = [];
    const fileSystem = FileSystem.makeNoop({
      makeDirectory: () => Effect.void,
      writeFile: () => Effect.void,
      remove: (path) =>
        Effect.sync(() => {
          removed.push(path);
        }),
    });
    await Effect.runPromise(
      writeClaudeToolResultImageFile(fileSystem, {
        directory: "/attachments",
        filePath: "/attachments/a.png",
        bytes: new Uint8Array([1]),
      }),
    );
    expect(removed).toEqual([]);
  });
});
