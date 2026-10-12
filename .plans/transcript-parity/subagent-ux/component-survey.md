# Subagent UX: open-source component survey

Date: 2026-10-10. Scope: React / Tailwind / shadcn-style components for subagent cards, parallel-agent rows, run timelines, tool-call steps, background-task indicators, nested agents, plan/todo trackers, and reasoning disclosure, judged against the proposal in [notes.md](notes.md).

**TL;DR**
- I logged **93 rows**, covering about 100 projects: row 93 groups 6 observability tools, and row 3 is a sub-package of row 2. I read about 25 components in full and skimmed about 20 more. The rest are metadata and file-tree checks. Only about 12 projects have a real subagent or parallel-agent component. Most "AI UI kits" stop at tool, reasoning, and chain-of-thought.
- The best direct references are **assistant-ui elements** (`subagent-list`, `task-card`, `tool-group`, `agent-status`), **Cline `SubagentStatusRow`**, **mischief `subagent-tree`**, **open-swe `subagents/*`**, and **1code `agent-task-tool`**. All of them have a permissive license.
- Use them for structure, state rules, and accessibility details. Do not copy markup verbatim. Every source breaks at least one Synara rule: fixed text sizes, its own motion or icons, Radix `asChild` wrappers, or `setInterval` timers. See "What not to take".
- No project does what the proposal does: a card anchored at the spawn point that updates in place, with a matching composer strip. Codex desktop and Claude Code are still the best UX references. Their source is closed.

---

## 1. Top 10

The ranking is weighted, not strictly ordered by criterion. The criteria are: (a) a real subagent, parallel-agent, or task-card component whose source I read; (b) a permissive license; (c) code quality and accessibility; (d) fit with Tailwind v4 and shadcn; (e) active in 2026; (f) motion and disclosure quality.

Two picks are not subagent-specific. AI Elements (#6) ranks above PastaUI, vibe-kanban, and Kilo because it is a maintained, permissive shadcn registry, and it supplies the step, tool, and reasoning parts that every agent row needs. PastaUI has no adoption, vibe-kanban needs a11y fixes, and Kilo is SolidJS with no code to borrow. Trigger.dev (#10) beats the thinner subagent-specific candidates (humanlayer `TaskToolCallContent`, Roo `SubtaskCollapsibleRow`, lmnr `subagent-group-element`, terragon `task-tool`). Those add nothing beyond picks 1–5, but `RunTimeline` fills a real gap: the lifecycle block in `AgentRowDetail`.

| # | Candidate | URL | License | Stars · last push | Subagent-specific? | Fit |
|---|---|---|---|---|---|---|
| 1 | assistant-ui `elements` kit | github.com/assistant-ui/assistant-ui (`packages/ui/src/components/react/assistant-ui/elements/`) | MIT | 12.5k · 2026-10-09 | **Yes**: `subagent-list`, `task-card`, `tool-group`, `agent-status`, `trace-waterfall`, `todo-list`, `agent-plan`, `agent-handoff` | Tailwind v4 (`inset-ring`, `forced-colors`), plain elements, `data-slot`. High |
| 2 | Cline `SubagentStatusRow` | github.com/cline/cline (`apps/vscode/webview-ui/src/components/chat/SubagentStatusRow.tsx`) | Apache-2.0 | 70k · 2026-10-10 | **Yes**: production parallel-subagent row (prompt, status, stats, latest tool, output) | React + Tailwind, VS Code tokens. Medium |
| 3 | mischief-ui `subagent-tree` (+ `agent-checklist`, `stopped-run`, `timeline`) | github.com/Tinkerers-Labs/mischief-ui · ui.tinkererslabs.com/r/subagent-tree.json | MIT | 3 · 2026-09-03 | **Yes**: nested parallel agents, tally header, `aria-live` summary | shadcn registry, no dependencies. High (low adoption) |
| 4 | open-swe `subagents/*` | github.com/langchain-ai/open-swe (`ui/src/features/agents/components/subagents/`) | MIT | 11k · 2026-10-11 | **Yes**: `SubagentGroup`, `SubagentCard`, `SubagentActivity`, `SubagentThreadView` | React + Tailwind, but the in-house "macaw" design system. Medium |
| 5 | 1code `agent-task-tool` / `AgentTaskToolsGroup` | github.com/21st-dev/1code (`src/renderer/features/agents/ui/agent-task-tool.tsx`, `agent-task-tools.tsx`) | Apache-2.0 | 5.6k · 2026-03-06 | **Yes**: Claude Code `Task` row with live elapsed, current-tool subtitle, nested tool list | Electron + React + Tailwind + shadcn. High |
| 6 | Vercel AI Elements | github.com/vercel/ai-elements (`packages/elements/src/`) · ai-sdk.dev/elements | Apache-2.0 | 2.5k · 2026-09-01 | Partial: `Task`, `ChainOfThought`, `Tool`, `Reasoning`, `Queue`, `Plan`, `Agent` (agent *definition*, not run) | shadcn registry, Radix Collapsible. High |
| 7 | PastaUI `background-runs` / `background-inbox` / `task-card` / `tool-timeline` | github.com/syeddhasnainn/pastaui · pastaui.com/r/*.json | MIT | 0 · 2026-10-07 | **Yes** (background): run list with summary pill, two-step Stop, Open | shadcn registry, Tailwind v4 `starting:`. High (no adoption) |
| 8 | vibe-kanban `ChatSubagentEntry` | github.com/BloopAI/vibe-kanban (`packages/ui/src/components/ChatSubagentEntry.tsx`) | Apache-2.0 | 28k · 2026-09-19 | **Yes**: one card per Task call (type, description, status, output) | React + Tailwind, custom tokens. Medium |
| 9 | Kilo Code `TaskToolExpanded` / `SubagentPanel` | github.com/Kilo-Org/kilocode (`packages/kilo-vscode/webview-ui/src/components/chat/TaskToolExpanded.tsx`, `.../agent-manager/SubagentPanel.tsx`) | MIT | 27.6k · 2026-10-11 | **Yes**: stop, "continue in background", open child session, avatar status, sibling tabs | **SolidJS**. Ideas only |
| 10 | Trigger.dev `RunTimeline` | github.com/triggerdotdev/trigger.dev (`apps/webapp/app/components/run/RunTimeline.tsx`) | Apache-2.0 | 16.5k · 2026-10-10 | No (run lifecycle), but it is the best start / run / finish lifecycle timeline | Remix + Tailwind + Radix tooltip. Medium |

Honorable mentions (not top 10): **prompt-kit** `Steps`/`ChainOfThought`/`Reasoning` (MIT, 3.1k, good generic steps; AI Elements covers the same ground). **signoff-ui** `tool-call-timeline` (MIT, 1 star, 2.4k lines, with a waterfall and durations; too heavy to copy). **AgentUI** (agentui.pro) `agent-progress`/`agent-disclosure` (good timer and motion; **no license is stated**, so use the patterns only). **lmnr** `subagent-group-element` (Apache-2.0; subagent bands in a trace timeline). **assistant-ui `react-o11y`** `SpanTimeline`/`SpanChildren` (MIT; span tree primitives).

License note: copying Apache-2.0 code verbatim (Cline, 1code, vibe-kanban, AI Elements, Trigger.dev) brings a NOTICE/attribution duty. Re-implementing the pattern in Synara's own components does not.

---

### 1. assistant-ui `elements` kit (MIT)

Files: `packages/ui/src/components/react/assistant-ui/elements/` → `subagent-list.tsx` (118 lines), `task-card.tsx` (187), `tool-group.tsx` (128), `agent-status.tsx` (80), `trace-waterfall.tsx` (102), `todo-list.tsx` (168), `agent-plan.tsx`, `agent-handoff.tsx`. Demos are in `apps/docs/components/demo/elements/*.tsx`. Commits on this folder are from 2026-10-08/09.

**Take**
- `TaskCard` is the closest match to the proposed `AgentRow`:
  - Header row: state icon, `sr-only` state word, truncated label, `meta` (model), `elapsed` (`tabular-nums`), and a chevron.
  - Body: an `actions` slot, a transcript `children` slot (expanded only), and a `result` slot that **stays visible when collapsed**. That is the proposal's two-line settled preview.
  - State union: `working | waiting | done | failed | cancelled`. It is a good checklist for `subagentStatusDotClassName`.
  - The header is a real `<button>` with `aria-expanded` set **only when there is content**, and it is `disabled` when there is nothing to expand. Copy this rule.
- `ToolGroup` header count logic: `running > 0 ? "done/total" : failed > 0 ? "N failed" : "N done"`, plus one aggregate icon. Use it for the "Running 1 of 3 agents · 1 failed" header.
- `SubagentList`: one row per agent with name, model, and a 3 px `role="progressbar"` (with `aria-valuenow`), plus `forced-colors:outline`. It has an optional "summary agent" row that the caller shows with `showSummary` (the demo shows it after the others finish). This is a useful idea for the "resumed after" state.
- `AgentStatus` pill: hides elapsed once the state is `done` or `failed`, and uses `key={label}` to re-trigger a fade when the activity text changes. Use it for the composer-strip item.

**Do not take**
- `paper`/`mono` surface helpers and `text-[13.5px]`/`text-xs`. Use `text-ui*`.
- `fade-in slide-in-from-top-1 animate-in` keyframes. Use `disclosureMotion.ts` / `DisclosureRegion`.
- lucide `Loader2Icon`/`CheckIcon`. Use `LiveStatusSpinner` and `StatusDot`.
- `SubagentList`'s numeric `progress[]`. Synara has no real percentage for agents, so a fake bar would mislead.
- These are marketing-grade presentational demos with no data layer. The value is in the prop shape and the state rules.

### 2. Cline `SubagentStatusRow` (Apache-2.0)

File: `apps/vscode/webview-ui/src/components/chat/SubagentStatusRow.tsx` (285 lines). This is a production component for Cline's `use_subagents` (parallel prompts).

**Take**
- **Per-agent card body**:
  - status icon (`running`/`completed`/`failed`/`cancelled`/pending)
  - prompt clamped to 2 lines, with a "Show more" that appears **only when a `ResizeObserver` shows overflow**
  - stats line: "N tools called · N tokens · $cost"
  - `latestToolCall` in mono while running, then a "Show output / Hide output" toggle that renders Markdown on success or error text on failure
  
  This is almost exactly the proposed row plus `AgentRowDetail`.
- **Cancelled-on-resume rule**: a row that still says `running` is shown as `cancelled` when it is not the last message, or when the next message is a resume. Synara needs the same rule for interrupted parents, so a stale spinner does not stay forever.
- The header title switches between singular and plural.

**Do not take**
- `text-[11px]`/`text-[10px]` sizes and VS Code CSS variables.
- The `"{prompt}"` quote styling.
- Expand state kept in a `Record<index, boolean>` in the row. Synara should key it by agent id, so it survives re-render and re-ordering.
- Showing cost. Synara does not show per-agent cost today.

### 3. mischief-ui `subagent-tree` (MIT)

Source: `ui.tinkererslabs.com/r/subagent-tree.json` → `registry/default/subagent-tree/subagent-tree.tsx` (175 lines, no dependencies). Related items: `agent-checklist` (state-change announcements), `stopped-run` (keeps partial output after a stop), `chain-of-thought` (open while working, folded after), `status-pill`, and `timeline`.

**Take**
- `AgentRun = { id, label, status: queued|running|done|failed, detail, duration, children }`. This is recursive, so it covers nested agents (open question 6).
- `tally()` walks the children to get running/done/failed/total. The header shows "2/5 done · 1 failed".
- One `aria-live="polite"` sr-only summary ("2 of 5 agents running" / "5 agents finished, 1 failed") **for the whole group**, not one announcement per row. This is the right announcement grain for a card that updates in place.
- The `sr-only ", running"` suffix after each label.
- A documented choice to use **nested lists, not a `role="tree"`**, because the content is watched, not navigated. Use the same choice for Synara's card.
- Child indent with a `border-s` guide line (`ms-[7px] ps-4`).

**Do not take**
- `text-[0.6875rem]`/`text-[0.8125rem]`.
- `animate-pulse` dots. Use `StatusDot`.
- The repo has 3 stars and one author. Treat the code as reference only, not as a dependency.

### 4. open-swe `subagents/*` (MIT)

Files: `ui/src/features/agents/components/subagents/SubagentGroup.tsx` (29), `SubagentCard.tsx` (87), `SubagentActivity.tsx` (101), `SubagentThreadView.tsx` (175).

**Take**
- One group per spawn batch, keyed by `toolCallId`. This matches "one card per spawn call".
- The card shows subagent type, description (`line-clamp-5`), and an **"Open ↗" link to the subagent transcript**. The link appears only in the transcript view, not in the live stream. Use the same idea for "Open thread".
- `SubagentActivity` is **one activity line**: the current tool name (humanized), a state icon, and "N steps" right-aligned and `tabular-nums`. A code comment says that listing every nested call "balloons the card". This is direct evidence for the proposal's single progress line.
- The live view subscribes to the namespace only while mounted (`useToolCalls(stream, { namespace })`). This is the same pattern as the detail subscription that the notes need for Codex progress.

**Do not take**
- The grid of up to 4 columns. A transcript column needs vertical rows.
- `@langchain/macaw-components` and phosphor icons.

### 5. 1code `agent-task-tool` (Apache-2.0)

Files: `src/renderer/features/agents/ui/agent-task-tool.tsx` (235), `agent-task-tools.tsx` (1095, `AgentTaskToolsGroup`, `TaskInfoItem`, `BlockingTasksList`).

**Take**
- **Elapsed rule**: tick from `startedAt` while pending, then switch to the authoritative `output.totalDurationMs ?? duration_ms` when settled. This matches the notes' gap (Claude `usage.duration_ms`). `formatElapsedTime` hides values under 1 s.
- **Subtitle rule**: while running, show the *last nested tool's* title and subtitle ("Read foo.ts"). When settled, show the truncated description.
- Title "Running Subagent" with a text shimmer while running, and "Completed Subagent" when settled.
- Nested tool list capped at 5 visible rows, with a top fade gradient while streaming.

**Do not take**
- **Auto-collapse when the agent settles** (`wasPending → setIsExpanded(false)`) and **auto-scroll of the inner list**. Both change the card height without user input, which breaks the AGENTS.md end-follow rule. Treat this as evidence for open question 9: do not auto-close.
- A `setInterval` per component. Use a shared `useNowMs`.
- A `div onClick` header. Use a real `<button>`.
- `any`-typed parts.

### 6. Vercel AI Elements (Apache-2.0)

Files: `packages/elements/src/task.tsx` (87), `chain-of-thought.tsx` (222), `tool.tsx` (173), `reasoning.tsx` (226), `queue.tsx` (274), `plan.tsx` (147), `agent.tsx` (141), `shimmer.tsx` (77).

**Take**
- `ChainOfThoughtStep`: icon column with a 1 px connector line (`absolute top-7 bottom-0 left-1/2 w-px bg-border`), label, description, and a `status` of complete/active/pending. Use it for the "Recent" steps list inside `AgentRowDetail`.
- `Tool` state map (`input-streaming`, `input-available`, `approval-requested`, `approval-responded`, `output-available`, `output-error`, `output-denied`) with one label and one icon each. It is a good checklist for tool-row states.
- `Reasoning`: auto-opens when streaming starts unless the user closed it explicitly (`isExplicitlyClosed`), and records the duration ("Thought for N s"). Use that open guard. **Do not use its close path.** It closes the panel once, 1 s after any stream ends (`AUTO_CLOSE_DELAY`, `hasAutoClosed`), even if the user opened it. That is the same height concern as #5.
- `Queue`/`QueueSection`: titled, collapsible sections of pending items. This could inform the composer strip when many agents run.

**Do not take**
- `Agent`/`AgentTools`/`AgentInstructions`. These describe a configured agent (instructions plus a tool accordion), not a running one.
- Radix `Collapsible asChild` and the `@radix-ui/react-use-controllable-state` import. Synara uses Base UI and `DisclosureRegion`.
- `Badge` status pills (too loud for transcript rows) and `text-sm`.

### 7. PastaUI (MIT, 0 stars)

Registry items: `background-runs.tsx` (195), `background-inbox.tsx` (158), `task-card.tsx` (93), `agent-status.tsx` (88), `tool-timeline.tsx` + `timeline-status.tsx` (181), `job-progress.tsx` (127).

**Take**
- `BackgroundRuns` header summary: `"2 running · 1 queued"`, or `"All done"` when nothing is active. This is the Codex-style header count for the composer strip.
- **Two-step Stop**: the first click arms a "Stop" confirm, which disarms after 3 s. The timestamp fades out on hover or focus to make room for the action. `pointer-coarse:` keeps actions visible on touch.
- The whole row body is a `<button>` that calls `onOpen(id)`. This maps to "Show in transcript" / "Open thread".
- `TaskCard` footer: "agent · duration" plus "Open task ↗", and a result block that fades in with `starting:opacity-0`.

**Do not take**
- `text-[15px]`/`text-[13px]`, `shadow-card`, rounded-16 cards, and `@solar-icons`.
- It has no adoption. Copy the ideas, not the files.

### 8. vibe-kanban `ChatSubagentEntry` (Apache-2.0)

File: `packages/ui/src/components/ChatSubagentEntry.tsx` (183).

**Take**
- An uppercase subagent-type label (`tracking-wide`) above a truncated description, with the status icon next to the type.
- **The border and header tint follow the status**: `border-error bg-error/5` on failure, `border-success/50` on success. This gives a scan cue in a long transcript.
- Output section with an "OUTPUT" eyebrow and Markdown via the `renderMarkdown` prop. Injecting the renderer keeps the component pure.
- `data-scroll-anchor-target` on the interactive header, a scroll-anchoring hook.

**Do not take**
- `div role="button" tabIndex=0` with a manual Enter/Space handler. Use a real `<button>`.
- Full success tint. Keep success quiet and tint only failure, so the card does not flash green when three agents finish.

### 9. Kilo Code `TaskToolExpanded` / `SubagentPanel` (MIT, SolidJS, ideas only)

Files: `packages/kilo-vscode/webview-ui/src/components/chat/TaskToolExpanded.tsx` (359), `packages/kilo-vscode/webview-ui/agent-manager/SubagentPanel.tsx` (159). Kilo is an opencode fork.

**Take (ideas)**
- Per-task actions with tooltips: **Stop**, **Continue in background** (shown only when a `backgroundSubagents` feature is on and the task can move), and **Open child session**.
- `AgentAvatar` with a running status, and an `AgentAvatarPalette` that gives siblings stable distinct colours. This could give each agent row a stable identity colour.
- `initialOpen`/`rememberOpen` keep the disclosure state per tool across re-renders.
- `taskAutoOpen(status, backgroundTask)` sets the default open state from the status (open question 9).
- `SubagentPanel` is a side inspector with sortable, closable tabs per sibling subagent, each a read-only `ChatView`. This is an alternative to "Open thread" navigation.

**Do not take**: any code. It is SolidJS (`createMemo`, `<Show>`).

### 10. Trigger.dev `RunTimeline` (Apache-2.0)

File: `apps/webapp/app/components/run/RunTimeline.tsx` (677). Exports `RunTimeline`, `RunTimelineEvent`, `RunTimelineLine`, `SpanTimeline`.

**Take**
- A small vertical lifecycle in a `grid-cols-[1.125rem_1fr]`:
  - event markers (`start-cap`, `dot-hollow`, `dot-solid`, `end-cap`) with a state of `complete`/`error`/`inprogress`/`delayed`
  - connecting lines (`light`/`normal`)
  - a right-aligned `tabular-nums` subtitle (time or duration)
  - optional help text in a tooltip
- `TimelineSpanRun` timestamps (`createdAt`, `startedAt`, `executedAt`, `completedAt`, `isError`) map directly to "Spawned → Started → Finished" in the `AgentRowDetail` identity and stats block, once the web roster has `startedAt`/`endedAt` (a gap in the notes).

**Do not take**
- Radix `TooltipProvider` per event.
- `text-sm`/`text-xs` and Trigger's own colour tokens.
- Treat this as a reference for the detail view only. It does not fit in the row.

---

## What not to take (applies to every source)

| Rule in Synara | What the sources do | Do this instead |
|---|---|---|
| UI text uses `text-ui*` (`uiFontSize.test.ts` fails on fixed sizes) | `text-[13.5px]`, `text-xs` (assistant-ui), `text-[0.6875rem]` (mischief), `text-[15px]` (PastaUI), `text-[11px]` (Cline), `text-sm` (AI Elements) | Map to `text-ui`, `text-ui-sm`, `text-ui-xs` |
| Disclosure motion comes from `disclosureMotion.ts` | `motion/react` (AgentUI), tw-animate `animate-in` (AI Elements, assistant-ui), a ResizeObserver max-height tween (prompt-kit `Reasoning`) | `DisclosureRegion` and `DisclosureChevron` |
| Base UI primitives | Radix `Collapsible asChild` (AI Elements, prompt-kit, signoff-ui) | Take the structure, not the wrapper |
| Existing icons and status atoms | lucide, phosphor, solar icons; `animate-pulse` dots | `StatusDot`, `LiveStatusSpinner`, `BotIcon`, `BackgroundTrayIcon` |
| A local tick, never in ChatView | `setInterval` per component (1code, AgentUI at 100 ms) | `useNowMs` + `formatClockDuration` |
| End-follow is stable; no height change without user input | Auto-collapse when settled (1code), auto-close of reasoning (AI Elements), auto-scroll of an inner list (1code) | Keep the open state user-owned. Settled rows shrink only through the preview clamp |
| Real interactive elements | `div role="button"` (vibe-kanban), `div onClick` (1code) | `<button aria-expanded>`, as assistant-ui `TaskCard` does |

## License exclusions (logged, never borrow)

- **AGPL-3.0**: coss (`cosscom/coss`, the Base UI design system of Cal.com and the closest stack match, excluded for its license), siteboon/claudecodeui (it has `SubagentPanel`/`SubagentTimeline`), smtg-ai/claude-squad, winfunc/opcode.
- **ELv2**: Arize Phoenix. **SSPL**: Inngest. **LobeHub Community License**: lobehub (`SubAgentStats`, `AgentTasks/*Subtasks*`).
- **Mixed or custom (unverified, API says NOASSERTION)**: zed (GPL/AGPL/Apache mix; Rust GPUI, ideas only), dify, Flowise, open-webui, dyad. **No license file**: BuilderIO/agent-native, anthropics/claude-agent-sdk-demos, CopilotKit/open-multi-agent-canvas, disler/claude-code-hooks-multi-agent-observability. **No license stated**: AgentUI (agentui.pro), inference.sh UI.
- **Open-core**: mastra (Apache-2.0 outside `ee/`; `packages/playground*` is outside `ee/`) and langfuse (MIT outside `ee/`, `web/src/ee/`, `worker/src/ee/`; `web/src/features/traces/` is outside). Both are usable with care.

---

## 2. Full candidate log (93 rows)

Legend:
- ★ = GitHub stars (approximate, 2026-10-10).
- **Sub** = subagent or parallel-agent specific: **Y** = yes, **P** = partial (task, plan, or steps only), **N** = no.
- **Stack** = what I saw in the code or the manifest. "TW" = Tailwind, with the version not checked. "TW4" = I saw Tailwind v4-only classes. "n.c." = not checked.
- "Src" = I opened the component source. "Meta" = I checked only metadata and the file tree.

### shadcn-style libraries and registries

| # | Candidate | URL | License | ★ · push | Sub | Stack | Parts | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | Vercel AI Elements | github.com/vercel/ai-elements · ai-sdk.dev/elements | Apache-2.0 | 2.5k · 09-01 | P | React, TW, shadcn, Radix | Task, ChainOfThought, Tool, Reasoning, Plan, Queue, Agent, Shimmer (Src) | Top 10 #6. Generic baseline |
| 2 | assistant-ui (`packages/ui` elements) | github.com/assistant-ui/assistant-ui | MIT | 12.5k · 10-11 | Y | React, TW4 (`inset-ring`), plain elements | subagent-list, task-card, tool-group, agent-status, trace-waterfall, todo-list (Src) | Top 10 #1 |
| 3 | assistant-ui `react-o11y` (sub-package of #2) | same repo, `packages/react-o11y` | MIT | (same) | P | React primitives | SpanRoot, SpanChildren, SpanTimeline, SpanStatusIndicator | Honorable mention: span-tree primitives |
| 4 | assistant-ui/tool-ui | github.com/assistant-ui/tool-ui · tool-ui.com | MIT | 779 · 08-31 | P | React, TW, shadcn, zod | plan, progress-tracker (registry Src) | Good plan/progress widgets; tool-output oriented |
| 5 | prompt-kit | github.com/ibelick/prompt-kit · prompt-kit.com | MIT | 3.1k · 09-28 | P | React, TW, shadcn, Radix | steps, chain-of-thought, tool, reasoning, loader, text-shimmer (Src) | Honorable mention; overlaps AI Elements |
| 6 | Kibo UI | github.com/shadcnblocks/kibo | MIT | 4.0k · 05-04 | N | React, TW, shadcn | Collapsible/accordion patterns only (tree) | No agent parts |
| 7 | Magic UI | github.com/magicuidesign/magicui | MIT | 22.6k · 10-05 | N | React, TW, Motion | Meta | Animated effects; not relevant |
| 8 | Motion Primitives | github.com/ibelick/motion-primitives | MIT | 6.5k · 09-28 | N | React, TW, Motion | disclosure, accordion, text-shimmer (tree) | Shimmer idea only |
| 9 | Origin UI (now coss; `origin-space/originui` redirects here) | github.com/cosscom/coss · coss.com/ui | **AGPL-3.0** | 10.7k · 10-09 | N | React, TW, **Base UI** | Meta | Excluded by license, although the stack fits best |
| 10 | ElevenLabs UI | github.com/elevenlabs/ui · ui.elevenlabs.io | MIT | 2.4k · 09-14 | N | React, TW, shadcn | shimmering-text, voice (tree) | Voice agents only |
| 11 | shadcn/ui + registry directory (434 registries) | github.com/shadcn-ui/ui · ui.shadcn.com/docs/directory | MIT | 125k · 10-10 | N | React, TW4, Radix/Base UI | `apps/v4/registry/directory.json` scanned | Source of the registry rows below |
| 12 | awesome-shadcn-ui | github.com/birobirobiro/awesome-shadcn-ui | list | 20.6k · 10-05 | N | n/a | Meta | Index only |
| 13 | shadcn-chat | github.com/jakobhoeg/shadcn-chat | MIT | 1.6k · 2025-08 | N | React, TW | Meta | Chat bubbles; stale |
| 14 | shadcn-chatbot-kit | github.com/Blazity/shadcn-chatbot-kit | MIT | 805 · 02-26 | N | React, TW | Meta | Chat only |
| 15 | llm-ui | github.com/richardgill/llm-ui | MIT | 1.7k · 09-29 | N | React | Meta | Streaming markdown |
| 16 | Kokonut UI | github.com/kokonut-labs/kokonutui | MIT | 2.1k · 08-20 | N | React, TW, Motion | Meta | Marketing components |
| 17 | Cult UI | github.com/nolly-studio/cult-ui | MIT | 6.4k · 10-01 | N | React, TW, Motion | Meta | Animated components |
| 18 | ReUI | github.com/keenthemes/reui | MIT | 3.6k · 10-03 | N | React, TW | Meta | General patterns |
| 19 | Creative Tim UI (`ai-workflow-status-01`) | github.com/creativetimofficial/ui · creative-tim.com/ui | MIT | 12k · 03-14 | P | React, TW, shadcn | Pipeline nodes: idle/running/done/error, last action, tokens (page) | Sequential pipeline with simulated data; weak fit |
| 20 | simple-ai | github.com/Alwurts/simple-ai · simple-ai.dev | MIT | 758 · 10-05 | P | React, TW, shadcn, React Flow | Registry now 6 items (reasoning, tool) | Workflow graphs, not transcript rows |
| 21 | nexus-ui | github.com/victorcodess/nexus-ui · nexus-ui.dev | MIT | 132 · 06-16 | P | React, TW, shadcn | reasoning, chain-of-thought, tool, text-shimmer (registry) | Duplicates AI Elements |
| 22 | PastaUI | github.com/syeddhasnainn/pastaui · pastaui.com | MIT | 0 · 10-07 | Y | React, TW4 (`starting:`), shadcn | background-runs, background-inbox, task-card, agent-status, tool-timeline, job-progress (Src) | Top 10 #7 |
| 23 | mischief-ui | github.com/Tinkerers-Labs/mischief-ui · ui.tinkererslabs.com | MIT | 3 · 09-03 | Y | React, TW, shadcn, no deps | subagent-tree, agent-checklist, stopped-run, chain-of-thought, timeline (Src) | Top 10 #3 |
| 24 | AgentUI | agentui.pro | **not stated** | n/a · 08-23 | P | React, TW, Motion | agent-activity, agent-progress, agent-disclosure, todo-list (Src) | Good timer and motion; patterns only |
| 25 | signoff-ui (`@agent-ui-kit`) | github.com/dgesteves/signoff-ui · agent-ui-kit-demo.vercel.app | MIT | 1 · 10-11 | P | React, TW, Radix, AI SDK | tool-call-timeline (waterfall), run-meter, agent-status (registry) | Honorable mention; 2.4k-line timeline, too heavy |
| 26 | brainless | github.com/theswerd/brainless · brainless.swerdlow.dev | MIT | 836 · 09-25 | P | React, TW | claude-tool-call (`<details>`), claude-todo-list, Codex/Grok sessions (registry) | Terminal look; `<details>` idea only |
| 27 | inference.sh UI | ui.inference.sh | not stated | n/a | P | React, TW, shadcn | task, steps, agent (registry) | Coupled to `@inferencesh/sdk` |
| 28 | LiveKit Agents UI | livekit.com/ui | not checked | n/a | N | React, TW, shadcn, AI Elements | agent-control-bar, visualizers, chat-transcript (registry) | Voice only |
| 29 | Manifest UI | ui.manifest.build | not checked | n/a | N | n.c. | progress-steps, status-badge (registry) | MCP-app widgets; minor |
| 30 | GAIA UI | ui.heygaia.io | not checked | n/a | N | n.c. | tool-calls-section (registry) | Minor |
| 31 | asanshay DS | ds.asanshay.com | not checked | n/a | N | n.c. | chat-tool, chat-reasoning (registry) | Minor |
| 32 | Delta components | deltacomponents.dev | not checked | n/a | N | n.c. | No agent items (registry) | Not relevant |
| 33 | dominik-ui | dominikkoch.dev/ui | not checked | n/a | N | n.c. | 4 items, none agent (registry) | Not relevant |
| 34 | scrimui | scrimui.dev | not checked | n/a | ? | n.c. | Registry fetch failed (TLS) | Not inspected |
| 35 | VLLNT UI | ui.vllnt.com | not checked | n/a | ? | Radix + TW (per directory text) | Registry returned 503 | Not inspected |
| 36 | ai-elements (Svelte port) | github.com/SikandarJODD/ai-elements | MIT | 321 · 06-17 | P | **Svelte** | Port | Wrong framework |
| 37 | ai-elements-vue | github.com/vuepont/ai-elements-vue | NOASSERTION | 1.2k · 10-11 | P | **Vue** | Port | Wrong framework |
| 38 | ShadKit | github.com/jasonkneen/ShadKit | MIT | 47 · 09-15 | ? | n.c. | Meta | Not inspected |
| 39 | agentfaces | github.com/ajibadedapo/agentfaces | MIT | 4 · 10-06 | N | React | Animated agent faces | Novelty |
| 40 | tweakcn | github.com/jnsahaj/tweakcn | Apache-2.0 | 10.4k · 09-03 | N | React, TW | Meta | Theme editor |
| 41 | tablecn | github.com/sadmann7/tablecn | MIT | 6.3k · 10-10 | N | React, TW, shadcn | Meta | Data tables |
| 42 | Tremor | github.com/tremorlabs/tremor | Apache-2.0 | 3.7k · 2025-10 | N | React, TW | Meta | Charts and tracker bar; stale |

### Coding-agent apps (open source)

| # | Candidate | URL | License | ★ · push | Sub | Stack | Parts | Verdict |
|---|---|---|---|---|---|---|---|---|
| 43 | Cline | github.com/cline/cline | Apache-2.0 | 70k · 10-10 | Y | React, TW, VS Code tokens | `SubagentStatusRow.tsx` (Src) | Top 10 #2 |
| 44 | Kilo Code | github.com/Kilo-Org/kilocode | MIT | 27.6k · 10-11 | Y | **SolidJS** | `TaskToolExpanded.tsx`, `SubagentPanel.tsx`, `TodoChip` (Src) | Top 10 #9 (ideas only) |
| 45 | opencode | github.com/anomalyco/opencode | MIT | 212k · 10-11 | Y | **SolidJS** (web), TUI | TUI `subagent-footer`, `subagents-tab` | Web task rendering not inspected; TUI ideas only |
| 46 | Roo Code | github.com/RooCodeInc/Roo-Code | Apache-2.0 | 24k · 05-15 | P | React, TW | `SubtaskRow`, `SubtaskCollapsibleRow`, `TodoListDisplay`, `UpdateTodoListToolBlock` (Src) | Subtasks shown in history only; todo list is decent |
| 47 | Continue | github.com/continuedev/continue | Apache-2.0 | 36k · 10-09 | N | React, TW | No subagent file matched by name | Not a source |
| 48 | Zed | github.com/zed-industries/zed | GPL/AGPL/Apache mix | 91.6k · 10-11 | ? | **Rust GPUI** | Agent panel | Ideas only |
| 49 | Codex CLI | github.com/openai/codex | Apache-2.0 | 128k · 10-10 | Y | **Rust** | `subagent_notification.rs`, `tools/parallel.rs` | Protocol reference; no web UI |
| 50 | CloudCLI / claudecodeui | github.com/siteboon/claudecodeui | **AGPL-3.0** | 14k · 10-09 | Y | React, TW | `SubagentPanel.tsx`, `SubagentTimeline.tsx` (Src skim) | Excluded by license |
| 51 | claude-code-webui | github.com/sugyan/claude-code-webui | MIT | 1.1k · 05-29 | N | React, TW | No subagent file | Basic |
| 52 | claude-code-viewer | github.com/d-kimuson/claude-code-viewer | MIT | 1.3k · 08-18 | P | React, TW | `TodoWriteVisualizer`, todo sections | Todo only; sidechain view not found by name |
| 53 | vibe-kanban | github.com/BloopAI/vibe-kanban | Apache-2.0 | 28k · 09-19 | Y | React, TW, custom tokens | `ChatSubagentEntry`, `ChatTodoList`, `TodoProgressPopup` (Src) | Top 10 #8 |
| 54 | 1code | github.com/21st-dev/1code | Apache-2.0 | 5.6k · 03-06 | Y | Electron, React, TW, shadcn | `agent-task-tool`, `AgentTaskToolsGroup`, `agent-todo-tool` (Src) | Top 10 #5 |
| 55 | goose | github.com/aaif-goose/goose | Apache-2.0 | 55k · 10-09 | ? | Rust backend; desktop n.c. | Subagents in `crates/goose/src/agents/` | Desktop UI not inspected |
| 56 | OpenHands | github.com/OpenHands/OpenHands | MIT | 90.5k · 10-11 | ? | React, TW | `agent-status.tsx` control | Delegation UI not inspected (path lookup failed) |
| 57 | Terragon (OSS) | github.com/terragon-labs/terragon-oss | Apache-2.0 | 259 · 02-10 | Y | React, TW | `task-tool.tsx` via `GenericToolPart` (Src skim) | Product shut down; simple |
| 58 | HumanLayer CodeLayer WUI | github.com/humanlayer/humanlayer | Apache-2.0 | 11.7k · 06-19 | Y | React, TW | `TaskToolCallContent`, `TodoWidget` (Src) | 100-char prompt preview + result preview; thin |
| 59 | Open SWE | github.com/langchain-ai/open-swe | MIT | 11k · 10-11 | Y | React, TW, macaw DS | `SubagentGroup/Card/Activity/ThreadView` (Src) | Top 10 #4 |
| 60 | Crystal (now Nimbalyst) | github.com/stravu/crystal | MIT | 3.1k · 02-26 | P | React, TW | Parallel sessions; `TodoListDisplay` | Session-level parallelism |
| 61 | claude-squad | github.com/smtg-ai/claude-squad | **AGPL-3.0** | 8.6k · 08-20 | P | **Go TUI** | Parallel sessions | Excluded |
| 62 | opcode | github.com/winfunc/opcode | **AGPL-3.0** | 22.4k · 09-18 | ? | Tauri, React | Meta | Excluded |
| 63 | HolyClaude | github.com/CoderLuii/HolyClaude | MIT | 2.6k · 10-10 | N | n.c. | No subagent file | Not relevant |
| 64 | agentapi | github.com/coder/agentapi | n.c. | 1.5k · 09-13 | N | Go | HTTP API | No UI |
| 65 | vibekit | github.com/superagent-ai/vibekit | MIT | 1.9k · 01-13 | N | TS SDK | Sandbox SDK | No UI |
| 66 | Dyad | github.com/dyad-sh/dyad | custom (`src/pro`) | 21.8k · 10-09 | N | Electron, React | Meta | Not relevant |
| 67 | claude_code_agent_farm | github.com/Dicklesworthstone/claude_code_agent_farm | NOASSERTION | 921 · 09-21 | P | Python, tmux | Parallel agents | No web UI |
| 68 | Void | github.com/voideditor/void | Apache-2.0 | 28.8k · 06-02 | N | Electron (VS Code fork) | Meta | No subagent UI |
| 69 | Gemini CLI | github.com/google-gemini/gemini-cli | Apache-2.0 | 107k · 10-10 | ? | **Ink TUI** | Meta | Wrong medium |
| 70 | claude-code-hooks-multi-agent-observability | github.com/disler/claude-code-hooks-multi-agent-observability | none | 1.5k · 02-08 | Y | **Vue** | Hook-event dashboard | No license; Vue |

### Agent frameworks, chat apps, and examples

| # | Candidate | URL | License | ★ · push | Sub | Stack | Parts | Verdict |
|---|---|---|---|---|---|---|---|---|
| 71 | CopilotKit | github.com/CopilotKit/CopilotKit | MIT | 37.9k · 10-10 | N | React, TW | Agent-state render; todo canvas examples (tree) | No subagent card |
| 72 | open-multi-agent-canvas | github.com/CopilotKit/open-multi-agent-canvas | none detected | 542 · 10-10 | Y | React | Multi-agent chat | No license |
| 73 | agent-chat-ui (LangGraph) | github.com/langchain-ai/agent-chat-ui | MIT | 3.2k · 10-06 | N | React, TW, shadcn | `messages/tool-calls.tsx`, `tool-call-table.tsx` | Plain tool-call tables |
| 74 | agent-inbox | github.com/langchain-ai/agent-inbox | MIT | 1.1k · 09-18 | N | React, TW | Human-in-the-loop inbox | Approval-inbox idea only |
| 75 | open-canvas | github.com/langchain-ai/open-canvas | MIT | 5.5k · 02-25 | N | React, TW | Meta | Not relevant |
| 76 | ChatKit JS | github.com/openai/chatkit-js | Apache-2.0 | 2.0k · 07-31 | N | Hosted web component | Widgets | No React source to borrow |
| 77 | ChatKit starter app | github.com/openai/openai-chatkit-starter-app | MIT | 883 · 03-27 | N | Next.js | Meta | Starter |
| 78 | openai-cs-agents-demo | github.com/openai/openai-cs-agents-demo | MIT | 6.6k · 2025-12 | P | Next.js, TW | Agent handoff / runner panel | Handoff-list idea; stale |
| 79 | openai-agents-js | github.com/openai/openai-agents-js | MIT | 3.9k · 10-10 | N | TS SDK | SDK | No UI |
| 80 | Mastra playground-ui | github.com/mastra-ai/mastra | Apache-2.0 outside `ee/` | 28.7k · 10-11 | P | React, TW | `trace-span-tree`, `span-tree-row`, `agent-subagent-details` (HoverCard of *configured* agents) (Src) | Span tree OK; the subagent part is config, not run |
| 81 | Agno Agent UI | github.com/agno-agi/agent-ui | MIT | 1.9k · 05-08 | N | Next.js, TW | Meta | Chat and tool calls |
| 82 | AG-UI | github.com/ag-ui-protocol/ag-ui | MIT | 16.4k · 10-10 | N | Protocol | Protocol | No components |
| 83 | ADK Web | github.com/google/adk-web | Apache-2.0 | 1.1k · 10-08 | P | **Angular** | Dev UI | Wrong framework |
| 84 | Vercel Chatbot | github.com/vercel/chatbot | Apache-2.0 | 21k · 07-08 | N | Next.js, TW, shadcn | Meta | Uses AI Elements-style parts |
| 85 | LobeHub | github.com/lobehub/lobehub | **community license** | 83k · 10-11 | Y | React, antd-style | `SubAgentStats`, `AgentTasks/*Subtasks*` | Excluded by license; "model · tool calls · tokens" stat-line idea |
| 86 | Nanobrowser | github.com/nanobrowser/nanobrowser | Apache-2.0 | 14k · 10-02 | ? | React (extension) | Meta | Multi-agent Chrome extension; not inspected |

### Observability / run views

| # | Candidate | URL | License | ★ · push | Sub | Stack | Parts | Verdict |
|---|---|---|---|---|---|---|---|---|
| 87 | Trigger.dev | github.com/triggerdotdev/trigger.dev | Apache-2.0 | 16.5k · 10-10 | N | Remix, TW, Radix tooltip | `RunTimeline`, `SpanTimeline`, `dashboard-agent/agent-card` (Src) | Top 10 #10 |
| 88 | Langfuse | github.com/langfuse/langfuse | MIT outside `ee/` | 35.6k · 10-11 | P | Next.js, TW, shadcn | `web/src/features/traces/components/TraceTree.tsx` (Src skim) | Debugger-grade trace tree; too dense for the transcript |
| 89 | Laminar | github.com/lmnr-ai/lmnr | Apache-2.0 | 3.4k · 10-09 | Y | Next.js, TW | `condensed-timeline/subagent-group-element.tsx` (Src) | Honorable mention: subagent band over a span timeline |
| 90 | Opik | github.com/comet-ml/opik | Apache-2.0 | 22.5k · 10-10 | P | React, TW | `TraceTreeViewer.tsx` | Debugger-grade trace tree |
| 91 | Phoenix | github.com/Arize-ai/phoenix | **ELv2** | 11.8k · 10-11 | P | React | Span tree | Excluded |
| 92 | Inngest | github.com/inngest/inngest | **SSPL** | 5.9k · 10-10 | P | React | Run and step view | Excluded |
| 93 | Helicone, AgentOps, W&B Weave, Logfire, OpenLLMetry, HyperDX (6 projects, one row) | github.com/Helicone/helicone, AgentOps-AI/agentops, wandb/weave, pydantic/logfire, traceloop/openllmetry, hyperdxio/hyperdx | Apache/MIT | 1k–10k | N | Mixed | Meta | LLM-request and trace dashboards; no agent-row components found |

---

## 3. What to borrow into which Synara component

| Synara component (from notes.md) | Borrow | From |
|---|---|---|
| `TranscriptSubagentCard` header | Count logic: running → "Running N of M agents", failures → "· K failed", settled → "Ran M agents". One aggregate icon. | assistant-ui `ToolGroup`; mischief `tally()` (counts nested children) |
| `TranscriptSubagentCard` a11y | One `aria-live="polite"` sr-only summary for the whole card. Nested lists, not `role="tree"`. | mischief `SubagentTree` |
| `TranscriptSubagentCard` grouping | One card per spawn `toolCallId`. Open-thread link appears only for persisted transcripts. | open-swe `SubagentGroup` / `SubagentCard` |
| `AgentRow` progress line | One line: the current tool ("Using Read") plus "N steps" right-aligned. Never the full nested list. | open-swe `SubagentActivity`; Cline `latestToolCall`; 1code `getSubtitle()` |
| `AgentRow` elapsed | Tick from `startedAt` while running, then switch to `usage.duration_ms` when settled. Hide under 1 s. `tabular-nums`. | 1code `formatElapsedTime`; assistant-ui `AgentStatus` hides elapsed when done |
| `AgentRow` status and SR text | sr-only state word after the label. Separate `cancelled` state. Rows still marked running are shown as cancelled when the parent resumed or was interrupted. | assistant-ui `TaskStateIcon`; Cline `wasCancelled` |
| `AgentRow` settled preview | A result slot that stays visible when collapsed (2-line clamp). Error preview in the error tone. Tint the border on failure only. | assistant-ui `TaskCard.result`; vibe-kanban `ChatSubagentEntry` |
| `AgentRow` expand control | A real `<button>`. `aria-expanded` only when there is detail; disabled otherwise. | assistant-ui `TaskCard` |
| `AgentRowDetail` prompt | 2-line clamp; "Show more" appears only when a `ResizeObserver` shows overflow. | Cline `SubagentPromptText` |
| `AgentRowDetail` result | "Show output" → Markdown (`ChatMarkdown`), with the renderer injected as a prop. | Cline; vibe-kanban `renderMarkdown` |
| `AgentRowDetail` "Recent" steps | Icon column with a 1 px connector, label + description, status per step. | AI Elements `ChainOfThoughtStep` |
| `AgentRowDetail` stats / lifecycle | "Spawned → Started → Finished" markers with `tabular-nums` times; "N tools · N tokens". | Trigger.dev `RunTimelineEvent`; Cline stats line; lobehub `SubAgentStats` (idea only) |
| `AgentRowDetail` actions | Stop; Continue in background; Open child thread. | Kilo `TaskToolExpanded` (ideas) |
| `ComposerSubagentStrip` | Header counts "2 running · 1 done" / "All done". Row body is a button → `onRevealInTranscript`. Two-step Stop that disarms after 3 s. Timestamp gives way to actions on hover or focus. | PastaUI `BackgroundRuns`; assistant-ui `AgentStatus` pill |
| `SubagentWakeMarker` | Nothing found that does this. Closest ideas: assistant-ui `SubagentList` "summary agent" row (the caller shows it with `showSummary`); mischief `stopped-run` keeps the partial output. Build it new. | none |
| Nested agents (open question 6) | Recursive `AgentRun.children` with a `border-s` guide, counts rolled up into the parent header. | mischief `SubagentTree` |
| Default open state (open question 9) | Evidence: 1code auto-collapses on settle, and AI Elements closes reasoning 1 s after the stream ends, even when the user opened it. Both change height with no user input. Kilo derives the default from the status but remembers the user's choice. Recommend: open by default while running, never auto-close, remember the user's toggle. | 1code, AI Elements (counter-examples); Kilo `rememberOpen` |

Nothing in the survey replaces the planned extraction of `WorkflowAgentRowView` → `AgentRow` and `WorkflowAgentDetail` → `AgentRowDetail`. The sources above give prop shapes and rules for those components. They do not give components to install.
