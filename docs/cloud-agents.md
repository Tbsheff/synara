# Cloud agents

Status: Beta only (`provider-cloud` in `BETA_ONLY_FEATURES`). The SDK is registered in the Beta server, it
has `cloud.*` WebSocket RPCs, a `cloud_submissions` table, and a Cloud page in the web app. Stable builds no
cloud layer and refuses every `cloud.*` RPC.

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

| File                                                                    | Purpose                                                   |
| ----------------------------------------------------------------------- | --------------------------------------------------------- |
| `packages/contracts/src/cloudAgents.ts`                                 | Schemas and typed errors. No runtime.                     |
| `apps/server/src/cloudAgents/CloudAgents.ts`                            | `CloudAgents` service, config, `makeCloudAgentsLayer`     |
| `apps/server/src/cloudAgents/CloudCliRunner.ts`                         | Runner seam over `runProcess`; tests swap in a fake       |
| `apps/server/src/cloudAgents/codexCloudDriver.ts`, `codexCloudCli.ts`   | Codex driver and pure output parsers                      |
| `apps/server/src/cloudAgents/claudeCloudDriver.ts`, `claudeCloudCli.ts` | Claude driver and pure output parsers                     |
| `apps/server/src/cloudAgents/cloudSubmitGuard.ts`                       | Submit idempotency by Synara request ID                   |
| `apps/server/src/cloudAgents/cloudTaskPolling.ts`                       | Status polling `Stream` with backoff                      |
| `apps/server/src/cloudAgents/testing/fakeCloudCli.ts`                   | Fake runner and recorded CLI output shapes                |
| `apps/server/src/cloudAgents/CloudAgentsGateway.ts`                     | RPC-shaped service: lazy SDK, durable submit, apply guard |
| `apps/server/src/cloudAgents/cloudBinaryResolution.ts`                  | Codex/Claude binary choice                                |
| `apps/server/src/cloudAgents/cloudAgentsServerLayer.ts`                 | Beta gate for the server layer                            |
| `apps/server/src/cloudAgents/wsCloudHandlers.ts`                        | RPC handlers, Stable refusal, error codes                 |
| `apps/server/src/persistence/Layers/CloudSubmissionRepository.ts`       | `cloud_submissions` table (migration 134)                 |

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

## Server integration (P1)

### Beta gate

| Layer  | Stable behavior                                                                                          |
| ------ | -------------------------------------------------------------------------------------------------------- |
| Server | `makeCloudAgentsServerLayer` returns `Layer.empty`: no scratch directory, no probe, no restart sweep.    |
| RPC    | Every `cloud.*` method fails with `WsRpcError { code: "CLOUD_AGENTS_UNAVAILABLE" }` before any CLI call. |
| Web    | `CLOUD_ON` hides the rail entry; the `/cloud` route redirects to `/`.                                    |
| Data   | `cloud_submissions` exists on Stable after migration 134 but nothing reads or writes it.                 |

### RPCs (`CLOUD_AGENTS_WS_METHODS`, `WsCloudAgentsRpcGroup`)

| Method                   | Result                          | Notes                                                                                           |
| ------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `cloud.getCapabilities`  | `CloudCapabilities`             | `refresh: true` resolves the binary again and probes again.                                     |
| `cloud.listEnvironments` | `{ environments }`              | Configured IDs plus labels seen in `list --json`. The CLI has no environment list.              |
| `cloud.listTasks`        | `CloudTaskPage`                 | `limit` 1–20, `cursor` passed through unchanged.                                                |
| `cloud.getTask`          | `CloudTask`                     | Also records `last_status` for a task that Synara submitted.                                    |
| `cloud.submit`           | `CloudSubmission`               | Resolves with `submitted`, `uncertain`, or `failed`. Rejects only on preflight errors.          |
| `cloud.listSubmissions`  | `{ submissions }`               | Newest first, optional `projectId`, up to 500.                                                  |
| `cloud.getDiff`          | `CloudGetDiffResult`            | Capped at 4 MiB on a line boundary, with `truncated`.                                           |
| `cloud.applyToWorktree`  | `CloudApplyResult`              | Path must be inside `ServerConfig.worktreesDir` (realpath). Then the SDK checks root and clean. |
| `cloud.sendFollowUp`     | `CloudFollowUpReceipt`          | Claude only.                                                                                    |
| `cloud.watchTask`        | stream of `CloudWatchTaskEvent` | `status` items, or one `error` item; then idles until the client unsubscribes.                  |

Errors: a cloud error becomes `WsRpcError` with `code` set to its tag (for example `CloudNoDiffError`). The
watch stream never fails for a cloud error and never completes, because the web transport reconnects the
socket for a failed or completed subscription. `CLOUD_AGENTS_UNAVAILABLE` is in the transport's
stream-admission list, so a Stable refusal does not reconnect.

### Submit durability (`cloud_submissions`, migration 134)

One row per `(provider, request_id)`: project, environment, branch, a 280-character prompt summary,
`state`, task ID and URL, last seen status, error detail, timestamps.

| Case                                        | Behavior                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| New request ID                              | Insert `submitting`, then run `exec` in a service-scoped fiber.          |
| Same ID while running                       | Joins the same fiber. `exec` runs once.                                  |
| Same ID after it settled                    | Returns the stored row. `exec` does not run again.                       |
| Preflight refusal (input, CLI, unsupported) | Row deleted, error returned, same ID can retry.                          |
| CLI failure                                 | `failed` with the error text.                                            |
| Timeout, interrupt, no URL                  | `uncertain`.                                                             |
| Server restart with a `submitting` row      | Beta startup marks it `uncertain`; a resubmit with that ID returns it.   |
| Client closes the tab                       | The submit keeps running; it is owned by the service scope, not the RPC. |

A simple repository table was chosen over orchestration events and projections: nothing else consumes
these records, a cloud task is not a thread yet (that is the "UI thread type" phase), and the table is
additive and inert on Stable.

### Codex binary

`getCapabilities` and the first cloud call pick the binary (never at startup):

1. `SYNARA_CLOUD_CODEX_BIN`, if set, is the only candidate.
2. Else, in order: `providers.codex.binaryPath`, `codex` on `PATH`, `/opt/homebrew/bin/codex`,
   `/usr/local/bin/codex`, `~/.local/bin/codex`, `~/.bun/bin/codex` (the last four only off Windows).
3. Each candidate gets `--version` through `CloudCliRunner`. The first one at or above
   `CODEX_CLOUD_MINIMUM_CLI_VERSION` (0.162.0) wins. If none qualifies, the first readable one is kept, so
   capabilities report `unavailableKind: "too-old"` with its path and version.

Claude uses `SYNARA_CLOUD_CLAUDE_BIN`, then `providers.claudeAgent.binaryPath`. A settings change is seen on
the next call; `refresh: true` forces a rebuild.

### Web (Beta only)

| Piece             | Where                                                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry point       | "Cloud" rail item (`appRail.logic.ts`, `cloudAvailable = CLOUD_ON`), route `/cloud`.                                                                           |
| Page              | `components/cloud/CloudView.tsx`: Codex / Claude picker, capability alert, list, detail.                                                                       |
| List              | `listSubmissions` merged with `listTasks` pages, de-duplicated by task ID; "Load more".                                                                        |
| Status            | `getTask` polling while the task is not terminal. `watchTask` is wired in `wsNativeApi` but the page does not use it yet.                                      |
| Submit            | `CloudSubmitDialog` (Codex): environment, branch (required), prompt, attempts. The request ID is made once per dialog.                                         |
| Diff              | `CloudTaskDiff` through the shared `PatchDiffBody` (extracted from the PR Code tab).                                                                           |
| Apply             | `CloudApplyDialog`: choose a managed worktree of the project or create one with `git.createDetachedWorktree`, then confirm. Shows applied, partial, or failed. |
| Claude            | Start note (terminal or claude.ai/code) and a follow-up form for a pasted session ID or URL.                                                                   |
| Too-old Codex CLI | Alert with path, version, the minimum, and `SYNARA_CLOUD_CODEX_BIN`; "Check again" refreshes.                                                                  |

## Tests

```sh
cd apps/server
bun run test src/cloudAgents
SYNARA_CLOUD_LIVE=1 SYNARA_CLOUD_CODEX_BIN=/opt/homebrew/bin/codex bun run test src/cloudAgents/CloudAgents.live.test.ts
```

The live test is opt-in and read-only. It runs the capability probes (`--version`, `--help`),
`codex cloud list --json --limit 5`, and the binary auto-detection (`--version` only). It never submits or
applies. Without `SYNARA_CLOUD_CODEX_BIN`, the list case fails on a machine whose `PATH` finds an older
`codex` first; the auto-detection case still passes, which is the point of it.

## Not verified live

- The Codex prompt after `--`. P0 proved a positional prompt; `--` is standard clap behavior.
- The Claude follow-up receipt shape and the `--` separator. No session ID was available in P0.
- Codex `error`, `cancelled`, multi-attempt, and changes-present outputs, and every `apply` output.
- The P1 server and web slice against a running Synara Beta. Tests use a fake CLI runner and a mocked
  native API; only `codex cloud list --json` and `--version`/`--help` probes ran live.
- `codex cloud apply` can write a cwd-relative `error.log` into the chosen worktree.
- Apply checks that the path is inside the Synara worktrees directory, not that it belongs to the task's
  repository.

## Next phases

1. **Provider registration (P1).** Done. See [Server integration](#server-integration-p1).
2. **UI thread type.** Add the `provider-cloud` execution owner to threads, the Inbox "Cloud" view, the
   attach-by-URL action, the sidebar badge, and the status line. Feed status from `watchTask`, with one
   shared `list --json` loop per account.
3. **Apply-to-worktree flow (P2).** Save the `diff` bytes with a SHA-256, create a clean Synara-owned
   worktree, run `git apply --check` and `git apply --3way` on the saved patch through the Git boundary,
   record an import journal, then start a new local thread. `apply` in this SDK is the CLI fallback for a
   worktree that the caller already prepared.
