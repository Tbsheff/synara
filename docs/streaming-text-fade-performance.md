# Streaming text fade performance

The fade keeps its 200 ms duration, 2.5 ms delay per new character, 600 ms delay
cap, eight opacity levels, and fast-input limit. Reduced motion disables it.

## Range reuse

The controller keeps each Range while its text node, local offsets, and fade
start time stay the same. It moves the Range between highlights only when the
opacity level or text color changes. Replacement nodes get new Ranges. Finished
and disposed fades remove all painted Ranges.

Chromium regression: `src/hooks/useStreamingTextReveal.browser.tsx`,
"allocates one Range for an unchanged node/fragment across 60 Hz frames".
The same eight-character append runs through twelve 60 Hz frames and settlement.
The test failed before the change and passed after it.

| Count              | Before | After | Reduction |
| ------------------ | -----: | ----: | --------: |
| Range construction |     13 |     1 |     92.3% |
| Highlight adds     |     13 |     9 |     30.8% |
| Highlight deletes  |     13 |     9 |     30.8% |

These are counts in a real Chromium DOM with a controlled animation clock.
They do not measure live-provider paint time or total heap use. The test also
checks unchanged text and layout bounds; another test covers DOM replacement,
old-prefix visibility, and disposal.

## Index release after settlement

The controller keeps its node index until the last scheduled fragment completes.
It then clears nodes, offsets, the root, text, and arrival history. Disposal clears
the same fields at once. A new live update rebuilds the index without fading old
text. Final code-node replacements remap the remaining fade before cleanup.
Reduced motion also stops an active controller at once.

Chromium regression: "releases 10,000 indexed code nodes only after the final fade
finishes". The test uses a code block with 10,000 text nodes, appends three
characters, disables streaming, checks the fade at 100 ms, and checks the
controller at 300 ms. It failed before the change and passed after it.

| Retained controller field at 300 ms | Before | After |
| ----------------------------------- | -----: | ----: |
| Text-node array entries             | 10,000 |     0 |
| Offset array entries                | 10,000 |     0 |
| Root reference                      |      1 |     0 |

This directly proves release of the controller's references. The source report
estimates 80–160 KiB for these array entries; that byte estimate is not a measured
heap reduction. Separate tests cover detached nodes on disposal, final syntax
highlighting, restart, and reduced motion.

## Changed-tail scans

The controller caches text nodes, text values, and offsets. DOM change records
identify edits to the current tail block. A text-only edit updates the changed
nodes and following tail offsets. Adding blocks scans the old tail and new
blocks. Replacements, edits to stable blocks, and formatting changes use a full
scan. The prefix check still compares changed text, so an in-place rewrite
cannot reuse the append path without validation.

Pending formatting changes also update the index on the next fade frame.
Settlement clears the cached text, tail block, weak node lookup, observer, and
pending change records along with the node index.

Both scan-count regressions in `src/hooks/useStreamingTextReveal.browser.tsx`
failed before this change and passed after it. The small test appends to one tail
behind 100 stable blocks for 20 updates. It removes all 20 DOM walks, all 2,020
stable-node visits, and all 24,920 characters passed to text joins. Character
comparison calls fall from 49,680 to 1,680.

The saved-arrival test replays the first 1,019 changed, positive message lengths
through 8,001 characters from `measure/results/after-prose-1.json`. The checked-in
fixture contains only arrival times and lengths. Their sum is 3,981,471, matching
the source report. The test uses one text node per 400-character paragraph,
retaining prior paragraphs. The original trial did not save its full text or DOM;
this is a controlled replay of its arrivals with modeled prose blocks.

| Count during saved-arrival replay |     Before |             After | Reduction |
| --------------------------------- | ---------: | ----------------: | --------: |
| DOM walks                         | 1,019 full | 41 tail/new-block |     96.0% |
| Text nodes visited by walkers     |     10,461 |                41 |     99.6% |
| Characters passed to text joins   |  3,981,471 |            16,000 |     99.6% |
| Character comparison calls        |  7,946,940 |           409,340 |     94.8% |

Comparison counts include both sides of each `charCodeAt` comparison. These
counts measure work, not elapsed CPU or paint time. A single long text node still
needs a prefix comparison; the estimated 8,000 character-visit target in the
source report would require trusting append-only input without this check.

Tests also compare incremental schedules and offsets with full-text results
across edits, appends, and replacements; check full-scan fallback for stable
edits and hidden math; and check asynchronous formatting, unchanged layout,
reduced motion, final fades, and release of all cached references.

Run focused unit tests from the repository root:

```sh
bun run test:web:focused src/hooks/useStreamingTextReveal.test.ts src/hooks/useSmoothStreamedText.test.ts
```

Run the browser checks from `apps/web` with an unused browser API port:

```sh
VITEST_BROWSER_API_PORT=51273 ../../node_modules/.bin/vitest run --config vitest.browser.config.ts --root . src/components/ChatMarkdown.*.browser.tsx src/components/chat/MessagesTimeline.*.browser.tsx src/hooks/useStreamingTextReveal.browser.tsx src/hooks/useSmoothStreamedText.browser.tsx
```

## Final verification

- `bun run fmt:check`: passed.
- `bun run lint`: passed, 1,032 warnings and zero errors; no warnings in the changed fade files.
- `bun run typecheck`: passed in all eight workspace tasks.
- Focused unit tests: 35 passed in two files.
- Required Markdown and timeline browser tests, plus both streaming hooks: 119
  passed in 26 files. All 12 fade tests passed, including the empty-tail offset
  test during settlement.

The first broad browser run passed 117 tests and failed the short Claude row
stability case at 16.1 px against its 16 px frame-step limit. That case passed
with the original fade module, and all cases passed on the final code rerun.
The browser harness also logged ResizeObserver notifications. Neither run
provides live-provider paint-time or post-GC heap-byte measurements.
