# Cloud agents SDK

Status: SDK layer only. It is not registered in the server runtime, it has no RPC, and it has no UI.

Cloud agents run on the provider's hosted infrastructure. Synara drives them only through the official,
unmodified CLIs:

| Provider    | CLI                                       | Supported operations                                        |
| ----------- | ----------------------------------------- | ----------------------------------------------------------- |
| Codex Cloud | `codex cloud exec/list/status/diff/apply` | Submit, list, status, diff, apply (Legacy environments)     |
| Claude Code | `claude -p "<msg>" --cloud <session-id>`  | Follow-up to an existing session. Start is interactive-only |

Rules that the SDK enforces:

- No private vendor HTTP API. No reads of OAuth tokens, Keychain, `~/.codex/auth.json`, or `~/.claude`
  credentials. Auth is whatever the CLI already has.
- Every process goes through `runProcess` (`apps/server/src/processRunner.ts`), which uses the shared
  `spawnProcess` boundary. Timeouts and Effect interruption kill the process tree.
- The executable is resolved once with `resolveExecutable` and pinned in the capabilities.
- Every command runs from a Synara-owned scratch directory, because the Codex CLI writes a cwd-relative
  `error.log` and defaults `--branch` to the cwd's branch. Apply is the only exception: it runs in the
  worktree that the caller names.
- CLI output is untrusted. IDs must match `^[A-Za-z0-9][A-Za-z0-9_-]*$`, so an ID cannot be read as a flag.
  Prompts and messages go after `--`. Error details are ANSI-stripped and capped at 600 characters.
- The child environment comes from `buildProviderChildEnvironment`, with `NO_COLOR=1`. Codex children lose
  `CODEX_STARTING_DIFF`. Claude children lose `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and
  `CLAUDE_CODE_OAUTH_TOKEN`, because cloud sessions need the stored claude.ai login.

## Code map

| File                                                                    | Purpose                                               |
| ----------------------------------------------------------------------- | ----------------------------------------------------- |
| `packages/contracts/src/cloudAgents.ts`                                 | Schemas and typed errors. No runtime.                 |
| `apps/server/src/cloudAgents/CloudAgents.ts`                            | `CloudAgents` service, config, `makeCloudAgentsLayer` |
| `apps/server/src/cloudAgents/CloudCliRunner.ts`                         | Runner seam over `runProcess`; tests swap in a fake   |
| `apps/server/src/cloudAgents/codexCloudDriver.ts`, `codexCloudCli.ts`   | Codex driver and pure output parsers                  |
| `apps/server/src/cloudAgents/claudeCloudDriver.ts`, `claudeCloudCli.ts` | Claude driver and pure output parsers                 |
| `apps/server/src/cloudAgents/cloudSubmitGuard.ts`                       | Submit idempotency by Synara request ID               |
| `apps/server/src/cloudAgents/cloudTaskPolling.ts`                       | Status polling `Stream` with backoff                  |
| `apps/server/src/cloudAgents/testing/fakeCloudCli.ts`                   | Fake runner and recorded CLI output shapes            |

## API

```ts
const cloud = yield* CloudAgents;

cloud.capabilities(provider)        // Effect<CloudCapabilities>, cached
cloud.refreshCapabilities(provider) // probe again
cloud.listEnvironments("codex")     // configured ids/labels + labels seen in `list --json`
cloud.submit({ provider, requestId, environment, prompt, branch, attempts? })
cloud.listTasks({ provider, environment?, limit?, cursor? })
cloud.listAllTasks({ provider, environment?, maxPages? })
cloud.getTask({ provider, taskId })   // list --json first, status as fallback
cloud.status({ provider, taskId })    // status command only
cloud.diff({ provider, taskId, attempt? })
cloud.apply({ provider, taskId, attempt?, worktreePath })
cloud.sendFollowUp({ provider, sessionReference, message })
cloud.watchTask({ provider, taskId, intervalMs?, maxIntervalMs?, ... }) // Stream<CloudTaskStatusChange>
```

Errors are the `CloudAgentError` union: `CloudCliUnavailableError`, `CloudOperationUnsupportedError`
(`interactive-only`, `no-cli-command`, `capability-missing`), `CloudInvalidInputError`,
`CloudTaskNotFoundError`, `CloudNoDiffError` (`no-changes`, `not-ready`, `unavailable`),
`CloudCliFailedError`, `CloudCliTimeoutError`, `CloudOutputParseError`, `CloudSubmitUncertainError`, and
`CloudSubmitInFlightError`.

Build the layer with `makeCloudAgentsLayer({ scratchDir, codex: { binaryPath, environments }, claude: {
binaryPath } })` and provide `CloudCliRunnerLive`.

## Behavior

| Case                              | Behavior                                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capabilities, Codex               | `--version` must be at least 0.162.0 (the tested version). `cloud --help` gives the subcommands, `cloud list --help` must list `--json`, `cloud exec --help` must list `--branch`.                |
| Capabilities, Claude              | `--version` and `--help` (must list `--cloud`). `canSubmit` is always false.                                                                                                                      |
| Submit, Codex                     | `cloud exec --env E --branch B --attempts N -- <prompt>`. `branch` is required. The task ID comes from the single `https://chatgpt.com/codex/tasks/<id>` line.                                    |
| Submit, same `requestId`          | Returns the stored receipt or failure. It never runs `exec` twice.                                                                                                                                |
| Submit timeout, interrupt, no URL | `CloudSubmitUncertainError`. Later calls with the same ID get the same error. No automatic retry.                                                                                                 |
| Submit while running              | `CloudSubmitInFlightError`.                                                                                                                                                                       |
| Submit, Claude                    | `CloudOperationUnsupportedError` (`interactive-only`). No process starts.                                                                                                                         |
| Status                            | Parses `[TOKEN] title` from stdout before the exit code: exit 1 + `[PENDING]` is a pending task. Then a 404 on stderr is `CloudTaskNotFoundError`.                                                |
| List and status disagree          | `getTask` uses `list --json`. `status` can lag by one poll.                                                                                                                                       |
| Diff                              | Reads the task first. Pending gives `not-ready`, ready with `files_changed == 0` gives `no-changes`. No `diff` process starts in either case.                                                     |
| Apply                             | Needs an absolute `worktreePath` that is a worktree root and clean (`git status --porcelain` empty, untracked files included). Exit 1 returns `partial` or `failed`, not an error.                |
| Follow-up, Claude                 | `--print --cloud <id> --output-format json -- <message>`. Reads `{ok, session_id, url}`. The `--cloud cannot be combined with --print` text maps to `interactive-only`.                           |
| Polling                           | First poll at once, then every 20 s (±10 % jitter). Errors double the delay up to 5 min. It stops at `ready`, `error`, or `cancelled`. It fails at once on not-found and after 5 errors in a row. |

## Tests

```sh
cd apps/server
bun run test src/cloudAgents
SYNARA_CLOUD_LIVE=1 SYNARA_CLOUD_CODEX_BIN=/opt/homebrew/bin/codex bun run test src/cloudAgents/CloudAgents.live.test.ts
```

The live test is opt-in and read-only. It runs the capability probes (`--version`, `--help`) and
`codex cloud list --json --limit 5`. It never submits or applies.

## Not verified live

- The Codex prompt after `--`. P0 proved a positional prompt; `--` is standard clap behavior.
- The Claude follow-up receipt shape and the `--` separator. No session ID was available in P0.
- Codex `error`, `cancelled`, multi-attempt, and changes-present outputs, and every `apply` output.

## Next phases

1. **Provider registration (P1).** Add `provider-cloud` to `BETA_ONLY_FEATURES`, refuse every cloud RPC on
   Stable on the server, and only then register `makeCloudAgentsLayer` in the server graph. Derive
   `scratchDir` from `ServerConfig.stateDir` and `binaryPath` from the provider settings. Persist the submit
   guard (a request record written before `exec`) so that a restart cannot double-submit.
2. **UI thread type.** Add the `provider-cloud` execution owner to threads, the Inbox "Cloud" view, the
   attach-by-URL action, the sidebar badge, and the status line. Feed status from `watchTask`, with one
   shared `list --json` loop per account.
3. **Apply-to-worktree flow (P2).** Save the `diff` bytes with a SHA-256, create a clean Synara-owned
   worktree, run `git apply --check` and `git apply --3way` on the saved patch through the Git boundary,
   record an import journal, then start a new local thread. `apply` in this SDK is the CLI fallback for a
   worktree that the caller already prepared.
