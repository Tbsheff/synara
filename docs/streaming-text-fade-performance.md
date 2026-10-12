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
