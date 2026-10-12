# Codex desktop transcript renderers — parity catalog

Read-only reverse-engineering of the official Codex desktop renderer, for Synara transcript parity.

## Source

| Fact | Value |
|---|---|
| App bundle | `/Applications/ChatGPT.app` (no `Codex.app` on this machine; Codex was merged into the ChatGPT desktop app) |
| Bundle id / productName | `com.openai.codex` / `Codex` (package `openai-codex-electron`) |
| Version | `26.1002.52244` (build `13536`) |
| Extracted asar | `/tmp/codex-src-xjDG9Z/app` (scratch; delete when done). Renderer chunks in `webview/assets/` |
| Codex++ | The asar contains no `codexpp`/`codex-plusplus` loader strings, so Codex++ is not hooked into ChatGPT.app. It patched the old `/Applications/Codex.app`, which no longer exists. Everything below is the stock renderer. |
| String source | formatjs `defaultMessage` literals (English) inline in the chunks. 49,846 unique message ids were dumped to `/tmp/codex-scripts/uniq.tsv` (id, English text, `chunk@offset`). |

Offsets are character offsets into the minified chunk. `AS` = `app-shared-6c00c2afcf84.js`, `SER` = `sites-end-resource-7e6c33984bd6.js` (despite the name, this chunk holds almost every transcript row renderer), `IFM` = `inline-followup-markdown-393383ad831c.js` (unit grouping), `SPLIT` = `split-items-into-render-groups-ccefa3223a00.js`, `LCT` = `local-conversation-turn-310d2b91b0d8.js`, `AP` = `app-primary-15d1279f1ff0.js`, `UMA` = `user-message-attachments-e1dfd22082fe.js`, `AAI` = `agent-activity-item-e4e1a1c7e3f6.js`.

## Pipeline (4 layers)

1. **Notification to store.** `AS@~2803000–2830000`. Items are kept as app-server `ThreadItem`s on the turn. Some notifications become synthetic items:
   - `turn/plan/updated` pushes `{type:"todo-list"}` (`AS@2822227`).
   - `model/rerouted` pushes `{type:"modelRerouted"}` (`AS@2822923`).
   - The `error` notification pushes `{type:"error", willRetry, errorInfo, additionalDetails}` (same offset).
   - `turn/diff/updated` sets `turn.diff` (`AS@2822115`).
   - Live command output is capped at the **last 20,000 chars**, prefixed with `[output truncated]\n` (`fen`/`pen=2e4`, `AS@2781644`, `@2782200`, `@2791250`).
2. **Item to view-model (`m1`).** `AS@4915906–4936700`. One switch maps each `ThreadItem` to a UI item type (`exec`, `patch`, `reasoning`, `web-search`, …). Item types with no case here are never rendered.
3. **Turn layout (`SPLIT`).** This layer splits the view-model list into these slots:
   - `userItems`
   - `agentItems`, the activity area
   - `assistantItem`, the final answer, which is pulled out of the activity area
   - `postAssistantItems`
   - `systemEventItem`, a trailing `system-error`
   - `unifiedDiffItem`, the **last** `turn-diff`
   - `todoListItem`, the **last** `todo-list`
   - `proposedPlanItem`
   - `approvalItem`
   - `userInputItem`
   - `permissionRequestItems`
   - `mcpServerElicitationItems`
   - `modelChangedItems` and `modelReroutedItems`
   - and similar slots for the remaining special items.
4. **Activity units and rows.**
   - `AAI ur()` (`AAI@20324`) classifies each agent item as `groupable`, `standalone`, or hidden (`null`).
   - `IFM I()` (`IFM@6351`) folds **consecutive groupable items into one group**. Any standalone item breaks the group.
   - `IFM Je()` (`IFM@20703`) turns a completed group of one item back into a standalone row. Exception: a patch that touches more than one file stays a group.
   - The group header and row renderers are in `SER` (`pD`/`hD`/`vD` near `@326500–346000`). The per-item switch `zE` is at `SER@~303000–326000`.

### Activity classification (`AAI@20324`, verbatim intent)

| Classification | Item types |
|---|---|
| groupable | `exec`, `patch` (standalone when declined by auto-review: `It` = `AP` export `au`, the same predicate `SER` uses as `uf(n)?\`auto-review-declined\``), `mcp-tool-call` (standalone when it is an MCP-app widget), `web-search` (hidden when the query is empty), `dynamic-tool-call` (unless its renderer is standalone or hidden), `external-event`, `automatic-approval-review` while `inProgress` |
| standalone | `image-view`, `context-compaction`, `multi-agent-action`, `stream-error`, `system-error`, `subagent-activity`, `assistant-message` (commentary), `user-message` (steer), `worked-for`, `worktree-init`, `user-input-response`, completed `mcp-server-elicitation`, `realtime-transcript`, `strict-review-notice`, `auto-review-interruption-warning`, `automatic-approval-review` when denied, aborted, or timedOut |
| null (not an activity row; rendered elsewhere or not at all) | `reasoning`, `todo-list`, `turn-diff`, `proposed-plan`, `plan-implementation`, `userInput`, `permission-request`, `model-changed`, `model-rerouted`, `personality-changed`, `forked-from-conversation`, `remote-task-created`, `automation-update`, `steered`; `automatic-approval-review` when approved |

Evidence: `case\`exec\`:case\`patch\`:return $(fr(e),It(e)?\`standalone\`:\`groupable\`);` … `case\`reasoning\`:…case\`turn-diff\`:case\`userInput\`:case\`steered\`:return null` (`AAI@20324`).

### Exploration sub-units

- `IFM X()` (`IFM@12623`) merges consecutive `exec` items whose parsed type is `read`, `search`, or `list_files` into one `exploration` unit. A `reasoning` item between them is absorbed into the unit.
- The unit status is `exploring` or `explored`.
- **The live UI never shows "Explored N files, M searches".** That string exists only in the Markdown export (see below).

## Turn-level behavior

| Behavior | What Codex does | Evidence |
|---|---|---|
| Activity collapse after the turn | Once the final assistant message starts and the turn was not cancelled, everything before the final answer collapses behind a toggle row. Default is collapsed (`isCollapsed: !forceExpanded && (persisted ?? !preventAutoCollapse)`). The row has a chevron that rotates 90° when expanded. Expand/collapse animates height + opacity + `translateY(-8px)`, 150 ms in reduced motion. | `XD`/`ZD`/`eO`/`tO` at `SER@~357000–362000` |
| Toggle label | `Worked for {time}` (`localConversation.workedFor.v2`). Fallbacks: `{count} previous messages` (`localConversation.previousMessagesSummary`) when there is no duration, `Activity` when status is unknown, `Paused`, `You stopped after {time}`. Denied auto-review actions add `· {n} denied actions`, which is clickable. | `AP@1142695` (`MJ`), `collapsed-turn-disclosure-f20a015d7689.js@853` |
| While running | `Working for {time}`, ticking, shown only when ≥1 s has elapsed; before that, `Working`. Uses tabular-nums. | `AP@1142695`, `AP@455166` |
| Duration format | (Worked-for is traced; the exec elapsed formatter `kS=jd` is *inferred* to be the same function.) `<1s` → hidden (exec) or `0s` (worked-for). `<60s` → `12s`. Otherwise `2m 5s`; with hours `1h 0m 5s`. Worked-for trims zero units (`1h 5s`). Uses `Intl.NumberFormat` units with `unitDisplay:"narrow"`. | `XYe`/`yR` `AP@454797` |
| What stays visible when collapsed | Persistent units: user steering messages, hook-feedback user messages, async/visible assistant messages, persistent dynamic tool calls, MCP-app widgets (when enabled). Everything else is in the collapsible part. A turn whose only unit is a `context-compaction` is never collapsed. | `HD`/`UD` `SER@354557` |
| worked-for insertion | `qxr` inserts a `worked-for` item just before the final answer (completed turns) or before the first non-async `final_answer` (in progress). Cancelled turn → status `unknown`. It is skipped when the turn contains a `sleep` item. | `AS@4939048`, `Evr AS@4870672`, `Dvr` |
| Thinking indicator | When the turn is running and nothing is active: shimmer text `Thinking`. If a `reasoning` item exists, the label becomes the **last non-empty line of the latest reasoning summary**, with Markdown removed and a bold-only line unwrapped (in practice usually the `**Title**` heading). | `LCT@69460–70582` (`fi=hr(t.content)` → `ll initialHeading`); `hr` = `app-initial aeo@6399735`; `thinkingShimmer.default` |
| Active group header | While a group is live, the header shows the active item with shimmer: `Running {command}` (or `Running command` in prose mode), `Editing files`, `Searching the web [for {query}]`, the MCP tool label, `Reading {target}`, `Searching for {query}`, `Listing files [in {folder} folder]`. These use `<action>`/`<detail>` spans; the detail truncates and the action does not wrap. | `bD` `SER@~342000`, `active-tool-activity-label-771a6797add8.js@3893–6766` |
| Completed group header | Summary parts joined with `Intl.ListFormat type:"unit"` (comma list). The first part is capitalized ("leading"); the rest are lowercase. **No numeric counts**, only singular/plural. Parts, in order: `Used {sources} integration(s)`, `Loaded a tool/tools`, `Called a tool/tools`, `Edited a file/Edited files`, `Stopped creating a file/files`, `Read files`, visualization, `Ran a command/Ran commands`, `Searched the web`, then dynamic-tool summary parts. When there are no parts: `Worked`. Example: "Edited files, read files, ran commands". | `h_`/`CD` `SER@38500`, `@345498`; `Oe` `IFM@7312`; messages `SER@40855–46122` |
| Group body | A scrollable list capped at `max-h-56` (224 px) with a vertical fade mask. Rows are separated by a grouped spacer. Repeated MCP calls to the same tool collapse into `{toolName} · {n} calls`. Repeated external events are also merged. | `SER@336500`, `lD SER@~327000` |
| Fixed "in-progress" strip above the composer | While the turn runs (and there is no blocking request), a strip above the composer shows: (a) the **todo pill** `Step {n} / {total}` with a progress donut and a tooltip listing all steps; (b) the **live diff pill** `{n} files changed` with `+x −y`, which opens the review panel; (c) extra fixed content. **The todo list is not rendered inline in the transcript.** | `Vo` `LCT@11300–16600`, `mT SER@~248000` |
| Turn diff card (after the turn) | Rendered when the turn is not in progress, `turn.diff` exists, and the diff is not already shown as an end resource. | `LCT@73719`, `JT SER@~264000–276500` |
| Timestamp separators | Between turns when the day changes or the gap is ≥30 min (`K=18e5`). | `local-conversation-thread-turn-entries-5460cecd925b.js` (`de`/`K`) |
| Failed turn made only of reconnect errors | When a failed turn is just N×`Reconnecting k/N` followed by a terminal error, repeated identical turns are deduped in the full transcript. | `ue` in `local-conversation-thread-turn-entries` (regex `^Reconnecting(?:\.\.\.)?\s+(\d+)\/(\d+)$`) |
| Render mode | `LCT` supports `commentaryDisplay` `all` \| `latest`. Every caller in this build passes `` `all` `` (`local-conversation-thread` ×2, `aeon-thread-detail`, `remote-conversation-page`, `security-route`, `use-imported-setup-opportunity`). So the collapsible `Worked for` path described here is the live path. `latest` (hide completed groups, keep only the current commentary, "Up next" status) is unused/dead in 26.1002. | `grep commentaryDisplay:` across assets; `LCT@79107` |
| Detail level setting | `conversationDetailMode`: `STEPS_PROSE` \| `STEPS_COMMANDS` (default) \| `STEPS_EXECUTION` (mapped to COMMANDS). PROSE hides raw commands (`Running command`), hides patch rows, and hides the turn-diff card. | `AS` (`nP.conversationDetailMode`), `tAn` |

## Per-item catalog

"Renders?" is about the inline transcript. "Group" uses the classification above.

### Core work items

| kind (app-server → UI) | renders? | layout / header format | default state | grouping | streaming | status / errors | evidence |
|---|---|---|---|---|---|---|---|
| `commandExecution` → `exec` (parsed `unknown`/`test`/`lint`/`format`/`noop`) | yes | Collapsed header: `Ran {command}` / `Ran {command} in {elapsed}`; the command is shown raw, truncated to one line. Expanded header: `Ran command [in {elapsed}]` (generic form; the command moves into the body). Running: `Running command [for {elapsed}]` with shimmer; elapsed ticks every 1 s. Interrupted: `Stopped {command} [after {elapsed}]`. Background terminal: `Started background terminal [with {command}]` → `Ran {command}` / `Background terminal finished` / `Background terminal stopped [with {command}]`. `date` commands get special text: `Checking/Checked the current date and time`. Skill scripts show as `script {fileName} from {skillName} skill`. | **collapsed** (`useState("collapsed")`) | groupable | live output via `item/commandExecution/outputDelta`, last 20k chars kept | Body is a shell card: `$ {command}`, `cwd`, output (`No output` when empty), copy buttons. Footer: `✓ Success` when exit 0, `Exit code {code}` otherwise, `Stopped` when interrupted, `Exit code unknown` when null. Declined by auto-review: `Command declined by auto-review[: {command}]` with a warning icon plus `Why it was denied`. An `inProgress` item in an interrupted turn becomes `interrupted`. | `hS`/`Jx` `SER@150500–175000`; footer `on` `UMA@17392`; m1 `AS@4922455` |
| `commandExecution` parsed `read` | yes (only when finished) | `<verb>Read</verb> {path}`. The path is a clickable file link; the label is `displayLabel` (attachment) or the basename. Skill files show `Read {skillName} skill`. **Returns null while in progress.** The in-progress state appears only in the group header (`Reading {target}`). | single line, not expandable | groupable (exploration) | n/a | auto-review decoration only | `lS SER@~160000`; `zE` exec case `SER@~311000` |
| `commandExecution` parsed `search` | yes (only when finished) | `<verb>Searched</verb> for {query} [in {path}]` / `Searched for files`. In progress: `Searching …`, but rows are hidden until finished. | single line | groupable (exploration) | n/a | — | `Zx SER@~157000` |
| `commandExecution` parsed `list_files` | yes (only when finished) | `<verb>Listed</verb> files [in {path}]` (in progress: `Listing`) | single line | groupable (exploration) | n/a | — | `iS SER@~158500` |
| `fileChange` → `patch` | yes, one row **per file** | `Edited {file}` / `Created {file}` / `Deleted {file}`, followed by `+N −M`. A blue dot marks an added file; a red dot marks a deleted file. Expanded header becomes `Edited file` / `Created file` / `Deleted file`. In progress: `Editing`/`Creating`/`Deleting` with shimmer. Interrupted: `Stopped editing/creating/deleting`. Declined or rejected: `Rejected`. Auto-review declined: `File change declined by auto-review: {file}`. | **collapsed** (`useState(false)`); while streaming, the diff body is visible if expanded | groupable. A completed single-file patch alone becomes a standalone row. | `item/fileChange/patchUpdated` updates changes live | Body is an inline diff with an open-file link. When the per-file diff cannot be built (`d(n,r)` returns null; threshold not verified), the row shows `Diff too large to preview`. (The 5,000-line `jT` cap applies to the turn-diff card, not this row.) Empty diff shows `No changes` or `Contents deleted`. Status maps: `completed`→applied, `failed`/`declined`→rejected, `approvalRequestId` with no result→pending (label hidden; approval panel handles it). | `ZC`/`$C SER@208200–222500`; `jT=5e3 SER@~252000`; m1 `AS@4923200` |
| `mcpToolCall` → `mcp-tool-call` | yes | Label comes from a large per-app table (`localConversation.mcpToolActivity.*`, 901 strings; e.g. `Clicked in {appName}`). Generic fallback: the **tool name humanized to sentence case**, with app-name prefix words removed (`search_issues` → "Search issues"). Icon: the app logo. Body: arguments and result content blocks, with `Show raw tool call output`; empty result shows `Tool returned no content`. | collapsed row | groupable (standalone when it is an MCP-app widget) | completed when `status != inProgress` or the turn ends | `failed` status is counted as a failed tool | `Fxr AS@4915906`; `ya mcp-tool-activity-label@471614`; `Lm` in `SER` |
| `dynamicToolCall` → `dynamic-tool-call` | yes (per-tool renderer registry) | Default `{toolName}`. Named tools have custom labels (e.g. `Read chat terminal`, thread handoff `Handing off to {destination}`). `update_running_summary` is hidden. `send_async_message` turns into an assistant bubble. `automation_update` becomes an automation card. | renderer-defined | groupable / standalone / hidden per renderer | completed on `completed`/`failed` | `success:false` → failed | m1 `AS@4923900`; `AAI` registry |
| `collabAgentToolCall` → `multi-agent-action` | yes (tool `wait` is hidden) | Header `{action}{countLabel}`, e.g. `Created 2 agents`, `Messaged an agent`. Actions are Creating/Created/Failed to create, Messaging/Messaged, Resuming/Resumed, Closing/Closed, Interrupting/Interrupted, Listing/Listed. Rows: `Created {agent} with the instructions: {instructions}` and `{action} {agent}{stateSuffix}`, where the state is one of pending init, running, interrupted, shutdown, completed, errored, not found. | expandable | standalone | status from item | `failed` → `Failed to …` | `SER@193568–207624`; m1 `AS@4924600` |
| `subAgentActivity` → `subagent-activity` | yes | `{displayName} started working` / `updated` / `interrupted` / `finished`; `Sent message to parent` / `Sent message to {agent}`. Avatar is seeded by thread id. Click opens the subagent. The display name comes from the last path segment, humanized. | single row | standalone (the first non-message row in a sequence starts a sub-group) | — | — | `sT SER@~245000`; `ybr AS@4895574` |
| `webSearch` → `web-search` | yes, when the query is non-empty | `Searched the web for {detail}` / `Searching the web for {detail}`, where `<label>` is tertiary and `<detailText>` is muted. Detail rules: `site:` filters become ` \| host · host`; multiple queries show `first …`; `openPage` shows the URL; `findInPage` shows `'pattern' in url`. Without detail: `Searched the web`. | single row | groupable | shimmer while not completed. Only the **last item of a running turn** is treated as in progress. | — | `EE`/`vE` `SER@~284000–286400`; m1 `AS@4934100` |
| `imageView` → `image-view` | yes | `Viewed an image` / `Viewed N images`. **Consecutive imageView items are merged into one row.** | collapsed; expand shows a horizontal thumbnail strip | standalone | — | — | `zS SER@177000`; m1 merge `AS@4931500` |
| `imageGeneration` → `generated-image` | yes | Image gallery tile; a placeholder while in progress (`pendingImageCount`). Usage-limit failure shows `You’ve reached your image creation limit…`. | n/a | standalone (outside the activity group) | in-progress placeholder | failure messages `codex.imageGenerationLimit.inline.*` | `zE` `SER@~310000` |
| `contextCompaction` → `context-compaction` | yes | Running: `Compacting context` with shimmer; after 10 s it adds `· This can take a few minutes`. Done: `Context automatically compacted` (automatic) or `Context compacted` (manual). Interrupted: `Compaction interrupted`. Work mode uses "Optimizing / Optimized the conversation". | single row with icon | standalone (never collapsed when alone) | status from `startedAtMs` / completed | interrupted when the turn ends while in progress | `cx`/`lx SER@~134500–138000` (`px=1e4`) |
| `enteredReviewMode` / `exitedReviewMode` | **no** | No case in `m1`. Review mode only flags the user message (`reviewMode`). | — | — | — | — | absent from `m1` switch `AS@4917000–4936700` |
| `sleep` | **no** | Hidden. Its presence suppresses the worked-for start time. | — | — | — | — | `Dvr`; no `m1` case |
| `hookPrompt` | yes, as a user message | User bubble labelled `Hook feedback` | — | user slot | — | `Hook blocked this message` on a blocked submit | m1 `AS@4921000`; `codex.userMessage.hookFeedback` |

### Messages, reasoning, plans

| kind | renders? | layout / header format | default state | grouping | streaming | status / errors | evidence |
|---|---|---|---|---|---|---|---|
| `agentMessage` phase `final_answer` → `assistant-message` | yes | Markdown reply below the `Worked for` toggle. Action row (copy, fork, etc.). An empty skipped completion shows `No update from this run`. | expanded | pulled out of the activity area as `assistantItem` | streams via `item/agentMessage/delta`, shimmer while streaming | — | `SPLIT p()`; `zE` assistant case |
| `agentMessage` phase `commentary` (preamble) | yes | Regular assistant text inside the activity area, between tool groups | inside the collapsible activity once the final answer starts | standalone (breaks groups) | the current commentary item gets shimmer | — | `SPLIT` (`k.push(r),U.add(r)`) |
| `reasoning` → `reasoning` | **body not shown inline** in the local transcript. The classifier returns `null`; confirmed that `IFM`'s `me` is `AAI` export `t` = `ur`. The **summary's bold heading becomes the "Thinking" shimmer label** while the turn runs. A `reasoning` component does exist (`Aw`): header `Thinking` (shimmer) → `Thought for {elapsed}` / `Thought`; the body shows the summary minus the `**Title**` line, max height 8.75 rem, auto-scrolls while streaming, and is collapsed when done. No path from units to it was found in the default local turn. | n/a | — | hidden | summary deltas update the heading | — | `ur` `AAI@20324`; `LCT@69460`; `Aw`/`Nw` `SER@~231000–234600`; summary join `_br AS@4895574` |
| `plan` → `proposed-plan` | yes (separate plan card, not in the activity group) | Card titled `Plan`; while streaming, `Writing plan`. Actions: `Download plan`, `Open plan in side panel`, `Expand/Collapse plan summary`. Preview mode is capped at 160 px with a fade mask. | expanded unless `defaultCollapsed` | `proposedPlanItem` slot | streams via `item/plan/delta`; completes when no longer the last item | — | `plan-summary-item-content-4e17a59474fc.js@9832–18332` |
| `turn/plan/updated` → `todo-list` | **not inline**. Only the **latest** todo list is shown, as a pill above the composer while the turn runs. | Pill `Step {n} / {total}` plus a progress donut (percent = completed/total). The current step is the first `in_progress`, else the first non-completed. Hover tooltip lists every step with a pending, in-progress spinner, or completed check icon; completed text is tertiary. | — | `todoListItem` slot | each update pushes a new item; the last one wins. At turn end, `inProgress` steps reset to `pending`. | hidden while a blocking request (approval/input) is pending | `AS@2822227`, `@2832897`; `Vo LCT@11300`; `mT SER@~248000` |
| `userMessage` | yes | User bubble (attachments, comments, review/PR-fix flags). Steering messages sent mid-turn render in the activity area and stay visible when collapsed. | — | user slot / standalone | — | `deliveryStatus:not-sent` → hook stats | `m1 AS@4934600` |
| `turn/diff/updated` → `turn-diff` | yes, **after** the turn (live pill during the turn) | Card title `Edited {filename}` (one file) or `Edited a file` / `Edited N files`. Subtitle `+x −y`, which shows `View changes ›` on hover. Buttons `Undo` ↔ `Reapply` and review. File rows: first **3** shown, then `Show N more files` / `Collapse files`. A single-file diff ≤5,000 lines renders an inline diff preview. | expanded card | `unifiedDiffItem` (last only) | during the turn: pill `{n} files changed +x −y` | Undo/Reapply errors show a dialog (`Applied cleanly (n)`, `Skipped (n)`, `Conflicts (n)`, `Git apply error: …`, `Undo requires a Git repository`). Turn diffs over 1 MiB are rebuilt from per-patch batches. | `JT`/`GT SER@262000–276500` (`sE=3`); m1 `AS@4932300` |

### Errors, notices, model events

| kind | renders? | layout / header format | default state | grouping | streaming | status / errors | evidence |
|---|---|---|---|---|---|---|---|
| `error` with `willRetry:true` → `stream-error` | yes | `Reconnecting {k}/{N}` with an animated rolling digit. Server overload or HTTP 429: `Server is busy, reconnecting {k}/{N}`. Messages that do not match `^Reconnecting(?:\.\.\.)?\s+(\d+)\/(\d+)$` show the raw message. | collapsed; expandable only when `additionalDetails` exist | standalone | **consecutive reconnect errors replace the previous row** (one row, counter advances) | — | `Bxr`/`Vxr AS@~4936000`, `cSr AS@4941408`; `Gw SER@~236300` |
| `error` with `willRetry:false` → `system-error` | yes | Error card. The message is unwrapped from a JSON `{error:{message}}` envelope. `serverOverloaded` gets `Retry` / `Retry in {s}s` with a countdown fill. `usageLimitExceeded` shows `You've hit your usage limit…` variants. On failed turns: `View diagnostics` (guided diagnostics: likely cause, OpenAI status, next step, `Copy diagnostic details`). `misalignmentPolicyViolation` and some codex error infos are suppressed. A trailing system-error goes into its own slot (`systemEventItem`). | expanded card | standalone | — | When a turn fails with `turn.error` and no non-retry error item exists, a synthetic `turn-error-{id}` system-error is appended. | m1 `AS@4929300`, `@4932000`; `H$n AS@3883281`; `AP@367980–402600` |
| `model/rerouted` → `model-rerouted` | yes, at turn level (not in the activity group) | Centered divider row: `Your request was routed to {toModel}.` For `highRiskCyberActivity`, an info icon tooltip: `Heads up, your request was re-routed to reduce cyber-abuse risk.` plus a link to chatgpt.com/cyber. | — | `modelReroutedItems` | — | — | `pC SER@~191400`; `AS@2822923` |
| model change → `model-changed` | yes, at turn level | Divider: `Model changed from {from} to {to}.` Tooltip: `Changing models mid-conversation will degrade performance. Context may automatically compact.` | — | `modelChangedItems` | — | — | `cC SER@189355` |
| `warning` / `guardianWarning` | partial | `guardianWarning` feeds the auto-review UI. A generic inline `warning` row was not found. | — | — | — | — | `AS@2825643` |
| `deprecationNotice`, `configWarning` | **not inline** | Stored per host (last 20) and shown in the Settings → Configuration panel. Logged as warning/debug. | — | — | — | — | `app-initial@9320100`, `@9357843`; `configuration-panel-b3d1af7d2342.js` |
| `thread/tokenUsage/updated` | **not inline** | Sets `conversation.latestTokenUsageInfo`, which feeds the context meter. | — | — | — | — | `AS@2812520` |
| `account/rateLimits/updated` | **not inline** | Account/usage state for the composer and banners | — | — | — | — | `AS@1930307` |
| personality / fork / remote task | yes | `Switched to {personality} personality`; `Continued from chat` (link); `Created {taskLink} in Codex Cloud` | — | turn-level slots | — | — | `SER@228382`, `@175605`, `@235905` |
| `strictReviewNotice` / auto-review interruption | yes | `This request requires additional safety checks, which can take extra time.`; `Turn ended by Auto-review` with expandable details | — | standalone | — | — | `SER@128804–130043` |

### Approvals and requests

| kind | renders? | layout / header format | default state | grouping | streaming | status / errors | evidence |
|---|---|---|---|---|---|---|---|
| `item/commandExecution/requestApproval` | **not as a transcript row**. It becomes an `exec` item with `approvalRequestId`, is pulled into the `approvalItem` slot (`hasBlockingRequest`), and is answered in the **pending-request panel in the composer area**. | Panel: `Allow ChatGPT to run this command?` / `Do you want {actor} to run this command?`. Network variant: `Allow ChatGPT to connect to {destination}?`, `{host} isn't on the current network allowlist`. Options include `Allow similar commands` (`Allow commands that start with {command} for this conversation`). Collapse/expand. | panel open | — | — | Decision is sent via `replyWithCommandExecutionApprovalDecision`. Pending approvals are auto-`decline`d on some teardown paths. | m1 approvals `AS@4932804`; `SPLIT` (`y=e=>e.type==="exec"&&e.approvalRequestId!=null…`); `pending-request-item-panel-66c58f1a7e3a.js@75109–80222`; `AS@2724715` |
| `item/fileChange/requestApproval` | panel (attached to the existing `patch` item as `approvalRequestId` + `grantRoot`) | `Allow ChatGPT to edit the following file(s)?`, `Allow all edits` (`Allow this and future file edits in this conversation without asking again`), file move `{src} → {dst}` | panel | — | — | patch rows hide their label while pending | `AS@4935300`; panel messages |
| `item/permissions/requestApproval` → `permission-request` | inline placeholder plus panel | Inline: `Awaiting approval` (muted shimmer) until completed, then nothing. Panel: `Allow ChatGPT to connect to the internet?` / `view` / `edit` / `view and edit the contents of {paths}?` | — | `permissionRequestItems` | — | — | `ex SER@132846`; `AS@4935800` |
| legacy `execCommandApproval` / `applyPatchApproval` | **no** | Explicitly ignored: `zd.warning(\`Ignoring legacy approval request method\`…)` | — | — | — | — | `AS@~4936100` |
| `item/tool/requestUserInput` → `userInput` | **not inline while open**: answered in the composer panel. The activity header shows `Waiting for your answer`. | Once answered (`userInputResponse`): `<label>Asked</label> N question(s)`, expandable to Q→A pairs (`No answer provided`). While open: `Asking question(s)` shimmer. | collapsed | `userInputItem` slot / `user-input-response` standalone | — | — | `dE SER@~281700`; `LCT@70229` |
| MCP elicitation (`mcpServer/elicitation/request`) → `mcp-server-elicitation` | open: panel; completed: row | `{serverName} requested information`; status `Accepted` / `Declined` / `Cancelled` / `Completed`; plugin install: `Installed {pluginName}` | — | completed → standalone | — | — | `SER@179303–188054` |
| auto-review (`automaticApprovalReview`) | yes | Attached to its target exec/patch/mcp row as a decoration (shield icon). `inProgress` is groupable; denied/aborted/timedOut is standalone, with `Why it was denied` and an `Approve` button (one retry). | — | see classification | — | — | `ne`/`C` in `SPLIT`; `SER@145441–154353` |

## Markdown export format (copy-as-Markdown; NOT the live UI)

`conversation-markdown-255c3ee1444d.js` serializes turns to Markdown with `<details>` blocks. Its plain-English strings have **counts** and are not i18n:
- `Explored 3 files, 2 searches, a list`
- `Edited 2 files, explored a file, ran 3 commands, called a tool, searched the web`
- `Tool activity` (fallback)
- per-command status `Stopped` / `Succeeded` / `Exit code N`

Evidence: `qe`/`Je`/`$e` @16410. Do not copy these into the live transcript headers; Codex's live headers have no counts.

## Rich-text tag styling

| Tag | Styling | Where |
|---|---|---|
| `<verb>` | `text-text-tertiary/90` (dimmer than the path) | read/search/list rows (`xS` `SER@~173000`) |
| `<action>` | `whitespace-nowrap` | live group header (`SD`) |
| `<detail>` | `min-w-0 truncate` | live group header (`xD`) |
| `<label>` / `<detailText>` | label tertiary; detail muted `text-text/40`; both go to default color on hover | web search, user-input |
| Row base | `text-size-chat`, muted `text-text/40`; the whole header lightens to default on `group-hover/activity-header` | all activity rows |

## Evidence snippets (verbatim minified, abridged with …)

| Claim | Snippet | Location |
|---|---|---|
| exec row collapsed by default; elapsed is hidden when 0 | ``[b,x]=(0,DS.useState)(`collapsed`)`` … ``F=!h&&e>0?kS(e):null`` | `SER@~150600` |
| exec header strings | ``id:`toolSummaryForCmd.ranSpecificCommandWithElapsed`,defaultMessage:`Ran {command} in {elapsed}` `` | `SER@171039` |
| raw command only when collapsed | ``y=d?n.cmd.trim():``…if(!u&&(v!=null\|\|b.length>0))`` (u = isExpanded) | `SER@~170500` |
| read rows hidden until finished | ``(n.parsedCmd.type===`read`\|\|…`list_files`)&&!n.parsedCmd.isFinished&&!e)return null`` | `SER@~311000` |
| exec footer | ``r?…(_,{id:`execFooter.success`,defaultMessage:`Success`})…:(_,{id:`execFooter.exitCode`,defaultMessage:`Exit code {code}`…`` | `UMA@17392` |
| patch row collapsed | ``[x,S]=(0,cw.useState)(!1)`` inside `$C` | `SER@~212600` |
| live output cap | ``function fen({current:e,delta:t,maxChars:n=pen})`` … ``pen=2e4`` ; ``let t=`[output truncated]\n` `` | `AS@2781644`, `@2782200`, `@2791250` |
| turn-diff shows 3 files | ``le=T?F.files:F.files.slice(0,sE)`` … ``sE=3`` | `SER@~266900`, `@281285` |
| large diff threshold | ``function AT(e,t,n){return Math.max(e,t+n)>jT}`` … ``jT=5e3`` | `SER@~251900` |
| compaction delay notice | ``Date.now()-n>=px`` … ``px=1e4`` | `SER@~137000` |
| reconnect regex | ``cSr=/^Reconnecting(?:\.\.\.)?\s+(\d+)\/(\d+)$/`` | `AS@4941408` |
| reconnect rows collapse | ``if(n?.type===`stream-error`&&n.reconnectAttempt!=null&&t.reconnectAttempt!=null){e[e.length-1]={...t,id:n.id};return}`` | `AS@~4940300` (`Vxr`) |
| todo-list is synthesized | ``case`turn/plan/updated`:{…e.items.push({id:s(),type:`todo-list`,explanation:i??null,plan:r})})`` | `AS@2822227` |
| last todo/diff wins | ``if(r.type===`turn-diff`&&(u=r),r.type===`todo-list`&&(p=r)`` | `SPLIT` |
| activity collapse default | ``{shouldAllowCollapse:!0,isCollapsed:!i&&(o??!a)}`` | `SER@357987` (`XD`) |
| working label threshold | ``e=c>=1e3?(…{...bR.workingFor,values:{time:s}}):(…{id:`localConversation.working`,defaultMessage:`Working`})`` | `AP@~1142900` |
| web search in-progress = last item only | ``let t=y.status===`inProgress`&&ie>=0&&e===ie;w.push({type:`web-search`,…completed:!t})`` | `AS@~4934100` |
| reasoning dropped from units | ``case`reasoning`:case`automation-update`:…case`steered`:return null`` | `AAI@20324` |
| legacy approvals ignored | ``case`applyPatchApproval`:case`execCommandApproval`:zd.warning(`Ignoring legacy approval request method`…`` | `AS@~4936100` |
| group summary has no counts | ``readFilesLeading`` → `Read files`; ``commandsLeading`` → `{count, plural, one {Ran a command} other {Ran commands}}` | `SER@42560`, `@43350` |

## Could not determine

- **Reasoning body path:** `Aw` ("Thought for Xs") exists and `zE` has a `reasoning` case, but the local turn drops `reasoning` from activity units (classifier import confirmed). Unknown which surface (if any) still renders it.
- **Per-file patch preview size threshold** (`d(n,r)` null condition), and whether the exec elapsed formatter is exactly `XYe`.
- **Exact `Ms()` rules** for when the `Thinking` row shows versus the active-item header (`LCT` `Ms`, not fully traced).
- **Exec card output height cap** and any line-based truncation inside the shell component (`an` in `UMA`). Only the 20k-char live store cap is confirmed.
- **Where `proposedPlanItem` and `postAssistantItems` sit** relative to the turn-diff card and end resources (exact order inside `LCT@76000–84000` was not traced).
- **Generic inline `warning` notification rendering:** no consumer found besides `guardianWarning`.
- **Icons:** only asset handles (e.g. `asset:Aa` for warning, `_i` for compaction); the actual glyphs were not mapped.
- **Live behavior:** nothing was executed. All findings are static reads of minified code.
