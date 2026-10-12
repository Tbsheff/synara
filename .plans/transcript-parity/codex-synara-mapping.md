# Codex app-server → Synara transcript mapping

Source of truth for the Codex protocol: `codex-cli 0.162.1` (`/opt/homebrew/bin/codex`), `codex app-server generate-ts` into `/tmp/codex-proto-OPm5/ts` (`ServerNotification.ts`, `ServerRequest.ts`, `v2/ThreadItem.ts`). The repo does not vendor the generated protocol types. Synara parses the payloads loosely in `CodexAdapter.ts`.

Inventory: **86 ServerNotification methods, 10 ServerRequest methods, 19 ThreadItem variants.**

## Pipeline (one pass, cited once)

| Stage | File:line | Behavior |
|---|---|---|
| Manager forwards notifications | `apps/server/src/codexAppServerManager.ts:4360-4450` | Every notification is emitted as a `ProviderEvent`. The only exceptions: child-conversation lifecycle (`thread/*`, `turn/*`, `tokenUsage`) is suppressed at `:5373-5390`, and `thread/started|closed|status/changed` are suppressed during a gateway renewal at `:4373-4380`. |
| Raw events opt-out | `codexAppServerManager.ts:780` | `experimentalRawEvents: false`, so `rawResponse*` is never sent. |
| Manager handles requests | `codexAppServerManager.ts:4644-4826` | Approvals (command, file-read, file-change, permissions, MCP tool) get a `requestId` and are parked. `requestUserInput` is parked. Non-tool MCP elicitations are auto-cancelled (`:4697-4711`). Synara gateway MCP tools are auto-accepted (`:4666-4695`). **Every other request is answered `-32601 Unsupported` (`:4820-4825`), but it has already been emitted to the adapter (`:4784`).** |
| Adapter dispatch | `apps/server/src/provider/Layers/CodexAdapter.ts:1155-1968` (`mapToRuntimeEvents`) | Each method goes to a canonical `ProviderRuntimeEvent`. An unmatched method goes to `event.unmapped` (`:1123`, `:1967`). |
| Item type normalization | `CodexAdapter.ts:385-417` | camelCase is turned into words and matched by substring. `hookPrompt`, `functionCallOutput`, `subAgentActivity`, and `sleep` become `unknown`, and `mapItemLifecycle` drops them (`:945`). |
| Unmapped filter | `CodexAdapter.ts:1117-1121`, `:2592-2601`; `apps/server/src/provider/unmappedProviderEvents.ts` (`makeUnmappedProviderEventGate`) | `skills/changed` and `remoteControl/status/changed` are diagnostic-only and are dropped. Methods that end in `delta\|progress\|partial\|chunk\|update\|updated` surface **once per thread and lifecycle generation**, and the rest of the burst is dropped. |
| Activity projection | `apps/server/src/orchestration/providerRuntimeActivityProjection.ts:652-1482` | Tool items become `tool.started/updated/completed`, but only for `TOOL_LIFECYCLE_ITEM_TYPES` (`packages/contracts/src/providerRuntime.ts:111-120`). Non-tool items return `[]` (`:1160`). Codex reasoning produces a row only on `item.completed` (`:662-693`). |
| Activity data bound | `providerRuntimeActivityProjection.ts:22-26`, `:293-340` | `payload.data` is the whole Codex notification `{threadId, turnId, item}`. If it serializes to more than 16 000 chars, strings are cut to 2 000 chars (then 800), arrays to 24 (then 12) items, and objects to 64 keys. |
| Ingestion side effects | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` | Assistant deltas and messages: `:2774-2870`, completion at `:2881-2930`. Proposed plan buffer: `:2879`, `:2940`. Tool output buffer: `:2755-2766`, merged at `:3219-3235` via `:506-528`. Turn diff (git only): `:3144`. Subagent child threads: `:2344-2358`. Claude-only reasoning preview: `:1347-1351`. |
| Web derivation | `apps/web/src/workLog.ts:389-451`, `:1120-1365`; `apps/web/src/components/chat/agentActivity.logic.ts:125-199`; `apps/web/src/pendingInteractionDerivation.ts:254-310` | Activities become work-log rows. Hidden kinds: `task.*`, `context-window.*`, `account.rate-limits.updated`, non-error `turn.completed` (`workLog.ts:405-418`, `:652-673`). |
| Web rendering | `apps/web/src/components/chat/MessagesTimeline.tsx:1479` uses `TimelineWorkEntryRow.tsx`, with disclosure in `ToolCallDetailsDialog.tsx:27-121` | `provider.event.unmapped` renders as a plain one-line row titled with the native method. JSON-looking detail is hidden (`TimelineWorkEntryRow.tsx:192-201`), `data` is never shown, and the row has no disclosure (`:681-688`). |

Quality key: **CLEAN** = purpose-built UI or a correct non-transcript surface (meter, banner, sidebar). **GENERIC** = generic row, label only, or method name. **PARTIAL** = rendered but fields or liveness lost. **DROPPED** = never visible. **DROPPED (by design)** = lifecycle or bookkeeping that is not transcript content.
Reach: **live** = sent during normal Synara turns. **gated** = sent only for an API that Synara never calls (`command/exec`, `process/*`, `fs/watch`, `fuzzyFileSearch`, `thread/realtime/start`, `externalAgentConfig`, `account/login`, raw events).

## 1. ThreadItem variants (via `item/started` / `item/completed`)

| Codex item | Canonical event | Web component | Quality | What's lost | Evidence |
|---|---|---|---|---|---|
| userMessage | `item.*` itemType `user_message` → no activity | User bubble comes from Synara's own `thread.turn-start` message, not from this item | CLEAN | The Codex echo is ignored. Prompts that Codex injects or that other clients send are not shown. `clientId` is unused. | `CodexAdapter.ts:399`; projection `:1160` |
| hookPrompt | none (`unknown`) | — | DROPPED | Hook-injected prompt fragments are invisible | `CodexAdapter.ts:945` |
| agentMessage | `content.delta` `assistant_text` + `item.completed` `assistant_message` (+ `asyncQuestions`) | `ChatMarkdown` assistant message, streaming (`MessagesTimeline.tsx:2383`); `AsyncUserInputCard` (`:2356-2362`) | CLEAN | `phase` (commentary vs final), `memoryCitation`, and `delivery` are never read. Commentary renders the same as the final answer. | `CodexAdapter.ts:400`, `:972-984`; `ProviderRuntimeIngestion.ts:2881-2930` |
| functionCallOutput | none (`unknown`) | — | DROPPED | The whole item | `CodexAdapter.ts:945` |
| plan | `item.completed` → `turn.proposed.completed`; `item.started` → no activity | `ProposedPlanCard` (`MessagesTimeline.tsx:2711-2719`; `workLog.ts:3199-3227`) | CLEAN | Final card only. Streaming is covered by the `item/plan/delta` row. | `CodexAdapter.ts:1515-1528`; `ProviderRuntimeIngestion.ts:2940` |
| reasoning | `item.completed` `reasoning`, detail = `summary` only | "Reasoning trace" `task.progress` row; detail view `AgentActivityDetailView.tsx` | PARTIAL | Not live for Codex. `content` (raw reasoning) is dropped by design. Detail is cut at 2 000 chars for Codex (8 000 for Claude). | `CodexAdapter.ts:968-970`; projection `:662-693`; `ProviderRuntimeIngestion.ts:1351` |
| commandExecution | `item.started/completed` `command_execution`, title "Ran command", detail = `command` | `TimelineWorkEntryRow` + `ToolCallDetailsDialog` (`:50-56`, `:207-225`) | PARTIAL | `exitCode` is never read from `item.exitCode`. `durationMs`, `cwd`, and `aggregatedOutput` have no web reads. Output comes only from the buffered deltas (`rawOutput.output`), so it is duplicated in `data` next to `aggregatedOutput` and reaches the 16 000-char bound sooner. No live output. | `lib/toolCallDetails.ts:129-201`, `:352-366`; `ProviderRuntimeIngestion.ts:506-528` |
| fileChange | `file_change`, title "File change" | "Edited <file>" rows (`TimelineWorkEntryRow.tsx:700-766`); +N/−M comes from the turn diff | PARTIAL | `changes[].diff` and `changes[].kind` are never read. If buffered output exists, the row becomes an output disclosure and loses the open-turn-diff link (`:731`). | `workLog.ts:2924-2984`; `lib/toolCallDetails.ts:203-231` |
| mcpToolCall | `mcp_tool_call`, title from `appContext.actionName`, `tool`, or "MCP tool call" | Row with MCP/GitHub/Synara icon (`TimelineWorkEntryRow.tsx:571-589`); disclosure shows state and time only | GENERIC | `arguments`, `result`, `error`, `durationMs`, and `mcpAppUi` (MCP app UI is not rendered). No tool details are built for MCP (`lib/toolCallDetails.ts:336-371`). | `CodexAdapter.ts:419-434`, `:452-455` |
| dynamicToolCall | `dynamic_tool_call` | Same generic row (`TimelineWorkEntryRow.tsx:286`) | GENERIC | `arguments`, `contentItems`, `success`, `durationMs` | `CodexAdapter.ts:455` |
| collabAgentToolCall | `collab_agent_tool_call` (no `itemTitle` case). Child conversation events are routed to a Synara subagent thread. | Inline preview (`TimelineWorkEntryRow.tsx:797-820`), `AgentActivityDetailView.tsx:55-211`, subagent strip (`ChatView.logic.ts:2133-2171`) | CLEAN | Little is lost | `CodexAdapter.ts:409`; `ProviderRuntimeIngestion.ts:2327`, `:2344-2358` |
| subAgentActivity | none (`unknown`) | — | DROPPED | `kind`, `agentPath`, `model`, `reasoningEffort` | `CodexAdapter.ts:945` |
| webSearch | `web_search`, title "Web search" | Row "Searched the web", globe icon (`toolCallLabel.ts:701`) | GENERIC | `query` and `action` (`itemDetail` has no query field) | `CodexAdapter.ts:488-517` |
| imageView | `image_view`, detail = `path` | Row with basename and eye icon | GENERIC | No image preview | `CodexAdapter.ts:505`; `TimelineWorkEntryRow.tsx:193`, `:280` |
| sleep | none (`unknown`) | — | DROPPED | Wait duration and reason | `CodexAdapter.ts:945` |
| imageGeneration | `image_generation` + artifact; ingestion attaches the image to the assistant message | Row + image in `ChatMarkdown.tsx:1335` | CLEAN | Completion is dropped if no image reference resolves | `CodexAdapter.ts:948-962`; `ProviderRuntimeIngestion.ts:2951` |
| enteredReviewMode | `item.*` `review_entered` → no activity | — | DROPPED | Review start marker and review target | `CodexAdapter.ts:412`; projection `:1160` |
| exitedReviewMode | `item.completed` remapped to `assistant_message` (detail = `review`); the manager settles the review turn | Assistant message markdown | CLEAN | Rendered as plain prose. `item.started` is dropped. | `CodexAdapter.ts:964-965`; `codexAppServerManager.ts:4553-4608` |
| contextCompaction | `context_compaction` → `context-compaction` activity | Row with compaction icon (`TimelineWorkEntryRow.tsx:249`) | CLEAN | Can repeat with `thread/compacted` ("Context compacted manually") | projection `:1135-1158`, `:1090-1110` |

## 2. ServerNotification methods

| Codex event | Canonical event | Web component | Quality | What's lost | Evidence | Reach |
|---|---|---|---|---|---|---|
| error | `runtime.error` (or `runtime.warning` when `willRetry` or non-fatal) | "Task interrupted" banner (`MessagesTimeline.tsx:1435-1450`) or italic notice | PARTIAL | A `runtime.error` row is dropped if the turn later completes or is interrupted (`workLog.ts:482-487`). With no turnId it falls back to a generic row. | `CodexAdapter.ts:1898-1917` | live |
| thread/started | `thread.started` | none (session binding) | DROPPED (by design) | — | `CodexAdapter.ts:1319-1334` | live |
| thread/status/changed | `thread.state.changed` | none | DROPPED (by design) | — | `CodexAdapter.ts:1352-1376`; projection `:1090-1093` | live |
| thread/archived | `thread.state.changed` archived | none | DROPPED (by design) | — | same | live |
| thread/deleted | `event.unmapped` | Plain row "thread/deleted" | GENERIC | Payload | `CodexAdapter.ts:1967` | live |
| thread/unarchived | `thread.state.changed` | none | DROPPED (by design) | — | `CodexAdapter.ts:1352` | live |
| thread/closed | `thread.state.changed` closed | none | DROPPED (by design) | — | same | live |
| thread/reverted | `event.unmapped` | Plain row "thread/reverted" | GENERIC | Synara calls `thread/revert`, so this row is user-reachable | `CodexAdapter.ts:1967` | live |
| skills/changed | `event.unmapped` → filtered | — | DROPPED (by design) | — | `CodexAdapter.ts:1117-1121`, `:2599` | live |
| thread/name/updated | `thread.metadata.updated` | Thread title (sidebar), not transcript | CLEAN | — | `CodexAdapter.ts:1378-1389`; `ProviderRuntimeIngestion.ts:3135` | live |
| thread/attachment/updated | `event.unmapped` (burst) | Plain row, once per generation | GENERIC | Every later update | unmapped gate | live |
| thread/goal/updated | `event.unmapped` (burst) | Plain row, once | GENERIC | Goal text, status, every later update | unmapped gate | live |
| thread/prediction/updated | `event.unmapped` (burst) | Plain row, once | GENERIC | Payload | unmapped gate | live |
| thread/goal/cleared | `event.unmapped` | Plain row | GENERIC | Payload | `CodexAdapter.ts:1967` | live |
| thread/queue/changed | `event.unmapped` | Plain row | GENERIC | Queue contents | same | live |
| project/changed | `event.unmapped` | Plain row | GENERIC | Payload | same | live |
| thread/project/updated | `event.unmapped` (burst) | Plain row, once | GENERIC | Payload | unmapped gate | live |
| thread/environment/connected | `event.unmapped` | Plain row | GENERIC | Payload | `CodexAdapter.ts:1967` | live |
| thread/environment/disconnected | `event.unmapped` | Plain row | GENERIC | Payload | same | live |
| thread/settings/updated | `event.unmapped` (burst) | Plain row, once | GENERIC | Payload | unmapped gate | live |
| thread/tokenUsage/updated | `thread.token-usage.updated` → `context-window.updated` | `ContextWindowMeter` (hidden from transcript) | CLEAN | — | `CodexAdapter.ts:1391-1406`; projection `:1112-1130` | live |
| turn/started | `turn.started` | Working indicator / session state | CLEAN | — | `CodexAdapter.ts:1408-1424` | live |
| hook/started | `hook.started` | none | DROPPED (by design) | Journal only | `CodexAdapter.ts:1060-1090`; projection `:1306-1310` | live |
| turn/completed | `turn.completed` | Hidden unless failed ("Task interrupted"); "Worked for X" collapse | CLEAN | `usage` and `stopReason` are not shown | `CodexAdapter.ts:1426-1446`; `workLog.ts:652-658` | live |
| hook/completed | `hook.completed` → `runtime.warning` only when failed, blocked, or stopped | Italic notice | PARTIAL | Successful hooks and their output are hidden (by design) | `CodexAdapter.ts:1091-1112`; projection `:1312-1360` | live |
| turn/diff/updated | `turn.diff.updated` → provider-diff placeholder checkpoint | "Edited N files" card (`MessagesTimeline.tsx:2463-2580`) | PARTIAL | Ignored in workspaces that are not git repos | `CodexAdapter.ts:1486-1500`; `ProviderRuntimeIngestion.ts:3144-3146` | live |
| turn/plan/updated | `turn.tasks.updated` | Task row + `ComposerActiveTaskListCard` | CLEAN | — | `CodexAdapter.ts:1460-1484`; `workLog.ts:1188-1208` | live |
| item/started | `item.started` (per item, see §1) | see §1 | see §1 | — | `CodexAdapter.ts:1502-1505` | live |
| item/autoApprovalReview/started | `event.unmapped` | Plain row | GENERIC | Review target | `CodexAdapter.ts:1967` | live |
| item/autoApprovalReview/completed | `runtime.warning` only when denied or aborted; approved → nothing | Italic notice | PARTIAL | Approved reviews are invisible | `CodexAdapter.ts:1245-1264` | live |
| autoApprovalReview/strictReviewRequired | `event.unmapped` | Plain row | GENERIC | Payload | `CodexAdapter.ts:1967` | live |
| item/completed | `item.completed` (per item, see §1) | see §1 | see §1 | — | `CodexAdapter.ts:1507-1532` | live |
| rawResponseItem/completed | `event.unmapped` | Plain row | GENERIC | — | `codexAppServerManager.ts:780` | gated (`experimentalRawEvents:false`) |
| rawResponse/completed | `event.unmapped` | Plain row | GENERIC | — | same | gated |
| item/agentMessage/delta | `content.delta` `assistant_text` | Live streaming `ChatMarkdown` | CLEAN | — | `CodexAdapter.ts:1562-1593`; `ProviderRuntimeIngestion.ts:2774-2870` | live |
| item/plan/delta | `turn.proposed.delta` | Buffered; card appears only at completion | PARTIAL | Not live | `CodexAdapter.ts:1542-1560`; `ProviderRuntimeIngestion.ts:2879` | live |
| command/exec/outputDelta | `event.unmapped` (burst) | Plain row, once | GENERIC | — | unmapped gate | gated |
| process/outputDelta | `event.unmapped` (burst) | Plain row, once | GENERIC | — | unmapped gate | gated |
| process/exited | `event.unmapped` | Plain row | GENERIC | — | `CodexAdapter.ts:1967` | gated |
| item/commandExecution/outputDelta | `content.delta` `command_output` | Buffered server-side, merged into `rawOutput.output` at completion | PARTIAL | Not live; capped at 24 000 chars before the 2 000-char string bound | `ProviderRuntimeIngestion.ts:205`, `:2755-2766`, `:3231-3235` | live |
| item/commandExecution/terminalInteraction | `item.updated` itemType `unknown` | none | DROPPED | `stdin` sent to the PTY; the expected buffered-output refresh never happens (itemType is not command) | `CodexAdapter.ts:1534-1540`; projection `:1160`; `ProviderRuntimeIngestion.ts:540` | live |
| item/fileChange/outputDelta | `content.delta` `file_change_output` | Buffered, shown as disclosure output at completion | PARTIAL | Not live; replaces the turn-diff link on the row | same as commandExecution/outputDelta | live |
| item/fileChange/patchUpdated | `event.unmapped` (burst) | Plain row "item/fileChange/patchUpdated", once | GENERIC | Live patch progress (`changes`) | unmapped gate | live |
| serverRequest/resolved | `request.resolved` → `approval.resolved` | Clears the pending panel; accepted rows hidden | CLEAN | — | `CodexAdapter.ts:1614-1631`; `workLog.ts:660-673` | live |
| item/mcpToolCall/progress | `tool.progress` → `tool.updated` | Live status detail on the MCP row (`workLog.ts:1438-1446`) | CLEAN | — | `CodexAdapter.ts:1595-1612`; projection `:1248-1264` | live |
| mcpServer/oauthLogin/completed | `mcp.oauth.completed` | none (no consumer) | DROPPED | Success or error of the OAuth login | `CodexAdapter.ts:1822-1834`; no consumer in server or web | live |
| mcpServer/startupStatus/updated | `event.unmapped` (burst) | Plain row, once | GENERIC | Status of each server after the first | unmapped gate | live |
| mcpServer/event/stream/notification | `event.unmapped` | Plain row | GENERIC | Payload | `CodexAdapter.ts:1967` | live |
| account/updated | `account.updated` | none | DROPPED (by design) | — | `CodexAdapter.ts:1798-1808` | live |
| account/gatewayOAuth/changed | `event.unmapped` | Plain row | GENERIC | Payload | `CodexAdapter.ts:1967` | live |
| account/rateLimits/updated | `account.rate-limits.updated` | `RateLimitBanner` (hidden from transcript) | CLEAN | — | `CodexAdapter.ts:1810-1820`; projection `:1362-1450` | live |
| app/list/updated | `event.unmapped` (burst) | Plain row, once | GENERIC | Payload | unmapped gate | live |
| remoteControl/status/changed | `event.unmapped` → filtered | — | DROPPED (by design) | — | `CodexAdapter.ts:1117-1121` | live |
| externalAgentConfig/import/progress | `event.unmapped` (burst) | Plain row, once | GENERIC | — | unmapped gate | gated |
| externalAgentConfig/import/completed | `event.unmapped` | Plain row | GENERIC | — | `CodexAdapter.ts:1967` | gated |
| fs/changed | `event.unmapped` | Plain row | GENERIC | — | same | gated |
| item/reasoning/summaryTextDelta | `content.delta` `reasoning_summary_text` | Buffered; "Reasoning trace" appears only at completion | PARTIAL | Not live for Codex (the preview is Claude-only) | `CodexAdapter.ts:658`; `ProviderRuntimeIngestion.ts:431-460`, `:1351` | live |
| item/reasoning/summaryPartAdded | `item.updated` itemType `unknown` | none | DROPPED | Harmless: the buffer is keyed by `summaryIndex` | `CodexAdapter.ts:1534-1540` | live |
| item/reasoning/textDelta | `content.delta` `reasoning_text` | none (Codex raw reasoning is not buffered) | DROPPED (by design) | Raw reasoning text | `ProviderRuntimeIngestion.ts:431-460` | live |
| thread/compacted | `thread.state.changed` compacted → `context-compaction` | Row "Context compacted manually" | CLEAN | Can repeat with the contextCompaction item; the label says "manually" even for auto-compaction | `CodexAdapter.ts:1352-1376`; projection `:1090-1110` | live |
| model/rerouted | `model.rerouted` | Generic row "Model switched: a -> b" | GENERIC | from/to are only in the label | `CodexAdapter.ts:1753-1765`; projection `:858-873` | live |
| model/verification | `event.unmapped` | Plain row | GENERIC | `verifications[]` | `CodexAdapter.ts:1967` | live |
| modelProvider/authRecoveryStarted | `event.unmapped` | Plain row | GENERIC | Payload | same | live |
| modelProvider/authRecoveryCompleted | `event.unmapped` | Plain row | GENERIC | Payload | same | live |
| turn/moderationMetadata | `event.unmapped` | Plain row (bare method name) | GENERIC | `metadata` JSON hidden | same | live |
| model/safetyBuffering/updated | `event.unmapped` (burst) | Plain row, once | GENERIC | Later updates | unmapped gate | live |
| warning | `event.unmapped`, detail = `message` | Plain row "warning" + message preview | GENERIC | Not styled as a warning | `CodexAdapter.ts:1123-1150` | live |
| guardianWarning | `event.unmapped`, detail = `message` | Plain row "guardianWarning" + message | GENERIC | Same | same | live |
| deprecationNotice | `deprecation.notice` | none (no consumer) | DROPPED | `summary` and `details`. A mapped event shows less than an unmapped one would. | `CodexAdapter.ts:1767-1779`; no consumer | live |
| configWarning | `config.warning` | none (no consumer) | DROPPED | `summary`, `details`, `path`, `range` | `CodexAdapter.ts:1781-1796`; no consumer | live |
| fuzzyFileSearch/sessionUpdated | `event.unmapped` (burst) | Plain row, once | GENERIC | — | unmapped gate | gated |
| fuzzyFileSearch/sessionCompleted | `event.unmapped` | Plain row | GENERIC | — | `CodexAdapter.ts:1967` | gated |
| thread/realtime/started | `thread.realtime.started` | none | DROPPED | — | `CodexAdapter.ts:1836-1847` | gated |
| thread/realtime/itemAdded | `thread.realtime.item-added` | none | DROPPED | — | `CodexAdapter.ts:1849-1859` | gated |
| thread/realtime/item/started | `event.unmapped` | Plain row | GENERIC | — | `CodexAdapter.ts:1967` | gated |
| thread/realtime/item/transcript/delta | `event.unmapped` (burst) | Plain row, once | GENERIC | — | unmapped gate | gated |
| thread/realtime/item/completed | `event.unmapped` | Plain row | GENERIC | — | `CodexAdapter.ts:1967` | gated |
| thread/realtime/transcript/delta | `event.unmapped` (burst) | Plain row, once | GENERIC | — | unmapped gate | gated |
| thread/realtime/transcript/done | `event.unmapped` | Plain row | GENERIC | — | `CodexAdapter.ts:1967` | gated |
| thread/realtime/outputAudio/delta | `thread.realtime.audio.delta` | none | DROPPED | — | `CodexAdapter.ts:1861-1871` | gated |
| thread/realtime/sdp | `event.unmapped` | Plain row | GENERIC | — | `CodexAdapter.ts:1967` | gated |
| thread/realtime/error | `thread.realtime.error` | none | DROPPED | — | `CodexAdapter.ts:1873-1884` | gated |
| thread/realtime/closed | `thread.realtime.closed` | none | DROPPED | — | `CodexAdapter.ts:1886-1896` | gated |
| windows/worldWritableWarning | `runtime.warning` | Italic notice | CLEAN | — | `CodexAdapter.ts:1919-1930` | live (Windows) |
| windowsSandbox/setupCompleted | `session.state.changed` (+ `runtime.warning` on failure) | Italic notice on failure | CLEAN | — | `CodexAdapter.ts:1932-1960` | live (Windows) |
| account/login/completed | `event.unmapped` | Plain row | GENERIC | — | `CodexAdapter.ts:1967` | gated |

Manager-synthesized and legacy methods are excluded from the counts: `session/*`, `turn/aborted`, `thread/compacting`, `item/requestApproval/decision`, `item/tool/requestUserInput/answered`, `process/stderr`, `*/unrenderable`, `codex/event/*` (`CodexAdapter.ts:1267-1317`, `:1336-1350`, `:1448-1458`, `:1226-1243`, `:1633-1751`).

## 3. ServerRequest methods

| Codex request | Canonical event | Web component | Quality | What's lost | Evidence | Reach |
|---|---|---|---|---|---|---|
| item/commandExecution/requestApproval | `request.opened` `command_execution_approval` → `approval.requested` | `ComposerPendingApprovalPanel` (`:165-266`) | CLEAN | `cwd`, parsed `commandActions`, and network/execpolicy context are not shown. `reason` is shown only when `command` is absent. | `CodexAdapter.ts:1186-1222`; projection `:718-776` | live |
| item/fileChange/requestApproval | `file_change_approval` | Same panel | PARTIAL | No diff in the approval panel | same | live |
| item/tool/requestUserInput | `user-input.requested` | `ComposerPendingUserInputPanel` (`ChatView.tsx:6049`); answered Q&A rows | CLEAN | Requests without renderable questions are declined, with a warning (`codexAppServerManager.ts:4808-4818`) | `CodexAdapter.ts:1187-1201` | live |
| mcpServer/elicitation/request | MCP tool approval → `tool_approval` panel. Synara gateway tools are auto-accepted. Other elicitations are auto-cancelled and produce `runtime.warning`. | Approval panel / italic notice | PARTIAL | Form and URL elicitations cannot be answered | `codexAppServerManager.ts:4666-4711` | live |
| item/permissions/requestApproval | `permissions_approval` | Approval panel; `permissionProfile` rendered as raw JSON (`ComposerPendingApprovalPanel.tsx:291`) | PARTIAL | Profile not formatted for people | projection `:528-540` | live |
| item/tool/call | `request.opened` `dynamic_tool_call`, but the manager already replied `-32601` | Stale "Approval requested" row. No panel, because there is no `requestId` (`pendingInteractionDerivation.ts:163-167`). | DROPPED | The call is refused and the row is misleading | `codexAppServerManager.ts:4820-4825` | gated (Synara registers no `dynamicTools`) |
| account/chatgptAuthTokens/refresh | `auth_tokens_refresh`, refused `-32601` | Stale "Approval requested" row | DROPPED | Token refresh fails | same; `pendingInteractionDerivation.ts:268-276` | gated (Synara never calls `account/login/start` with external tokens) |
| attestation/generate | `unknown`, refused `-32601` | Stale "Approval requested" row | DROPPED | — | `CodexAdapter.ts:554-556` | gated (`requestAttestation` not set, `codexAppServerManager.ts:921-923`) |
| applyPatchApproval (legacy v1) | `apply_patch_approval`, refused `-32601` | Stale row, no panel | DROPPED | Legacy path; not used by v2 threads | same | gated (v1 only) |
| execCommandApproval (legacy v1) | `exec_command_approval`, refused `-32601` | Stale row, no panel | DROPPED | Same | same | gated (v1 only) |

## 4. Streaming deltas: rendered live?

| Delta | Live in UI? | Evidence |
|---|---|---|
| item/agentMessage/delta | **Yes** (streaming mode; buffered mode when the setting is off) | `ProviderRuntimeIngestion.ts:136`, `:2774-2870`; `MessagesTimeline.tsx:2383` |
| item/reasoning/summaryTextDelta | **No.** Buffered; row appears at `item.completed`. The live preview is Claude-only. | `ProviderRuntimeIngestion.ts:1351`; projection `:662-669` |
| item/reasoning/textDelta | **No.** Never shown (by design). | `ProviderRuntimeIngestion.ts:431-460` |
| item/commandExecution/outputDelta | **No.** Buffered (24 000-char cap) and merged at completion. The running row shows label and "Active Ns ago" only. | `ProviderRuntimeIngestion.ts:2755-2766`, `:3231-3235`; `lib/liveActivityPresentation.ts:142-170` |
| item/fileChange/outputDelta | **No.** Same buffer. | same |
| item/fileChange/patchUpdated | **No.** One generic row per generation. | unmapped gate |
| item/plan/delta | **No.** Buffered; `ProposedPlanCard` at completion. | `ProviderRuntimeIngestion.ts:2879`, `:2940` |
| item/commandExecution/terminalInteraction | **No.** Dropped (`unknown` item.updated). | `CodexAdapter.ts:1534-1540` |
| item/mcpToolCall/progress | **Yes.** Status detail on the row. | `workLog.ts:1438-1446` |

## Counts

Item rows count each ThreadItem once. `item/started` and `item/completed` are excluded from the notification count because §1 covers them. Counts were computed from the table rows above.

| Bucket | Items (19) | Notifications (84) | Requests (10) | Total (113) | Gated (not sent to Synara today) | Live (86) |
|---|---|---|---|---|---|---|
| CLEAN | 7 | 12 | 2 | 21 | 0 | 21 |
| PARTIAL | 3 | 8 | 3 | 14 | 0 | 14 |
| GENERIC | 4 | 44 | 0 | 48 | 17 | 31 |
| DROPPED (gap) | 5 | 10 | 5 | 20 | 10 | 10 |
| DROPPED (by design) | 0 | 10 | 0 | 10 | 0 | 10 |

Convention difference from `claude-synara-mapping.md`: 5 CLEAN notification rows go to a correct surface that is not the transcript. They are `thread/name/updated` (sidebar title), `thread/tokenUsage/updated` (context meter), `account/rateLimits/updated` (banner), `turn/started` (working indicator), and `turn/completed` (collapse / failure banner). Counting only purpose-built transcript UI gives CLEAN 16.

Verified by direct grep: `exitCode` is read from `rawOutput`, `data`, `data.item.result`, and `data.result`, but not from `data.item.exitCode` (`apps/web/src/lib/toolCallDetails.ts:134-139`, `:182-189`). `aggregatedOutput` and Codex `durationMs` have no reads in `apps/web/src` or `packages/shared/src`.

Unverified:
- Whether a refused request (`item/tool/call` and others; all are gated today) leaves a stale "Approval requested" row. The projection writes the activity without a `requestId` (`providerRuntimeActivityProjection.ts:718-776`). `derivePendingApprovals` skips it (`pendingInteractionDerivation.ts:163-167`), so no panel appears. Whether `workLog.ts` still draws a row was not confirmed.
- No row was checked against a live Codex session. All results come from code reading only.

## Top gaps (ranked by user impact, live paths only)

1. **Command and file-change output is not live, and exit code and duration are lost.** Synara buffers `outputDelta` server-side (`ProviderRuntimeIngestion.ts:2755-2766`). It never reads `item.exitCode`, `durationMs`, `cwd`, `aggregatedOutput`, or `fileChange.changes[].diff`.
2. **Codex reasoning summary is not live.** The preview is gated to `claudeAgent` at `ProviderRuntimeIngestion.ts:1351`. Plan text (`item/plan/delta`) is also buffered until completion.
3. **MCP, dynamic, and web-search tool rows are label-only.** No arguments, result, error, search query, or MCP app UI.
4. **`configWarning` and `deprecationNotice` are mapped to canonical events that nothing consumes**, so they are invisible. Unmapped `warning` and `guardianWarning` show only as bare method-name rows.
5. **`hookPrompt`, `subAgentActivity`, `sleep`, `functionCallOutput`, `enteredReviewMode`, `terminalInteraction`, and `mcpServer/oauthLogin/completed` are dropped** at `CodexAdapter.ts:945`, projection `:1160`, or for lack of a consumer.
6. **26 live `event.unmapped` methods appear as bare method-name rows**, for example thread/goal/*, thread/queue/changed, thread/reverted, mcpServer/startupStatus/updated, model/verification, and item/fileChange/patchUpdated. Methods ending in `updated`, `delta`, or `progress` surface only once per generation.
7. **Non-tool MCP elicitations are auto-cancelled** (`codexAppServerManager.ts:4697-4711`). Permission approvals show `permissionProfile` as raw JSON.
