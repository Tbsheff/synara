# Live smoothness measurement: real Codex and Claude streams

Date: 2026-10-11. Branch `feat/transcript-parity` at `6c9897831` plus the uncommitted working tree at measurement time. No source edits. Raw logs, video, and frame bursts: `/tmp/smooth-live/` (index at the end).

## Result

The stream itself is mostly smooth in a production build: no long tasks to speak of, and streaming-phase CLS is 0.02-0.05. The visible jank sits at the **edges of a turn**: the end of the turn drops the reader off the bottom in 4 of 8 measured turns (3 of 6 in the production build; every long no-tool answer), and block-level markdown (display math, code blocks, Claude's first chunk) appears in multi-line steps.

| # | Jank source | Worst measured | Seen in | Where to look (run, rAF frame `f`, video s) |
|---|---|---|---|---|
| 1 | Turn end drops end-follow: scrollTop falls 132 px in one frame, then the fold shrinks the row and the gap stays | Gap peaks at **168-254 px** and settles at **142-143 px** above the bottom (last 6-7 lines under the composer); never re-pinned in the 4 s capture | Codex t1 (prod and dev), Claude t1 (both runs). Codex t2 and Claude t2 recovered after 1-4 frames with a 50-146 px snap | `codex` t1 f 2402, 84.1 s; `claude` t1 f 1425, 48.5 s |
| 2 | Follow released mid-stream while a code block streams; the view freezes on the code block | scrollTop frozen **3.7 s** (f 1937-2039), gap grew to **925 px**, then one **925 px** snap | Claude run 2 t2 (1 of 8 turns) | `claude-run2` t2 f 1937 → f 2039, 66.8 s → 70.5 s |
| 3 | Display math holds the text, then lands in one step | **918-1153 ms** text stall, then **+55 to +87 px** in one frame (`katex` 2→3). A raw `$` shows for 1-2 frames before | Codex t1, both runs | `codex` t1 f 2183, 76.5 s |
| 4 | Claude's first chunk lands in bursts | First 1.5 s: chars per update p50 **37-118**, p90 **121-263** (later p50 25). Per-frame growth up to **244 px**; 3-5 frames per turn grow ≥ 100 px | All 4 Claude turns; never on Codex (max 80 chars per update) | `claude` t1 f 987, 33.1 s |
| 5 | Code blocks: `<pre>` replaced on every highlight pass, growth in 4-line steps | **92-96** `<pre>` swaps per Claude t1 (~6/s), **290** per Codex t1 (~5/s; 707 in dev). Steps of **84-106 px** at once | All turns with code | `codex` t1 f 1048, 35.4 s |
| 6 | Turn-end fold animates in uneven steps that pull the content | Row shrinks **-112, -37, -25, -17, -7 px** over ~150 ms (Codex: -31, -59, -98, -21, -41, -15, -7). Each step moves the text by the same amount | Every turn | `codex` t1 f 2410, 84.4 s |
| 7 | Turn-end DOM churn | `working-header`/`working` rows unmount and remount as new elements 60-90 ms before removal; `[data-assistant-message-id]` element replaced (whole answer DOM rebuilt) in **7/7** prod turns; answer text moves +4 to +6 px; the message action row appears (single layout-shift entry **0.12-0.14**) | Every turn | Same frames as #1 |
| 8 | Text reveal cadence is ~15 Hz word steps, not per-frame | Text changes on only **48-57 %** of frames (final answer segment); update interval p50 **63-70 ms**, p90 **~125 ms**; **106-151** stalls > 100 ms per Codex turn | All turns | Any mid-stream clip, e.g. `codex/frames/t1-mid-stream.webm` |
| 9 | Codex intermediate segments fold away above the final answer at settle | Commentary row removed above the answer (rows 7→4): answer moves **-91 px** in the document plus a **146 px** scroll snap; 1-frame bounce visible in video | Codex t2 | `codex` t2 f 4582, 155.8 s |
| 10 | Activity rows before and at first text | Work rows (MCP startup, hooks) insert/remove before text: tail row jumps **±37-40 px**; Claude's reasoning-summary row moves from the bottom to the top of the work list (~70-100 px); the `Thinking` row jumps **33-104 px** with no text change when the answer row mounts | Every turn | `claude` t1 f 461, 16.6 s and f 1132, 37.8 s |

Video second = (epoch ms − `videoStartEpoch`) / 1000, from each run's `frames/calibration.json` (aligned with an on-screen clock in every frame).

Not found: no font-size or line-height change between streaming and settled text (13 px / 21.125 px in the answer box from first paint to settle, every turn). No message-row re-keying during streaming (0 remounts by message ID mid-stream). No long tasks of note in the production build.

## Setup

| Item | Value |
|---|---|
| Instance | Isolated server `:3911` (`SYNARA_HOME` under `/tmp/smooth-live-home.*`), web `:5911`. Dev-runner dry run checked first. `SYNARA_AUTH_TOKEN` unset in the test processes only. `SYNARA_HOME` pointed at the temp home for every server process; nothing was started against `~/.synara` |
| Web build | Run 1 (Codex dev): `vite` dev server. Runs 2-4: `vite build` snapshot of the working tree + `vite preview`, because other agents' edits triggered HMR updates and one full reload in the dev page during the first Claude attempt |
| Browser | Playwright Chromium, headless, 1400×900, DPR 1, Playwright video on (25 fps). rAF ran at ~30 fps (frame interval p50 31-39 ms, p95 62-70 ms). Treat long-task numbers as relative, and cadence as "per frame at ~30 fps" |
| Instrumentation | Injected init script (no source edits): `PerformanceObserver` for `layout-shift` (with sources), `longtask`, `event` (≥ 16 ms), `long-animation-frame`; MutationObserver for row/`pre`/`table` add and remove; rAF → `MessageChannel` post-paint sample per frame (scrollTop, scrollHeight − clientHeight − scrollTop gap, assistant row and answer-box rects, visible text length excluding KaTeX MathML/buttons/`aria-hidden`, `pre`/`table`/`.katex` counts, last 8 rows with message IDs); on-screen epoch clock for video alignment |
| Prompts | t1: ~1000-word markdown answer, no tools: H1/H2/H3, two lists, 4×6 table, inline code, 10-line TS fence, 70+ line Python fence mid-answer, link, inline and display math. t2: tool turn (ls, read 4 files, `git log`, `wc -l`) then a ~700-word report with a table and a 35+ line TS fence. Claude t1 adds "think carefully first" |
| Models | Codex: GPT-6 Astra, Medium. Claude: Claude Sonnet 5.5, High (thinking on: reasoning summary row present). Claude run 2 is an accidental second Claude run with the Codex prompts (model carried over to the new thread); kept as a repeat sample |

## Codex vs Claude

All production build. "Gap at end" = scrollHeight − clientHeight − scrollTop on the last captured frame (4 s after the stream ended).

| Metric | Codex t1 | Codex t2 | Claude t1 | Claude t2 | Claude #2 t1 | Claude #2 t2 |
|---|---|---|---|---|---|---|
| Send → first answer text | 12.4 s | 3.1 s | 19.2 s | 15.8 s | 10.3 s | 17.0 s |
| Stream length | 58.6 s | 56.7 s (final answer 34.7 s) | 15.8 s | 5.6 s | 15.5 s | 5.7 s |
| Final text (chars) | 8990 | 5136 | 7611 | 4052 | 7104 | 3920 |
| Revealed chars/s | 154 | 148 ¹ | 482 | 719 | 458 | 689 |
| Text updates/s | 13.6 | 14.0 ¹ | 14.6 | 13.8 | 13.1 | 14.6 |
| Chars per update p50 / p90 / max | 10 / 21 / 45 | 9 / 20 / 80 | 27 / 54 / 243 | 27 / 150 / 288 | 27 / 69 / 188 | 30 / 97 / 189 |
| Update interval p50 / p90 / max (ms) | 64 / 125 / **1153** | 63 / 126 / 219 | 63 / 122 / 188 | 70 / 124 / 134 | 68 / 125 / 198 | 65 / 124 / 138 |
| Stalls > 100 ms / > 250 ms | 151 / 2 | 106 / 0 | 37 / 0 | 20 / 0 | 47 / 0 | 15 / 0 |
| Bursts ≥ 150 chars in one frame | 0 | 0 | 3 | 8 | 2 | 2 |
| Answer-box growth per frame p50 / p99 / max (px) | 21 / 75 / 87 | 21 / 75 / 80 | 32 / 138 / 244 | 42 / 202 / 202 | 32 / 107 / 110 | 33 / 181 / 181 |
| `<pre>` replacements during stream | 290 | 71 | 92 | 32 | 96 | 28 |
| Follow gap episodes (frames, max px) | end: 98, **201** | end: 4, 172 | end: 92, **180** | end: 1, 50 | end: 86, **254** | mid: 102, **925** |
| Gap at end (px) | **142** | 0 | **143** | 0 | **142** | 0 |
| Long tasks in stream (count, max) | 1, 61 ms | 3, 82 ms | 1, 89 ms | 0 | 0 | 0 |
| Max long animation frame | 91 ms | 93 ms | 118 ms | 76 ms | 73 ms | 80 ms |
| CLS total / max session window | 0.280 / 0.222 | 0.155 / 0.109 | 0.261 / 0.189 | 0.184 / 0.111 | 0.261 / 0.190 | 0.213 / 0.095 |
| CLS share at settle | 79 % | n/m | 73 % | n/m | n/m | n/m |

¹ Final answer segment only. Codex t2 streams a commentary segment, then ~22 s of tool calls, then the answer; over the whole window the rates are 93 chars/s and 8.8 updates/s.

Codex dev (`vite` dev server, same Codex t1 prompt) for reference: 148 long tasks in a 55.7 s stream (9.7 s total, max 165 ms), max LoAF 226 ms; top script `@tanstack/react-pacer` `setTimeout` (store flush throttle) 18.1 s cumulative, React scheduler 5.0 s. Update interval max 918 ms (display math again), 14 stalls > 250 ms, end gap 143 px. Production removes almost all of this cost, so dev-mode long tasks should not drive smoothness work.

Differences that matter:

- **Codex** streams slowly (148-154 chars/s) and evenly; the reveal never bursts. Its jank is block-level: display math stalls for ~1 s then jumps, code blocks grow in 4-line steps, and the turn end drops follow.
- **Claude** streams 3-5× faster (458-719 chars/s) and front-loads: after thinking, the first 1.5 s arrives in 120-290 char steps, so headings, paragraphs, and whole code blocks pop in. The turn end behaves the same as Codex.

## Detail per jank source

### 1. Turn end drops end-follow

Frame sequence (identical shape in all four persistent cases; Codex prod t1 shown, times from stream start):

| t (ms) | Event | scrollTop Δ | Row height Δ | Gap after |
|---|---|---|---|---|
| 58554 | `working-header` + `working` rows replaced by new elements; row +36 px | **-132** | +36 | **168** |
| ~58650 | working rows removed; outer row class `pb-1`→`pb-2`; answer element replaced | 0 | -37 (rows gone) | ~143 |
| 58809-58970 | Leading work display folds: inner wrapper `group min-w-0 py-0.5`→`mb-3` | -59, -98, -21, -41, -15, -7 | same | 142-201 |
| +4 s | No further scroll | 0 | 0 | **142** |

- Layout-shift sources at settle: a viewport-sized `div` plus the message action icons (`central-icon` spans, tooltip-trigger buttons) appearing at y≈847-852; single largest entry 0.12-0.14.
- Video: `/tmp/smooth-live/codex/frames/t1-turn-end-sheet.png`, `/tmp/smooth-live/claude/frames/t1-turn-end-sheet.png`, `/tmp/smooth-live/codex-v1/frames/turn-end-sheet.png`. The last paragraph slides down behind the composer and stays there.
- Root cause: native scroll anchoring holds the answer while the fold shell above it shrinks, and no re-pin path runs after settle. The first 132 px drop has a separate, unidentified writer. See "Code trace and probe" below.

### 2. Mid-stream follow release (Claude run 2, t2)

- At +1799 ms scrollTop stops at 6059 and stays for 3.7 s while scrollHeight grows from 7002 to 7821; the gap rises 106 → 925 px; at +5500 ms scrollTop jumps +925 in one frame.
- The release starts during a run of `<pre class="shiki">` replacements (one every 25-65 ms, 25 swaps between +1553 and +3054 ms). No `event` entries in the window, so no user input.
- One occurrence in 8 turns. It is the largest single jump measured. The driver sends no input during a turn (the `event` observer only logs events ≥ 16 ms, so it is not proof on its own).
- Video `/tmp/smooth-live/claude-run2/frames/release-4fps-sheet.png` (4 fps over 5 s): the view stays on the same code block for ~3.5 s while the answer keeps streaming off screen, then jumps to "Next Steps".

### 3. Display math

- Codex prod t1: 1153 ms with no text change, then +55 px (`katex` 2→3) and the paragraph after it in the same frame. Codex dev t1: 918 ms, +87 px. The frame sheet `/tmp/smooth-live/codex/frames/t1-katex-stall-sheet.png` shows the line cut back, a bare `$`, a pause, then the equation and the next line together.
- Claude did not stall on math (its display math arrived inside a large chunk).

### 4. Claude first-chunk bursts

- Claude t1 first 1.5 s: 18 updates, p50 54 chars, p90 216; one frame adds 243 chars and a whole TS code block (+254 px). After 1.5 s: p50 26, p90 45.
- Video `/tmp/smooth-live/claude/frames/t1-stream-start-sheet.png`: heading, two sections, and the code block appear within ~4 frames.

### 5. Code blocks

- Each highlight update replaces the `<pre>` node (MutationObserver: remove `pre.shiki#N`, add `pre.shiki#N+1`), 5-13 times per second while a fence streams.
- Height grows in 84-106 px steps (4-5 code lines) in dev, max 87 px in prod for Codex; up to 254 px for Claude when the block first mounts.

### 6-7. Fold steps and DOM churn at settle

- Fold steps are uneven (-112 then -37 then -25...) and every step moves the visible text because follow is already lost (source 1).
- Every prod turn replaced the `[data-assistant-message-id]` element at settle. The answer text moved +4 to +6 px in the document in the same frame.

### 8. Reveal cadence

- Text changes on about half the frames at ~30 fps (48 % Codex, 47-57 % Claude, final segment only): one commit per ~65 ms, 9-30 chars each. Codex reveals 1-2 words per step, Claude 4-5 words.
- Stalls > 250 ms appear only around display math (Codex) and in dev mode.

### 9-10. Segment fold and pre-text rows

- Codex t2: three assistant segments (commentary, then tools, then the final answer). At settle the commentary row above is removed: answer -91 px in the document, +146 px scroll snap, one-frame bounce in `/tmp/smooth-live/codex/frames/t2-turn-end-sheet.png`.
- Before text, MCP-startup and hook rows insert and remove under the user message (`nrows` 3→4→2→4); the tail row moves ±37-40 px each time. When the answer row mounts, the `Thinking` row jumps 33-104 px. On Claude, the reasoning-summary row moves from below the hook/MCP rows to above them (`/tmp/smooth-live/claude/frames/t1-stream-start-sheet.png`, frames 1-3).

## Code trace and probe (source 1)

Read-only trace (citations from the working tree at measurement time; files are being edited by other agents):

Status: **inferred** from this code trace plus one probe turn. The computed `overflow-anchor` of the scroller was not captured during a live default turn; the one direct read, after a page reload (tail anchor probably not set), returned `none`. Both default t2 turns also recovered without help, so the probe recovery is suggestive, not proof.

- An anchored send sets `tailAnchorMessageId`, and the anchor stays after settle (`ChatView.tsx:1960-1964`, `:6742-6748`; `anchorSentMessagesToTop` defaults to true, `appSettings.ts:383`). While it is set, `MessagesTimeline.tsx:2857-2858` passes `maintainVisibleContentPosition: false` to LegendList. LegendList then omits its `overflowAnchor: "none"` style (`@legendapp/list` `react.js:6247-6265`, `:7480-7495`), so Chrome's native scroll anchoring is live on the transcript scroller.
- `SettledTurnFoldTransition` (`MessagesTimeline.tsx:3515-3579`, start height from `measureSettledTurnFoldStartHeight` at `:3581-3597`) sits above the answer in the same row and shrinks to 0. Native anchoring keeps the answer still, so scrollTop drops by each shrink step and the gap does not close.
- Re-pin paths are all gated off after settle: `onIsAtEndChange` requires `hasStreamingAssistantText` (`useChatTranscriptScroll.ts:224-247`, `ChatView.tsx:1791-1793`); the auto-follow effect fires before the fold and bails when `isAtEndRef` is false (`useChatTranscriptScroll.ts:565-587`); `maintainScrollAtEnd` only holds within 10 % of the scroll length (`react.js:684-685`); `followTailBeforePaint` needs growth (`useTimelineRowOverlapGuard.ts:75-90`).
- The working-row remount is not an app key change (`working-header-row` and `working-indicator-row` are stable, `MessagesTimeline.logic.ts:904,937`). Inferred: LegendList re-binds the items to other recycled containers when the folding splice (`MessagesTimeline.logic.ts:1129-1132`) shifts indices.

Live probe (one Claude t1 turn, production build, `overflow-anchor: none !important` injected on the scroller, `/tmp/smooth-live/claude-noanchor/`):

| Step | Default (3 turns) | `overflow-anchor: none` |
|---|---|---|
| Frame A: scrollTop drop when the working rows re-bind | -132 px, gap 168 | **-132 px, gap 168 (unchanged)** |
| During the fold | scrollTop follows each shrink; gap 142-254 | Browser clamps: gap 168 → 142 → 11 → 0 within ~400 ms |
| Gap 4 s after settle | 142-143 px | **0** |
| CLS (turn) | 0.261 | 0.306 (the answer slides up ~131 px instead of the gap staying) |

Conclusion: native anchoring is the likely reason the gap persists (inferred, n=1 probe). It is **not** what causes the first 132 px drop: that drop is identical with anchoring forced off. That drop happens in the same frame the working rows move to new containers and the row grows +36 px; its writer is not yet identified. Turning anchoring off alone trades a stuck gap for a 131 px slide, so the fix has to keep the reader pinned through Frame A and the fold, not only disable anchoring.

Next step to find the Frame A writer (no relaunch needed beyond one turn): in `instrument.js`, wrap the scroller's `scrollTop` setter and `scrollTo`/`scrollBy`, and log `new Error().stack` for any write in the settle window; also log a `scroll` listener with the frame index.

## Caveats

- Headless Chromium with video capture ran rAF at ~30 fps. Block events are content-driven and do not depend on frame rate (follow gaps, the 925 px snap, math +55/+87 px, fold steps, code mounts), so the ranking holds. Cadence numbers do shift: at 60 Hz the 40 ms reveal gate lands at ~50 ms, so expect ~20 commits/s, ~25 % fewer chars per commit, and a lower share of frames with a text change.
- Instrument overhead: each sample walks the answer twice with a TreeWalker. `instrument.js` shows in LoAF at up to 8-10 ms (prod) and 30 ms (dev). That cost is inside the LoAF and frame-interval numbers and likely contributes to the ~30 fps.
- The production numbers come from a `vite build` snapshot of a working tree that other agents were editing at the time.
- One turn per provider per configuration. Source 2 appeared once.
- CLS counts only non-scroll layout movement; scroll-driven movement is measured from the frame log, not CLS.
- Codex loaded the operator's own MCP config (several MCP servers failed to start); those rows are part of what the user sees, but they add pre-text row churn that a clean config would not.
- Dev mode logged React `validateDOMNesting` warnings for `<a>` inside `<a>` in the Codex answer row (markdown link around an auto-linked path).

## Evidence index (`/tmp/smooth-live/`)

| Path | Contents |
|---|---|
| `codex/`, `claude/`, `claude-run2/` | Production-build runs: `t*.jsonl` (raw per-second drains: frames, shifts, longtasks, events, LoAF, mutations, style signatures), `t*.analysis.json`, `t*-mid.html`/`t*-end.html` DOM snapshots, `t*-end.png`, `markers.json`, `video/*.webm` |
| `codex-v1/` | Codex on the `vite` dev server (first instrument version: text length includes the leading work display) |
| `*/frames/` | 10 fps PNG bursts, 6×5 contact sheets (`*-sheet.png`), and clip `.webm` per moment (stream start, thinking, code-block growth, display math, mid-stream, tool rows, turn end). `calibration.json` maps video seconds to epoch ms |
| `summary.json` | One row per turn with the metrics above |
| `scripts/` | `instrument.js` (injected), `drive.mjs` (Playwright driver), `analyze.mjs`, `summary.mjs`, `extract.sh` |
| `claude-noanchor/` | Probe turn with `overflow-anchor: none` injected (source 1) |
| `claude-partial/`, `codex-smoke/` | Aborted Claude attempt (HMR reload) and the smoke turn; not used in the tables |
