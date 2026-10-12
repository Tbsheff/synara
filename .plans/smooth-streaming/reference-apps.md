# How Codex desktop and Claude desktop stream assistant text (reference for Synara)

Date: 2026-10-11. Read-only research. No repository source file was changed.

## TL;DR

`live-measurement.md` shows that the stream itself is mostly smooth in Synara. The worst jank is at the edges of a turn:
- The turn end drops end-follow: the reader is left 142-254 px above the bottom in 4 of 8 turns.
- Follow can release mid-stream: the view froze for 3.7 s while a code block streamed.

Claude's follow controller has a rule that prevents both. When the scroller moves up and no user input can explain the move, the controller treats it as a layout clamp and snaps back to the bottom. It does not unpin. That is change #1.

The other differences are in pacing and markup:
- **Cushion.** Both reference apps keep a large cushion of received text that is not shown yet: Codex about 0.45 s, Claude a 550 ms target. Synara drains in 0.16 s.
- **Fade.** Both apps fade each new word, which hides the step size.
- **Re-parse.** Both apps parse only the tail of the message again.

Synara already has most of the earlier plan: `README.md` items 1, 6, 7, 9 and 10, most of 5, and steps 1-2 of 8.

Top 8 changes (detail and exact values in "Ranked changes"):

| # | Change | Copy these values |
|---|---|---|
| 1 | Follow: do not unpin on an upward move that no input explains; one same-frame path | Restore to the bottom when the move is within **150 ms** of a follow write or within **400 ms** of a DOM mutation or width resize, and no input is active. User input: wheel-up within **200 ms**, up key within **500 ms**, active touch, pointer held (≤ 15 s), touch release within **2.5 s**. Pinned at ≤ **2 px**. `overflow-anchor: none` in every mode |
| 2 | Bigger reveal cushion, with snap rules | Drain window 0.16 → **0.45-0.55 s**. Snap when the backlog is more than **600 chars**. Show the text at once on mount when it is more than **400 chars**. Snap when the tab becomes visible. Ship with #5 or with an end drain of **≤ 250 ms** |
| 3 | Reveal on word boundaries; hold back a dangling block marker | Step **22 chars**, back off to the last space when that space is past half the step. Do not end on a line that is only a list marker (`- `, `1.`) or a heading marker (`#`) |
| 4 | Parse only the tail again (block memo) | Codex: cut at the last safe blank line, LRU **100** prefixes. Claude: committed blocks plus a frontier, memo on block identity, **16** blocks per Fragment |
| 5 | Fade each newly revealed word | **200 ms linear**, delay **+2.5 ms per char**, delay cap **600 ms**, chunk ≤ **16 chars**, no fade above **1.6 chars/ms**. Codex alternative: **0.7 s** `cubic-bezier(.37,.55,.86,.88)`, no stagger |
| 6 | Code block: grow inside one `<pre>`; open-fence and off-screen rules | Do not remount the `<pre>` on a highlight pass. Hide the copy button while the fence is open. Plain `<pre>` until the block is within **600 px** of the viewport |
| 7 | Eased scroll-to-bottom (extend the existing slide tween) | **200 ms** (Claude) or **260 ms** (Codex), `1-(1-t)^3`, first frame 16 ms, frame step cap 34 ms. Instant when ≤ 24 px away or under reduced motion |
| 8 | Containment on each markdown block | `contain: layout paint; overflow-clip-margin: 32px` under `@supports (overflow-clip-margin: 32px)`. Not on table, KaTeX or mermaid. Fallback `contain: layout` |

## Sources and versions

| App | Version | Where the streaming renderer is | Notes |
|---|---|---|---|
| Codex desktop (`com.openai.codex`) | 26.1002.52244 (`Info.plist` and the extracted `package.json` agree) | `/tmp/codex-src-xjDG9Z/app/webview/assets/` (extracted on 2026-10-10; matches the installed app) | Minified. Not executed |
| Claude desktop (`/Applications/Claude.app`) | `CFBundleShortVersionString` 2.31226.1 | **Bundled locally** in `Contents/Resources/ion-dist/assets/v1/` (3,333 JS chunks). It is **not** in `app.asar` and it is **not** loaded from the network. The `app.asar` extract (`/tmp/claude-asar-D3XlCx/`) holds only the Electron shell | Two surfaces: **chat** (claude.ai, `progressive-markdown`) and **Code tab** ("epitaxy", renderer "alluvium") |

Chunk abbreviations:
- **Codex:**
  - `AI` = `app-initial-61c077dcc1af.js`
  - `ACSS` = `app-initial-c43288484373.css`
  - `SCSS` = `app-shared-f2d570e85ceb.css`
  - `SER` = `sites-end-resource-7e6c33984bd6.js`
  - `TSL` = `thread-scroll-layout-f180b07a04e9.js`
  - `LTE` = `local-conversation-thread-turn-entries-5460cecd925b.js`
- **Claude:**
  - `S11` = `shared-11-Bx4tMrIf.js`
  - `ALV` = `c19e90103-CvUj-0ZH.js` (Code-tab renderer)
  - `SST` = `shared-styles-CTu5t_TM.css`
  - `MD` = `c89efce1a-rr23Ogn_.js` (chat markdown)
  - `PIN` = `c7f8992b4-BdURlFSy.js` (follow controller)
  - `VL` = `c4a9ee384-CDM_HJvg.js` (virtual list)
  - `CHAT` = `ca2ef848d-Dz47ULRM.js`
  - `MSG` = `cc1aae219-CPC-WA-x.js`
  - `CODE` = `cd5a31703-B4nKQMBN.js`
  - `MCSS` = `c6a992d55-C0zTICcS.css`

Offsets are character offsets in the file. Synara paths are relative to `apps/web/src/`.

"Codex lag ≈ 0.45 s" and "~28 updates/s" come from my line-by-line port of `O2c`, run with simulated input: 100 ms flushes at 100, 500 and 2000 chars/s. They are not measurements of the live app.

## Side-by-side, per technique

### 1. Reveal pacing (buffer and reveal)

| | Codex | Claude | Synara |
|---|---|---|---|
| Algorithm | Class `O2c` (`AI@10716191`). It runs on each new text and on a 50 ms `setTimeout`:<br>1. Arrival-rate EMA: `rate = max(1, .1*n + .9*rate)`.<br>2. For each 50 ms elapsed, the rate relaxes toward the backlog band: `r<rate*1.5 → (r+1.5rate)/2`; `r>rate/1.2 → (r+rate/1.2)/2`.<br>3. Advance `n*rate + carry`; the fraction carries forward.<br>4. Publish on rAF via `useSyncExternalStore`. | `ph` (S11@87900). Config `Hp={stepChars:22,targetLagMs:550,minStepMs:25,maxStepMs:150}` (S11@78405).<br>Tick interval = `clamp(25, 550*22/backlog, 150)` ms, 22 chars per tick. The backlog drains with a 550 ms time constant.<br>Max ≈ **880 chars/s** unless catch-up is on. | Closed-form damped spring toward `backlog / 0.16 s`. Cap 2000 chars/s, `VELOCITY_LERP 0.15`. Frame-rate independent (`hooks/useSmoothStreamedText.ts:24-108`). |
| Steady lag | ≈ **0.45 s** of text at 100-2000 chars/s (port of `O2c`) | **550 ms** target (`targetLagMs`) | ≈ **0.16 s** (`DRAIN_WINDOW_SECONDS`) |
| Commit cadence | rAF publish after each 50 ms drain or arrival. ≈ 28 publishes/s, ≈ 17 chars each at 500 chars/s (port) | One commit per tick: 25-150 ms apart, 22 chars each | ≥ 40 ms apart (`MIN_EMIT_INTERVAL_MS`): ≈ 20-25/s, ≈ 25 chars each. Live measurement: p50 63-70 ms (`live-measurement.md` #8) |
| Step boundary | Raw character count | **Word:** step 22; back off to the last space when that space is past `t + step/2` (`ih`, S11@87228).<br>**Block marker:** do not stop on a line that is only a list marker or a heading marker (`oh`/`ah`, S11@87481). `ah` tests only these two patterns.<br>**Inline:** optional hold-back within the last **600 chars** (`uh`, S11@87680). | Floored character count (partial words show) |
| Large first text | Shown as is (the store is created with the text already present) | "Join": shown at once when it is more than **120 chars** (chat default) or **400 chars** (Code tab: `Nb={holdBack:!1,holdBlockMarkers:!0,joinAboveChars:400,rejoinAboveChars:600}`, ALV@~179000) | Text present at mount is shown at once |
| Catch-up | The rate follows the backlog with no cap | Code tab only:<br>- "Rejoin" snaps when the backlog is more than **600** chars and the jump is more than 600.<br>- Extra catch-up starts above `550*22/25 = 484` chars of backlog and ramps up over **75 ms**. | Cap 2000 chars/s |
| Hidden tab | rAF stops; the timer still drains | On `visibilitychange`, snap to the full text (S11@87900, `d=()=>{...e>l.current&&(...c(e))}`) | dt clamp of 50 ms per frame, so the backlog drains slowly after the tab returns |
| Stream end | The backlog snaps: `update(...,n=false)` sets `bufferedLength=e.length` (AI@10716191).<br>`animate` is `!Ee&&(be\|\|!n.completed)` (SER@106582), so without `onRevealComplete` the snapped text gets no fade.<br>In the reply-chain path (LTE `z`), a completed message becomes `revealing`. It then fades with a **16 ms** stagger, max **96 ms**, at 0.15 s. The row calls `onRevealComplete` only after `getAnimations({subtree:true})` settles (SER@101406).<br>Whether every local turn uses that path is not resolved. | The backlog snaps: the pacer returns the full text when `enabled` is false (`I=t?e.slice(...):e`) | 150 ms forced drain, then the raw text (`END_OF_STREAM_DRAIN_MS`) |
| Gate | Final answer only; commentary is not buffered (`et=n.phase==="commentary"?void 0:{kind:"adaptive",...}`, SER@106053).<br>Off when `Bf()` is true (probably reduced motion; not resolved).<br>Flag `267402900` changes the arrival floor from 10 s to 0.01 s (`?.01:10`, AI@~10724500): **flag-gated, value unknown**. | Chat: `useStreamingFadeIn:!0` (CHAT@97616, MSG@145696); active when the streaming renderer has loaded.<br>Code tab: `paceReveal:e.kind==="text"&&!v` (CODE@1285787). | Off under reduced motion |

### 2. Fade on new words or tokens

| | Codex | Claude | Synara |
|---|---|---|---|
| Unit | Word: `Intl.Segmenter(void 0,{granularity:"word"})` (AI@10726532). Non-word segments join the previous word (`gQc`, AI@10605997). | Code tab, "word" mode: words from `(?:^\s+)?\S+\s*` (`Jp`, S11@78599).<br>"Phrase" mode: one span per reveal step. Chat always uses phrase mode: `Js` → `Ky` passes no `wordFade`. | None (row-level fade only) |
| Animation | `_fade-in`: opacity 0→1 over `var(--duration)`, easing `cubic-bezier(.37,.55,.86,.88)`, `both`, delay `var(--fade-delay)` (ACSS@223650; keyframes ACSS@207583). | **Word:** `_fadeInText`, opacity 0→1, **linear, backwards**. JS sets `animationDuration:200ms` and the delay (`mm=200`, ALV@92436; SST rule `.1s linear backwards`).<br>**Phrase (chat and Code tab):** WAAPI `delta-fade`, opacity 0→1 over **400 ms linear**, `fill:backwards`. The total duration is rounded up to a 1 s grid with a 250 ms margin, so cleanup happens in batches (`Zg`, S11@104489). `_m=500` is the phrase settle window, not the animation length. | `chat-fade-enter`: 160 ms ease-out, opacity only, on new tail rows (`index.css:417-435`) |
| Duration | **0.7 s** while streaming (`--animation-duration-streaming-text:.7s`, SCSS@159825; applied through the adaptive-streaming class, ACSS@224247).<br>0.15 s elsewhere (`--transition-duration-basic`). | Word 200 ms. Phrase 400 ms. | n/a |
| Stagger | None while adaptive (`v=o?0:n.fadeSegmentDelayMs`, AI@~10725000).<br>16 ms per segment, max 96 ms, when `onRevealComplete` is set (see table 1). | Delay **+2.5 ms per char** (`Gp=2.5`), capped at `now+600 ms` (`hm=600`).<br>A new chunk starts after **16 chars** in the same pass or **48** across passes (`fm`, `pm`).<br>No fade when the input is faster than **1.6 chars/ms** over a **100 ms** window (`vm`, `dm`). | n/a |
| Re-render safety | Stable segment keys. `onAnimationEnd` adds the key to `settledKeys`, and a settled span drops the class (`fQc`, AI@~10605000). | A `reveals` map keyed by text position. A settled entry renders as plain text (`xm.settled`, ALV@92436). | n/a |
| Reduced motion | Duration 0 s, delay 0 (ACSS@224684) | Runs only under `prefers-reduced-motion: no-preference`.<br>`[data-reduce-motion=true]` → none; WAAPI fades are cancelled. | Reveal off |

### 3. Partial markdown

| | Codex | Claude | Synara |
|---|---|---|---|
| Parser | `marked` lexer (`Lexer.lex`, `app-shared-6c00c2afcf84.js@1402395`); React renders the tokens | **Chat:** unified/remark per chunk, with fast paths for an open fence, list, table or paragraph (`Ky`, S11@132292; `Wy`, S11@130176).<br>**Code tab:** a custom incremental block parser `Df` with `feed`/`advance`/`snapshot` (ALV@60815, ALV@~85816). Remark is the fallback after a parse error. | `react-markdown` + remark-gfm/math + rehype-katex over the whole message (`ChatMarkdown.tsx:242-260`) |
| Re-parse scope | Stable prefix: cut at the last blank line that is outside a fence, list or directive (`J2c`). Prefix tokens are cached in an LRU of **100** (`K2c`/`q2c`, AI@10722063; `$2c=100`, AI@10723396). Only the tail is lexed again. | **Code tab:** `committed` blocks plus a `frontier`. Block memo `(e,t)=>e.block===t.block` (`Xp`, ALV@~86000).<br>**Chat:** completed chunks are memoized, with one streaming chunk; **16** chunks per Fragment (`Gy=16`). | The whole message on each commit, deferred with `useDeferredValue` |
| Repair | `bWc` (AI@10425967):<br>- Open fence: no repair (`isCodeFenceOpen:!0`).<br>- Cut an unfinished `[label](`.<br>- Strip a partial image.<br>- Close an odd `*`/`**`. | `holdBlockMarkers`, word steps and the optional inline hold-back (see table 1) | `lib/markdownStreamingRepair.ts`: links, emphasis, inline code, `$$`, table tail. **No hold for a dangling list or heading marker line** |

### 4. Code blocks while streaming

| | Codex | Claude | Synara |
|---|---|---|---|
| Open fence | Copy button hidden (`showCopyButton:!s`); mermaid copy excluded. With no language, use `plaintext` (`$Jc`, AI@10527542). | Not resolved (see "Could not determine") | Copy button always shown (`ChatMarkdown.tsx:969-978`) |
| Off-screen blocks | A plain `<pre class=CodeBlockPlaceholder><code>` until an `IntersectionObserver` with `rootMargin:"600px 0px"` fires (`tYc`, AI@10530446) | Chat, long documents: `content-visibility:auto` on each child (`deferOffscreenBlocks`, MD@23140) | Always highlighted |
| Highlighter | Not resolved on the transcript path (lowlight and hljs chunks exist). How Codex avoids remounting the `<pre>` is not verified. | Shiki in a shared Web Worker. In-page fallback with the JS regex engine, time-sliced at **3 ms** per slice (`Gf=3`, S11@~71000). Fallback message: "Syntax highlighting has been disabled due to code size". | Shiki via `@pierre/diffs`, throttled at 160 ms-1 s, with a plain live tail (`ChatMarkdown.tsx:1011-1050`). Live measurement: the `<pre>` is replaced about 5-6 times/s, growing in 4-line steps (`live-measurement.md` #5) |

### 5. Layout-shift control

| | Codex | Claude | Synara |
|---|---|---|---|
| Per-block containment | None found | **Chat** reply root (`Ky` root class `Ay=To.blocks`, S11): each block child gets `contain: layout`.<br>Under `@supports (overflow-clip-margin:32px)`: `contain: layout paint; overflow-clip-margin: 32px`. Not on table, KaTeX, mermaid or `[data-no-contain-paint]` (SST `._blocks_4za3l_47`).<br>Code-tab use is not checked. | None |
| Off-screen blocks | Code placeholder (above) | `content-visibility:auto` with `contain-intrinsic-block-size: auto 3rem` (p 6rem, `ul/ol` 10rem, headings 1.5rem) and `overflow-clip-margin: 2.5rem`.<br>Gated on `@supports (overflow-anchor:auto) and (contain-intrinsic-block-size:auto 1px)` (MD@23140).<br>Used for documents and artifacts (`deferOffscreenBlocks:!0`), not for the live chat reply. | None |
| Settled bottom | n/a | Follow targets `settledBottom = max(scrollTop, scrollHeight - clientHeight - unfoldedGrowth)`, so growth from an unfolding animation does not count (`y()`, PIN) | n/a |
| Message enter | Image enter `.18s ease-out`, scale .98→1 (ACSS@~224400) | `message-fade-up`: 1.1 s spring `linear(...)` with `translateY(10px)` (MCSS, MSG@463471) | Opacity only, 160 ms |

### 6. Scroll follow

| | Codex | Claude | Synara |
|---|---|---|---|
| Mechanism | The scroller has `[overflow-anchor:none]` and `flex-col-reverse`, so the browser keeps the bottom fixed with no JS (TSL@18661).<br>With flag `2004881635` on, it is `flex-col` with a ResizeObserver delta (TSL@5498). **Flag-gated, value unknown.** | **Pinned follow:** a ResizeObserver watches the scroller and the content. When pinned and more than 2 px from the settled bottom, it writes `scrollTop` in the observer callback, in the same frame (`Z`, PIN).<br>**Mutation path:** a MutationObserver path re-reads with a budget: ≤ **2** reads per **16 ms** and ≤ **8 ms** in total (`ue`, `de`, `fe`).<br>**Virtual list:** it sets `style.overflowAnchor="none"` (VL@18372) and corrects anchors in its observer. During an active wheel or touch, it puts the correction into a `translateY` on the content. It moves that into `scrollTop` **120 ms** after the gesture ends (`$n=120`, VL@3263). | LegendList `maintainScrollAtEnd` (rAF, > 5 px gate), plus `followTailBeforePaint`: one write per frame, slack 1 px (`useTimelineRowOverlapGuard.ts:20, :69-91`).<br>`overflow-anchor` stays on while a tail anchor is set. |
| Follow zone | 24 px (`Ke(e)=r(e)<=24`, TSL@~21600) | Pinned at ≤ **2 px**.<br>Re-pin at stream start within **8 px** (`settledBottom()-scrollTop<=G$`, `G$=8`, CHAT@465753). | 1 px |
| Upward move with no input | (column-reverse keeps the bottom fixed) | **Restore, do not unpin** (`tt`, PIN; constants `te=150,ne=200,re=500,ie=2500,oe=400,ce=15e3,me=.75`). When pinned and the scroller moved up by more than 2 px:<br>1. Unpin when user input explains the move: active touch, wheel-up within **200 ms**, an up key within **500 ms**, a pointer held (< **15 s**), or a touch release with a scroll within **2.5 s**.<br>2. Otherwise, restore to the bottom when one of these is true:<br>&nbsp;&nbsp;- the move came within **150 ms** of its own write;<br>&nbsp;&nbsp;- the device pixel ratio changed and the drift is < **0.75** device px;<br>&nbsp;&nbsp;- a child mutation or width resize happened within **400 ms**.<br>3. Otherwise, unpin and count `uncorroboratedUnpins`. | A content shrink can move `scrollTop` up, and the next check then sees the reader off the bottom (`live-measurement.md` #1) |
| Detach | Wheel up. Keys: ArrowUp, Home, PageUp, Shift+Space. Touch > **8 px** (`Ze=8`). Scrollbar drag (TSL). | Wheel `deltaY<0`. Keys: ArrowUp, PageUp, Home, Shift+Tab. Touch > **4 px**. Mousedown on the scrollbar.<br>**A pointerdown on a transcript row unpins** (`holdProps`, PIN), except inside `[data-transcript-continues-turn]`.<br>Code tab: a click on the empty scroller re-pins after **500 ms** when `scrollTop` did not change and the selection is collapsed (`dat=500`, CODE@1539810). | Drag > 8 px, a selection, an upward scroll, wheel, keys, touchmove. A plain click keeps follow (`useChatTranscriptScroll.ts:26, :334-376`). |
| Scroll-to-bottom | **260 ms** cubic ease-out on rAF; instant when ≤ 24 px away or under reduced motion (`Ye=260`, TSL@~21687) | **200 ms** (`g1=200`, CHAT) with `out:e=>1-(1-e)**3`. First frame 16 ms; frame step cap 34 ms (`fr`, `pr=16`, `hr=34`, VL@35867). Abandoned when the user scrolls up or presses an up key. | Native smooth scroll, then an instant settle (`transcriptScroll.ts:62-74`) |

### 7. Caret, end of stream, turn collapse

| | Codex | Claude | Synara |
|---|---|---|---|
| Text caret | None | None | None |
| Status indicator | A shimmer label. The reasoning heading replaces "Thinking". | An animated working mark near the jump button (`tE`, CHAT). Details not inspected. | `WorkingStatusLine`: 600 ms hold, crossfade |
| End of stream | Snap, or a short staggered fade in the reply-chain path (table 1) | The backlog snaps (table 1). Whether the phrase spans still fade the snapped text is not resolved. | 150 ms drain |
| Turn collapse | **Prior note, not re-verified at 26.1002.52244:** expand 300 ms `[.19,1,.22,1]`, collapse 150 ms `[.23,1,.32,1]`, `translateY(-8px)`. Neither curve is in SER now. `duration:.3` with `[.19,1,.22,1]` is in `src-e8d0e084b1bb.js@100318`, and `.22 s [.23,1,.32,1]` is in `app-primary-15d1279f1ff0.js@120998`. | Not inspected | Clone collapse 220 ms ease-out + 40 ms buffer |

## Ranked changes for Synara

Only open gaps are listed. The rank follows the measured jank in `live-measurement.md` first, and then how far each change moves Synara toward both reference apps.

### 1. Follow: an upward move that no input explains is a clamp, not a release

- **Change.** In the follow code (`useChatTranscriptScroll.ts`, `useTimelineRowOverlapGuard.ts`), port Claude's `tt` rule (PIN). When following and `scrollTop` moved up by more than 2 px:
  1. **Release follow** when user input explains the move:
     - an active touch;
     - wheel-up within **200 ms**;
     - an up key within **500 ms**;
     - a pointer held on the scrollbar (< **15 s**);
     - a touch release within **2.5 s**;
     - a text-selection drag (Synara's own rule).
  2. **Restore to the bottom in the same frame** when one of these is true:
     - the move came within **150 ms** of a follow write;
     - a DOM mutation or width change happened within **400 ms**;
     - the device pixel ratio changed and the drift is < **0.75** device px.
  3. **Otherwise**, release follow, and log the case (a dev counter like `uncorroboratedUnpins`).

  In the same change:
  - Use a "settled bottom" that ignores growth from an unfolding animation (Claude `unfoldedGrowth`), so a fold or unfold does not count as leaving the bottom.
  - Set `overflow-anchor: none` on the transcript scroller in every mode. Both reference apps do this; Synara leaves it on while a tail anchor is set.
  - Replace `scrollTailExpansionToEnd`'s four writes (rAF, 80, 180, 260 ms) with the existing pre-paint `followTailBeforePaint`.
  - Remove the LegendList `> 5 px` gate when pinned.
- **Why.** `live-measurement.md` #1: at turn end, `scrollTop` falls 132 px in one frame and the reader is never re-pinned. #2: follow released mid-stream while a code block streamed. A fold shrink or a `<pre>` swap moves `scrollTop` up with no user input, and Synara reads that move as navigation.
- **Not copied.** Claude also re-pins at stream start within 8 px. AGENTS.md says that user navigation away from the bottom releases follow, so a reader who scrolled up 5 px must stay detached. Rule 2 already handles the gaps that layout causes. Keep `ChatView.browser.tsx:6933` green.
- **Risk.**
  - AGENTS.md forbids coupling virtualizer measurement to a height-follow loop. Keep one write per frame and the existing re-entrancy guard. The restore is one write, not a loop.
  - Pending approvals and tool-only activity must not re-arm a detached reader. Rule 2 runs only while following.
- **Verify.** Pre-paint probe: distance from the bottom on each frame through the turn end and through a streaming code block. Targets:
  - 0 px on ≥ 99 % of frames;
  - no 132 px drop;
  - wheel-up during the stream still detaches in ≤ 1 frame.

### 2. Keep a bigger cushion, and add snap rules

- **Change.** In `hooks/useSmoothStreamedText.ts`:
  1. Raise `DRAIN_WINDOW_SECONDS` from 0.16 to **0.45-0.55**. Claude uses 550 ms; Codex settles at about 0.45 s.
  2. Snap to the full text when the backlog is more than **600 chars** (Claude `rejoinAboveChars`).
  3. Show the text at once when the first visible text is more than **400 chars** (Claude Code tab `joinAboveChars`).
  4. Snap on `visibilitychange` to visible (Claude). Today the 50 ms dt clamp makes the reader wait.
  5. Keep `MAX_CHARS_PER_SECOND` at 2000. It is already above Claude's 880.
- **Why.** The 100 ms store flushes and short provider gaps empty a 0.16 s buffer, so the reveal stops and starts again. `live-measurement.md` #8 counts 106-151 stalls of more than 100 ms per Codex turn. A 0.5 s cushion covers a gap of up to 0.5 s.
- **Coupling. Do not ship this item alone.**
  - A 0.5 s window keeps about three times more backlog at stream end: about 250 chars at 500 chars/s. The 150 ms end drain then becomes a visible spurt.
  - Codex snaps that backlog, and in its reply-chain path it fades the rest with a 16/96 ms stagger and waits for the fade before the turn settles. Claude snaps.
  - Ship this with #5, or raise `END_OF_STREAM_DRAIN_MS` to **≤ 250 ms**. Make the turn-settle step (`ACTIVE_TURN_LAYOUT_SETTLE_DELAY_MS`) wait for the drain, as Codex waits for `getAnimations()`.
- **Cost.** The text appears up to 0.5 s after it arrives. Both reference apps accept this.
- **Verify.** Extend `useSmoothStreamedText.test.ts`:
  - Feed 100 ms flushes with a 400 ms gap. Target: no frame with zero growth.
  - The largest single-frame jump at stream end is ≤ the stream's p95 jump.

### 3. Reveal on word boundaries and hold back a dangling block marker

- **Change.**
  - **Word steps.** Make the emitted count follow Claude `ih`/`oh` (S11@87228-87481). Find the last space before `shown + step`. When it is after `shown + step/2`, emit up to that space plus 1.
  - **Marker hold.** Never emit a prefix whose last line is only one of these markers:
    - list marker: `^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d{1,9}[.)]?)$|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[(?:[ xX](?:\][ \t]*)?)?)?$)`
    - heading marker: `^ {0,3}(?:>[ \t]*)*#{1,6}[ \t]*$`

    A bare quote line (`^[ \t]*(?:>[ \t]*)+$`) is a Synara extension. Claude defines that pattern but does not hold it.
  - Also add the marker rule to `markdownStreamingRepair.ts` as "drop the last line when it is only a block marker". It then also works when the reveal is off.
- **Why.** Partial words and a bare `- ` or `#` on the last line become a list item or a heading for one commit. That moves the layout twice.
- **Risk.** Low. The reveal is slightly slower; there is no scroll effect.
- **Verify.** Unit table:
  - `"foo bar ba"` at step 22 does not end in `ba`.
  - `"text\n- "` emits `"text\n"`.

### 4. Parse only the tail again (block memoization; perf #8)

- **Change.**
  - Split the live text at the last blank line that is outside a fence, list, `$$` or table.
  - Parse the prefix once and cache it in an LRU of **100**, keyed by the prefix string.
  - Render the prefix blocks memoized on block identity, and render only the tail live.
  - Group the memoized blocks in Fragments of **16** (Claude `Gy=16`).

  References: Codex `K2c`/`J2c` (AI@10722063); Claude `committed` + `frontier` with the memo `e.block===t.block` (ALV@~85816).
- **Why.** Both reference apps parse only the tail. This is also the precondition for #5: words keep their spans across commits only when the blocks keep their identity.
- **Risk.** Medium.
  - A reference definition or a footnote in the tail can change the prefix. Fall back to a full parse when the tail contains `]:` or `[^`.
  - Keep the memo key stable across the end drain.
  - No change to scroll coupling.
- **Verify.** Count the block renders per commit in `ChatMarkdown.streaming.browser.tsx`. Target: only the tail block renders again.

### 5. Fade each newly revealed word (after #4)

- **Change.** In the tail block only, wrap the newly revealed words in `<span data-wf>`. Use the Claude Code-tab values:

  | Setting | Value |
  |---|---|
  | Animation | Opacity 0→1, **200 ms linear**, `animation-fill-mode: backwards` |
  | Delay | `max(now, lastAssigned) + chars*2.5 ms`, capped at **now + 600 ms** |
  | Delay chunk | A new chunk starts after **16 chars** in one pass (**48** across passes) |
  | Fast input | No fade when the input is faster than **1.6 chars/ms** over **100 ms** (snap instead) |
  | Settled words | Drop the class on `animationend`. Keep a `settled` set keyed by text position, so a settled word never animates again |

  Use `Intl.Segmenter({granularity:"word"})` for the boundaries, with Codex's fallback `/\s*\S+(?:\s+|$)/g`.
  Codex alternative, for a softer look: **0.7 s** `cubic-bezier(.37,.55,.86,.88)`, `both`, no stagger.
- **Why.**
  - Synara commits about 25 chars about 20 times a second; a fade over 200-700 ms hides that step size.
  - The fade also hides the end-of-stream drain from #2.
- **Risk.**
  - Opacity only, so there is no layout change and no effect on end-follow.
  - Do not ship this before #4: spans that are created again would restart their fades.
  - Reduced motion: no fade (the hook already returns raw text).
  - Keep the fade off the find-in-page highlight path.
- **Verify.**
  - Browser test: a settled span has no animation after the next commit.
  - Count running animations per frame. Target: at most one chunk in flight per 16 chars.

### 6. Code blocks: grow inside one `<pre>`; open-fence and off-screen rules

- **Change.**
  1. Keep one `<pre>` element for the life of the block. On each highlight pass, update its contents; do not unmount the Suspense child or swap the element. Keep the plain live tail inside that `<pre>`.
  2. While `classifyStreamingCodeBlock` returns `open` or `awaiting-info-line`, do not render the copy button (Codex `showCopyButton:!s`).
  3. For a block more than **600 px** below the viewport, render a plain `<pre><code>` with the same font and line height. Highlight it when `IntersectionObserver({rootMargin:"600px 0px"})` fires (Codex `tYc`).
- **Why.**
  - Step 1 targets `live-measurement.md` #5: the `<pre>` is replaced 92-290 times per turn and grows in 84-106 px steps. A swap also moves `scrollTop`, which #1 then has to absorb.
  - How Codex avoids the remount is **not verified**. Step 1 is a Synara design, not a copy.
  - Step 2: the copy button copies only half of a block that is still open.
  - Step 3 saves work off-screen. It does not change the visible block.
- **Risk.**
  - The plain and highlighted `<pre>` must have the same metrics, or the change shifts the layout.
  - Find-in-page must still search the placeholder. The placeholder is real text, so it does.
- **Verify.**
  - Count `<pre>` element replacements in a streaming block. Target: 0 after the first mount.
  - No copy button while the fence is open.

### 7. Eased scroll-to-bottom (extend the existing slide tween)

- **Change.**
  - Do not write a new tween. Extend the rAF slide that already exists for the send slide (`transcriptScroll.ts`, `ANCHOR_SLIDE_DURATION_MS`, `useTailAnchorScroll.ts`) with a "to bottom" mode.
  - Use it in place of the native smooth scroll in `transcriptScroll.ts:62-74`:

  | Setting | Value |
  |---|---|
  | Duration | **200 ms** (Claude) or **260 ms** (Codex) |
  | Easing | `1-(1-t)^3` |
  | Frame time | First frame dt 16 ms; dt cap **34 ms** per frame |
  | Target | The settled bottom, read again on each frame |
  | Stop | Abandon on a user scroll-up or an up key |
  | Landing | Re-arm follow when it lands |
  | Skip | Instant when ≤ **24 px** away or under reduced motion |
- **Why.** Native smooth scroll has no fixed duration, and it chases a bottom that moves while text streams. Both reference apps use a short, fixed tween.
- **Risk.** Mark each tween write as programmatic so that it does not detach follow. Synara already has a 200 ms programmatic window.
- **Verify.** Browser test: while text streams, the button lands at distance 0 within 260 ms ± 1 frame.

### 8. Containment on each markdown block

- **Change.** Add these rules to the direct children of the markdown root, under `@media screen` (Claude chat `._blocks_4za3l_47`, SST):
  - Default: `contain: layout`.
  - With `@supports (overflow-clip-margin: 32px)`: `contain: layout paint; overflow-clip-margin: 32px`.
  - Do not apply them to `table`, `.katex-display`, mermaid, or blocks that have an opt-out attribute.
- **Why.** Growth inside the tail block then causes no layout work in the settled blocks above it, so each commit costs less while the text streams.
- **Risk.**
  - `contain: paint` clips anything that draws outside the block: focus rings, popovers, link previews, the code-block copy toast.
  - The 32 px clip margin covers rings and shadows. Popovers must portal out of the block.
  - Test the find highlight and the selection handles.
- **Verify.** On a 4,000-word stream, compare the `PerformanceObserver` layout-shift sum and the long-animation-frame time before and after.

### Further candidates (not in the top 8)

| Item | Values | Note |
|---|---|---|
| Defer anchor correction during a gesture | During a wheel or touch gesture, put the correction in a `translateY` on the content. Move it into `scrollTop` **120 ms** after the gesture ends (VL `$n=120`) | Detached readers only. A large change to LegendList |
| `content-visibility:auto` for long settled messages | `contain-intrinsic-block-size: auto 3rem` (p 6rem, lists 10rem, headings 1.5rem), `overflow-clip-margin: 2.5rem` | Claude uses this for documents, not for the live reply. Risky with the virtualizer |
| Shiki off the main thread | A Web Worker; in-page fallback time-sliced at **3 ms** | Belongs with perf web.md #9 |

### Do not copy

| Item | Why |
|---|---|
| Claude `message-fade-up` (1.1 s spring, `translateY(10px)`) | The transform moves content under the reader and conflicts with end-follow. Keep Synara's opacity-only 160 ms fade. |
| A plain snap of the backlog at stream end (Codex default path, Claude) | Synara's drain is better. Keep it, and hide what is left with #5. |
| Claude: a pointerdown on a row unpins | Synara's shipped `README.md` #9 keeps follow on a plain click. Claude gets a similar result only for clicks on the empty scroller in the Code tab (re-pin after 500 ms, `dat=500`, CODE). No revert is proposed. |
| Claude: re-pin at stream start within 8 px | It breaks the AGENTS.md rule that navigation away from the bottom releases follow. #1 rule 2 covers the gaps that layout causes. |
| One follow zone for every case | The apps differ: Codex 24 px; Claude 2 px; Synara 1 px. Pick the zone together with #1, not in isolation. |

## Could not determine

| Item | Status |
|---|---|
| Codex flag `2004881635` (column-reverse or ResizeObserver follow) and `267402900` (arrival floor) | Flag-gated, value unknown. No local cache with these IDs was found under `~/Library/Application Support/Codex` or `com.openai.codex`. |
| Codex reply-chain reveal path | `z` in LTE gives a completed message the `revealing` state and the 16/96 ms stagger. Whether every local turn goes through it (`n != null`) is not resolved. |
| Codex highlighter on the transcript path, and how it avoids `<pre>` remounts | The code snippet component `Yn` loads lazily. `lowlight` and `highlight.js` chunks exist; the call path was not followed. No streaming throttle was seen. |
| Codex `Bf()` | Probably reduced motion (it turns off the buffer). Not resolved. |
| Claude `Ii()` / `dt()` (phrase or word mode in the Code tab) | Reads an atom from `c26fb8b6b-EDdRebCk.js`. Not resolved, so the Code tab can run in either mode. Chat always runs in phrase mode. |
| Claude streaming code blocks (open-fence fast path, plain tail, copy button) | `openFenceFastPath` exists (S11@130214). Its rendering was not traced. |
| Claude block containment in the Code tab | Confirmed for the chat root (`Ay=To.blocks`) only. |
| Claude and Codex turn collapse | Claude: not inspected. Codex: the prior values are not in the current SER chunk (see table 7). |
| The redacted CSS class on Codex's 0.7 s rule | The tool output hid the class name. It is inferred to be the adaptive-streaming class (`gl(M.className,N&&T7.AdaptiveStreaming)`, AI@~10727900), because the rule scopes `._FadeIn` under it. |
