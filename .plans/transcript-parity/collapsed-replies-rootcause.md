# Root cause: Claude replies folded into "Worked for" after background subagent wakes

Evidence source: thread `a9b4e17f-…` (the reported thread). I used a raw copy of `~/.synara/userdata/state.sqlite` and its WAL, and deleted the copy after the analysis. This document gives ids, sequences, and text lengths only. It does not include message text.

## TL;DR

The fold is an ordering bug, not a grouping-design bug. Three steps cause it:

1. **Two sequence counters are compared as one.** Checkpoint notices get the orchestration envelope sequence (about 664k). Provider activities get the runtime journal sequence (about 872k). The source is `ProjectionPipeline.ts:1279` (`activity.sequence ?? event.sequence`). The web store does the same at `storeNormalization.ts:1360-1368`, and its comment says that the two counters are different.
2. **The timeline comparator is not transitive.** `compareTimelineEntries` (`workLog.ts:3043-3054`) orders work against work by `sequence`, and messages (no sequence) against work by `createdAt`. All `checkpoint.baseline.skipped` rows (664k) sort before all provider rows (872k) in the same user block. The linear merge (`workLog.ts:3341-3355`) then puts **every provider work row after the last assistant reply of the block**.
3. **Because of this, the background-wake boundary rows move to the end.** The fix from #1497 (f860c6066) makes each "Subagent finished" row a response boundary (`MessagesTimeline.logic.ts:638-649`, `:715-730`, `:954-963`). Those rows now land after the 231-char reply. `deriveTerminalAssistantMessageIds` (`:587-608`) then marks only that reply as terminal, and `collapseSettledTurns` (`:908-1060`) folds the 894-char and 971-char replies into one disclosure.

**Proof (real rows, simulation of the web merge):**

| Case | Order produced |
|---|---|
| With the 4 `checkpoint.baseline.skipped` rows | user, a132, a894, skip, a971, skip, skip, **a231**, skip, then all provider rows (tool.started, "Moved to background", task.completed …) |
| The same rows without the checkpoint rows | user, a132, tools, a894, completions, **completion `add708e` 20:07:04.589**, a971, …, **completion `a8ab72` 20:10:32.257**, a231 |

The second order gives three responses, each with its own "Worked for". "Worked for 6m 20s" = user message 20:04:14.174 → a231 at 20:10:34.6. This shows that no boundary took effect.

The checkpoint rows that start the bug come from a second defect (see §2): subagent child turns are processed as parent turns, and wake turns have no baseline.

## 1. Final answer vs folded messages, and turn boundaries

### Web rule (provider-independent)

| Step | Code | Behavior |
|---|---|---|
| Response boundaries | `MessagesTimeline.logic.ts:638-649` | A user message **or** a work row with `backgroundTaskCompletion` starts a new response. turnId is not used. |
| Terminal message | `MessagesTimeline.logic.ts:587-608` | The last assistant message before the next boundary is terminal. All other assistant messages are narration. |
| Completion rows stay standalone | `MessagesTimeline.logic.ts:711-730` | They do not merge into a leading or inline work group. |
| Fold | `MessagesTimeline.logic.ts:908-1060` | Each terminal message scans back (`:960-994`) and folds work rows, earlier assistant messages, and segments. It stops at a completion row (`:963`), an async-input message, or a user row. |
| Trailing work | `MessagesTimeline.logic.ts:817-819` | Work after the last answer attaches to that answer as `inlineWorkEntries` and is folded too (`:1039-1040`). |
| Live guard | `MessagesTimeline.logic.ts:629`, `:844`, `:922-925` | `subagentsRunning` keeps the tail open while background agents run. |

The comment at `:960-962` says that some providers have several turnIds in one answer. That is why the web does not use turnId as a boundary.

### Claude adapter: a wake is a new Synara turn

| Step | Code |
|---|---|
| Assistant output without an active turn starts a **synthetic turn** with a new random TurnId and `raw.method = "claude/synthetic-turn-start"` | `ClaudeAdapter.ts:4121-4170`, called from `handleAssistantMessage` `:4216` |
| An SDK `result` closes it (`turn.completed`) | `ClaudeAdapter.ts:4417-4449`, `:5263-5264` |
| The next user send closes a stale synthetic turn | `ClaudeAdapter.ts:6728-6732` |
| The SDK-injected task-notification user message is dropped. Nothing in the transcript shows where the wake started. | see `claude-synara-mapping.md` row "user SDK-originated text" |
| `task_notification` → `task.completed` with **no turnId**. It arrives about 5 ms to 5 s before the wake's first assistant message. | `ClaudeAdapter.ts:5013-5074` |

In the data, each wake is its own turn (`1f6b1375`, `15bf09a1`). Each has `requested_at == started_at` and a null `pending_message_id` in `projection_turns`. Turn identity on the server is correct. The web grouping does not use it, and it uses the completion row instead. Ordering (§TL;DR) breaks the completion row.

## 2. "Checkpoint baseline unavailable for this turn" (repeated)

Source: `CheckpointReactor.ts:652-666` calls `appendCheckpointIssueActivity(baselineUnavailable)`, which writes kind `checkpoint.baseline.skipped` (`:403-430`). The condition is that no turn-start baseline ref exists at completion (`:585-615`). Dedupe is per turnId or messageId (`:369-402`). Thus each distinct turn gets one notice. The web always keeps these rows visible (`workLog.ts:612-618`).

The reported block has 4 notices: 3 before the final reply and 1 after it, which is then folded. There are two different sources:

| turnId | Owner | Why it has no baseline |
|---|---|---|
| `070747fd`, `17f3b195`, `afad5331` | **Subagent child turns.** Their messages and tools are on `subagent:a9b4…:toolu_…` threads. | Child runtime events carry `threadId = parent` plus `providerRefs.providerParentThreadId` (raw rows checked for `afad5331`). `processRuntimeEvent` (`CheckpointReactor.ts:1735-1758`) has **no** child guard. The guard at `:380-381` (`thread?.parentThreadId`) never fires, because the thread it loads is the parent. `ThreadGitMetadataReactor.ts:322-326` has the correct guard. |
| `1f6b1375`, `15bf09a1` | Parent **wake (synthetic) turns** | Only a pre-dispatch owner (a user send) captures a baseline. `ensurePreTurnBaselineFromTurnStart` stops on purpose when none exists (`CheckpointReactor.ts:1107-1110`). A wake turn can never have one. |

**Phantom checkpoints (verified, more serious than the noise):** each child turn also uses a **parent** checkpoint turn count. The `projection_turns` rows for the parent are:

| turn | checkpoint_turn_count | status | pending_message_id |
|---|---|---|---|
| 9ba9393b (user) | 17 | ready | set |
| 070747fd (child) | 18 | missing | null |
| 1f6b1375 (wake) | 19 | missing | null |
| 17f3b195 (child) | 20 | missing | null |
| 15bf09a1 (wake) | 21 | missing | null |
| 33e92bc7 (user) | 22 | ready | set |
| afad5331 (child) | 23 | missing | null |

Child turns create parent turn rows, checkpoint refs, and `thread.turn.diff.complete` on the parent. The effect on Undo and turn-count mapping is not verified in the UI, but the rows exist.

Recommendation: drop it for child turns, and do not show it for wake turns. Details are in "Fix direction".

## 3. Event → row mapping

| Row in UI | SDK message | Runtime event (ClaudeAdapter) | Activity (providerRuntimeActivityProjection = PRAP) | Web derivation |
|---|---|---|---|---|
| **"Moved to background" `<desc>`** | `system:background_tasks_changed` (REPLACE set) | Only newly added ids → `runtime.warning` (message = description, or `"N tasks: …"`), detail = raw SDK message. `ClaudeAdapter.ts:5097-5117` | kind `runtime.warning`, summary `"Moved to background"`, `nativeEventType: background_tasks_changed`. `PRAP:803-850` (`:835`) | Plain work row. Tray icon at `TimelineWorkEntryRow.tsx:251`. The aggregate is session-wide. Thus **background tasks of subagents** (for example "Map runtime events to web UI", "Trace web rendering of activities", "Timer while web trace agent runs") also show on the parent, with turnId null. |
| **"N updates - `<text>`"** | `system:task_progress` for each subagent task (`description` = "Running Find Codex.app location", …) | `task.progress` `ClaudeAdapter.ts:4977-5011` | kind `task.progress`, summary **"Reasoning update"**, detail = summary ?? description. `PRAP:963-990` (`:970`) | `deriveAgentActivityTimelineState` groups consecutive "Reasoning update" rows **without toolCallId** into one "Reasoning trace" row with preview `"${n} updates - ${latest}"`. `agentActivity.logic.ts:132-170` (`:147`, `:168`). Progress from several subagents interleaves, so the group mixes agents. The label is wrong: this is subagent progress, not reasoning. Codex also uses the "Reasoning update" label (`isReasoningUpdateWorkEntry`), so a change here must be specific to Claude. |
| **"Subagent finished: `<desc>`"** | `system:task_notification` | `task.completed` (no turnId) `ClaudeAdapter.ts:5013-5074` | kind `task.completed`, summary "Task completed / failed / stopped". `PRAP:993-1024` | `deriveBackgroundTaskCompletionEntries` (`workLog.ts:519-575`) relabels only tasks that a visible `background_tasks_changed` announced: `"Subagent <outcome>: <desc>"` for `local_agent`, otherwise "Background task …". It sets `backgroundTaskCompletion`, which is the **response boundary** in §1. |
| "Checkpoint baseline unavailable …" | (none; server reactor) | `turn.completed` of a child or wake turn | `checkpoint.baseline.skipped`, envelope sequence. `CheckpointReactor.ts:403-430` | Always visible, `workLog.ts:612-618`. Its low sequence causes the misordering in §TL;DR. |

## 4. Codex desktop vs Synara

| | Codex desktop (stock bundle 26.1002, `split-items-into-render-groups-*.js`) | Synara |
|---|---|---|
| Grouping unit | **One protocol turn.** Each turn is split into user items, agent (work) items, one `assistantItem`, and `postAssistantItems`. | User message or background-completion row. TurnId is ignored on purpose. |
| Final answer choice | The last item, if it is an assistant message. Otherwise a back-scan past trailing subagent activity, completed reasoning, and finished exec. That item is used **only if `phase === "final_answer"`**. Messages with `phase === "commentary"` go into the work group. Phase `null` falls back to the last assistant message. | Last assistant message before a boundary (`MessagesTimeline.logic.ts:587-608`). |
| `phase` field | `AgentMessageThreadItem.phase: "commentary" \| "partial_answer" \| "final_answer" \| null` (app-server v2 schema `MessagePhase`). Null means "unknown, keep legacy behavior". | **Not read.** No `phase` or `final_answer` reference in `apps/` or `packages/`. `CodexAdapter.ts:986-1000` builds the `item.*` payload (itemType, asyncQuestions, status, …) and drops `phase`. It stays only in `raw`. |
| Wake after a background task | A new turn, and therefore its own final answer. | A new turn on the server, but the web merges it into the previous response unless a completion row is between them. |

Claude equivalents (none are mapped today):

- **One `result` for each SDK turn** gives one `turn.completed` for each synthetic turn. The last assistant text before `result` is that turn's final answer. This is the strongest signal, and it is already on the server.
- `stop_reason` on each API assistant message (`end_turn` vs `tool_use`). It is only read for fork import (`ClaudeAdapter.ts:7370-7394`), not on the live path. `end_turn` text is the final answer. Text followed by `tool_use` is commentary.
- `raw.method = "claude/synthetic-turn-start"` marks a turn that the provider started (a wake), as opposed to a user send.

## Fix direction (no implementation)

Ranked by value and risk:

1. **Use one ordering key (root fix, web plus server).** Do not compare runtime-journal sequences with envelope sequences.
   - Option A: sort messages and all work by `createdAt`, and use `sequence` only to break ties within the same counter.
   - Option B: give each activity a tag for its counter, and compare sequences only within the same counter.
   - Fix `compareActivitiesByOrder` (`workLog.ts:2987-3000`) and `compareTimelineEntries` (`:3043-3054`) together. The snapshot SQL ordering (`ProjectionSnapshotQuery.ts:2190-2201`) mixes the same counters, so check it as well.
   - Tests: add a case to `workLog.test.ts` and `MessagesTimeline.logic.test.ts` (the #1497 tests) with a `checkpoint.baseline.skipped` row that has an envelope sequence lower than the runtime sequences. Expect each wake reply to stay a terminal answer.
2. **Stop the child-turn checkpoint capture (server).** In `CheckpointReactor.processRuntimeEvent` (`:1735`), and in `runtimeRelevant` (`:1829-1832`), return early when `event.providerRefs?.providerParentThreadId` is set. This is the same rule as `ThreadGitMetadataReactor.ts:326`. This removes the phantom parent turns and checkpoints, and 3 of the 4 notices. Add a `CheckpointReactor` test with a child `turn.completed`.
3. **Do not show the baseline notice for wake turns.** For a turn with no pre-dispatch owner (no `pending_message_id`; synthetic start), log at debug level, as `workspaceInitializedDuringTurn` already does (`CheckpointReactor.ts:600-608`). The user cannot act on the notice, because revert is keyed by user message. Optional: alias the previous turn's end checkpoint as an approximate baseline. Do this only if a diff for each wake is wanted, because background subagent edits would then count toward the wake.
4. **Make the wake boundary independent of row order (defense in depth).** Persist a "provider-initiated" origin on the turn. Source: synthetic `turn.started`, a new optional contract field instead of `raw`. The web then treats the first assistant message of such a turn as a response boundary, in addition to the completion row. This also covers wakes that the timeline cannot match to a visible "Moved to background" notice. Use this origin flag, not a generic turnId change, so that the mini-turn case at `:960-962` stays safe.
5. **Optional: final-answer signal across providers.** Add an optional `phase` to assistant message contracts. Codex fills it from `AgentMessageThreadItem.phase`. Claude fills it from `stop_reason` or "last text before `result`". The web prefers `phase === "final_answer"` and falls back to today's rule. Phase alone does not fix this report: the wake replies are terminal for their own turns, and the bug is grouping across turns.
6. **Fix the row labels (cosmetic).** For Claude subagent `task.progress`, use a subagent label instead of "Reasoning update", or group by `taskId`. Then "N updates" does not mix agents. Do not change the Codex path.

## Open risks / not verified

- Live (not reloaded) ordering: the live path also falls back to the envelope sequence (`storeNormalization.ts:1360-1368`). Thus the same misordering is expected live, but it was not observed in a running UI.
- The phantom checkpoint counts (18, 20, 23) can shift Undo and diff mapping for later user turns. The effect in the UI is not tested.
- Other server-appended activities without a runtime sequence (for example `checkpoint.capture.failed`, `checkpoint.revert.failed`, worker notices, handoff rows) can cause the same misordering for every provider, Codex included.
- The report says the notice repeated "3x". The data shows 4 in the block (3 before the final reply, 1 after it, folded). The screenshot can be from an earlier state.
