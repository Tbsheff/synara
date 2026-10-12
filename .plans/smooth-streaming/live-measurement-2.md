# Live smoothness measurement 2: real Codex and Claude streams

Date: 2026-10-11 (re-run). Branch `feat/transcript-parity` at `6c9897831` plus the uncommitted working tree at build time (14:49). No source edits. Same method and scripts as [live-measurement.md](live-measurement.md); evidence in `/tmp/smooth-live-2/` (index at the end).

## Result

The turn-end follow loss is gone: the reader stayed pinned to the bottom in **6 of 6** turns (gap 0 px on every frame, during the stream and for 4 s after it), and there were **0** mid-stream follow releases. Code blocks no longer replace their `<pre>` while they stream (**0** swaps, was 32-290 per turn). Display math stalls dropped from 1153 ms to 269-398 ms.

What remains: Claude can still drop a whole table or code block in one frame (one update of **1172 chars / +626 px**), the turn-end fold still snaps in one frame and causes 28-55 % of the turn's CLS, and display math shows raw TeX in a placeholder before it renders.

## Before / after

"Before" = production-build runs in live-measurement.md (Codex t1/t2, Claude t1/t2). "After" = this run, same prompts for t1 and t2. t3 is new (display-math turn, no baseline).

| Metric | Codex t1 before → after | Codex t2 before → after | Claude t1 before → after | Claude t2 before → after | Codex t3 (new) | Claude t3 (new) |
|---|---|---|---|---|---|---|
| Load avg 1 min during turn (min / mean / max) | n/r → 8.7 / 10.7 / 13.4 | n/r → 8.8 / 10.1 / 11.2 | n/r → 9.4 / 9.9 / 10.7 | n/r → 10.4 / 10.6 / 10.9 | 8.5 / 9.1 / 9.9 | 9.5 / 10.0 / 10.6 |
| Send → first visible answer text | 12.4 s → **5.7 s** | 3.1 s → 2.3 s | 19.2 s → 15.4 s | 15.8 s → 15.7 s | 15.8 s | 5.7 s |
| Stream length | 58.6 s → 48.2 s | 56.7 s → 51.1 s | 15.8 s → 13.3 s | 5.6 s → 5.8 s | 24.3 s | 8.2 s |
| Final text (chars) | 8990 → 8963 | 5136 → 5052 | 7611 → 5907 | 4052 → 4034 | 2950 | 1967 |
| Revealed chars/s | 154 → 190 | 93 ¹ → 102 ¹ | 482 → 445 | 719 → 692 | 163 | 321 |
| Text updates/s | 13.6 → 14.7 | 8.8 ¹ → 7.8 ¹ | 14.6 → 17.1 | 13.8 → 17.3 | 11.8 | 15.1 |
| Chars per update p50 / p90 / max | 10/21/45 → 11/24/94 | 9/20/80 → 11/25/81 | 27/54/**243** → 25/42/**75** | 27/150/288 → 20/36/**1172** | 12/25/94 | 20/39/67 |
| Update interval p50 / p90 / max (ms) | 64/125/**1153** → 61/122/**212** | 63/126/219 → 60/120/**1549** | 63/122/188 → 60/107/208 | 70/124/134 → 59/119/217 | 88/153/398 | 61/124/242 |
| Stalls > 100 ms / > 250 ms | 151/2 → 141/**0** | 106/0 → 88/6 | 37/0 → 29/0 | 20/0 → 12/0 | 90/2 | 24/0 |
| Bursts ≥ 150 chars in one frame | 0 → 0 | 0 → 0 | 3 → **0** | 8 → 2 | 0 | 0 |
| Answer-box growth per frame p50 / p99 / max (px) | 21/75/87 → 21/63/75 | 21/75/80 → 21/80/85 | 32/138/244 → 25/85/96 | 42/202/202 → 21/**616/616** | 21/47/47 | 32/69/69 |
| `<pre>` replacements during stream | 290 → **0** | 71 → **0** | 92 → **0** | 32 → **0** | 0 (11 math placeholders) | 0 (9 math placeholders) |
| Follow-gap frames, max gap (stream + 3 s) | 98 fr, 201 px → **0, ≤ 1 px** | 4 fr, 172 px → **0, ≤ 1 px** | 92 fr, 180 px → **0, ≤ 1 px** | 1 fr, 50 px → **0, ≤ 1 px** | 0, 0 px | 0, 0 px |
| Gap 4 s after settle (px) | **142 → 0** | 0 → 0 | **143 → 0** | 0 → 0 | 0 | 0 |
| Mid-stream follow releases | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 (was 1 × 925 px in Claude run 2) | 0 | 0 |
| Largest single-frame scroll step | -132 px (Frame A) → -268 px ² | +146 px snap → n/a in stream ³ | -132 px → -158 px ² | +50 px → +626 px ⁴ | n/a in stream ³ | n/a in stream ³ |
| Long tasks in stream (count, max) | 1, 61 ms → 1, 78 ms | 3, 82 ms → 2, 79 ms | 1, 89 ms → 14, 74 ms | 0 → 0 | 1, 132 ms | 1, 124 ms |
| Max long animation frame | 91 → 121 ms | 93 → 117 ms | 118 → 88 ms | 76 → 75 ms | 155 ms | 144 ms |
| CLS total / max session window | 0.280/0.222 → 0.300/**0.110** | 0.155/0.109 → 0.137/0.071 | 0.261/0.189 → 0.294/0.162 | 0.184/0.111 → 0.145/0.098 | 0.050/0.030 | 0.064/0.030 |
| CLS at settle (share) | 0.22 (79 %) → **0.110 (36 %)** | n/m → 0.071 (51 %) | 0.19 (73 %) → 0.162 (55 %) | n/m → 0.041 (28 %) | 0.018 (35 %) | 0.029 (46 %) |
| Answer element replaced at settle | yes → yes | yes → yes | yes → yes | yes → yes | yes | yes |
| `overflow-anchor` on scroller at turn end | not captured → `none` | → `none` | → `none` | → `none` | `none` | `none` |

n/r = not recorded in the first run. n/m = not measured.
¹ Whole window from first text (commentary segment, ~22 s of tools, final answer). The first run's final-segment-only rate was 148 chars/s, 14.0 updates/s.
² At turn end, with the reader pinned: the fold above the answer collapses in one frame (row -205 px Codex, -158 px Claude) and the scroller follows it. The text near the bottom stays in view; see issue 2.
³ The largest steps in these turns are the send scroll (+183 to +281 px, 2-15 s before first text), the same as before.
⁴ Content growth, not a release: the reader followed a 1172-char update in one frame (issue 1).

Models: Codex GPT-6 Astra, Medium (`codex app-server` under the isolated server). Claude Sonnet 5.5, High (`claude --output-format stream-json` under the isolated server, 19 samples in `load.log`). The picker label was checked on each thread and the provider process was checked from the server's process tree.

## Top remaining jank sources

| # | Source | Worst measured | Where (run, rAF frame `f`, video s) |
|---|---|---|---|
| 1 | Claude large-chunk bursts after a tool turn. The first two updates of the final answer land in one frame each: a heading, a paragraph and the whole table (+785 chars, +515 px in the document), then the next sections and a code block (+1172 chars, +626 px), 217 ms apart | 1172 chars / +626 px in one frame (before: max 288 chars / 202 px). Claude t1 improved: max 75 chars, 0 bursts | `claude` t2 f 2061 → f 2068, 68.96 s; sheet `claude/frames/t2-burst-sheet.png` (frames 5-6, then row 2 frame 2) |
| 2 | Turn-end settle. The working rows remount (+116 px scroll at f 2068), then the leading work fold collapses in one frame (-205 px) instead of over the 220 ms transition, the answer element is replaced, and the action row appears. The reader stays pinned, but the visible text bounces up ~70 px and back ~40 px over 3 frames | Settle CLS 0.04-0.16 (28-55 % of the turn). Top CLS sources: `#text<code` in the answer (0.126 Codex t1, 0.088 Claude t1) and the action-row icon spans (0.078 Claude t1). Fold steps: Codex t1 `-53, -20, -5, -205, -6`; Claude t1 `-158, -91, -16, -36, -13, -6` | `codex` t1 f 2068-2073, 67.0-67.3 s (`codex/frames/t1-turn-end-sheet.png`, frames 5-8); `claude` t1 f 1199, 41.9 s |
| 3 | Display math placeholder. Each display equation first renders as `pre.chat-markdown-pending-math` (raw TeX in monospace), then swaps to KaTeX with a height change. The text holds while the equation closes | Stalls 269-398 ms with -40 / +35 px (before: 1153 ms, +55 px). 11 placeholder mounts in Codex t3, 9 in Claude t3. Working row below moves +56 to +76 px in one frame when a placeholder and KaTeX mount together | `codex` t3 +11.0 s, 169.7 s (`codex/frames/t3-math-stall-sheet.png`: raw `\frac{\mathbb{E}...}` lines in row 1); `claude` t3 f 2805, 92.4 s |
| 4 | Codex mid-answer stall with no DOM change | 1549 ms with no text change and +0 px (6 stalls > 250 ms in that turn). No `pre`, KaTeX, table or row change in the window; cause not identified (provider pause or reveal pacer, **unverified**) | `codex` t2 +36.6 → +38.1 s, f 3688-3742, 117.4 s (`codex/frames/t2-stall-sheet.png`) |
| 5 | Reveal cadence and pre-text rows | Text still changes in ~15 Hz steps (interval p50 59-61 ms, p90 107-124 ms). Work rows still insert before text and push the tail row ±40 px (Codex t1 f 456). Claude t1 had 14 long tasks in the stream (max 74 ms) under load ~10 | Any mid-stream clip; `codex` t1 f 456 |

Not seen this time: turn-end gap above the bottom, mid-stream follow release, `<pre>` swaps during code-block streaming, Codex display-math stalls > 1 s.

## Setup

| Item | Value |
|---|---|
| Instance | Isolated server `:3911`, `SYNARA_HOME` under `/tmp/smooth-live-2-home.mGNJ` (now deleted). Dev-runner dry run checked first (`baseDir` = temp home). `SYNARA_AUTH_TOKEN` was not set in the parent shell; `env -u` was still applied to the test processes. `~/.synara` not touched |
| Web build | `vite build` snapshot of the working tree + `vite preview` on `:5911` (same as runs 2-4 before). `git status`/`git diff` hashes at build time: `tree-status-at-build.md5` |
| Browser | Playwright Chromium headless, 1400×900, DPR 1, video on. rAF frame interval p50 30-31 ms, p95 61-62 ms (same ~30 fps as before) |
| Instrumentation | Same `instrument.js`, recovered byte-for-byte from the first run's transcript (initial writes plus every later patch, replayed in order) |
| Prompts | t1 and t2 identical to the first run (Claude t1 keeps "think carefully first"). t3 (new): no tools, ~600 words deriving linear-probing probe counts and the birthday bound, ≥ 6 display equations including one `aligned` block |
| Changes to scripts | Paths moved to `/tmp/smooth-live-2/`; t3 added; per-second `os.loadavg()` in `markers.json`; `analyze.mjs` first-text detection now ignores assistant IDs that existed before the send (needed for t3); `summary2.mjs` adds settle CLS, gap per phase, largest scroll step, `<pre>` add/remove counts. Metric definitions are unchanged |
| Load | Machine busy (Codex audit workflow): 1-min load 8.5-13.4 on 14 cores during the runs; 5-min 11.4-13.2. The first run did not record load |

## Caveats

- One turn per provider per prompt. Issue 1 appeared once (Claude t2); Claude run 2 had a 925 px release last time in 1 of 8 turns, and 0 of 6 now is not proof that it is fixed.
- Gap is measured on the scroller (`scrollHeight − clientHeight − scrollTop`). The Codex t1 end screenshot (`codex/t1-markdown-end.png`) confirms the last line and the action row sit above the composer; the other end screenshots were not inspected by eye.
- An "OpenCode update available" toast was on screen during both runs (top left of the transcript). It is fixed-position UI but may account for part of the unattributed `div` CLS (0.05-0.08 per turn).
- Long-task and LoAF numbers ran under load ~10 and are not comparable 1:1 with the first run.
- The build snapshot includes other agents' uncommitted edits at 14:49.

## Evidence index (`/tmp/smooth-live-2/`)

| Path | Contents |
|---|---|
| `codex/`, `claude/` | `t1-markdown*`, `t2-tools`, `t3-math`: `.jsonl` raw drains, `.analysis.json`, `-mid.html` / `-end.html`, `-end.png`; `markers.json` (send times, load samples, model label, `overflowAnchor`); `video/*.webm` |
| `*/frames/` | `cal30.png` (on-screen clock), 10 fps bursts, 6×5 sheets and clips: `codex/t1-turn-end`, `codex/t2-stall`, `codex/t3-math-stall`, `claude/t1-turn-end`, `claude/t2-burst` |
| `calibration.json` | `videoStartEpoch` per run (video s = (epoch ms − videoStartEpoch) / 1000) |
| `summary.json` | One row per turn with all metrics above |
| `load.log` | Every 5 s: `vm.loadavg` and provider processes under the server PID |
| `scripts/` | `instrument.js`, `drive.mjs`, `analyze.mjs`, `summary.mjs` (old), `summary2.mjs`, `extract.sh`, `sampler.sh`, setup/picker helpers |
| `server.log`, `web-build.log`, `web-preview.log`, `*-drive.log` | Process logs |
| `prev-bash-cmds.txt` | First run's shell commands, used to rebuild the scripts |
