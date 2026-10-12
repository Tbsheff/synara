# Chat Markdown performance

## Sealed block strings

`createMarkdownBlockTextCache` owns rendered and source strings for block slices.
It reuses sealed blocks until their content or origin changes. The live block has
local code-fence offsets. Its slices also need their own strings because React's
previous-render objects can retain a live context after that block seals.
Whole-message strings do not need a copy. String copies preserve UTF-16 units,
including lone surrogates. Replacements and cross-block references clear stale
sealed entries.

The Node regression retained 53,059,552 bytes before the fix and fails at a
5 MiB limit. The browser test streams 100 paragraphs, each with 10,483 content
characters, then a live tail, for 1,048,504 source characters. It uses reduced
motion, waits for each block to render, collects garbage, and saves heap snapshots
in parts under `apps/web/node_modules/.cache/markdown-perf`.

The baseline mode replaces the string cache with the old slice-only behavior.
Run it with:

```sh
VITE_MARKDOWN_PERF_PHASE=before bun run --cwd apps/web test:browser src/components/ChatMarkdown.performance.browser.tsx
VITE_MARKDOWN_PERF_PHASE=after bun run --cwd apps/web test:browser src/components/ChatMarkdown.performance.browser.tsx
```

Measurements cover Chromium component tests with the React compiler enabled.
They do not prove desktop release memory use. Live sliced blocks require a copy
per update; sealed blocks copy once. No matching string-owner helper existed, so
this change adds one beside the existing block scanner.

| Chromium result      |        Before |        After |                  Change |
| -------------------- | ------------: | -----------: | ----------------------: |
| Heap growth after GC | 111,535,656 B | 10,348,544 B | -101,187,112 B (90.72%) |

The baseline snapshot had 200 large parent strings reachable through slices,
with 105,902,000 bytes of string storage. The fixed snapshot's saved block
contexts have no `sourceText` slices. Other app and test strings remain in the
snapshot, so whole-page heap totals also include harness and module storage.

## Chat highlight size limit

Chat uses the same 250,000 UTF-16-unit limit as file preview. Above that limit,
it highlights an empty string and appends the full code as plain text inside
the same Shiki PRE. It keeps the language, theme, copy controls, wrap state,
find offsets and code text. It does not suspend on a new highlighter when code
crosses the limit. The LRU rejects an entry larger than its byte budget before
it removes existing entries, including an oversized replacement.

The limit test failed before the fix because chat sent 250,001 characters to
Shiki. It now checks the exact boundary, PRE identity, unchanged line height,
final code text and find marks. The LRU test also failed before the fix.

The measurement streams exactly 1,048,576 characters in eight 128 KiB steps,
using `const value: number = 42;` lines. It waits 1,100 ms per step so the
highlight throttle runs, then settles the message and collects garbage.
The cache metric uses the cache's byte estimate for settled entries inserted
during this test. The peak metric samples JS heap once per stream step; it is
not a continuous peak or a measure of Chromium's native DOM memory.

| Chromium result                   |      Before |       After |
| --------------------------------- | ----------: | ----------: |
| Largest highlighted input (chars) |   1,048,576 |     131,073 |
| Largest Shiki HTML (chars)        |  11,978,070 |   1,497,414 |
| Settled HTML cache (B)            |  23,956,140 |         268 |
| Sampled peak heap growth (B)      | 641,323,536 | 109,792,908 |
| Settled heap growth after GC (B)  | 148,141,292 |  11,697,428 |
| Code-block DOM nodes              |     645,292 |          17 |

Run `bun run --cwd apps/web test:browser src/components/ChatMarkdown.highlightLimit.browser.tsx`.
Compare the parent commit with the limit commit for the before/after run. The
measurements isolate this limit from the later parsed-prefix cache change.
Large code blocks lose syntax colors. They retain the full plain code and
its existing layout. No new display helper was needed.

## Parsed Shiki prefix cache

`StableShikiHtml` caches the parsed prefix by highlighted HTML alone. It caches
line elements by that parsed value and keeps the plain tail as a separate text
child. It builds combined HTML only for the parser fallback or active find
marks. The existing plain-tail escape helper now lives with the small Shiki HTML
helpers; the syntax-highlighting module re-exports it for its existing callers.
This keeps the find renderer from loading the highlighter just to append text.

The compiled Chromium test sends 60 updates with six highlighted-prefix changes.
It failed before the fix with 60 parser calls. It also checks escaped tails,
fallback marks, PRE identity, line-node identity and complete visible code.

| Count for 60 updates         | Before | After | Reduction |
| ---------------------------- | -----: | ----: | --------: |
| Prefix parses                |     60 |     6 |       90% |
| Highlighted line prop builds |    120 |    12 |       90% |

Run `bun run --cwd apps/web test:browser src/components/ChatMarkdown.shikiParsing.browser.tsx`.
Counts use the same fixed update sequence before and after. They do not measure
frame time or claim a live-provider speed gain. Active find marks still require
combined HTML, as before. This change reuses the current parser and append helper.

## Verification

- `bun run fmt:check`: passed on 4,803 files.
- `bun run lint`: passed with 0 errors and 1,033 warnings; filesystem budget passed.
- `bun run typecheck`: all eight packages passed with narrow local CDP heap types.
- Affected unit tests: nine files, 203 tests passed.
- Requested ChatMarkdown and MessagesTimeline browser command: 105 of 106 tests
  passed in two final runs. The burst-reveal frame assertion observed 174 and 180
  visible characters against a 140-character limit. Height growth stayed at 95 px
  against its 200 px limit. The isolated burst file passed all four tests.
- Base commit `50bdb4681`: all 101 existing browser tests passed, and its isolated
  burst file passed all four tests. The temporary base copy served the linked
  dependency assets through an explicit Vite filesystem allow list.
- Final full browser scope with `--retry 1`: all 27 files and 106 tests passed.

The runs also logged ResizeObserver notifications. The full-suite burst assertion
has an intermittent failure on the final tree; the green run permits one retry.
First-attempt frame-level parity under the full benchmark load remains unverified.
