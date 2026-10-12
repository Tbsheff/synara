# Transcript parity: gap measurement

Goal: every Codex and Claude event renders cleanly in Synara, with Codex desktop (ChatGPT.app 26.1002.52244, bundle `com.openai.codex`) as the reference.

All findings come from reading the code, plus real counts from `~/.synara` (read-only copy). Nothing here is checked against a live session unless stated.

## Source reports

| File | Content |
|---|---|
| `codex-desktop-renderers.md` | How Codex desktop renders each item kind (minified-bundle evidence) |
| `codex-synara-mapping.md` | 113 Codex events → Synara UI, graded |
| `claude-synara-mapping.md` | 109 Claude SDK messages/blocks/tools → Synara UI, graded |
| `event-frequency.md` | Real event counts per provider from the user's DB |
| `collapsed-replies-rootcause.md` | Root cause of real replies folding into "Worked for" |

## Score today

| Provider | Clean | Partial | Generic | Dropped (gap) | Dropped / state (by design) |
|---|---|---|---|---|---|
| Codex (86 live events) | 21 (16 in transcript) | 14 | 31 | 10 | 10 |
| Claude (109 rows) | 31 | 19 | 16 | 31 | 5 + 7 state |

## Ranked gaps

Rank = how often the event occurs × how bad the current render is.

| # | Gap | Volume (user DB) | Today | Codex desktop | Fix direction |
|---|---|---|---|---|---|
| 1 | Real replies fold into "Worked for" | Every Claude thread with background tasks | Ordering bug: work rows sort by sequence, messages by time; two sequence counters mixed (`workLog.ts:3043`, `ProjectionPipeline.ts:1279`) | Picks `phase === "final_answer"` per turn | One ordering key + mixed-sequence test; keep Codex `phase` (dropped at `CodexAdapter.ts:986-1000`); Claude: last text before `result` |
| 2 | Command rows | Codex 17.8k, Claude Bash ~2.3k | Output only at completion; no exit code, duration, cwd | `Ran {cmd} in {t}`, live output (last 20k chars), `Success` / `Exit code N` footer | Stream `command_output` deltas to web; read `item.exitCode`, `durationMs`; Claude: use structured stdout/stderr |
| 3 | Noise rows | Codex 1,474 unmapped + 1,844 warnings; checkpoint warning per child/wake turn | Bare method-name rows; repeated truncated warnings; "Moved to background"; mixed "N updates" groups | Not in transcript; config/deprecation warnings go to Settings | Explicit drop/route list for unmapped methods; guard child turns in `CheckpointReactor`; debug-level for wake turns; group task_progress per subagent |
| 4 | File edits | Codex 1.9k, Claude Edit 157 | Per-file `changes[].diff` / `structuredPatch` unused; buffered output replaces turn-diff link | One row per file `Edited {file} +N −M`, summary card (3 files + "Show N more", Undo/Reapply) | Render per-change diff from provider payload; keep turn-diff link |
| 5 | Claude tool misclassification | Seen in DB: Agent/Bash typed `mcp_tool_call` | Name-substring guessing (`ClaudeAdapter.ts:1184-1235`); `tool_progress` forces MCP type | n/a | Classify from the SDK tool name table, never substrings; don't let progress override type |
| 6 | Generic tools | Codex MCP 382, web search 147; Claude Read 179, Grep/Glob/WebFetch/Skill | Name-only rows; no args/results/errors/query | Grouped rows with action summary | Per-tool detail builders in `toolCallDetails.ts` (args + result + error); web search query in `itemDetail` |
| 7 | Dropped user-facing content | Advisor 11, images in tool results, refusals | Images/PDFs in tool results stripped (`ClaudeAdapter.ts:1744-1766`); refusal reason, hook block reason, local command output, server-tool results dropped | n/a | Map to visible rows/cards |
| 8 | Reasoning | All turns | Claude: collapsed rows capped 8k chars; Codex: not live | Not in transcript; latest summary line replaces "Thinking" shimmer | Decide: match Codex (status line only) or keep rows; make Codex reasoning live either way |
| 9 | Grouping and retry rows | Most turns | `ToolCallGroupSummaryRow` exists; retries add rows | Consecutive tools merge; header lists actions ("Edited files, ran commands"); `Reconnecting k/N` replaces in place | Compare group header wording; replace retry rows in place |
| 10 | Approvals edge cases | Rare | `auth_tokens_refresh` / unknown requests leave an unanswerable row | Panel at composer; legacy approvals ignored | Drop the row when no panel can render |

Near parity already: subagents (Codex collab, Claude Agent), approvals panel, user-input questions, plans, task list, turn diff card, compaction, image generation, live assistant text.

## Suggested order

1. Gap 1 (bug, small, high impact).
2. Gap 3 noise cleanup + gap 5 misclassification (small, removes wrong output).
3. Gap 2 command rows (biggest volume).
4. Gap 4 file edits, then gap 6 per-tool details.
5. Gaps 7–10.
