import type { CloudTaskId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  classifyClaudeCloudStderr,
  parseClaudeFollowUpReceipt,
  parseClaudeSessionReference,
  parseClaudeVersion,
} from "./claudeCloudCli.ts";
import {
  classifyCodexApplyOutput,
  decodeCloudTaskId,
  isCodexNoDiffStderr,
  isCodexNotFoundStderr,
  parseCodexCloudSubcommands,
  parseCodexExecOutput,
  parseCodexListJson,
  parseCodexStatusText,
  parseCodexVersion,
} from "./codexCloudCli.ts";
import { toCloudCliSpawnError } from "./CloudCliRunner.ts";
import {
  CLAUDE_PRINT_CLOUD_DISABLED_STDERR,
  CLAUDE_SESSION_ID,
  CODEX_CLOUD_HELP_STDOUT,
  CODEX_EXEC_STDOUT,
  CODEX_NO_DIFF_STDERR,
  CODEX_NOT_FOUND_STDERR,
  CODEX_TASK_ID,
  claudeFollowUpReceipt,
  codexListJson,
  codexStatusStdout,
} from "./testing/fakeCloudCli.ts";

function taskId(value: string): CloudTaskId {
  const decoded = decodeCloudTaskId(value);
  if (!decoded) throw new Error(`invalid test task id ${value}`);
  return decoded;
}

const ANSI_GREEN = "\u001b[32m";
const ANSI_RESET = "\u001b[0m";

describe("codex cloud exec output", () => {
  it("reads the task id from the single URL line", () => {
    expect(parseCodexExecOutput(CODEX_EXEC_STDOUT)).toEqual({
      taskId: CODEX_TASK_ID,
      url: `https://chatgpt.com/codex/tasks/${CODEX_TASK_ID}`,
    });
  });

  it("ignores ANSI color and surrounding whitespace", () => {
    expect(
      parseCodexExecOutput(`\r\n  ${ANSI_GREEN}${CODEX_EXEC_STDOUT.trim()}${ANSI_RESET}  \r\n`)
        ?.taskId,
    ).toBe(CODEX_TASK_ID);
  });

  it.each([
    ["no URL", "Task submitted\n"],
    ["two task URLs", `${CODEX_EXEC_STDOUT}${CODEX_EXEC_STDOUT}`],
    ["another host", `https://example.com/codex/tasks/${CODEX_TASK_ID}\n`],
    ["an id that starts with a dash", "https://chatgpt.com/codex/tasks/-rf\n"],
    ["an id with a nested path", `https://chatgpt.com/codex/tasks/${CODEX_TASK_ID}/extra\n`],
  ])("rejects output with %s", (_label, stdout) => {
    expect(parseCodexExecOutput(stdout)).toBeNull();
  });
});

describe("codex cloud status text", () => {
  it("reads a pending status (the CLI exits 1 for it)", () => {
    expect(parseCodexStatusText(codexStatusStdout("PENDING"))).toEqual({
      rawStatus: "PENDING",
      status: "pending",
      title: "Say hello",
      environmentLabel: "synara-sandbox",
      reportsNoDiff: true,
    });
  });

  it.each([
    ["READY", "ready"],
    ["APPLIED", "ready"],
    ["ERROR", "error"],
    ["CANCELLED", "cancelled"],
    ["SOMETHING_NEW", "unknown"],
  ] as const)("maps [%s] to %s", (token, status) => {
    expect(parseCodexStatusText(codexStatusStdout(token))?.status).toBe(status);
  });

  it("strips ANSI color before it reads the token", () => {
    const colored = `${ANSI_GREEN}[READY]${ANSI_RESET} Say hello\nsynara-sandbox  •  1m ago\n`;
    expect(parseCodexStatusText(colored)?.status).toBe("ready");
  });

  it("returns null when the output has no status token", () => {
    expect(parseCodexStatusText("")).toBeNull();
    expect(parseCodexStatusText("Error: something broke\n")).toBeNull();
  });
});

describe("codex cloud list --json", () => {
  it("reads the empty list", () => {
    expect(parseCodexListJson('{"tasks": [], "cursor": null}')).toEqual({
      ok: true,
      page: { tasks: [], cursor: null },
    });
  });

  it("maps the recorded task shape", () => {
    const parsed = parseCodexListJson(codexListJson([{ status: "ready", filesChanged: 2 }], "c2"));
    expect(parsed).toEqual({
      ok: true,
      page: {
        cursor: "c2",
        tasks: [
          {
            provider: "codex",
            id: CODEX_TASK_ID,
            url: `https://chatgpt.com/codex/tasks/${CODEX_TASK_ID}`,
            title: "Say hello",
            status: "ready",
            rawStatus: "ready",
            updatedAt: "2026-10-11T18:04:12.123456789Z",
            environmentId: null,
            environmentLabel: "synara-sandbox",
            diffSummary: { filesChanged: 2, linesAdded: 6, linesRemoved: 2 },
            attemptTotal: 1,
            isReview: false,
          },
        ],
      },
    });
  });

  it("derives the task URL from the validated id instead of trusting the listed URL", () => {
    const listed = JSON.stringify({
      tasks: [{ id: CODEX_TASK_ID, url: "https://evil.example/phish", status: "ready" }],
      cursor: null,
    });
    const parsed = parseCodexListJson(listed);
    expect(parsed.ok && parsed.page.tasks[0]?.url).toBe(
      `https://chatgpt.com/codex/tasks/${CODEX_TASK_ID}`,
    );
  });

  it("keeps an unknown status as unknown instead of failing", () => {
    const parsed = parseCodexListJson(codexListJson([{ status: "teleported" }]));
    expect(parsed.ok && parsed.page.tasks[0]?.status).toBe("unknown");
  });

  it("rejects malformed JSON and unsafe task ids", () => {
    expect(parseCodexListJson("not json").ok).toBe(false);
    expect(parseCodexListJson('{"cursor": null}').ok).toBe(false);
    expect(parseCodexListJson(codexListJson([{ id: "--force", status: "ready" }])).ok).toBe(false);
  });
});

describe("codex cloud errors and help", () => {
  it("recognizes the 404 bad-id stderr", () => {
    expect(isCodexNotFoundStderr(CODEX_NOT_FOUND_STDERR)).toBe(true);
    expect(isCodexNotFoundStderr("Error: network unreachable")).toBe(false);
  });

  it("recognizes the no-diff stderr", () => {
    expect(isCodexNoDiffStderr(CODEX_NO_DIFF_STDERR)).toBe(true);
    expect(isCodexNoDiffStderr(CODEX_NOT_FOUND_STDERR)).toBe(false);
  });

  it("reads subcommands only from the Commands section", () => {
    expect([...parseCodexCloudSubcommands(CODEX_CLOUD_HELP_STDOUT)].toSorted()).toEqual([
      "apply",
      "diff",
      "exec",
      "list",
      "status",
    ]);
    expect(parseCodexCloudSubcommands("Options:\n  list  not a command\n").size).toBe(0);
  });

  it("reads the CLI versions", () => {
    expect(parseCodexVersion("codex-cli 0.162.1\n")).toBe("0.162.1");
    expect(parseClaudeVersion("2.1.296 (Claude Code)\n")).toBe("2.1.296");
    expect(parseCodexVersion("unknown")).toBeNull();
  });

  it("classifies apply results", () => {
    expect(classifyCodexApplyOutput({ exitCode: 0, stdout: "applied", stderr: "" })).toBe(
      "applied",
    );
    expect(
      classifyCodexApplyOutput({ exitCode: 1, stdout: "", stderr: "Partial apply: 1 conflict" }),
    ).toBe("partial");
    expect(
      classifyCodexApplyOutput({ exitCode: 1, stdout: "", stderr: "error: patch failed" }),
    ).toBe("failed");
  });

  it("rejects task ids that a CLI could read as a flag", () => {
    expect(decodeCloudTaskId("-h")).toBeNull();
    expect(decodeCloudTaskId("task e")).toBeNull();
    expect(decodeCloudTaskId(CODEX_TASK_ID)).toBe(CODEX_TASK_ID);
  });
});

describe("cloud CLI spawn errors", () => {
  it("never copies process arguments such as the prompt into the error detail", () => {
    const failure = toCloudCliSpawnError(
      "/fake/bin/codex",
      new Error("Failed to run codex cloud exec -- SECRET PROMPT: EACCES"),
    );
    expect(failure.executableMissing).toBe(false);
    expect(failure.detail).not.toContain("SECRET");
  });

  it("still recognizes a missing executable", () => {
    const failure = toCloudCliSpawnError("codex", new Error("Command not found: codex"));
    expect(failure.executableMissing).toBe(true);
  });
});

describe("claude cloud CLI output", () => {
  it("classifies the recorded `-p --cloud` refusal as interactive-only", () => {
    expect(classifyClaudeCloudStderr(CLAUDE_PRINT_CLOUD_DISABLED_STDERR)).toBe("interactive-only");
    expect(classifyClaudeCloudStderr("Error: session not found")).toBe("not-found");
    expect(classifyClaudeCloudStderr("Error: rate limited")).toBe("other");
  });

  it.each([
    [CLAUDE_SESSION_ID, CLAUDE_SESSION_ID],
    [`https://claude.ai/code/${CLAUDE_SESSION_ID}`, CLAUDE_SESSION_ID],
    [`https://claude.ai/code/${CLAUDE_SESSION_ID}?tab=diff`, CLAUDE_SESSION_ID],
    [`https://evil.example/code/${CLAUDE_SESSION_ID}`, null],
    [`http://claude.ai/code/${CLAUDE_SESSION_ID}`, null],
    ["--dangerously-skip-permissions", null],
    ["", null],
  ])("parses session reference %j", (reference, expected) => {
    expect(parseClaudeSessionReference(reference)).toBe(expected);
  });

  it("reads the follow-up receipt", () => {
    expect(parseClaudeFollowUpReceipt(claudeFollowUpReceipt(), taskId(CLAUDE_SESSION_ID))).toEqual({
      ok: true,
      sessionId: CLAUDE_SESSION_ID,
      url: `https://claude.ai/code/${CLAUDE_SESSION_ID}`,
    });
  });

  it("drops a receipt URL that does not point at the same Claude session", () => {
    const sessionId = taskId(CLAUDE_SESSION_ID);
    const foreignUrl = JSON.stringify({
      ok: true,
      session_id: CLAUDE_SESSION_ID,
      url: "https://evil.example/phish",
    });
    expect(parseClaudeFollowUpReceipt(foreignUrl, sessionId)).toEqual({
      ok: true,
      sessionId,
      url: null,
    });
  });

  it("rejects a receipt that is not ok, names another session, or is not JSON", () => {
    const sessionId = taskId(CLAUDE_SESSION_ID);
    expect(parseClaudeFollowUpReceipt('{"ok":false,"error":"denied"}', sessionId)).toEqual({
      ok: false,
      detail: "denied",
    });
    expect(parseClaudeFollowUpReceipt(claudeFollowUpReceipt("session_other"), sessionId).ok).toBe(
      false,
    );
    expect(parseClaudeFollowUpReceipt("Queued.", sessionId).ok).toBe(false);
  });
});
