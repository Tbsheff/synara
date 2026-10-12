# Transcript parity: build plan

Goal: every Codex and Claude provider event renders cleanly in Synara's transcript and matches Codex desktop where it applies.

Inputs: [README.md](README.md) (gaps 1–10), [disposition.md](disposition.md) (target for all 222 events), the mapping reports, and the contracts in `packages/contracts/src/transcriptDetails.ts`.

The work is split by **file ownership**. Two agents never edit the same file in one wave. When an agent needs a change in a file it does not own, it writes the request in its completion report; the owner applies it in the next wave.

## Hard constraints (apply to every agent)

1. **Gap 1 fixes rows that are already stored.** The user's DB holds activities with mixed sequence counters (runtime journal ~872k, orchestration envelope ~664k). Fix the comparator on the web (`compareTimelineEntries` and `compareActivitiesByOrder` in `apps/web/src/workLog.ts`): `createdAt` is the primary key; `sequence` only breaks ties. Do not rewrite stored sequences. Add a regression test built from the real-row case in [collapsed-replies-rootcause.md](collapsed-replies-rootcause.md).
2. **Final answer.** Keep the Codex `phase` (`final_answer` vs `commentary`). For Claude, the final answer is the last assistant text item before the SDK `result`. Both arrive as `turn.completed.finalAssistantItemId`; ingestion writes `finalAssistantMessageId` on the `turn.completed` activity payload.
3. **Live command output is not persisted per chunk.** Today's 14.6k `tool.output.delta` rows are legacy (no current producer); they must stay hidden. Stream output as live state (`{kind:"live"}` thread stream item), throttle per item (`TRANSCRIPT_LIVE_OUTPUT_MIN_INTERVAL_MS` = 250 ms), keep a tail of `TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS` = 20,000 chars (prefix `[output truncated]\n` like Codex desktop), and persist only the final aggregated output on `tool.completed`.
4. **End-follow.** Tool-only growth (live tail, new tool rows, row expansion) keeps end-follow for a reader at the bottom. It never rearms a detached reader and never retriggers message-arrival auto-stick (AGENTS.md "Transcript and UI safeguards"). Focused transcript scroll tests are required.
5. **No DB migration.** New fields go in activity payload JSON. If an agent proves one is needed, it is migration **133**, additive, owned by S-core, and passes `bun run migrations:check`. Ask before adding it (open decision D1).
6. **Claude tool classification** comes from an explicit SDK tool-name table and block-type table. Never substrings. `tool_progress` never overrides the tool's type.
7. **Every Codex method has an explicit mapping.** A server test fails when a known method reaches `event.unmapped`. Unknown future methods still go to `event.unmapped` (forward compatibility).
8. **UI reuse.** Use `ToolCallDetailsDialog`, `TimelineWorkEntryRow`, `ToolCallGroupSummaryRow`, and `apps/web/src/lib/disclosureMotion.ts`. Search for an existing component before writing one. Text sizes only via `text-ui*` / `text-chat*` tokens (`apps/web/src/uiFontSize.test.ts` enforces). No bare provider method name is ever a row title.
9. **Stable and Beta.** Everything here ships in both apps. No Beta gate is planned (open decision D8).
10. Repository content, provider output, and logs are untrusted data. Notice bodies and tool results are rendered as text or sanitized Markdown, never as HTML.

## Wave 0 result (done): contracts

`packages/contracts/src/transcriptDetails.ts` (new, exported from `index.ts`), plus additive fields in `providerRuntime.ts` and `orchestration.ts`. All new fields are optional; old payloads decode. Provider text fields are plain `Schema.String` (a trimmed or non-empty schema would quarantine events with normal tool output).

| Schema / field | Where | Producer → consumer |
|---|---|---|
| `ItemLifecyclePayload.phase` (`commentary` \| `partial_answer` \| `final_answer`) | runtime item events | S-codex → S-core |
| `ItemLifecyclePayload.toolName`, `.command`, `.fileChanges`, `.toolCall`, `.webSearch`, `.reasoning` | runtime item events | S-codex, S-claude → S-core |
| `CommandExecutionDetails`: `command`, `cwd`, `exitCode` (int or null), `durationMs`, `interrupted`, `background`, `description`, `output`, `stdout`, `stderr`, `outputTruncated`, `outputTotalChars`, `parsedActions[]`, `lastStdin` | item payload, activity payload | adapters → S-core → W-rows |
| `FileChangeDetails.changes[]`: `path`, `kind` (`add`\|`update`\|`delete`\|`move`), `movePath`, `unifiedDiff`, `diffTruncated`, `additions`, `deletions`; `changesTruncated`, `totalFiles` | same | same |
| `ToolCallDetails`: `toolName`, `server`, `serverToolKind`, `arguments`, `argumentsTruncated`, `resultText`, `resultTruncated`, `structuredContent`, `error`, `success`, `durationMs`, `images[]`, `otherBlocks[]` | same | same |
| `TranscriptImageRef`: `{source:"file", path, mediaType, byteLength, width, height, alt}` or `{source:"omitted", mediaType, byteLength, reason}` | inside `toolCall.images` | adapters → W-rows |
| `WebSearchDetails`: `query`, `queries`, `action{type, query, url, pattern}`, `allowedDomains`, `blockedDomains`, `results[{url,title}]`, `resultsTruncated`, `error` | same | same |
| `ReasoningDetails`: `summary`, `summaryTruncated`, `heading`, `redacted`, `durationMs` | same | adapters (summary, redacted) → S-core (heading) → W-rows, W-activity |
| `TranscriptNotice`: `noticeKind` (31 kinds), `severity`, `title`, `detail`, `body`, `bodyTruncated`, `status`, `dedupeKey`, `toolUseId`, `nativeType`, `data` | new runtime event `transcript.notice`; activity kind `transcript.notice` | adapters → S-core → W-timeline → W-rows |
| `ToolActivityPayload` | decode schema for the tool activity `payload` JSON | S-core → W-timeline |
| `TurnStartedPayload.origin` (`user` \| `provider`) | runtime | adapters → S-core |
| `TurnCompletedPayload.finalAssistantItemId` | runtime | adapters → S-core |
| `TurnCompletedActivityHints`: `finalAssistantMessageId`, `origin` | `turn.completed` activity payload | S-core → W-timeline |
| `ToolProgressPayload.itemType` | runtime | S-claude → S-core |
| `ModelReroutedPayload.refusalCategory`, `.refusalExplanation`, `.retractedItemIds` | runtime | S-claude → S-core |
| `RuntimeWarningPayload.retryAttempt`, `.retryMaxAttempts` | runtime | adapters → S-core → W-timeline |
| `UserInputQuestionOption.preview` | runtime | S-claude → W-activity |
| `OrchestrationThreadStreamItem` `{kind:"live", live: ThreadLiveUpdate}`; `ThreadLiveToolOutput{threadId, turnId, itemId, activityId, streamKind, tail, truncated, totalChars, updatedAt}`; `ThreadLiveToolOutputCleared` | thread subscription only | S-core → W-timeline |
| Caps: `TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS` 20,000; `TRANSCRIPT_FILE_DIFF_MAX_CHARS` 20,000; `TRANSCRIPT_FILE_CHANGES_MAX_ENTRIES` 50; `TRANSCRIPT_TOOL_RESULT_MAX_CHARS` 20,000; `TRANSCRIPT_TOOL_ARGUMENTS_MAX_CHARS` 8,000; `TRANSCRIPT_NOTICE_BODY_MAX_CHARS` 8,000; `TRANSCRIPT_REASONING_MAX_CHARS` 8,000; `TRANSCRIPT_LIVE_OUTPUT_MIN_INTERVAL_MS` 250 | constants | all |

Runtime code changed in Wave 0 only where the contract forced it to compile: `apps/web/src/routes/__root.tsx` ignores `{kind:"live"}` items (W-timeline replaces this with the real handler).

Producer rules (contracts carry no comments; these are the rules):
- Cap every body with the constants above and set the matching `*Truncated` flag. Consumers never assume a body is complete.
- Never put inline image bytes in a payload. Write the file, then send a `file` ref, or send an `omitted` ref with a reason.
- Do not duplicate typed fields in `data`. `data` stays for legacy rows and small ids only.
- Every notice gets a `dedupeKey` when it can repeat. S-core derives the activity id from `threadId` + `dedupeKey`, so repeats upsert one row. Warnings dedupe per turn (a repeat in a later turn stays visible); config, skills, and MCP status dedupe per lifecycle generation.
- `TranscriptNotice.title` is a `TrimmedNonEmptyString`; an untrimmed or empty value fails the journal encode and quarantines the event. The title is Synara-composed. When it includes provider text, the producer trims it, caps it at 200 chars, and falls back to a fixed label when empty. Longer provider text goes in `detail` or `body` (plain strings).

## File ownership

### Wave 1 (server, parallel)

| Agent | Owns (edit) | Creates |
|---|---|---|
| **S-codex** | `apps/server/src/provider/Layers/CodexAdapter.ts`, `CodexAdapter.test.ts`; `apps/server/src/codexAppServerManager.ts`, `codexAppServerManager.test.ts`; `apps/server/src/codexErrorClassification.ts` (only if retry parsing needs it) | `apps/server/src/provider/codexMethodDispositions.ts` + `.test.ts` |
| **S-claude** | `apps/server/src/provider/Layers/ClaudeAdapter.ts`, `ClaudeAdapter.test.ts`; `apps/server/src/provider/claudeTaskTracker.ts`; `apps/server/src/provider/claudeWorkflowRuntime.ts` (+test, only if task patches need it) | `apps/server/src/provider/claudeToolClassification.ts` + `.test.ts`; `apps/server/src/provider/claudeToolResultBlocks.ts` + `.test.ts` |
| **S-core** | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`, `ProviderRuntimeIngestion.test.ts`, `ProviderRuntimeIngestion.buffer.test.ts`; `apps/server/src/orchestration/providerRuntimeActivityProjection.ts` + test; `apps/server/src/orchestration/providerRuntimeProgressCoalescing.ts` + test; `apps/server/src/orchestration/Layers/CheckpointReactor.ts` + test; `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` + test; `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` + test; `apps/server/src/wsRpc.ts` (+ its tests); `apps/server/src/wsStreamAdmission.ts`; `apps/server/src/provider/unmappedProviderEvents.ts` + tests; `packages/contracts/**` (follow-up contract edits, including `wsCompatibility.ts`); `packages/shared/src/subagents.ts` (only if touched) | `apps/server/src/orchestration/liveToolOutput.ts` + `.test.ts`; `apps/server/src/orchestration/reasoningHeading.ts` + `.test.ts` |

### Wave 2 (web, parallel after step 0)

| Agent | Owns (edit) | Creates |
|---|---|---|
| **W-timeline** | `apps/web/src/workLog.ts`, `workLog.test.ts`; `apps/web/src/wsTransport.ts`, `wsNativeApi.ts`, `threadDetailResumeCursors.ts` (live-item audit only); `apps/web/src/components/chat/ThreadErrorBanner.tsx` (+ browser test); `apps/web/src/components/chat/MessagesTimeline.logic.ts` + test; `MessagesTimeline.tsx`, `MessagesTimeline.test.tsx`, `MessagesTimeline.*.browser.tsx`; `apps/web/src/storeNormalization.ts` + test; `store.ts`, `storeEventReducer.ts`, `storeState.ts`, `storeTimelineSequence.test.ts`, `store.test.ts`, `storeEventReducer.test.ts`; `apps/web/src/routes/__root.tsx`; `apps/web/src/components/chat/useChatTranscriptScroll.ts`, `transcriptScroll.ts`, `useTailAnchorScroll.ts`; `apps/web/src/chat-scroll.ts` + test | `apps/web/src/liveToolOutputStore.ts` + test (if the live slice does not fit `store.ts`) |
| **W-rows** | `apps/web/src/lib/toolCallDetails.ts` + test; `apps/web/src/lib/toolCallLabel.ts` + test; `apps/web/src/components/chat/TimelineWorkEntryRow.tsx` + `TimelineWorkEntryRow.*.test.tsx`; `ToolCallDetailsDialog.tsx`; `AgentActivityDetailView.tsx` | `apps/web/src/lib/transcriptNoticeLabels.ts` + test (notice icons/titles and the legacy `provider.event.unmapped` title table) |
| **W-activity** | `apps/web/src/components/ChatView.logic.ts` + test; `apps/web/src/components/ChatView.tsx` (only the `workingLabel` wiring); `apps/web/src/lib/liveActivityPresentation.ts` + test; `apps/web/src/components/chat/agentActivity.logic.ts` + test; `toolCallGroup.logic.ts` + test; `ToolCallGroupSummaryRow.tsx`; `apps/web/src/pendingInteractionDerivation.ts` + test; `ComposerPendingApprovalPanel.tsx` + browser test; `ComposerSubagentStrip.tsx`, `ComposerSubagentStrip.logic.ts` + test; `ComposerPendingUserInputPanel.tsx`, `UserInputQuestionForm.tsx` | — |

Shared-file rule: `packages/contracts` is S-core's in Wave 1 and frozen in Wave 2 (web agents report contract needs instead of editing).

## Wave 1 agents

### S-codex

Covers: gaps 1 (phase), 2, 3, 4, 6, 7, 10; disposition rows with owner S-codex (Codex §1–§3).

Tasks:
1. **Method table.** Create `codexMethodDispositions.ts`: one exported record for the 84 notifications, one for the 10 requests, one for the 19 item types. Each entry is `mapped`, `ignored-gated`, or `ignored-state`, matching [disposition.md](disposition.md). The adapter returns no event for ignored entries (they never reach `event.unmapped`). Unknown methods still go to `event.unmapped`.
2. **Item types.** Replace the camelCase substring match (`CodexAdapter.ts:385-417`) with an explicit item-type table. `hookPrompt`, `functionCallOutput`, `subAgentActivity`, `sleep`, `enteredReviewMode` get mappings; `mapItemLifecycle` no longer drops them (`:945`).
3. **Phase and final answer.** Read `item.phase` where the item payload is built (`:986-1000`) and set `payload.phase`. Track per turn the last agentMessage item with `phase === "final_answer"`; send it as `turn.completed.finalAssistantItemId`. Omit it when no item has a phase. `turn.started.origin = "user"` for Synara-dispatched turns.
4. **Commands.** Fill `command` from `item.command`, `cwd`, `exitCode` (null stays null), `durationMs`, `aggregatedOutput` (tail-capped), `commandActions` → `parsedActions`, interrupted/declined status. Stop copying `aggregatedOutput` into `data`. `terminalInteraction` → `item.updated` with itemType `command_execution` and `command.lastStdin`.
5. **File changes.** `changes[]` → `fileChanges` (kind normalized, `move_path` → `movePath`, diff capped, additions/deletions counted from the diff). `item/fileChange/patchUpdated` → `item.updated` with `fileChanges` (S-core coalesces).
6. **Tools.** MCP and dynamic tools → `toolCall` (arguments capped, result content → `resultText`, image content → `omitted` refs until D2 is decided, `structuredContent`, `error`, `success`, `durationMs`). `functionCallOutput` merges into its tool row by `callId`. Web search → `webSearch.query` / `action`.
7. **Reasoning.** Send `reasoning.summary` on completion; the summary deltas already exist. S-core derives `heading`.
8. **Notices.** Emit `transcript.notice` for: hookPrompt, subAgentActivity, sleep, review enter/exit, `thread/reverted`, `skills/changed` (dedupe per generation), auto-approval review started/completed/strict, `mcpServer/startupStatus/updated` (one ready row per generation, one warning per failed server), `model/verification`, auth recovery started/completed, `turn/moderationMetadata` (only when flagged), `warning`, `guardianWarning`, user-message echoes with no Synara message. Hooks, config warnings, deprecation notices, and OAuth completion keep their canonical events (S-core projects them).
9. **Errors and retries.** `error` with `willRetry` → `runtime.warning` with `retryAttempt` / `retryMaxAttempts` parsed from `Reconnecting k/N`.
10. **State surfaces.** Environment connected/disconnected and safety buffering → `session.state.changed` with a `reason` the working-status line reads. Goal updated/cleared: confirm whether Synara writes the goal; if yes, ignore; if not, report (open decision D4).
11. **Refused requests.** In `codexAppServerManager.ts` (`:4784`, `:4820-4825`), refused requests (`item/tool/call`, `account/chatgptAuthTokens/refresh`, `attestation/generate`, legacy v1 approvals) no longer reach the adapter as `request.opened`. Auto-cancelled non-tool elicitations (`:4697-4711`) emit an `mcp-elicitation` notice.

Tests (`CodexAdapter.test.ts`, `codexMethodDispositions.test.ts`, `codexAppServerManager.test.ts`):
- Table-driven: every known notification/request/item type, fed with a minimal payload, produces no `event.unmapped`. The table has exactly 84 + 10 + 19 entries.
- Phase on agentMessage; `finalAssistantItemId` on `turn/completed`; absent when no phase.
- Command details: whitespace-only and leading/trailing-whitespace output survives; `exitCode: null`; 30k output → 20k tail + `outputTruncated`.
- File change: two files, `add` + `update`, diff and counts; a `move`.
- Notices: skills/changed twice in one generation → same `dedupeKey`.
- Refused request → no `request.opened`.

Done when: tests above pass; `bun run test` in `apps/server` for the touched files passes; `bun run typecheck` passes.

### S-claude

Covers: gaps 1 (Claude final answer), 2, 4, 5, 6, 7, 8; disposition rows with owner S-claude (Claude §A–§E).

Tasks:
1. **Classification.** Create `claudeToolClassification.ts`: an exact-name table for every SDK tool (the 0.3.259 list in `claude-synara-mapping.md` §D plus legacy names) → itemType + label key; `mcp__` prefix → `mcp_tool_call` with server and tool split; a block-type table for `server_tool_use` / `mcp_tool_use` → `serverToolKind`. Unknown names → `dynamic_tool_call`. Replace `classifyToolItemType` (`ClaudeAdapter.ts:1184-1235`). `ListAgents` → `dynamic_tool_call`; `CronCreate`/`CronDelete` → `dynamic_tool_call`; `mcp__github__create_issue` → `mcp_tool_call`.
2. **Progress type.** `tool_progress` (`:5152-5164`) sends `itemType` from the classified start of the same `toolUseId`.
3. **Results.** Create `claudeToolResultBlocks.ts`: convert `tool_result` content + `tool_use_result` into typed details. Bash → `command` (`stdout`, `stderr`, `interrupted`, `background`, `description`; `exitCode` when the result states one). Edit/Write/NotebookEdit → `fileChanges` from `structuredPatch` (unified diff text, counts; `Write` with null `originalFile` → `add`). Read/Grep/Glob/WebFetch/others → `toolCall.resultText`. Images → files written under the thread's attachment directory via the existing `attachmentPaths.ts` helpers, size-capped, else `omitted` (D2). `document` / `search_result` / `tool_reference` → `otherBlocks`. Replace the text-only extraction at `:1744-1766`.
4. **Server tools.** Handle `server_tool_use`, `mcp_tool_use` and every `*_tool_result` block in the stream path (`:3894-3899`) and the snapshot loop (`:4228-4336`). A result block completes its item; items no longer close only at turn end.
5. **Final answer and wake origin.** Track the last assistant text item per turn; on `result` send `turn.completed.finalAssistantItemId`. A synthetic turn start (`:4121-4170`) sends `turn.started.origin = "provider"`.
6. **Notices.** Map these to `transcript.notice` instead of `warnUnhandledSdkKind`: `system:init` MCP status (one "MCP servers ready" row per session, one warning per failed server, same scheme as Codex), `commands_changed` (`skills-changed`, dedupe per generation), `local_command_output`, `model_refusal_no_fallback`, `notification`, `memory_recall`, `elicitation_complete`, `informational` (hook block reasons → `hook-blocked`), `plugin_install`, `permission_denied` (with `toolUseId`), failed compaction (`system:status`), failed MCP servers in `system:init`, SDK-originated user messages. Explicit ignore for `control_request_progress`, `session_state_changed`, `worker_shutting_down`, `prompt_suggestion`, `mirror_error`. Set `includeHookEvents: true` (`:6222-6225`).
7. **Other fixes.** `redacted_thinking` → reasoning item with `reasoning.redacted`. `model_refusal_fallback` → `model.rerouted` with refusal fields and `retractedItemIds`. `api_retry` → `retryAttempt` / `retryMaxAttempts`. `result` errors → `runtime.error` with `errorCode` = subtype and all `errors[]`. `background_tasks_changed` emits only tasks the thread owns (`claudeTaskTracker.ts`). `task_updated` forwards `description` / `end_time` patches. AskUserQuestion: question id unique per index; option `preview`.

Tests: classification table test (every listed name, observed misclassifications, unknown name); `tool_progress` keeps `command_execution` for Bash and `collab_agent_tool_call` for Agent; structuredPatch → per-file diff; image block → file ref (and `omitted` over the cap); advisor `server_tool_use` + `advisor_tool_result` → one completed item with `resultText`; `finalAssistantItemId` = last text before `result` with a trailing tool call; synthetic turn has `origin: "provider"`; each mapped subtype emits a notice, ignored subtypes emit nothing.

Done when: tests pass; `bun run test` for touched server files; `bun run typecheck`.

### S-core

Covers: gaps 1 (server side), 2 (live channel, caps), 3, 8, 9; disposition rows with owner S-core and every "notice chain" row (projection step).

Tasks:
1. **Ordering (gap 1).** Align the snapshot activity order in `ProjectionSnapshotQuery.ts:2190-2201` with the web rule (`createdAt`, then `sequence` as tie-break). Do not change `ProjectionPipeline.ts:1279` sequences on stored rows. Check that any snapshot window that keeps "the latest N activities" does not select by mixed sequence; fix it if it does.
2. **Checkpoint noise (gap 3).** In `CheckpointReactor.processRuntimeEvent` (`:1735`) and `runtimeRelevant` (`:1829-1832`), return early when `event.providerRefs?.providerParentThreadId` is set (same rule as `ThreadGitMetadataReactor.ts:326`). For a turn with `origin: "provider"` or no pre-dispatch owner, log the missing baseline at debug level and write no `checkpoint.baseline.skipped` activity.
3. **Final answer.** Map `turn.completed.finalAssistantItemId` to the message id with the existing resolver (`resolveAssistantCompletionMessageId`, `ProviderRuntimeIngestion.ts:1440`) and write `TurnCompletedActivityHints` (`finalAssistantMessageId`, `origin`) on the `turn.completed` activity payload.
4. **Typed payloads.** In `providerRuntimeActivityProjection.ts`, copy `toolName`, `command`, `fileChanges`, `toolCall`, `webSearch`, `reasoning` into the tool activity payload (`ToolActivityPayload`). Rework the bound at `:22-26` / `:293-340`: typed fields are capped by the contract constants and exempt from the 2,000-char string cut; `data` is trimmed first; set a total payload ceiling (proposal: 64k chars) and truncate in this order: `data`, `toolCall.arguments`, `toolCall.structuredContent`, output head.
5. **Notices.** First verify the upsert premise: appending an activity whose id already exists must replace the row in place for any kind, in the projection, in the snapshot, in the web store, and through command idempotency (today only Claude reasoning does this, through its own path in `dispatchActivityUpdate`). An upsert keeps the original `createdAt` and `turnId`, otherwise the row moves under the createdAt-first comparator. Then project `transcript.notice` to activity kind `transcript.notice` (tone from severity; id from `threadId` + `dedupeKey`, else the event id). Project `hook.started` / `hook.progress` / `hook.completed`, `config.warning`, `deprecation.notice`, `mcp.oauth.completed`, `files.persisted` as notices too. Remove the hook `runtime.warning` path once notices cover it.
6. **Progress.** `tool.progress` uses `payload.itemType` when present, else the type of the started row; never forces `mcp_tool_call` (`:343-361`). Claude `task.progress` no longer projects a "Reasoning update" activity; it stays a `task.progress` activity with `taskId` (hidden; W-activity shows it in the strip). The Codex path is unchanged.
7. **Live output.** Create `liveToolOutput.ts`: a per-thread in-memory hub that appends `command_output` / `file_change_output` deltas to a 20k tail per item, publishes `ThreadLiveToolOutput` at most every 250 ms per item, and publishes `ThreadLiveToolOutputCleared` on item completion, turn completion, interrupt, and session exit. In `wsRpc.ts` merge the hub into `subscribeThread` as `{kind:"live"}` items: no sequence, not in replay, not counted in the resume cursor; on subscribe, send the current tails. Under backpressure keep only the latest item per `itemId` so `wsStreamAdmission.ts` never reports overflow because of live output. Wire compatibility: an older client fails to decode an unknown stream item kind, so raise `WS_PROTOCOL_MAX_REVISION` in `packages/contracts/src/wsCompatibility.ts` (negotiated through `bootstrap.negotiate`) and send live items only to connections that negotiated the new revision; older clients get the final output on `tool.completed` as today. Reduce the existing tool-output buffer (`:2755-2766`) to the same 20k tail and use it for the final `command.output` only when the adapter sent none.
8. **Reasoning (gap 8).** Remove the `claudeAgent` gate in `publishReasoningPreview` (`ProviderRuntimeIngestion.ts:1351`). Create `reasoningHeading.ts` (last non-empty summary line, Markdown removed, bold-only line unwrapped) and set `reasoning.heading` on previews and completions.
9. **Coalescing.** `item.updated` with `fileChanges` (Codex `patchUpdated`) and `hook.progress`: at most one persisted update per item per second, final state always persisted.
10. **Retries (gap 9).** `runtime.warning` with `willRetry` upserts one activity per turn (stable id, original `createdAt` kept, same upsert path as task 5) so `Reconnecting k/N` replaces in place.
11. **Other.** `item/plan/delta` throttled live plan preview (≥250 ms). `turn.steered` with target `subagent` gets summary "Message delivered to subagent". Non-git turn diff falls back to the provider unified diff (`:3144`). In `unmappedProviderEvents.ts`, drop the `skills/changed` special case (the adapter maps it now).

Tests:
- `CheckpointReactor.test.ts`: child `turn.completed` (with `providerParentThreadId`) creates no parent turn, checkpoint, or notice; a provider-origin turn writes no `checkpoint.baseline.skipped`.
- `providerRuntimeActivityProjection.test.ts`: typed fields survive with a 20k output and 3 × 20k diffs; `data` is trimmed first; notice upsert by `dedupeKey`; `tool.progress` keeps `command_execution`.
- `ProviderRuntimeIngestion.test.ts`: `finalAssistantMessageId` on the turn activity; Codex reasoning preview publishes with a heading.
- `liveToolOutput.test.ts`: 1,000 deltas in 1 s → ≤ 5 publishes per item; tail is exactly the last 20k chars with the truncation prefix; cleared on completion; **no activity is appended for any delta** (assert the activity count).
- `wsRpc` test: a live item reaches a subscriber, is absent from replay, and does not move the cursor.

Done when: tests pass; `bun run test` in `apps/server` for touched files; `bun run typecheck`; `bun run migrations:check` passes with no new migration.

## Wave 2 agents

**Step 0 (W-timeline, first, one small change).** Extend `WorkLogEntry` in `workLog.ts` with optional typed fields: `toolName`, `command`, `fileChanges`, `toolCall`, `webSearch`, `reasoning` (contract types), `notice: TranscriptNotice`, `liveOutput: { tail, truncated, totalChars, updatedAt }`, and `isFinalAnswer` hints where needed. Typecheck, then W-rows and W-activity start. After step 0 the type is frozen for the wave.

### W-timeline

Covers: gaps 1, 2 (live state, scroll), 3 (legacy rows, notice derivation), 9 (retry rows).

Tasks:
1. **Comparator (gap 1).** Pre-check first: on a read-only copy of the user's DB (never the live file), count activity pairs that both carry runtime sequences where `createdAt` order and `sequence` order disagree. If the count is not zero, add a rule for those pairs before switching (for example: same counter detected by both being provider kinds → sequence wins). Then change `compareTimelineEntries` (`workLog.ts:3043`) and `compareActivitiesByOrder` (`:2987`) together: `createdAt` first, then `sequence` when both have one, then lifecycle rank, then id. Keep the linear merge (`:3341-3355`) consistent with the new comparator. Leave `withOrchestrationEventSequence` (`storeNormalization.ts:1360-1368`) as is; add a test that a live-normalized activity and the same snapshot activity sort the same way.
2. **Final answer.** In `MessagesTimeline.logic.ts`, `deriveTerminalAssistantMessageIds` (`:587-608`) prefers `finalAssistantMessageId` from the turn's `turn.completed` activity; Codex `commentary` messages stay in the work group; without the hint, keep today's rule.
3. **Typed entries.** Decode tool activity payloads with `ToolActivityPayload` (per field, `decodeUnknownOption`) into the step-0 fields; fall back to the legacy `data` parsing for old rows.
4. **Notices and legacy rows.** Derive one entry per `transcript.notice` activity (latest per `dedupeKey`). Hide legacy `tool.output.delta` rows and legacy `provider.event.unmapped` rows whose method is `drop:` in the disposition; give the other legacy unmapped rows a title from `transcriptNoticeLabels.ts` (W-rows).
5. **Live state.** Audit every thread stream consumer (`wsTransport.ts`, `wsNativeApi.ts`, `threadDetailResumeCursors.ts`, `routes/__root.tsx`): a live item must never be queued as an event, counted for the resume cursor, or treated as a snapshot. Handle `{kind:"live"}` in `routes/__root.tsx`: store live tails per `threadId` + `itemId` (not persisted, cleared on `tool-output-cleared`, on the item's `tool.completed`, and on a new snapshot); attach the tail to the running entry as `liveOutput`.
6. **Retries.** Consecutive `willRetry` warnings in one turn render as one `Reconnecting k/N` row (latest wins). Consecutive image views merge.
7. **Scroll (AGENTS.md).** Live tail growth and tool-row growth keep end-follow for a reader at the bottom and never rearm a detached reader.

Tests:
- `workLog.test.ts` and `MessagesTimeline.logic.test.ts`: the real-row case from `collapsed-replies-rootcause.md` (user 20:04:14.174; replies a132, a894, a971, a231 at 20:10:34.6; four `checkpoint.baseline.skipped` rows with envelope sequences ~664k; provider rows with runtime sequences ~872k including completion `add708e` at 20:07:04.589 and `a8ab72` at 20:10:32.257). Expect three responses, each wake reply terminal, no reply folded into the previous "Worked for".
- Same-millisecond rows from one counter keep sequence order; compaction progress before terminal.
- `finalAssistantMessageId` pins a non-last message; absent hint keeps legacy behavior.
- Legacy `tool.output.delta` rows render nothing.
- `MessagesTimeline.segments.browser.tsx` stays green (text segments carry envelope sequences and interleave with tool rows).
- `ThreadErrorBanner` names the Claude result subtype ("Stopped: max turns reached").
- Browser tests (`MessagesTimeline.scroll.browser.tsx`, `MessagesTimeline.tailAnchor.browser.tsx`): (a) at bottom, live tail grows three times → still at bottom; (b) reader scrolled up 400 px, live tail grows and two tool rows arrive → `scrollTop` unchanged, follow not rearmed; (c) live tail replaced by the final `tool.completed` output → a following reader stays at bottom after the settled layout.

Done when: `bun run test` in `apps/web` (affected files) and the browser tests pass (`bun run --cwd apps/web test:browser -- <files>`; in a git worktree call the vitest binary with an explicit `--root`, because the script resolves to the main checkout).

### W-rows

Covers: gaps 2, 4, 6, 7 (rendering), 8 (reasoning row); every `row:` target whose owner lists W-rows.

Tasks:
1. **Command row.** Collapsed `Ran {command}` (+ ` in {duration}`), running `Running {command}` with the live tail, interrupted `Stopped {command}`. Body: `$ command`, cwd, output (`No output` when empty), footer `Success` / `Exit code N` / `Stopped` / `Exit code unknown`. Duration format as Codex desktop: under 1 s hidden, `12s`, `2m 5s`, `1h 0m 5s`. `parsedActions` → `Read {path}`, `Searched for {query} in {path}`, `Listed files in {path}`. Read `entry.command` first; the legacy fallback must also read `data.item.exitCode` (`toolCallDetails.ts:134-139`).
2. **File rows.** One row per entry in `fileChanges.changes`: `Edited|Created|Deleted {file} +N −M`, expandable diff using the existing diff renderer; keep the open-turn-diff link even when output exists (`TimelineWorkEntryRow.tsx:731`).
3. **Tool details.** Detail builders for MCP, dynamic, and Claude built-ins in `toolCallDetails.ts`: arguments, result text, structured content, error, images (thumbnails through the existing local-file preview grant), other blocks. Labels in `toolCallLabel.ts` keyed by tool name (Read with line range, Grep, Glob, WebFetch, WebSearch query, Skill, ToolSearch, SendMessage, LSP, Monitor, Cron*, ListAgents, TaskOutput, TaskStop, EnterPlanMode, MCP humanized sentence case, advisor and other server tools). Show the key argument on the row; never hide it behind "failed only" (`TimelineWorkEntryRow.tsx:203-209`).
4. **Web search.** `Searched the web for {query}`, `Opened {url}`, `Searched for '{pattern}' in {url}`; results listed in the details.
5. **Notice rows.** Create `transcriptNoticeLabels.ts` (icon and tone per `noticeKind`, legacy unmapped method → title table). Render notices in `TimelineWorkEntryRow` as compact one-line rows with an expandable body using `disclosureMotion.ts`.
6. **Other rows.** Reasoning: heading as the row title, "Reasoning redacted" marker. Model reroute divider with refusal tooltip. Steer row. Completion row `output_file` link. Compaction label auto vs manual.

Tests: `toolCallDetails.test.ts` / `toolCallLabel.test.ts` cases for each label and details builder, legacy fallback for old payloads, exit code from `data.item.exitCode`; a `TimelineWorkEntryRow` test that no row title equals a raw method name (`thread/goal/updated`, `warning`); `uiFontSize.test.ts` passes.

Done when: tests pass; `bun run lint` and `bun run fmt:check` clean for touched files.

### W-activity

Covers: gaps 3 (task progress), 8 (status line), 9 (group header), 10 (approvals); `surface:` targets owned on the web.

Tasks:
1. **Working status.** In `ChatView.logic.ts` (`:1423-1447`), the `workingLabel` prop passed by `ChatView.tsx`, and `liveActivityPresentation.ts` (`:108`), show the latest `reasoning.heading` of the running turn instead of "Thinking"; also show session-state reasons (safety buffering, environment disconnected, compacting).
2. **Subagent progress.** `agentActivity.logic.ts` (`:132-170`): Claude `task.progress` no longer forms "N updates" reasoning rows; group by `taskId`; `ComposerSubagentStrip` shows the latest progress line per task. Codex reasoning updates are unchanged.
3. **Group header (gap 9).** Compare `toolCallGroup.logic.ts` / `ToolCallGroupSummaryRow.tsx` wording with Codex desktop: comma list, no counts, first part capitalized ("Edited files, read files, ran commands"); `Worked` when empty.
4. **Approvals (gap 10).** `pendingInteractionDerivation.ts`: a request with no `requestId` or an unsupported type creates no row and no panel. `ComposerPendingApprovalPanel.tsx`: command approval shows cwd, parsed actions, reason; file-change approval shows the per-file diff; permission profile formatted for people (no raw JSON at `:291`); Claude `title` / `description` / `blockedPath` / `decisionReason`. User-input panel shows option `preview`.

Tests: working label uses the heading; Claude task progress from two subagents does not mix; group header strings; stale approval row absent for `auth_tokens_refresh` and `dynamic_tool_call` without `requestId`; approval panel browser test for the formatted permission profile.

Done when: tests pass; lint and fmt clean for touched files.

## Verification gates

| Gate | Command | When |
|---|---|---|
| Format | `bun run fmt:check` | each agent, before report |
| Lint | `bun run lint` | each agent |
| Types | `bun run typecheck` | each agent |
| Unit tests | `bun run test` (never `bun test`) scoped to touched packages | each agent |
| Browser tests | `bun run --cwd apps/web test:browser` (scroll, tail anchor, tool details) | W-timeline, W-rows |
| Migrations | `bun run migrations:check` | S-core |
| Full suite | `bun run test` at the root | after Wave 2 |
| Live check | isolated Synara instance (`verify` skill), one Codex and one Claude session with a long command, a file edit, an MCP call, a web search, a hook, and a background subagent wake | after Wave 2; mocks do not prove provider behavior |

## Open decisions

| # | Decision | Proposal |
|---|---|---|
| D1 | Message-level `phase` storage | Not needed: `finalAssistantMessageId` on the `turn.completed` activity covers completed turns; live turns keep today's rule. Revisit migration 133 (`projection_thread_messages.phase`, nullable) only if live commentary grouping must match Codex during the turn |
| D2 | Where tool-result images are stored and how long | Thread attachment directory via `attachmentPaths.ts`, 5 MB per image cap, cleaned with the thread by `managedAttachmentCleanup.ts`; until decided, adapters send `omitted` refs |
| D3 | Total activity payload ceiling | 64k chars per activity; command output 20k tail. Storage impact: ~18k Codex commands × ≤20k ≈ ≤360 MB worst case; measure on the user's DB copy before raising further |
| D4 | Codex thread goal | If Synara writes the goal, ignore Codex goal notifications; otherwise sync to the Synara goal surface |
| D5 | Claude `citations` | Deferred; needs message-level storage (same question as D1) |
| D6 | Codex `mcpAppUi` (MCP app widgets) | Out of scope; row shows the tool result only |
| D7 | Retracted Claude text after `model_refusal_fallback` | Needs an orchestration command to hide a message; S-core proposes one or keeps the text with a "retracted" marker |
| D8 | Beta gating | None planned; all changes are rendering fixes for both apps. Add a `BETA_ONLY_FEATURES` key only if the live channel shows risk in Canary |
| D9 | Hook rows volume after `includeHookEvents: true` | Successful hooks with empty output group into the work group; if still noisy, show only failed/blocked hooks |
