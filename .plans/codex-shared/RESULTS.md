# Shared Codex process results

One compatible account process now hosts many Synara threads. Five warm threads used one app-server instead of five. Their total measured physical footprint fell by 42.0%. The installed Codex still starts external stdio MCP clients per native thread, so the one-MCP-process-per-account goal remains unmet.

## Design

```text
Synara session A → native thread A ┐
Synara session B → native thread B ├→ compatible account app-server
Synara session C → native thread C ┘   → request ID / native thread ID router
                                      → original Synara session consumer
```

- Registry: SHA-256 of sorted effective environment, account/home and auth/config identity, resolved executable path/file identity/version, process arguments, extra skill root, priority and platform. Hashes do not expose credentials. Incompatible settings get separate processes.
- Process: account defaults, executable, environment, launch capabilities, priority and extra skill roots. The shared process starts in the account continuation home.
- Native thread/turn: cwd, model, effort, approval/sandbox policy, collaboration mode, developer instructions and caller-scoped Synara MCP authorization headers. The existing HTTP gateway stays shared; each native thread has a distinct token.
- Routing: one transport, unique client request IDs, native thread ownership for notifications and approvals, explicit native child routes and an account-notification allowlist. Unowned requests receive an error. Retired native IDs cannot move to another Synara identity within the process.
- Validation: a successful native open must return a thread ID. An invalid response fails the process so no unknown native lease can remain. Each new Synara session reads current account capabilities; a shared process does not cache a stale subscription tier.
- Stop: interrupt and unload only the owned native threads; verify unload before releasing the lease. Other sessions stay live. The last lease gets a one-second grace. Metadata discovery uses a compatible process lease with its existing idle timeout.
- Crash/account auth change: fail every hosted session as an error, retain the teardown barrier, and allow replacement only after verified process-tree exit. Each warm session still uses one of the existing bounded warm slots.
- Rollout: `codexAppServerMode` defaults to `shared`; `per-session` is the server fallback for the next session start. `codex-shared-process` is Beta-only because one routing or crash fault can affect several sessions. Stable always uses dedicated session processes and preserves the saved setting.

## Measurement

Measured on macOS arm64 with Codex CLI 0.162.1 and Bun 1.4.3. The isolated server used port 4093 and reserved web URL 6053; no web listener was needed for the RPC-driven measurement. Both modes used the same account copy, model `gpt-6.1-sol`, low effort, project, warm limit 5, and one fixed Python stdio MCP fixture. The account copy includes auth, but the harness never prints credentials. Source model/pricing policy was not changed.

The measurement used implementation commit `fc4edaae0`. Later commits add settings fixtures, crash-hook isolation, native-open validation and fresh account-capability reads. They preserve process grouping; their behavior has focused tests, but the complete memory benchmark was not repeated after those changes.

All homes are under `~/synara-builds/codex-shared/homes`. Production homes, applications and the running app were not used.

| Case | App-servers before → after | All provider processes before → after | Configured stdio MCP before → after | Footprint MiB before → after | RSS MiB before → after |
| --- | --- | --- | --- | --- | --- |
| 1 warm thread | 1 → 1 | 3 → 3 | 1 → 1 | 206.5 → 194.7 | 244.2 → 235.2 |
| 3 warm threads | 3 → 1 | 9 → 7 | 3 → 3 | 552.4 → 295.4 | 712.7 → 288.0 |
| 5 warm threads | 5 → 1 | 15 → 11 | 5 → 5 | 721.0 → 418.3 | 958.0 → 386.4 |
| 3 streaming / 5 open | 5 → 1 | 15 → 11 | 5 → 5 | 722.4 → 450.6 | 1145.7 → 371.4 |

Totals sum the owned Codex app-server trees, including native Node kernels and the configured stdio fixture. They exclude the Synara server, browser and test runner. `ps` reports RSS; `vmmap -summary` reports physical footprint, including compressed memory. These are sequential single samples, not controlled repeated benchmarks. Warm samples wait ten seconds after readiness; streaming samples require all three turns to be running with nonempty assistant output. All six measured turns completed. The initial harness attempts are excluded from the table.

An independent native protocol probe also started three MCP fixture children for three threads in one app-server. The [public Codex runtime](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/mcp_runtime.rs) owns thread/turn MCP runtimes. A shared Synara app-server cannot remove that duplication. Arbitrary stateful stdio transport pooling needs a separate upstream or server-specific isolation contract.

## Live lifecycle proof

- Stop one warm thread while its peer starts a turn: the peer completed on the same app-server PID.
- SIGKILL only the isolated shared app-server with two hosted threads: both sessions became errors with a clear transport failure.
- Send again: one replacement process resumed the surviving conversation and completed.
- All old process-tree members exited; after cleanup, no app-servers or fixture processes remained and isolated ports were free.

## Checks

- `bun run fmt:check`: pass.
- `bun run lint`: pass; no errors. Final warning count is recorded in the check log.
- `bun run typecheck`: pass across eight package tasks.
- `bun run windows-runtime:check`: pass across 313 app source files, 113 boundary files, five dependency patches and nine manifests.
- Affected server tests with `GIT_CONFIG_GLOBAL=/dev/null`: 545 passed, two skipped, 14 files.
- Updated web settings fixtures: 61 passed, two files.
- Requested warm-session browser files: seven passed, two files, isolated browser API port 51293.
- The broad workspace run stopped with SIGTERM when Synara closed. Scripts (255 tests), shared (1,036 tests; one skipped), and plugin SDK (15 tests) passed before shutdown.
- Web: 512 files passed; four failed and three skipped. Two failed assertions concern snoozed empty threads and done-today inbox entries; two suites fail because their React mock omits `forwardRef`. All four match the supplied warm-pool report and their test files are unchanged from the starting commit.
- Desktop: 1,423 tests passed; six skipped and one upload test failed. Its complete focused file passed on retry (11 tests). The interrupted server run also reported a checkpoint restore-interruption failure; its focused retry passed. Neither test was changed.
- The resumed full server suite was also interrupted at 23:43 UTC (exit 143). It reported four failures in two unchanged files before shutdown: two simulated-auth cleanup cases in `CodexTextGeneration.test.ts`, and two probe/replay cases in `AcpJsonRpcConnection.test.ts`. No complete server-suite totals are available.

The requested browser command was:

```sh
cd apps/web
VITEST_BROWSER_API_PORT=51293 ../../node_modules/.bin/vitest run --config vitest.browser.config.ts --root . src/components/chat/MessagesTimeline.warmSession.browser.tsx src/components/chat/useWarmProviderSession.browser.tsx
```

## Final two-file comparison

Only the two failing server files were rerun after the final interruption. Runs used separate disposable Synara homes, `GIT_CONFIG_GLOBAL=/dev/null`, the same Bun and locked dependencies, and no inherited `SYNARA_AUTH_TOKEN`. They ran in sequence. The `integrate/all` run used a detached checkout of its pinned commit, without changing the user's active checkout.

| Source | Tested commit | Result | Duration |
| --- | --- | --- | --- |
| `synara/share-codex-app-server` | `595edecbc` | Two files passed; 63 tests passed | 21.98 s |
| `integrate/all` | `a4800758e` | Two files passed; 63 tests passed | 19.42 s |

Both test files, their implementation files, and `bun.lock` are identical between these commits. The four earlier server failures did not reproduce on either branch. These retries establish no reproduced regression; they do not prove the failures' cause or establish that they are pre-existing. The interrupted broad runs remain incomplete and non-green.

The command in each checkout was:

```sh
env -u SYNARA_AUTH_TOKEN SYNARA_HOME=<isolated-test-home> GIT_CONFIG_GLOBAL=/dev/null bun run --cwd apps/server test src/git/Layers/CodexTextGeneration.test.ts src/provider/acp/AcpJsonRpcConnection.test.ts
```

Logs: `checks/feature-two-files.log`, `checks/integrate-two-files.log` and `checks/two-file-comparison.json` under `~/synara-builds/codex-shared`.

## Limits

The external MCP duplication goal is not met. Windows has source and boundary checks, but no packaged Windows run. Native account rotation, child-agent shutdown, and the 15-minute warm expiry have focused tests, not new long-running platform trials. Unknown or threadless private events cannot be routed and are dropped; unowned requests fail closed. A shared process crash affects every hosted thread. The dedicated fallback requires session stop/restart.

Raw evidence stays outside the repository in `~/synara-builds/codex-shared`: mode measurement JSON, `runtime-proof.json`, the native protocol fixture/probe, RPC harnesses and check logs.

## Local implementation commits

| Commit | Change |
| --- | --- |
| `7a8d950d5` | Design and native MCP limit |
| `44fcf15d5` | Process identity, routing registry and lifecycle tests |
| `6be977c27` | Manager integration, server fallback and Beta gate |
| `fc4edaae0` | Thread leases, credential renewal and shared metadata discovery |
| `102e8fec6` | Required server setting in web test fixtures |
| `9bd84bdc1` | Crash cleanup when a session callback throws |
| `a85fed3f5` | Native-open validation and fresh account capabilities |
| `595edecbc` | Saved measurements and live lifecycle proof |

No commits were pushed. No stash was used. Unrelated untracked plans remain untouched.
