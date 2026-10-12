# Smooth streaming: top 10 changes to how the transcript feels

Date: 2026-10-10. Read-only research. Code state: branch `feat/transcript-parity` at `6c9897831`, plus the uncommitted transcript-parity changes in the working tree. Other agents are editing `ChatView.tsx`, `ChatView.logic.ts`, `MessagesTimeline.tsx` and `MessagesTimeline.logic.ts`, so line numbers in those files can move. Each citation also names its function or constant so that you can find it again. `LL` = `apps/web/node_modules/@legendapp/list/react.mjs` (v3.3.3, patched by `patches/@legendapp*`). Web paths are relative to `apps/web/src/`.

Scope: how smooth the transcript looks to the user. Raw cost (markdown re-parse per commit, work-log re-derivation, highlighting on the main thread, store churn) is in [perf-audit/README.md](../perf-audit/README.md) #7, #8, #10 and [perf-audit/web.md](../perf-audit/web.md) #1, #2, #9. This document refers to those items and does not repeat them.

## Result

| # | Change | Impact (1-5) | Ease (1-5) | Score | Overlap |
|---|---|---|---|---|---|
| 1 | Keep the status line steady: no "Thinking" → heading → "Thinking" flip-flop, minimum hold time, crossfade | 4 | 4 | 16 | Refines parity W-activity #1 (in progress) |
| 2 | One turn header from send to settle; fold the turn in one eased step | 5 | 3 | 15 | Builds on parity gap 1 / W-timeline; new motion work |
| 3 | Follow the tail in the same frame as the growth (remove the one-frame lag) | 5 | 3 | 15 | New. Extends W-timeline scroll tests (a)-(c) |
| 4 | Stop ticking numbers from moving text: `tabular-nums`, one clock, one formatter | 3 | 5 | 15 | New |
| 5 | Code blocks: stream the code at text cadence, cache failed languages, wait for the full fence line | 4 | 3 | 12 | Visible part only. Cost is perf web.md #9 |
| 6 | Repair partial markdown while streaming (links, images, emphasis, math) | 3 | 4 | 12 | New. Block parse is perf #8 |
| 7 | Fade new tail rows in (opacity only) | 3 | 4 | 12 | New |
| 8 | Text reveal: drain the backlog at stream end, make the smoothing frame-rate independent, then fade in new words | 4 | 3 | 12 | New. The word fade needs perf #8 first |
| 9 | A click in the transcript does not drop follow | 3 | 4 | 12 | New |
| 10 | Debounce and fade the "Reconnecting to Synara server" banner | 2 | 5 | 10 | New |

Score = impact × ease. When scores are equal, the item with more impact comes first. Ease 5 = one small file; ease 2 = a library patch or a cross-cutting change.

## Cadence today (provider to pixels)

| Stage | Behavior | Evidence |
|---|---|---|
| Provider → server | One `thread.message.assistant.delta` per provider delta. There is no time window for text | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:3104-3107, :3193-3200` |
| Server tool progress | 50 ms window, for tool progress only | `providerRuntimeProgressCoalescing.ts:3` (`PROVIDER_RUNTIME_PROGRESS_WINDOW_MS`) |
| Live tool output (parity) | 250 ms per item | `packages/contracts/src/transcriptDetails.ts:20` (`TRANSCRIPT_LIVE_OUTPUT_MIN_INTERVAL_MS`) |
| Browser store | 100 ms trailing throttle. The first delta of a message flushes at once. Deltas merge per message | `routes/__root.tsx:2174-2183` (`domainEventFlushThrottler`), `orchestrationEventCoalescing.ts:36-65` |
| Reveal | Speed = `min(2000, backlog / 0.16 s)`, low-pass 0.15 per frame, React commit at least 40 ms apart | `hooks/useSmoothStreamedText.ts:23-35, :91-105` |
| Effective | 20 commits/s at 60 Hz (the 40 ms gate lands on the 50 ms frame). Each commit adds ~(rate ÷ 20) chars: ~25 chars (4-5 words) at 500 chars/s. The reveal is 1-2 store flushes behind | Simulation of `stepSmoothReveal` with the real constants |
| Stream end | The text that is not yet shown appears in one frame | `useSmoothStreamedText.ts:207` (`return animate ? revealed : text`) |

The steady-state speed changes by only about ±10 %, so the 100 ms bursts are mostly hidden. What the user sees is (a) 4-5 words appearing at once 20 times a second, (b) a snap at the end, and (c) the layout events listed below.

## How Codex desktop does it (reference)

Source: `/tmp/codex-src-xjDG9Z/app/webview/assets/` (minified). File names are shortened: AI = `app-initial-*.js`, SER = `sites-end-resource-*.js`, TSL = `thread-scroll-layout-*.js`.

| Topic | Codex desktop | Synara today |
|---|---|---|
| Reveal pacing | Class `O2c`: EMA arrival rate (α 0.1), backlog relaxation every 50 ms, fraction carried forward, published on rAF through `useSyncExternalStore`. Flushes all text at stream end. The arrival-floor flag (`267402900`) value that ships is unknown | `useSmoothStreamedText`: similar idea, snaps at end |
| New-token motion | Words split with `Intl.Segmenter`. Each word is a `span._FadeIn` with a stable key; settled words do not animate again. 0.7 s opacity fade on the final answer, 0.15 s elsewhere; stagger 16-24 ms, maximum 96-800 ms | None |
| Partial markdown | Custom repair `bWc`: drops a partial image line, cuts an unfinished `[link](` at `[`, closes an odd `*`/`**`, leaves an open fence open. Stable-prefix token cache: only the tail after the last blank line is lexed again | No repair (table repair only). Full parse per commit |
| Open code fence | `isCodeFenceOpen`: hides the copy button, no language → `plaintext`, mermaid shows a placeholder; heavy blocks render a placeholder until they are within 600 px of the viewport | Rendered code throttled to 160 ms-1 s; unknown languages fall back to plain text |
| Scroll follow | Default (flag-off) mode: `flex-col-reverse` scroller with `overflow-anchor:none`, so the browser keeps the bottom pinned without JS. The shipping flag value is unknown. Follow zone 24 px. User intent (wheel, keys, touch > 8 px, scrollbar drag) cancels follow; a plain click is not in that list (inferred, not observed) | LegendList `maintainScrollAtEnd`, follow in the next frame (see #3). Any pointerdown cancels follow (see #9) |
| Scroll-to-bottom | 260 ms cubic ease-out on rAF; instant under reduced motion or when ≤ 24 px | Native smooth scroll |
| Turn collapse | framer-motion: expand 300 ms `[.19,1,.22,1]`, collapse 150 ms `[.23,1,.32,1]`, `translateY(-8px)` + opacity | Two steps (see #2) |
| Status label | "Working" → "Working for {time}" after 1 s; the latest reasoning summary replaces the shimmer | Label changes with no transition (see #1) |
| Reduced motion | App setting plus OS setting. Reveal off, fades 0 s, shimmer off, collapse 150 ms with no translate, scroll instant | Reveal off. Most CSS honors `motion-reduce` (gaps in "Not ranked") |

---

## 1. Keep the status line steady

- **What the user sees:** The shimmer row at the tail changes text, icon and width with no transition. With the in-progress parity change, it reads "Thinking" → reasoning heading → "Thinking" each time a reasoning row with the same heading lands in the transcript. Quick changes look like flicker, and the shimmer sweep changes speed as the width changes.
- **Root cause:**
  - `resolveWorkingStatusText` returns `null` when the heading is already visible in the transcript, so the label goes back to "Thinking" (`components/ChatView.logic.ts:1654-1657`, uncommitted).
  - Label chain: `resolveWorkingLabel` (`ChatView.logic.ts:1447-1460`). Icon swap: `MessagesTimeline.tsx:664-669`. Row is `w-fit`, label is raw text (`MessagesTimeline.tsx:2790-2810`, `row.kind === "working"`).
  - The `tw-shimmer` background size is a percentage of the element (`index.css:2542-2551`), so a width change also changes the sweep speed (unverified visually).
- **Change:**
  1. When the heading is visible in the transcript, keep showing the last label instead of "Thinking". Go back to "Thinking" only when nothing new happens for a period (for example 3 s).
  2. Hold each label for at least ~600 ms; when a newer label arrives during the hold, show only the newest.
  3. Crossfade label changes with the existing fade class in `lib/disclosureMotion.ts` (fade-only, `:36-41`); do not write a new keyframe.
  4. Use a `min-width` that only grows during a turn, so that the row does not shrink and grow.
- **Reference:** Codex shows the latest reasoning summary in place of the shimmer and keeps it until the next one (`codex-desktop-renderers.md`, gap 8 in the parity README).
- **Risk:**
  - Low. The row height does not change, so end-follow is not affected.
  - Reduced motion: the crossfade class carries `motion-reduce:transition-none`; the hold time still applies (it is pacing, not motion).
  - Coordinate with the W-activity owner; this edits the same function.
- **Verify:**
  - Unit test in `ChatView.logic.test.ts`: heading → visible heading row → label stays the heading; a burst of 3 headings in 300 ms → one change.
  - Browser test (new case in `MessagesTimeline.tailAnchor.browser.tsx` or `ChatView.browser.tsx`): count label text changes per second in a scripted turn. Target ≤ 2/s; today one change per event.

## 2. One turn header from send to settle; fold in one eased step

- **What the user sees:**
  - **Start:** "Working for Xs" and a divider appear above the answer only when the turn start time arrives, which pushes the content down.
  - **End:** The header and the "Thinking" row disappear at once and the answer moves up. 180 ms later, in one commit, the turn work folds, "Worked for X" appears below a collapsing clone, the changed-files card opens fully expanded, and row padding changes by 4 px.
  - **Number change:** the number can change form at the handoff ("9s" → "9.6s").
- **Root cause:**
  - The header is inserted only when `activeTurnStartedAt` exists (`components/chat/MessagesTimeline.logic.ts:907-918`, `findLiveTurnHeaderInsertIndex`).
  - The header and "Thinking" row follow `isWorking` (`ChatView.tsx:1788-1789`), but the fold follows `activeTurnInProgress`, which stays true for `ACTIVE_TURN_LAYOUT_SETTLE_DELAY_MS = 180` (`ChatView.logic.ts:1890`, `ChatView.tsx:1818-1847`).
  - The fold itself is `collapseSettledTurns` (`MessagesTimeline.logic.ts:967-1113`): it splices out the folded rows in one pass.
  - The clone collapse (`MessagesTimeline.tsx:2323-2341`, hook at `:3118-3307`) renders summarized chunks, not the original rows, so its first frame can have a different height (unverified).
  - Changed-files card defaults open (`MessagesTimeline.tsx:2508-2512`, `?? true`). Padding changes `pb-1`→`pb-2` (`:1434-1444`) and `mb-0.5`→`mb-2` (`:2229-2233`).
  - Live timer floors whole seconds from the turn start; settled uses `formatDuration` (rounds, decimals under 10 s) from the earliest folded row (`MessagesTimeline.logic.ts:1060-1099`, `session-logic.ts:87-109`).
  - A possible second change after completion: a snapshot with more than one text segment changes the row key from `message.id` to `${id}#seg:N`, and those rows render muted (`workLog.ts:3862-3882`, `MessagesTimeline.tsx:1645-1662`). How often this happens is unverified.
- **Change:**
  1. Make the header one row with a stable id, inserted at send time (use the optimistic send time; switch silently to the server start time). Its text is "Working" → "Working for Xs" → "Worked for X". The row does not unmount at turn end; only the text changes and it becomes the disclosure trigger.
  2. Drive the header, the "Thinking" row and the fold from one signal (the settle signal after the 180 ms grace), so that all the changes happen in one commit.
  3. The collapse clone must measure the real rows it replaces (render the same rows, not summarized chunks) so that the first frame matches. Keep the existing 220 ms grid-rows collapse from `disclosureMotion.ts`.
  4. Mount the changed-files card collapsed, or expand it with `DisclosureRegion` after the fold ends.
  5. One formatter and one start time for live and settled (see #4).
  6. Do not change the key of a row that already streamed when segments arrive. Keep the first segment on `message.id`, and do not apply muted styling to the final-answer segment (parity gap 1 owns the final-answer rule; coordinate).
- **Reference:** Codex: "Working" → "Working for {time}" after 1 s on the same line; collapse 150 ms `[.23,1,.32,1]` with opacity and `translateY(-8px)` (SER `tO`).
- **Risk:**
  - AGENTS.md: "Keep end-follow while the reader remains at the bottom, including ... the final settled layout." The fold shrinks content above the answer. For a reader at the bottom, the list must stay pinned to the end during each frame of the collapse, so run it with the same-frame follow from #3. A detached reader must stay at the same content: keep `maintainVisibleContentPosition` behavior and add a test.
  - The header row must not rearm a detached reader. It is not a message, so it does not change `transcriptAutoFollowSignal` (`useChatTranscriptScroll.ts:153-170`); keep it that way.
  - Reduced motion: the collapse is instant through `motion-reduce:transition-none`; this is correct.
  - Parity W-timeline owns the fold logic now. Do this after it merges.
  - Ease 3 can be optimistic: today the live header is its own row, but the settled "Worked for" is rendered inside the terminal message row. One header row for both is a structural change to `MessagesTimeline.logic.ts` and to the message row renderer.
- **Verify:**
  - Browser test that extends `MessagesTimeline.toolGroupCollapse.browser.tsx`: sample the final answer's `getBoundingClientRect().top` on each frame with the pre-paint ResizeObserver probe from `MessagesTimeline.rowOverlap.browser.tsx:312-337`. Target: the answer moves in one direction (no step up, then a second step).
  - `PerformanceObserver({type: "layout-shift"})`: sum of shift values from `turn.completed` to 500 ms later, before and after.
  - Record a 60 fps screen video of a real Claude turn with tools and step through it frame by frame.
  - Unit: `formatElapsed` live and settled give the same text for the same start and end.

## 3. Follow the tail in the same frame as the growth

- **What the user sees:** While text streams at the bottom, the new line paints first and the scroll catches up one frame later (often two). The text appears to bounce at the bottom edge 20 times a second. Small growth (≤ 5 px, the end of a disclosure ease) is not followed, so a small gap stays until the next large growth.
- **Root cause:**
  - `doMaintainScrollAtEnd` calls `scrollToEnd` inside `requestAnimationFrame` (`LL:1373`). The shared ResizeObserver runs before paint of frame N; the scroll runs in frame N+1.
  - Growth while a follow is pending sets `pendingMaintainScrollAtEnd`, which runs after `setTimeout(0)` and one more rAF (`LL:1389-1399`).
  - Follow triggers only when `Math.abs(prevSizeKnown - size) > 5`, and never on a row's first size (`LL:4826-4828`).
  - Shrinks are applied one frame late outside MVCP mode (`LL:5337-5383`).
  - Synara's own rescue path is also rAF-deferred (`components/chat/useChatTranscriptScroll.ts:181-203`), and `scrollTailExpansionToEnd` writes four times at rAF, 80, 180 and 260 ms (`MessagesTimeline.tsx:1198-1214`).
  - Props: `maintainScrollAtEnd={followLiveOutput && !tailAnchorSlideInFlight}`, `maintainScrollAtEndThreshold={0.1}` (`MessagesTimeline.tsx:2864-2865`).
- **Change:**
  1. In the existing LegendList patch, when the list is already at the end and follow is on, call `scrollToEnd({animated:false})` synchronously in the ResizeObserver flush (before paint). Keep the rAF path for the case where the list is not at the end yet.
  2. Remove the `> 5` px condition when the list is already at the end.
  3. Replace the four writes in `scrollTailExpansionToEnd` with one ResizeObserver-driven follow on the tail row for 300 ms.
  4. Set `overflow-anchor: none` on the transcript scroller in every mode. Today Chrome scroll anchoring stays on while a tail anchor is set (`MessagesTimeline.tsx:2866-2867` passes `false`; `LL:6226-6244, :6595`).
- **Reference:** In its default (flag-off) mode, Codex uses a `flex-col-reverse` scroller, so the browser keeps the bottom in place in the same frame with no JS (TSL). The flag (`2004881635`) value that ships is unknown; in the other mode Codex compensates with a ResizeObserver height delta. Column-reverse is a large structural change for Synara; a bounded same-frame scroll in the observer gets the same result.
- **Risk:**
  - AGENTS.md: "never couple virtualizer measurement to a bottom-stick/height-follow feedback loop." **This change has that shape.** In a virtualized list a scroll can move the rendered window; new rows then mount, are measured, and the ResizeObserver fires again. The cycle is bounded today only because the follow waits one frame. Bounds that the patch must have:
    - At most one synchronous scroll write per frame (a per-frame flag, cleared in the next rAF).
    - A re-entrancy guard: a size change caused by the scroll write itself does not start a second synchronous write; it goes to the existing rAF path.
    - Write only when the size delta is positive, follow is on, and the list was at the end before the growth.
    - If a reviewer still reads this as the forbidden loop, fall back to the parts that do not touch measurement: steps 2-4 and the `overflow-anchor` fix.
  - AGENTS.md: "User navigation away from the bottom releases follow." The synchronous path runs only when `maintainScrollAtEnd` is true, and `clearTranscriptAutoFollow(true)` already turns that off with `flushSync` before the next frame (`useChatTranscriptScroll.ts:120-145`).
  - Tail anchor: the slide sets `tailAnchorSlideInFlight`, which turns this off. Keep it like that.
  - Library patch: the patch must be applied again when LegendList is upgraded. Reduced motion: no change (the scroll is instant).
- **Verify:**
  - New browser case in `MessagesTimeline.liveOutput.browser.tsx` (and plain-text streaming in `MessagesTimeline.tailAnchor.browser.tsx` with anchoring off): with the pre-paint probe from `MessagesTimeline.rowOverlap.browser.tsx`, record `scrollHeight - scrollTop - clientHeight` for each frame during a 170-frame stream. Target: 0 px on ≥ 99 % of frames (today a non-zero value on most growth frames, by code reading). Also count synchronous scroll writes per frame: target ≤ 1 on every frame. The current tests use `vi.waitFor` with 4-96 px tolerance (`MessagesTimeline.liveOutput.browser.tsx:21`, `MessagesTimeline.tailAnchor.browser.tsx:26`) and do not see one-frame gaps.
  - Keep W-timeline cases (a)-(c) and `ChatView.browser.tsx:6933` (no rearm for non-message activity) green.
  - In a git worktree, run the vitest binary with an explicit `--root`.

## 4. Stop ticking numbers from moving text

- **What the user sees:** "Working for 9s" → "10s" changes width each second. On tool rows, "· Active 3s ago · 12s elapsed" changes width each second and the disclosure chevron after it moves sideways. Two clocks tick at different times, so text moves twice a second. At turn end the number can change format.
- **Root cause:**
  - `WorkingTimer` uses its own `setInterval(…, 1000)` from mount, not aligned to the start time, and not paused when the tab is hidden (`MessagesTimeline.tsx:3329-3351`).
  - Tool rows use `startVisibleInterval` (`lib/liveActivityPresentation.ts:12, :28`; `lib/visibleInterval.ts:3-41`).
  - No `tabular-nums` on the header (`MessagesTimeline.tsx:2775-2785`), the "Worked for" span (`:2360-2364`) or the tool-row meta (`TimelineWorkEntryRow.tsx:1122-1124, :1159-1161`). The label box fits its content and the chevron follows it (`TimelineWorkEntryRow.tsx:1106-1113, :1622`).
  - Formatters differ: `formatClockDuration` floors; `formatDuration` rounds and shows decimals (`session-logic.ts:87-109`).
  - On completion the meta tail disappears in one step (`liveActivityPresentation.ts:171-173`).
- **Change:**
  1. Add `tabular-nums` to all three places.
  2. Move `WorkingTimer` to `startVisibleInterval` and align ticks to whole seconds from the start time (one shared clock).
  3. Use one formatter for live and settled text.
  4. Put the chevron in a fixed position (before the label or at a fixed right edge), or give the meta a `min-width` in `ch`.
  5. Fade the meta tail out with the fade-only disclosure class.
- **Reference:** Codex ticks "Working for {time}" every 1 s from one clock (`codex-desktop-renderers.md`).
- **Risk:** Very low. No height change, so no end-follow risk. Reduced motion: no animation added except the meta fade, which uses `motion-reduce:transition-none`.
- **Verify:**
  - Browser test: record `getBoundingClientRect().width` of the header and the chevron `left` for 5 s while live. Target: the chevron does not move; the width changes only when the digit count changes.
  - Unit test: the live and settled formatter give the same string at the handoff.

## 5. Code blocks: stream the code at text cadence

- **What the user sees:**
  - Code in a streaming fence grows in jumps every 160 ms (up to 1 s for big blocks) while the prose around it grows smoothly.
  - When the fence line is ```` ```pyt ```` before the full name arrives, or when the language is not bundled (`txt`, `plaintext`, `plain`, any unknown name), the block probably stays on the plain fallback and suspends again on every render (runtime behavior unverified; the code path is below).
  - At stream end the code jumps to its final text.
- **Root cause:**
  - `SuspenseShikiCodeBlock` renders the throttled value, not the live code (`components/ChatMarkdown.tsx:1031-1046`; `STREAMING_CODE_HIGHLIGHT_INTERVAL_MS = 160` at `:1005-1023`; `hooks/useThrottledStreamingValue.ts:35-89`).
  - The language is the raw text after the backticks, with no check that the info line is complete (`codeFence.ts:90`).
  - `parseCodeFenceInfo` maps only an empty info string to `text` and `gitignore` to `ini` (`lib/codeFence.ts:90`).
  - `@pierre/diffs` 1.3.5 `getSharedHighlighter` skips only `text` and `ansi` (`dist/highlighter/shared_highlighter.js:22`). Every other name goes to `resolveLanguage`, which throws when the name is not in Shiki's `bundledLanguages` (`dist/highlighter/languages/resolveLanguage.js`). In the installed Shiki 4.5.0, `txt` and `plaintext` were not found in the bundled list (`console` was).
  - `getSyntaxHighlighterPromise` deletes the cache entry for a failed language and returns the `text` highlighter (`lib/syntaxHighlighting.ts:60-77`). The delete runs after the promise was cached, so each later call for that name makes a new promise, and `use()` at `ChatMarkdown.tsx:1094` (`UncachedShikiCodeBlock`) suspends on it again.
- **Change:**
  1. Render highlighted HTML for the throttled prefix, plus the plain live remainder (the lines after the throttled prefix) in the same `<pre>` with the same font and line height. The code then grows at the text cadence, and highlighting catches up behind it.
  2. Cache failed languages as an alias to `text` (keep the resolved promise in the cache under the failed name). Also map `txt`, `plaintext` and `plain` to `text` in `parseCodeFenceInfo`, next to the `gitignore` mapping.
  3. While the fence is open and the info line has no newline yet, treat the language as `text`.
  4. Hide the copy button while the fence is open.
- **Reference:** Codex: `isCodeFenceOpen` hides the copy button and maps a missing language to `plaintext`; the fence is not closed by the repair step (AI `bWc`).
- **Risk:**
  - The plain remainder must not change the height when it becomes highlighted (same font and line height; Shiki does not wrap differently). Check with a frame probe.
  - Cost: this is the visible part only; the main-thread cost stays with perf web.md #9.
  - Reduced motion: not applicable.
- **Verify:**
  - Extend `ChatMarkdown.streaming.browser.tsx`: stream 200 lines of code at 500 chars/s and record the `<pre>` text length per frame. Target: the text grows on every commit (today it is stepped at 160 ms).
  - Unit test in `syntaxHighlighting` tests: `getSyntaxHighlighterPromise("pyt")` returns the same promise on the second call.
  - Count Suspense fallback mounts (a `data-` attribute on the fallback `<pre>`) during a stream with ```` ```txt ````. Target: ≤ 1.

## 6. Repair partial markdown while streaming

- **What the user sees:** Raw markdown, then a sudden change of form:
  - `[text](http://exa` shows as literal text, then becomes a link with a favicon.
  - A partial image line shows as text.
  - A single `**` makes the rest of the line look wrong until it closes.
  - `$$ ... ` shows raw TeX, then becomes typeset math (a height change).
  - A table shows raw pipes until the delimiter row arrives (already repaired partly).
- **Root cause:** No repair step before the parse. Only the table repair (`markdownTableRepair.ts:117-150`) and dollar protection (`ChatMarkdown.tsx:1516-1522`, unclosed `$$` at `:559-565`, `$` at `:578-583`) exist. Links: `ChatMarkdown.tsx:1236-1238`.
- **Change:** Add a pure function `repairStreamingMarkdown(text)`, used only when `isStreaming` is true, before the table repair. It follows the Codex rules:
  1. Cut an unfinished `[label](url` at its `[`.
  2. Drop a partial image line.
  3. Close an odd `*`/`**` at the end, except inside code or when the marker is followed by a space.
  4. Hide an unclosed `$$` block until it closes; leave the fence logic as it is.
- **Reference:** Codex `bWc` (AI@10438109) with the rules above; it does not close code fences.
- **Risk:**
  - Hiding text (link label, math) for a short time. Show the link label as plain text instead of cutting it if testing shows that cutting looks worse.
  - Applies only while streaming; settled messages parse the original text. No scroll or reduced-motion effect.
- **Verify:**
  - Unit table test (new `markdownStreamingRepair.test.ts`) with Codex cases: link, image, `**`, `$$`, code fence untouched.
  - Browser: stream a fixture that contains each construct and count DOM element type changes per block (for example `p` → `a`). Target: each block changes form at most once.

## 7. Fade new tail rows in

- **What the user sees:** Assistant text rows, tool rows, the "Thinking" row and headers appear and disappear in one frame. Only a locally sent user message has an enter animation.
- **Root cause:**
  - `chat-message-send-enter` is added only for optimistic user rows (`MessagesTimeline.tsx:1450`, `useMessageSendEnterAnimations` at `:2949-3030`; `index.css:392-413`).
  - Other rows have only `transition-colors` for the find highlight (`MessagesTimeline.tsx:1433`).
- **Change:** Add an opacity-only enter (140-180 ms, ease-out) for rows that mount at the tail while the turn is live. Use the same "new id" set approach as `useMessageSendEnterAnimations`. Do not add a transform or height animation. Do not animate rows that mount because of virtualization or a thread switch (only ids that are new since the last render of a live turn).
- **Reference:** Codex fades words (0.15-0.7 s) and images (`.18s ease-out _image-enter`), so new content never appears in one frame. A row-level enter animation was not found in the bundle.
- **Risk:**
  - Opacity does not change layout, so measurement and end-follow are not affected (AGENTS.md virtualization rule kept).
  - Rows that LegendList recycles must not fade again: key the set by row id.
  - Reduced motion: add the class to the existing `prefers-reduced-motion` block in `index.css`.
- **Verify:**
  - Extend `MessagesTimeline.messageEnter.browser.tsx`: new tool row at the tail has the class; scrolled-back rows, and rows rendered after a thread switch, do not.
  - Reduced-motion case with `page.emulateMedia` (or the existing media mock).

## 8. Text reveal: drain at the end, frame-rate independent, then fade new words

- **What the user sees:**
  - At stream end, the last 1-2 flushes (~100 chars at 500 chars/s) appear in one frame. At the same moment the parse becomes synchronous and code blocks jump (#5).
  - During the stream, 4-5 words appear at once, 20 times a second.
  - On 120 Hz screens the smoothing is twice as sharp as intended.
- **Root cause:**
  - `return animate ? revealed : text` (`hooks/useSmoothStreamedText.ts:207`), pinned by `useSmoothStreamedText.browser.tsx:73-87`.
  - `state.velocity += (target - velocity) * VELOCITY_LERP` per frame, with no `dt` (`:92`).
  - Commit gate `MIN_EMIT_INTERVAL_MS = 40` (`:35, :103-105`); kept on purpose for cost (perf web.md #2).
  - `useDeferredValue` while streaming only (`ChatMarkdown.tsx:1527-1528`).
- **Change:**
  1. When `isStreaming` turns false, keep animating until the backlog is empty, with a fast drain (for example the rest in ≤ 150 ms), and only then return `text`. Pass a separate "revealing" flag to `ChatMarkdown` so that the deferred parse and the code throttle stay on until the drain ends.
  2. Use `1 - (1 - VELOCITY_LERP) ** (dt * 60)` so the smoothing is the same at 60 and 120 Hz.
  3. After perf #8 (block parse with stable blocks), wrap the newly revealed words of the last block in spans with a short opacity fade (`Intl.Segmenter`, 0.15-0.3 s, no stagger). Settled words never animate again. This hides the 20 Hz chunks without more React commits.
- **Reference:** Codex `O2c` flushes at the end, but its fade (0.7 s per word) hides the jump; the fade uses `Intl.Segmenter`, stable keys and a `settledKeys` set (AI@10616505-10620761).
- **Risk:**
  - Step 1 delays the "complete" look by ≤ 150 ms. The turn-end fold (#2) must wait for the drain, or the fold and the last words land together. End-follow: the final growth is followed by the normal path. The tail key includes text length and `completedAt` (`ChatView.logic.ts:302-329`), so the final re-snap still runs.
  - Step 3 without perf #8 would create new spans on every parse and start the fades again. Do not ship step 3 before perf #8.
  - Reduced motion: the hook already returns the raw text; keep that. Word fade off under reduced motion.
- **Verify:**
  - Unit (`useSmoothStreamedText.test.ts`): `stepSmoothReveal` with `dt = 1/60` and `1/120` reaches the same position within 2 % after 300 ms; after `isStreaming=false`, the revealed length reaches the target within 150 ms and never jumps by more than 2× the steady-state chars per commit.
  - Browser: record the revealed character count per frame. Target: the largest single-frame jump at stream end ≤ the 95th percentile of jumps during the stream. Update the browser test that pins the snap.

## 9. A click in the transcript does not drop follow

- **What the user sees:** A click inside the transcript while text streams at the bottom (for example to open a tool row or to put focus in the transcript) stops the follow. New text then grows below the viewport, and the user must scroll back down.
- **Root cause:**
  - `onMessagesPointerDownBase` calls `clearTranscriptAutoFollow(true)` for any pointerdown (`components/chat/useChatTranscriptScroll.ts:276-278`), which detaches with `flushSync` (`:120-145`).
  - On pointerup, a detached reader comes back only within 1 px of the bottom (`:216-220`). Text that arrives during the press (the next 100 ms flush) moves the bottom, so the reader stays detached. Opening a disclosure adds height as well.
  - Code path confirmed; how often users hit it is unverified.
- **Change:** Keep follow only for clicks that change no layout.
  1. On pointerdown, record "was following" and do not detach yet.
  2. Detach when there is real navigation: the pointer moves more than ~8 px (drag or text selection), a scroll event with no programmatic flag happens during the press, or the target is the scrollbar.
  3. Detach when the click is on a disclosure trigger (`button, summary, [role='button'], [data-scroll-anchor-target]`, the selector in `onMessagesClickCaptureBase`, `:242-275`) that is not in the tail row. Keep the existing trigger anchor for these clicks. Otherwise end-follow would pin the bottom and push the trigger the user just clicked up the screen.
  4. On pointerup with no navigation and no disclosure trigger (focus, plain text, empty space), or with a trigger in the tail row, keep follow.
- **Reference:** Codex detaches on wheel up, navigation keys, touch moves over 8 px and scrollbar drags (TSL). That a plain click does not change follow is an inference from this list; it was not observed.
- **Risk:**
  - AGENTS.md: "User navigation away from the bottom releases follow." A text-selection drag is navigation: it must still detach, or the selection moves while the user drags. The 8 px threshold keeps this.
  - The disclosure trigger anchor exists so that the clicked row does not jump; step 3 keeps it for every row except the tail row.
  - No reduced-motion effect.
- **Verify:** New cases in `useChatTranscriptScroll.browser.tsx`:
  1. Following; pointerdown/up on plain text with no move while 3 flushes land → still at bottom (distance 0 px).
  2. Following; drag 20 px to select text → detached, `scrollTop` unchanged.
  3. Following; click a disclosure 300 px above the bottom → the trigger's `top` stays within 1 px; reader detached.
  4. Detached; click → stays detached (no rearm).

## 10. Debounce and fade the reconnect banner

- **What the user sees:** A short connection blip shows "Reconnecting to Synara server" at the top at once and removes it at once. The composer notice for the same event waits 1.5 s, so the two do not agree.
- **Root cause:**
  - `ServerBusyIndicator` sets `reconnecting` with no delay (`components/ServerBusyIndicator.tsx:56-63`) and mounts or unmounts with no motion (`:18, :77`).
  - The composer notice waits 1500 ms (`lib/composerTransportStatus.ts:28-35`).
- **Change:** Use the same 1500 ms delay (share the constant from `composerTransportStatus.ts`). Show the banner with the fade-only disclosure class, and keep it for at least ~600 ms once shown so that it does not flash.
- **Reference:** No Codex evidence was collected for connection banners. The reference is internal: the composer notice already waits 1500 ms.
- **Risk:** A real outage is shown 1.5 s later. This is acceptable because the composer notice already uses this delay. The transcript does not clear on resync (`ChatView.logic.ts:794-803`, `storeProjection.ts:1516-1535`), so nothing else flashes. No scroll effect. Reduced motion: the fade is turned off by `motion-reduce:transition-none`.
- **Verify:** Unit or browser test with fake timers: a 1 s disconnect shows no banner; a 3 s disconnect shows it after 1.5 s and keeps it ≥ 600 ms.

---

## Not ranked (kept so the research is not lost)

| Item | Evidence | Note |
|---|---|---|
| "Show N more" cap drops the oldest rows at the top of a live group as new rows arrive | `MessagesTimeline.tsx:1568-1611` (`slice(-6)`), `MAX_VISIBLE_WORK_LOG_ENTRIES = 6` (`MessagesTimeline.logic.ts:28`) | Rows move up inside the group on each tool call. Parity gap 9 changes the group header; review after it merges |
| Instant toggles that do not use `disclosureMotion.ts` | Work-log caps (`MessagesTimeline.tsx:1568-1611`), user-message clamp (`:3668-3690`), `ProposedPlanCard.tsx:24-70`, `ThreadErrorBanner.tsx:83-136`, `PullRequestContextCard.tsx:96-113` | AGENTS.md asks for `disclosureMotion.ts`; fix when each file is next edited |
| `estimatedItemSize={90}` for all row kinds | `MessagesTimeline.tsx:2853` | The "Thinking" row (~24 px) and the header get a size correction in the first frame. Add `getEstimatedItemSize` per kind. Smaller after #3 |
| A work row merges into the assistant message row, which changes its key | `MessagesTimeline.logic.ts:790-799, :834-838` | The list measures again from the 90 px estimate. Part of #2 if it shows in the frame probe |
| Tail-anchor handoff snaps after 3 clipped frames | `useTailAnchorScroll.ts:272-281`, `transcriptScroll.ts:25` (`ANCHOR_SLIDE_DURATION_MS = 320`) | Visible only when the answer overflows the reserve during the send slide |
| Overlap guard forces layout on most streaming frames | `useTimelineRowOverlapGuard.ts:118-138, :165-178` | Cost item; the fast path misses because the "Thinking" row, not the streaming row, is the tail. Belongs with perf web.md |
| Reduced-motion gaps | `chat-generated-image-shimmer` (`index.css:1954-1965`), `terminal-running-indicator-pulse` (`index.css:288-307`), `animate-spin` in `ui/spinner.tsx:11`, `ChatComposerFooter.tsx:326`, `GeneratedMarkdownImage.tsx:179` | Add `motion-reduce` rules; the spinners also break the stepped-spinner rule in `index.css:7-10` |
| Markdown images have no reserved size | `ChatMarkdown.tsx:1345, :1355` | Height jumps when a remote image loads; only user thumbnails trigger the tail-expansion follow |
| Animated-follow flag can stay set after the send slide | `useChatTranscriptScroll.ts:459-461` | Unverified; a later re-snap could be a smooth scroll that competes with `maintainScrollAtEnd` |

## Suggested order

1. Small, separate PRs now: #4, #10, #1 (after the W-activity edit lands), #7.
2. Scroll: #3, then #9. Both need the frame-probe test first, so write that test before the change and record the baseline numbers.
3. Markdown: #6, then #5. Then #8 steps 1-2.
4. After parity W-timeline merges: #2.
5. After perf #8 (block parse): #8 step 3 (word fade).

## Shared measurement method

| Metric | How | Where |
|---|---|---|
| Distance from bottom per frame | Pre-paint ResizeObserver probe; `scrollHeight - scrollTop - clientHeight` each frame | Copy from `MessagesTimeline.rowOverlap.browser.tsx:312-337` |
| Layout shift | `new PerformanceObserver(cb).observe({type: "layout-shift", buffered: true})`; sum the values in a time window | Any `*.browser.tsx`; Chromium only |
| Reveal smoothness | Revealed char count per frame; report the largest jump and the 95th percentile | `useSmoothStreamedText.browser.tsx` |
| Label and number stability | Text changes per second; `getBoundingClientRect` width and chevron `left` | `ChatView.browser.tsx`, `TimelineWorkEntryRow.rows.browser.tsx` |
| Real session | 60 fps screen recording of an isolated instance (separate home and ports, see AGENTS.md) with one Claude and one Codex turn with tools | Use the `verify` skill |

Run browser tests with `bun run --cwd apps/web test:browser -- <files>`. In a git worktree, run the vitest binary with an explicit `--root`.
