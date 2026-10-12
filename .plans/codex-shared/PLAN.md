# Shared Codex app-server

## Goal and source constraint

One compatible app-server hosts many Synara session threads. The installed Codex 0.162.1 still starts a stdio MCP transport per native thread: an isolated protocol probe started one, two, then three MCP children for one, two, then three threads. Process sharing reduces app-server overhead; it cannot promise one external MCP transport per account. Do not pool arbitrary MCP transports without a separate server-specific isolation contract.

## Boundaries

- Contracts own the server setting `codexAppServerMode: "shared" | "per-session"`, default shared.
- Shared Beta policy disables shared mode on production desktop, preserving the saved preference.
- The Codex process registry owns transport, process identity, request ownership, native thread routes, and process teardown.
- The manager keeps session events, approvals, gateway leases, auth checks, turns, and native conversation state.
- ProviderService keeps its warm-slot limits and session consumers; a Codex warm slot owns one native thread lease.
- Shared runtime spawning and verified tree teardown retain the current platform boundaries.

## Current and target stacks

```text
Current: ProviderService.ensureSessionForThread → CodexAdapter.startSession
  → CodexAppServerManager.startSession → spawnAppServer → initialize → thread/start
  → session-local stdout / request registry

Target: ProviderService.ensureSessionForThread → CodexAdapter.startSession
  → CodexAppServerManager.startSession → resolve mode + process identity
  → registry.acquire(identity) → initialize once → thread/start or resume or fork
  → process transport → request owner / native thread route → manager session handler

Stop: manager.stopSessionContext → settle approvals + retire gateway lease
  → interrupt own active turn + unsubscribe own native threads + verify unload
  → release process lease → last lease grace → verified process-tree exit

Crash: process transport/exit → reject all requests + fail all hosted sessions
  → verified process teardown barrier → next start acquires replacement
```

## Identity

Hash the canonical effective environment, effective CODEX_HOME, source continuation home,
account ID and auth/config fingerprint, resolved executable path and file identity/version,
process launch arguments, priority policy, and platform. Never log environment or credentials.
Cwd, model, effort, approval/sandbox policy, developer instructions, and gateway MCP headers
remain native thread/turn inputs. Start the shared process in a neutral account home so the
first project does not set process startup defaults for other projects.

## Slices

1. Add tested process key, routing registry, and process lifecycle.
2. Wire manager start/fork, stop, renewal, auth invalidation, and fallback setting; add interleaved manager coverage.
3. Measure per-session/shared in isolated homes, run required checks, document limits.

## Verification

Run focused registry/manager/adapter/provider/settings tests, then fmt:check, lint,
typecheck, windows-runtime:check, the broader workspace suite with isolated Git config,
and the two requested warm-session browser files on an unused test port. Real measured
turns use the existing model choice, isolated Synara and Codex homes, and a fixed stdio
MCP fixture. Record RSS plus physical footprint where available. Commit each working slice;
never push or stash. Keep unrelated untracked plans untouched.
