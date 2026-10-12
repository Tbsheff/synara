import { Effect } from "effect";

import {
  CloudCliSpawnError,
  type CloudCliInvocation,
  type CloudCliOutput,
  type CloudCliRunnerShape,
} from "../CloudCliRunner.ts";

export const CODEX_TASK_ID = "task_e_0123456789abcdef0123456789abcdef";
export const CODEX_OTHER_TASK_ID = "task_e_fedcba9876543210fedcba9876543210";
export const CODEX_ENV_ID = "0123456789abcdef0123456789abcdef";
export const CODEX_ENV_LABEL = "synara-sandbox";
export const CLAUDE_SESSION_ID = "session_011CUabcdEFGHijklMNOPqrs";

export const CODEX_VERSION_STDOUT = "codex-cli 0.162.1\n";

export const CODEX_CLOUD_HELP_STDOUT = `[EXPERIMENTAL] Browse tasks from Codex Cloud and apply changes locally

Usage: codex cloud [OPTIONS] [COMMAND]

Commands:
  exec    Submit a new Codex Cloud task without launching the TUI
  status  Show the status of a Codex Cloud task
  list    List Codex Cloud tasks
  apply   Apply the diff for a Codex Cloud task locally
  diff    Show the unified diff for a Codex Cloud task
  help    Print this message or the help of the given subcommand(s)

Options:
  -c, --config <key=value>
          Override a configuration value that would otherwise be loaded from \`~/.codex/config.toml\`.

  -h, --help
          Print help (see a summary with '-h')
`;

export const CODEX_CLOUD_LIST_HELP_STDOUT = `List Codex Cloud tasks

Usage: codex cloud list [OPTIONS]

Options:
      --env <ENV_ID>
          Filter tasks by environment identifier
      --limit <N>
          Maximum number of tasks to return (1-20)
      --cursor <CURSOR>
          Pagination cursor returned by a previous call
      --json
          Emit JSON instead of plain text
`;

export const CODEX_CLOUD_EXEC_HELP_STDOUT = `Submit a new Codex Cloud task without launching the TUI

Usage: codex cloud exec [OPTIONS] --env <ENV_ID> [QUERY]

Options:
      --env <ENV_ID>
          Target environment identifier (see \`codex cloud\` to browse)
      --attempts <ATTEMPTS>
          Number of assistant attempts (best-of-N)
      --branch <BRANCH>
          Git branch to run in Codex Cloud (defaults to current branch)
`;

export const CODEX_EXEC_STDOUT = `https://chatgpt.com/codex/tasks/${CODEX_TASK_ID}\n`;

export const CODEX_NOT_FOUND_STDERR = `Error: http error: get_task_details failed: GET https://chatgpt.com/backend-api/wham/tasks/task_e_bogus failed: 404 Not Found; content-type=application/json; body={"detail":"Invalid task ID"}\n`;

export const CODEX_NO_DIFF_STDERR = `Error: No diff available for task ${CODEX_TASK_ID}; it may still be running.\n`;

export const codexStatusStdout = (token: string, title = "Say hello") =>
  `[${token}] ${title}\n${CODEX_ENV_LABEL}  •  2m ago\nno diff\n`;

export interface FakeListTask {
  readonly id?: string;
  readonly status: string;
  readonly filesChanged?: number;
  readonly environmentLabel?: string;
  readonly title?: string;
}

export const codexListJson = (tasks: ReadonlyArray<FakeListTask>, cursor: string | null = null) =>
  JSON.stringify({
    tasks: tasks.map((task) => ({
      id: task.id ?? CODEX_TASK_ID,
      url: `https://chatgpt.com/codex/tasks/${task.id ?? CODEX_TASK_ID}`,
      title: task.title ?? "Say hello",
      status: task.status,
      updated_at: "2026-10-11T18:04:12.123456789Z",
      environment_id: null,
      environment_label: task.environmentLabel ?? CODEX_ENV_LABEL,
      summary: {
        files_changed: task.filesChanged ?? 0,
        lines_added: (task.filesChanged ?? 0) * 3,
        lines_removed: task.filesChanged ?? 0,
      },
      is_review: false,
      attempt_total: 1,
    })),
    cursor,
  });

export const CODEX_SAMPLE_PATCH = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 hello
+world
`;

export const CLAUDE_VERSION_STDOUT = "2.1.296 (Claude Code)\n";

export const CLAUDE_HELP_STDOUT = `Usage: claude [options] [command] [prompt]

Options:
  --cloud [description|session_id|url]  Create a cloud session with the given
                                        description, or attach to an existing
                                        one by session ID or claude.ai/code URL
  --environment <environment_id>        Create a new cloud session that runs on
                                        the given self-hosted environment
  --output-format <format>              Output format (only works with --print):
                                        "text" (default), "json" (single
                                        result), or "stream-json" (realtime
                                        streaming)
  -p, --print                           Print response and exit
  --teleport [session]                  Resume a teleport session
`;

export const CLAUDE_PRINT_CLOUD_DISABLED_STDERR =
  'Error: --cloud cannot be combined with --print.\nStarting a new cloud session with --cloud is interactive only: drop --print, or drop --cloud to run locally. To message an existing cloud session instead, pass its ID: `claude -p "message" --cloud <session-id>` (find IDs at claude.ai/code).\n';

export const claudeFollowUpReceipt = (sessionId = CLAUDE_SESSION_ID) =>
  JSON.stringify({ ok: true, session_id: sessionId, url: `https://claude.ai/code/${sessionId}` });

export type FakeCloudCliResponse =
  | {
      readonly stdout?: string;
      readonly stderr?: string;
      readonly exitCode?: number | null;
      readonly timedOut?: boolean;
    }
  | "missing"
  | "hang";

export interface FakeCloudCliRoute {
  readonly match: (invocation: CloudCliInvocation) => boolean;
  readonly responses: ReadonlyArray<FakeCloudCliResponse>;
}

export const argsEqual =
  (...expected: ReadonlyArray<string>) =>
  (invocation: CloudCliInvocation) =>
    invocation.args.length === expected.length &&
    expected.every((value, index) => invocation.args[index] === value);

export const argsStartWith =
  (...expected: ReadonlyArray<string>) =>
  (invocation: CloudCliInvocation) =>
    expected.every((value, index) => invocation.args[index] === value);

export const route = (
  match: FakeCloudCliRoute["match"],
  ...responses: ReadonlyArray<FakeCloudCliResponse>
): FakeCloudCliRoute => ({ match, responses });

export const CODEX_PROBE_ROUTES: ReadonlyArray<FakeCloudCliRoute> = [
  route(argsEqual("--version"), { stdout: CODEX_VERSION_STDOUT }),
  route(argsEqual("cloud", "--help"), { stdout: CODEX_CLOUD_HELP_STDOUT }),
  route(argsEqual("cloud", "list", "--help"), { stdout: CODEX_CLOUD_LIST_HELP_STDOUT }),
  route(argsEqual("cloud", "exec", "--help"), { stdout: CODEX_CLOUD_EXEC_HELP_STDOUT }),
];

export const CLAUDE_PROBE_ROUTES: ReadonlyArray<FakeCloudCliRoute> = [
  route(argsEqual("--version"), { stdout: CLAUDE_VERSION_STDOUT }),
  route(argsEqual("--help"), { stdout: CLAUDE_HELP_STDOUT }),
];

export interface FakeCloudCli {
  readonly runner: CloudCliRunnerShape;
  readonly calls: ReadonlyArray<CloudCliInvocation>;
  readonly callsMatching: (match: FakeCloudCliRoute["match"]) => ReadonlyArray<CloudCliInvocation>;
}

function toOutput(response: Exclude<FakeCloudCliResponse, "missing" | "hang">): CloudCliOutput {
  return {
    stdout: response.stdout ?? "",
    stderr: response.stderr ?? "",
    exitCode: response.exitCode === undefined ? 0 : response.exitCode,
    timedOut: response.timedOut ?? false,
  };
}

export function makeFakeCloudCli(routes: ReadonlyArray<FakeCloudCliRoute>): FakeCloudCli {
  const calls: CloudCliInvocation[] = [];
  const hits = new Map<FakeCloudCliRoute, number>();
  const runner: CloudCliRunnerShape = {
    run: (invocation) =>
      Effect.suspend(() => {
        calls.push(invocation);
        const matched = routes.find((candidate) => candidate.match(invocation));
        if (!matched) {
          return Effect.die(new Error(`Unexpected CLI call: ${invocation.args.join(" ")}`));
        }
        const hitIndex = hits.get(matched) ?? 0;
        hits.set(matched, hitIndex + 1);
        const response = matched.responses[Math.min(hitIndex, matched.responses.length - 1)]!;
        if (response === "missing") {
          return Effect.fail(
            new CloudCliSpawnError({
              executable: invocation.executable,
              executableMissing: true,
              detail: `Command not found: ${invocation.executable}`,
            }),
          );
        }
        if (response === "hang") return Effect.never;
        return Effect.succeed(toOutput(response));
      }),
  };
  return {
    runner,
    calls,
    callsMatching: (match) => calls.filter(match),
  };
}
