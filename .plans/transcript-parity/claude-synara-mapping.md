# Claude Agent SDK → Synara transcript mapping

Source of truth: `@anthropic-ai/claude-agent-sdk@0.3.259` (`node_modules/.bun/@anthropic-ai+claude-agent-sdk@0.3.259+*/.../sdk.d.ts`, `sdk-tools.d.ts`), Anthropic SDK `0.100.0` (`resources/beta/messages/messages.d.ts`). Synara at `feat/plugin-host-review-queue` (d4e323bfb + working tree). Read-only trace, 2026-10-10.

## Pipeline and abbreviations

`SDKMessage` → `handleSdkMessage` (CA:5207-5284) → canonical `ProviderRuntimeEvent` (`packages/contracts/src/providerRuntime.ts:213-263`) → `projectProviderRuntimeActivities` (PRAP:652-1483) + `processRuntimeEvent` (PRI:2129-3306) → web `deriveWorkLogEntries` (WL:389-451, 1120-1365) → `MessagesTimeline` (MT:1462-1582) → `TimelineWorkEntryRow` (TWER).

| Abbrev | File |
|---|---|
| CA | `apps/server/src/provider/Layers/ClaudeAdapter.ts` |
| PRAP | `apps/server/src/orchestration/providerRuntimeActivityProjection.ts` |
| PRI | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` |
| WL | `apps/web/src/workLog.ts` |
| TWER | `apps/web/src/components/chat/TimelineWorkEntryRow.tsx` |
| MT | `apps/web/src/components/chat/MessagesTimeline.tsx` |
| TCD | `apps/web/src/lib/toolCallDetails.ts` |
| TCL | `apps/web/src/lib/toolCallLabel.ts` |
| SDK | `claude-agent-sdk/sdk.d.ts` |
| SDKT | `claude-agent-sdk/sdk-tools.d.ts` |

Quality buckets: **CLEAN** purpose-built UI. **GENERIC** generic row (name / title / raw text only). **PARTIAL** shown, but fields that matter are lost. **DROPPED** never reaches the transcript (an unhandled kind may leave a one-time "Unhandled …" warning row with no content). **STATE** consumed as non-transcript state (meter, session status, cache) by design; not a transcript gap.

Cross-cutting facts that drive many rows:

1. **Unknown system subtypes / message types** go to `warnUnhandledSdkKind` (CA:2871-2883, called at CA:5121 and CA:5276). It emits one `runtime.warning` per kind per session: text "Unhandled Claude system message subtype 'X'." The payload content is not shown (PRAP:803-856 renders `message` only).
2. **Tool item type is name-heuristic** (`classifyToolItemType`, CA:1184-1235). Check order: todo/task* → `plan`; contains "agent" → `collab_agent_tool_call`; bash/command/shell/terminal → `command_execution`; edit/write/file/patch/replace/create/delete → `file_change`; mcp → `mcp_tool_call`; websearch → `web_search`; image → `image_view`; else `dynamic_tool_call`. The `mcp__` short-circuit exists only for approvals (CA:1254). So `mcp__github__create_issue` → `file_change`, and `mcp__x__list_agents` → `collab_agent_tool_call`, which spawns a child thread (PRI:2321-2341).
3. **Structured tool results are dropped.** `tool_use_result` (structuredPatch, originalFile, stdout/stderr, interrupted, etc.) is read only for TaskCreate/TaskUpdate and Workflow (CA:1877, 4024-4049). It is never put on `item.*.data`. No code in `apps/` or `packages/` references `structuredPatch`.
4. **Tool output body** appears only for `command_execution` and `file_change` (`toolResultStreamKind`, CA:1822-1831; `deriveWorkLogToolDetails`, TCD:336-371). Other types show result text only as the row detail, and only when there was no detail or the call failed (WL:1156-1160). The expanded view is an "Activity" block (state/time) with no input or result (`ToolCallDetailsDialog.tsx:131-187`).
5. **Tool-result text is text-only.** `extractTextContent` (CA:1744-1766) drops image, document, and search_result blocks. Activity data is capped: when it serializes over 16k chars, strings are cut to 2,000 (PRAP:22-23, 293-336).
6. **Dynamic/MCP argument previews** (`ToolName: {json}`) are hidden unless the call failed (TWER:203-209). Most generic rows therefore show only the tool name, plus a file basename when the detail has a path (TWER:192-194).
7. **Subagents:** `forwardSubagentText: true` (CA:6221). Messages whose `parent_tool_use_id` is a recognized Agent/Task call go to a child thread (CA:5214-5239, 1997-2014). Each child has its own transcript. The parent shows `ComposerSubagentStrip` (`ChatView.tsx:5842`). The parent tool row is removed when subagent metadata is present (WL:370-387).
8. **Hooks:** Synara registers only `SessionStart` and `PreToolUse` callbacks (CA:6222-6225). `includeHookEvents` is not set, so `hook_*` messages arrive only for SessionStart/Setup (SDK:1720).

## A. SDKMessage variants (SDK:4616, 42 rows)

| Claude event | Canonical event | Web component | Quality | What's lost | Evidence |
|---|---|---|---|---|---|
| `assistant` (envelope) | blocks → see §B; usage → `thread.token-usage.updated`; `error` → turn failed + `runtime.error` | message bubble, ContextWindowMeter, `ThreadErrorBanner` | CLEAN | `aborted`, `supersedes`, `resumed_from_incomplete_thinking`, `context_usage` ignored | CA:4207-4415, 4217-4225, 4392-4408 |
| `user` with `tool_result` | `item.updated` + `content.delta` (cmd/file only) + `item.completed` | tool row (see §D) | CLEAN | `tool_use_result` structured payload (fact 3) | CA:3939-4119, 1833-1880 |
| `user` SDK-originated text/image (synthetic, `origin` peer / task-notification / channel, hook-injected) | none | none | DROPPED | Whole message. Peer and task-notification deliveries and `origin.body` never render. | CA:3948-3958 (only `tool_result` read), CA:1865 |
| `user` replay (`isReplay: true`) | none | none | DROPPED | Intended: Synara keeps its own history | CA:3939-3958 |
| `result` `success` | `turn.completed` (usage, cost, stopReason) | hidden; feeds meter/cost | STATE | `result` text not used (already streamed); `permission_denials`, `terminal_reason`, `fast_mode_state` ignored | CA:4417-4462, PRAP:1266-1304, WL:652-658 |
| `result` `error_during_execution` / `error_max_turns` / `error_max_budget_usd` / `error_max_structured_output_retries` | `runtime.error` + `turn.completed(failed\|interrupted)` | `ThreadErrorBanner` "Task interrupted" | PARTIAL | Only `errors[0]` kept; subtype not named; `permission_denials` dropped | CA:4438-4449, PRAP:778-801, MT:1433-1451 |
| `stream_event` | see §C | — | CLEAN | see §C | CA:3750-3937 |
| `system:init` | `session.configured` → `context-window.configured` | hidden | STATE | tools, MCP status, slash commands, skills, plugins not surfaced in transcript (`initToolNames` kept) | CA:4794-4805, PRAP:698-716 |
| `system:compact_boundary` | `thread.state.changed{compacted}` → `context-compaction` | compaction row (TWER:249) | CLEAN | `preserved_segment` metadata | CA:4841-4858, PRAP:1090-1110 |
| `system:status` | `session.state.changed`; `compacting` → compaction progress row | compaction row / session status | PARTIAL | `compact_result: failed` + `compact_error` text dropped; `permissionMode` change not projected | CA:4829-4840, 2697 |
| `system:api_retry` | `runtime.warning` "Request retry n/m in Xs (HTTP s)" | italic notice row | CLEAN | `error` category | CA:4806-4816, PRAP:811-833 |
| `system:control_request_progress` | unhandled warning | none | DROPPED | all (Synara does not use side_question) | CA:5120-5126 |
| `system:model_refusal_fallback` | `model.rerouted` | generic info row | GENERIC | `api_refusal_category/explanation`; `retracted_message_uuids` not applied, so retracted text stays visible | CA:4757-4779, 964-996, PRAP:858-875, TWER:113-146 |
| `system:model_refusal_no_fallback` | unhandled warning | none | DROPPED | refusal `content`, category, explanation; user sees no reason | CA:5120-5126 |
| `system:local_command_output` | unhandled warning | none | DROPPED | slash-command output (/usage, /cost …) | CA:5120-5126 |
| `system:hook_started` | `hook.started` | none | DROPPED | all (PRAP drops) | CA:4859-4869, PRAP:1306-1310 |
| `system:hook_progress` | `hook.progress` | none | DROPPED | stdout/stderr | CA:4870-4881, PRAP:1306-1310 |
| `system:hook_response` | `hook.completed` | `runtime.warning` only on fail/block/stop | PARTIAL | success output, stdout/stderr | CA:4882-4895, PRAP:1316-1360 |
| `system:plugin_install` | unhandled warning | none | DROPPED | install status/errors | CA:5120-5126 |
| `tool_progress` | `tool.progress` → `tool.updated` with `itemType` forced to `mcp_tool_call` | elapsed time on matching row (merge key `toolUseId`, WL:2841) | PARTIAL | `subagent_retry`; Bash/Agent progress relabeled as MCP (DB shows 209 Agent + 105 Bash updates typed `mcp_tool_call`, event-frequency.md:169) | CA:5152-5164, PRAP:343-361, 1248-1264 |
| `auth_status` | `auth.status` | plain notice (latest only) | PARTIAL | `output` lines never stored | CA:5182-5193, PRAP:1221-1246, WL:599 |
| `system:task_notification` | `task.completed` | background strip, `WorkflowRunCard`, synthetic "Subagent/Background task completed" row | CLEAN | `output_file`, `resource_links` | CA:5013-5074, PRAP:922-1063, WL:522-575 |
| `system:task_started` | `task.started` | background strip / `WorkflowRunCard` / subagent strip | CLEAN | `prompt`, `spawn_depth` | CA:4896-4976, `session-logic.ts:282-460` |
| `system:task_updated` | `task.updated` (status / isBackgrounded / error only) + child `session.state.changed` | strip state | PARTIAL | `description`, `end_time`, `total_paused_ms` patches (CA:4637 comment: "Non-status patches stay dropped") | CA:4638-4736 |
| `system:task_progress` | `task.progress` | "Reasoning trace" row, summary "Reasoning update" | GENERIC | Mislabeled as reasoning; `last_tool_name` not shown; `usage` goes to meter | CA:4977-5012, PRAP:963-975, `agentActivity.logic.ts:24-34` |
| `system:background_tasks_changed` | `runtime.warning` (added tasks only) | "Moved to background" row with tray icon | CLEAN | removals (settle via task lifecycle) | CA:5097-5119, PRAP:806-835, TWER:252 |
| `system:thinking_tokens` | none | none | DROPPED | intended (high-frequency telemetry) | CA:4626-4632 |
| `system:session_state_changed` | unhandled warning | none | DROPPED | Synara derives its own state | CA:5120-5126 |
| `system:worker_shutting_down` | unhandled warning | none | DROPPED | reason (bridge-only) | CA:5120-5126 |
| `system:commands_changed` | unhandled warning | none | DROPPED | refreshed slash-command list | CA:5120-5126 |
| `system:notification` | unhandled warning | none | DROPPED | `text`, priority | CA:5120-5126 |
| `system:files_persisted` | `files.persisted` | none (counted as progress signal only) | DROPPED | file ids, failures | CA:5075-5096, `ProjectionSnapshotQuery.ts:267` |
| `tool_use_summary` | `tool.summary` | status text row → `AgentActivityDetailView` | CLEAN | — | CA:5166-5180, PRAP:1194-1219, `agentActivity.logic.ts:37, 61-67` |
| `system:memory_recall` | unhandled warning | none | DROPPED | recalled memory paths/content ("Recalled from memory") | CA:5120-5126 |
| `rate_limit_event` | `account.rate-limits.updated` (+ `account.rate-limited`) | `RateLimitBanner` | CLEAN | — | CA:5195-5203, PRAP:1362-1450, `RateLimitBanner.tsx:28` |
| `system:elicitation_complete` | unhandled warning | none | DROPPED | MCP URL elicitation completion | CA:5120-5126 |
| `system:permission_denied` | `runtime.warning` "Tool was denied: reason" | italic notice, not linked to the tool row | GENERIC | `tool_use_id` link, `decision_reason_type` | CA:4817-4828 |
| `prompt_suggestion` | unhandled type warning (option not enabled) | none | DROPPED | suggestion text (`promptSuggestions` not set, CA:6184-6234) | CA:5275-5282 |
| `system:mirror_error` | unhandled warning | none | DROPPED | Synara does not configure SessionStore | CA:5120-5126 |
| `system:informational` | unhandled warning | none | DROPPED | `content` banner text: hook block reasons, slash output, warnings | CA:5120-5126 |
| `conversation_reset` | none (cache/usage reset) | none | STATE | — | CA:5253-5262 |
| `system:vcs_state_changed` (untyped, matched structurally) | `vcs.state.changed` | git metadata refresh | STATE | — | CA:998-1024, 4783-4791, `ThreadGitMetadataReactor.ts:328` |

## B. Content blocks (Anthropic SDK 0.100.0 `BetaContentBlock` messages.d.ts:864, `BetaContentBlockParam` :868)

| Claude block | Canonical event | Web component | Quality | What's lost | Evidence |
|---|---|---|---|---|---|
| assistant `text` | `item.*{assistant_message}` + `content.delta{assistant_text}` | assistant markdown bubble, segmented around tool rows | CLEAN | `citations` | CA:3779-3811, 3886-3893, 2540-2600; PRI:2774-2875 |
| assistant `thinking` | `item.*{reasoning}` + `content.delta{reasoning_text}` | collapsed "Reasoning trace" rows → `AgentActivityDetailView` | PARTIAL | not inline; text capped at 8,000 chars per block | CA:3671-3748, 4309-4336; PRAP:24, 664-696 |
| assistant `redacted_thinking` | none | none | DROPPED | no "redacted reasoning" marker | CA:3763 (only `thinking`), 3894-3899 (early return), 4313 |
| assistant `tool_use` | `item.started/updated/completed` | per tool, see §D | (§D) | see §D | CA:3886-3918, 3603-3668 |
| assistant `server_tool_use` (advisor, web_search, web_fetch, code_execution, tool_search) | `item.started` via name heuristic (`web_search` → `dynamic_tool_call`; `text_editor_code_execution` → `file_change`) | generic row, closed only at turn end | PARTIAL | result never attached; status forced at `completeTurn` | CA:3894-3897, 4238-4241, 3370-3397 |
| assistant `web_search_tool_result` | none | none | DROPPED | results/citations | no handler (CA:1865 reads user `tool_result` only) |
| assistant `web_fetch_tool_result` | none | none | DROPPED | fetched content | same |
| assistant `advisor_tool_result` | none | none | DROPPED | advisor answer | same |
| assistant `code_execution_tool_result` | none | none | DROPPED | stdout/stderr/files | same |
| assistant `bash_code_execution_tool_result` | none | none | DROPPED | stdout/stderr | same |
| assistant `text_editor_code_execution_tool_result` | none | none | DROPPED | edit result | same |
| assistant `tool_search_tool_result` | none | none | DROPPED | tool references | same |
| assistant `mcp_tool_use` | `item.*` via name heuristic | per §D MCP row | PARTIAL | misclassification risk (fact 2) | CA:3896, 4241 |
| assistant `mcp_tool_result` | none | none | DROPPED | result; item closes at turn end | same as `web_search_tool_result` |
| assistant `container_upload` | none | none | DROPPED | file id | no handler |
| assistant `compaction` | none | none | DROPPED | summary content (compaction is shown via `compact_boundary`) | no handler |
| user prompt text (Synara-originated) | orchestration user message (not from SDK stream) | user bubble | CLEAN | — | MT:1642-1688 |
| user prompt `image` / file attachment (Synara-originated) | orchestration attachments | `UserImageAttachmentThumbnail`, `FileAttachmentChip` | CLEAN | — | MT:1642-1649, 1777-1800, 3305-3345 |
| `tool_result` text, cmd / file_change tools | `content.delta{command_output\|file_change_output}` → `data.rawOutput.output` | shell transcript / file details | CLEAN | 24k buffer cap | CA:4000-4022, PRI:506-550, 2755-2766 |
| `tool_result` text, other tools | `item.completed.data.result` only | row detail only when no detail or failed | PARTIAL | success output not viewable | WL:1156-1160, TCD:336-371 |
| `tool_result` `is_error: true` | `item.*{status: failed}` | failed row; error text inline (TWER:208) | CLEAN | — | CA:3961, 3987 |
| `tool_result` `image` | none (text extraction drops it) | none | DROPPED | screenshots, Read of PNG | CA:1744-1766, 1876; PRAP:23 |
| `tool_result` `document` / `search_result` / `tool_reference` | none | none | DROPPED | PDF pages, search results, deferred-tool refs | CA:1744-1766 |

## C. Stream events (`BetaRawMessageStreamEvent` messages.d.ts:1532, deltas :1466)

| Claude event | Canonical event | Web component | Quality | What's lost | Evidence |
|---|---|---|---|---|---|
| `message_start` / `message_delta` / `message_stop` | none (reasoning key + cache timing) | none | STATE | usage comes from the `assistant` snapshot instead | CA:3760-3777 |
| `content_block_start` (text / thinking / tool_use / server_tool_use / mcp_tool_use) | assistant text block open / reasoning `item.started` / tool `item.started` | as §B | CLEAN | other block types ignored (CA:3894-3899) | CA:3763-3766, 3886-3918 |
| `text_delta` | `content.delta{assistant_text}` | streaming bubble | CLEAN | — | CA:3780-3811 |
| `thinking_delta` | `content.delta{reasoning_text}` | Reasoning trace preview (250 ms throttle) | PARTIAL | 8k cap | CA:3767-3770, PRI:1347-1370 |
| `input_json_delta` | `item.updated` with refreshed detail (on complete JSON parse) | live row heading/args | CLEAN | — | CA:3813-3882 |
| `signature_delta` | none | none | DROPPED | intended | CA:3779-3884 (no branch) |
| `citations_delta` | none | none | DROPPED | citations | same |
| `compaction` delta | none | none | DROPPED | — | same |
| `content_block_stop` | completes text block / reasoning item | — | CLEAN | — | CA:3771-3773, 3921-3936 |

## D. Built-in tools (SDKT `ToolInputSchemas`, SDKT:11-57; names inferred from input types; untyped runtime tools marked *)

Classification column = `classifyToolItemType` result (CA:1184-1235).

| Claude tool (key inputs) | Canonical itemType | Web component | Quality | What's lost | Evidence |
|---|---|---|---|---|---|
| `Agent` / legacy `Task` (description, prompt, subagent_type, model, run_in_background, isolation) | `collab_agent_tool_call` + child thread | `ComposerSubagentStrip`; child thread transcript; fallback agent row → `AgentActivityDetailView` | CLEAN | not inline-nested under the parent row; `isolation`, `model` not shown | CA:1196-1206, 1310, 5214-5239; PRI:2148-2356; WL:370-387; TWER:591-594, 797-820 |
| `Bash` (command, timeout, description, run_in_background) | `command_execution` | command row + bash transcript block | CLEAN | exit code (absent from text result); stdout/stderr split; `interrupted`; `description` | CA:1207-1214, 4000-4022; TCD:129-201; `ToolCallDetailsDialog.tsx:50-56, 207-248` |
| `TaskOutput` (task_id, block, timeout) | `dynamic_tool_call` | generic row "TaskOutput" | GENERIC | task output body | CA:1235 |
| `TaskStop` (task_id/shell_id) | `dynamic_tool_call` | generic row | GENERIC | which task | CA:1235 |
| `ExitPlanMode` (plan, allowedPrompts) | `turn.proposed.completed` (tool row suppressed) | `ProposedPlanCard` | CLEAN | `allowedPrompts` | CA:1294-1296, 5906-5926, 4279-4293; WL:679-692; MT:2711-2720 |
| `Edit` (file_path, old_string, new_string, replace_all) | `file_change` | "Edited `file` +A/−D" row; Before/After panes; turn diff in DiffPanel | CLEAN | SDK `structuredPatch`/`gitDiff` (stats come from checkpoint diff); `replace_all`; strings cut to 2,000 when data > 16k | CA:1215-1225; TCD:203-231, 263-330; TWER:699-766; PRAP:293-336 |
| `Write` (file_path, content) | `file_change` | Edited row + "Written Content" | CLEAN | content > ~16k JSON truncated to 2,000 chars | TCD:374-388; PRAP:22-23 |
| `Read` (file_path, offset, limit, pages) | `dynamic_tool_call` | row with search icon + basename; click opens file viewer | PARTIAL | line range / pages; result content; image/PDF result blocks | TWER:221-227, 673-693; CA:1744-1766 |
| `Glob` (pattern, path) | `dynamic_tool_call` | generic row "Glob" | GENERIC | pattern (args hidden), matched files | TWER:203-209 |
| `Grep` (pattern, path, glob, output_mode, …) | `dynamic_tool_call` | generic row "Grep" (+ basename if path) | GENERIC | pattern, matches | TWER:192-209 |
| `NotebookEdit` (notebook_path, cell_id, new_source, edit_mode) | `file_change` | "Edited" row without file or edit panes | PARTIAL | `notebook_path` and `new_source` not recognized | TCD:256, 270 (`file_path` / `old_string` keys only) |
| `WebFetch` (url, prompt) | `dynamic_tool_call` | row with site favicon + URL | PARTIAL | `prompt`; fetched summary | TCL:34-70; TWER:560-563 |
| `WebSearch` (query, allowed/blocked_domains) | `web_search` | "Searched the web" row | GENERIC | `query` (args hidden); results | CA:1229-1231; TCL:693 |
| `TodoWrite` (todos) | `plan` (row dropped) + `turn.tasks.updated` | "X of N tasks completed" row + `ComposerActiveTaskListCard` / `TaskProgressSteps` | CLEAN | — | CA:1186-1195, 3660-3667, 3874-3881, 2933-2972; PRAP:877-895, 1160; WL:1188-1208; `TaskProgressSteps.tsx:26-55` |
| `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList` | `plan` (row dropped) + tracked tasks → `turn.tasks.updated` | task list card | CLEAN | Get/List reads leave no trace (intended) | CA:1189-1192, 4024-4038 |
| `AskUserQuestion` (questions[header, question, options[label, description, preview], multiSelect], annotations, metadata) | `user-input.requested/resolved` (tool row suppressed) | `ComposerPendingUserInputPanel` → `UserInputQuestionForm`; `UserInputExchange` | PARTIAL | option `preview`; `annotations`/`metadata`; question id = `header`, so duplicate headers collide | CA:5719-5796, 5743-5755; PRAP:897-920; MT:2722 |
| `EnterPlanMode` | `dynamic_tool_call` | generic row | GENERIC | mode switch not signalled | CA:1235 |
| `mcp__<server>__<tool>` | `mcp_tool_call`, or misclassified (fact 2) | MCP row with brand icon (github / synara / browser / computer) | GENERIC | input + result body; wrong type and icon for names with create/edit/file/delete/agent/command… | CA:1215-1228; TWER:305-358, 566-589 |
| `ListMcpResourcesTool` / `ReadMcpResourceTool` / `ReadMcpResourceDir` / `RefreshMcpTools` | `mcp_tool_call` | generic MCP row | GENERIC | resource list / content | CA:1226-1228 |
| `Workflow` (script, name, args, scriptPath, resumeFromRunId) | `dynamic_tool_call` + `task.*` workflow lifecycle | `WorkflowRunCard` (+ generic row) | CLEAN | — | CA:4040-4085, 4919-4947; `WorkflowRunCard.logic.ts:298-380` |
| `Monitor` (description, command, timeout_ms, persistent) | `dynamic_tool_call` | generic row | GENERIC | command, streamed events | CA:1235 |
| `CronCreate` / `CronDelete` | `file_change` (misclassified: "create"/"delete") | "Edited" row with no file | PARTIAL | cron, prompt; wrong type | CA:1215-1225 |
| `CronList`, `ScheduleWakeup`, `RemoteTrigger`, `PushNotification`, `REPL`, `Artifact`, `Projects`, `ClaudeDesign`, `SendFeedback`, `ReportFindings`, `ProposeSkills`, `ProposeGoal`, `ReadNotifications`, `ShowOnboardingRolePicker`, `EnterWorktree`, `ExitWorktree` | `dynamic_tool_call` | generic row (name only) | GENERIC | all inputs (e.g. REPL code, findings, worktree path) and results | CA:1235; TWER:203-209 |
| `Skill`* (skill, args) | `dynamic_tool_call` | generic row "Skill" | GENERIC | skill name hidden with args | CA:1235 |
| `ToolSearch`*, `SendMessage`*, `LSP`* | `dynamic_tool_call` | generic row | GENERIC | inputs/results | CA:1235 |
| legacy `MultiEdit` (file_path, edits[]) — absent from 0.3.259 types | `file_change` | Edits panes (TCD reads `edits[]`) | CLEAN | — | TCD:321-329 |
| legacy `KillShell` / `BashOutput` / `SlashCommand` — absent from 0.3.259 types | `command_execution` (contains shell/bash/command) | command row; the start row is suppressed when there is no `command` | PARTIAL | target shell id; may render empty | CA:1207-1214; WL:1228-1236 |

## E. Permissions, hooks, subagent control

| Claude event | Canonical event | Web component | Quality | What's lost | Evidence |
|---|---|---|---|---|---|
| `canUseTool` (generic tool, supervised mode) | `request.opened/resolved` → `approval.requested/resolved` | `ComposerPendingApprovalPanel`; routine accepts hidden | CLEAN | SDK `title`/`description`/`blockedPath`/`decisionReason` unused; detail capped at 400 chars and redacted | CA:5975-6080, 1250-1288; PRAP:718-776; `ComposerPendingApprovalPanel.tsx:165-290` |
| `canUseTool` AskUserQuestion | `user-input.requested` | see §D | PARTIAL | see §D | CA:5902-5904 |
| `canUseTool` ExitPlanMode | `turn.proposed.completed`; tool denied with "plan captured" | `ProposedPlanCard` | CLEAN | — | CA:5906-5926 |
| `canUseTool` in full-access / auto-allow | none (allowed silently) | — | STATE | intended | CA:5963-5968 |
| Synara `SessionStart` hook | cache observation | cache UI (`ClaudeCacheDetails.tsx`) | STATE | — | CA:5690-5700 |
| Synara `PreToolUse` hook (subagent steer delivered) | `turn.steered{target: subagent}` on child | generic info row | GENERIC | — | CA:4175-4205; PRAP:1065-1088 |
| User-settings hooks (PreToolUse, PostToolUse, Stop, UserPromptSubmit, …) | not emitted (`includeHookEvents` unset) | none | DROPPED | hook activity; block reasons arrive only via `informational` (also dropped) | CA:6222-6225; SDK:1720 |
| Subagent message routing (`parent_tool_use_id`) | child thread events | child thread transcript | CLEAN | settled-task tail is dropped (intended); unrecognized parents stay on the parent thread | CA:5214-5239, 1997-2014 |

## Totals

Counted from the Quality column. The §B `tool_use` row points to §D and is not counted.

| Bucket | A | B | C | D | E | Total |
|---|---|---|---|---|---|---|
| CLEAN | 10 | 5 | 4 | 9 | 3 | 31 |
| GENERIC | 3 | 0 | 0 | 12 | 1 | 16 |
| PARTIAL | 6 | 4 | 1 | 6 | 1 | 18 |
| DROPPED | 19 | 13 | 3 | 0 | 1 | 36 |
| STATE | 4 | 0 | 1 | 0 | 2 | 7 |
| Rows | 42 | 22 | 9 | 27 | 8 | 108 |

Of the 36 DROPPED rows, 5 are intended (user replay, `thinking_tokens`, `signature_delta`, plus `mirror_error` and `worker_shutting_down`, which Synara's setup never triggers). 13 system subtypes / types fall to `warnUnhandledSdkKind`.

## Top gaps (by user impact)

1. **Generic tool bodies.** Read, Grep, Glob, WebSearch, WebFetch, Skill, MCP and every dynamic tool show name-only rows. Their inputs are hidden (TWER:203-209) and their results are not viewable (TCD:336-371). Read is the most frequent Claude tool after Bash and Edit (event-frequency.md:116-118).
2. **Item-type heuristic bugs** (CA:1184-1235). MCP tools named create/edit/file/delete become `file_change`. Tools containing "agent" become `collab_agent_tool_call` and spawn child threads. CronCreate/CronDelete become `file_change`. `tool.progress` relabels Bash/Agent as `mcp_tool_call` (PRAP:347).
3. **Dropped user-visible text.** `informational`, `local_command_output`, `notification`, `model_refusal_no_fallback`, `memory_recall`, and SDK-originated user messages (peer / task-notification). Each unhandled kind adds one content-free "Unhandled …" warning row.
4. **Images and documents in tool results** are stripped (CA:1744-1766), so screenshots and Read of images or PDFs are invisible.
5. **Structured results unused.** Edit/Write `structuredPatch`, Bash stdout/stderr/exit status (fact 3).
6. **Reasoning.** Not inline, capped at 8k; `redacted_thinking` leaves no marker; `task_progress` is mislabeled "Reasoning update" (PRAP:970).
7. **Server-tool results** (advisor, web_search, code_execution, MCP-connector) are dropped. Their items close only at turn end with no result.
