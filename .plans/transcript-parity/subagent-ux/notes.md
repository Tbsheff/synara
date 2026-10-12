# Subagent UX: current vs proposed

Mockup: [mockup.html](mockup.html). Screenshots: `state-{a..e}-dark.png`, `state-a-light.png`, `state-d-light.png`, `reference-dark.png`. These are 2x renders of each section, made with agent-browser (Chrome) from the `file://` URL.

The tokens in the mockup are the resolved output of `buildThemeCssVariables()` for the default theme, plus the static tokens in `index.css`. The fonts are 13 px base, with `ui-sm` 12, `ui-xs` 11, and `ui-lg` 14 (`getAppTypographyScale`). The icons are copied from `apps/web/public/central-icons-*`, Tabler 3.44, and `lib/hugeicons.tsx`. The markup uses the real Tailwind class strings, so you can lift it into TSX.

## TL;DR of the proposal

1. Each spawn call (Claude `Agent`/`Task`, Codex `spawnAgent`) gets **one card at its spawn point**. The current code drops it (`omitRoutedSubagentWorkEntries`, `useChatWorkLog.ts:102`).
2. The card header uses the tool-row shell: "Running 3 agents · 1:12", then "Running 1 of 3 agents · 2:41 · 1 failed", then "Ran 3 agents · 6:03". Each agent has one `AgentRow`: dot, name, (role), model · effort, progress ("Using Read"), background glyph, elapsed, status.
3. **State changes update the card in place.** The transcript gets no "Moved to background", "Subagent finished: X", or "N updates - …" rows. A settled row keeps a two-line result or error preview. When expanded, it shows WorkflowRunCard's detail block plus a Result section and "Open thread".
4. **A wake turn is its own response.** A quiet divider ("Resumed after X finished · Show agents") replaces the completion row. The wake reply is never folded into "Worked for".
5. The composer strip stays the live control surface. It adds elapsed time, a background glyph instead of the word, a "Show in transcript" action, and Codex-style header counts ("2 running · 1 done").

## Current state (what the code renders today)

| Surface | Source | Problem |
|---|---|---|
| No row at the spawn point | `isRoutedSubagentWorkEntry` + `omitRoutedSubagentWorkEntries` (`workLog.ts` ~450, `useChatWorkLog.ts:102`) | You cannot see where the agents started or what they were asked. Claude and Codex both have this problem. |
| "Moved to background `<n tasks: …>`" | `background_tasks_changed` → `runtime.warning`, tray icon (`TimelineWorkEntryRow.tsx` ~284) | Session-wide set with turnId null. It also lists the background tasks of nested subagents. |
| "N updates - Using Grep" | `deriveAgentActivityTimelineState` reasoning grouping | Mixes agents. The working tree now skips Claude `task.progress` rows, so the row is gone for Claude, but nothing replaces it in the transcript. |
| "Subagent finished / failed: X" | `deriveBackgroundTaskCompletionEntries` (`workLog.ts` ~692) | Clutters the transcript between parent tool rows. It is also the **response boundary** (`MessagesTimeline.logic.ts:638-649`), which is the root of the folded-reply bug (`../collapsed-replies-rootcause.md`). |
| Composer strip | `ComposerSubagentStrip` + `.logic.ts`, derived in `useChatWorkLog.ts:274` (not in `ChatView.logic.ts`) | No elapsed time, "background" as a bare word, no result or error, no link to the spawn point. It retires when everything settles. |
| Codex "X started working" / "X finished" notices | `subAgentActivity` → transcript notice (`CodexAdapter.ts` ~1946) | One row per agent per lifecycle step. This is the Codex version of the "Subagent finished" clutter. |
| `AgentActivityDetailView` | `agentActivity.logic.ts` | Routed agents cannot reach it. For background agents, "Result" is the launch placeholder text. |

## Component mapping

| Mockup piece | Existing component | Change / new props |
|---|---|---|
| Spawn card (header + rows) | New `TranscriptSubagentCard`, rendered from `TimelineWorkEntryRow` for routed `collab_agent_tool_call` entries | Replace the omit with a card at the entry. The header reuses the tool-row shell (`AgentActivityOpenSurface` classes, `WORK_ROW_MUTED_HOVER_TONE`), `LiveStatusSpinner`/`BotIcon`, and `DisclosureChevron`. The body is a `DisclosureRegion` with `ml-7 rounded-lg border border-border/45 bg-background/60` (the same box as the typed tool details). |
| Agent row | `WorkflowAgentRowView` (`WorkflowRunCard.tsx`) | Extract to `chat/AgentRow.tsx`. Add `progress?`, `isBackground?` (tray glyph), and `preview?: { kind: "result" \| "error"; text }`. WorkflowRunCard, ComposerSubagentStrip, and the card all use it. |
| Expanded detail | `WorkflowAgentDetail` | Extract to `AgentRowDetail`. Add an optional `result?: string` section (ChatMarkdown, 4-line clamp plus disclosure). Identity, stats, Prompt, Recent, and Open thread stay as they are (the mockup adds only an ArrowUpRight glyph to "Open thread"). |
| Status | `StatusDot`, `subagentStatusDotClassName`, `subagentStatusTextToneClassName` | No change |
| Elapsed ticker | `useNowMs` + `formatClockDuration` (WorkflowRunCard) | Tick locally inside the card, never in ChatView |
| Roster model | `ComposerSubagentStrip.logic.ts` (`mergeSubagentSnapshots`, `collectLatestTaskProgress`) | Extract to `subagentRoster.logic.ts`: `deriveSubagentRoster(entries) → Map<spawnEntryId, AgentRowModel[]>`. The strip and the card read the same model. |
| Card in a settled turn | `collapsedComputerActionEntries` / `synaraThreadCreationRecaps` (`MessagesTimeline.tsx` ~2059-2072) | Lift spawn cards out of the collapsed "Worked for", as these entries already are |
| Wake marker | None (closest: the "Worked for" divider) | New `SubagentWakeMarker`. It needs a turn-level wake flag. |
| Completion rows | `deriveBackgroundTaskCompletionEntries` | Stop rendering `local_agent` completions. **First** move the response boundary to turnId plus the wake flag. |
| Codex "X started working / finished" notices | `subAgentActivityNotice` (`CodexAdapter.ts` ~1946) | Hide in the transcript when the agent has a card. Its lifecycle feeds the card status. |
| "Moved to background" | `background_tasks_changed` row | Hide for `local_agent` tasks that have a card. Keep for `local_bash`, or route it to the background-work row. |
| Composer strip | `ComposerSubagentStrip` | Item: `elapsedLabel`, `spawnEntryId`. Prop: `onRevealInTranscript(item)`. Header label from counts. Use `BackgroundTrayIcon` instead of the word. |
| Fallback detail | `AgentActivityDetailView` | Keep for non-routed collab rows (OpenCode task, `ListAgents`). The card does not use it. |

## Data per field

| Field | Source today | Status |
|---|---|---|
| Name, role, model, effort, prompt | `WorkLogSubagent` (receiver metadata + identity directory) | Have |
| Status | `WorkLogSubagent.isActive/rawStatus/statusLabel` | Have |
| Open thread target | `resolvedThreadId` | Have |
| Progress (Claude) | `task.progress` detail = SDK `summary`, or `"Using <lastToolName>"` (`claudeTaskProgressSummary`). Keyed by taskId and toolUseId. | Partial: the SDK writes model progress summaries only when `agentProgressSummaries` is on, and it is off (0 hits in `apps/server` and `packages`). Today the line is always "Using X" or empty. |
| Progress (Codex) | Lifecycle only: `subAgentActivity` (started / interacted / interrupted / finished) is mapped to a `subagent-activity` notice (`CodexAdapter.ts` ~1946). `agentsStates[id]` has status and message. Codex sends no progress text. | **Gap**: derive it from the child thread's latest work entry. That needs the detail subscription, which `useChatWorkLog` keeps only while the agent runs. |
| Start / end time | Claude: `task.started` createdAt (payload has `toolUseId`), `task.completed` createdAt, `usage.duration_ms`. Codex: spawn entry createdAt. | **Gap (web only)**: `WorkLogSubagent` has no `startedAt`/`endedAt` |
| Tokens, tool calls | `usage { total_tokens, tool_uses, duration_ms }` on the task.progress and task.completed activity payloads | **Gap (web only)**: projected, but not read into the roster |
| Recent tools | `lastToolName` on each task.progress payload | **Gap (web only)**: keep the last 5 per toolUseId |
| Result preview | Background: `task.completed` detail (SDK `summary`). Foreground: collab entry `detail` (Agent tool_result). Codex: `ParsedSubagentAgentState.message`. | Partial: **`task.completed` has no toolUseId.** The SDK `task_notification` has `tool_use_id`, but `ClaudeAdapter.ts` (`case "task_notification"`) does not forward it. Fix it server-side (add `toolUseId` to the payload and projection), or join on the web through `task.started` (taskId → toolUseId). |
| Error text | Same as the result, with status `failed` | Partial (same join) |
| Wake turn flag | `raw.method = "claude/synthetic-turn-start"` on the server | **Gap**: not on the projected turn or messages |
| Which agent woke the parent | The last `task.completed` before the wake turn start | Partial: infer it by order, or have the server stamp it |

## Open questions

1. **This reverses a stated decision.** The comment above `isRoutedSubagentWorkEntry` says that "the transcript never renders a subagent roster". Is the move to one card per spawn approved?
2. **Strip and card duplication.** Should the strip compact to its header while the card is on screen (IntersectionObserver), or always stay expanded?
3. **Wake marker style.** Use a quiet divider (proposed), a Codex-style "{name} finished" row, or nothing? The marker is the only thing that explains why the parent spoke again with no user message.
4. **Sizing conflict.** Transcript tool rows size from the chat font prop (`textFontSizePx`), but the new card uses `text-ui*` as asked. The two differ when the chat and UI font settings differ. Which one should the card follow?
5. Enable `agentProgressSummaries` for model-written progress lines? This costs extra tokens per agent.
6. Nested subagents: should their background tasks show only in the child thread? Today they leak into the parent's "Moved to background".
7. Light mode: the `-300` status hues are low contrast on white (see `state-a-light.png`). Use `-500`/`-600` in light?
8. In a settled turn, lift the card out of "Worked for" (shown), or keep it inside the fold?
9. Default open state: open while any agent runs, closed when all settle?

## Order of work (suggested)

1. Server: forward `tool_use_id` on `task.completed`, and stamp the wake flag on turns that `claude/synthetic-turn-start` starts.
2. Web: change the response boundary in `MessagesTimeline.logic.ts` to turnId plus the wake flag, and remove its dependence on `backgroundTaskCompletion` rows. This fixes the folded-reply bug without the card.
3. Extract `AgentRow` / `AgentRowDetail` / `subagentRoster.logic.ts`. Switch WorkflowRunCard and the strip to them, with no visual change.
4. Add `TranscriptSubagentCard`, replace the omit, hide the `local_agent` completion and "Moved to background" rows, and add the wake marker.
5. Strip props (elapsed, glyph, reveal, header counts).
