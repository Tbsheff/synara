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
