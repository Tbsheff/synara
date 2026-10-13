# Files performance and Find

Files uses a 180 ms pointer dwell before it reads a file body or lists a folder.
Pointer leave, blur, workspace change, and unmount cancel the queued read.
Keyboard focus still starts prefetch at once, and a click starts the normal file
query at once.

Files requests `includeChildHints: false` when it lists folders. The server reads
the parent once and omits `hasChildren`. Other callers keep the existing default
with child hints. Query keys keep the two result shapes separate.

Large editable previews use the existing `CodeEditorPane`, `CodeEditBoundary`,
and Pierre virtualizer in plain-text mode. The initial file size selects the
engine, so clearing the buffer does not replace the editor. Reload changes the
document version. Files opts into the existing editor state retention so a
Markdown Preview/Source switch keeps text, selection, and undo history.

The Files tree uses the existing TanStack virtualizer above 200 visible entries.
It reuses `ExplorerRow`, row styles, context menus, drag data, and keyboard index
rules. Small trees keep the existing disclosure components. Wide trees mount a
viewport range with eight extra rows on each side and retain the focused row.
Arrow keys, Home, and End can move focus to an unmounted row. A newly selected
file scrolls into view; later folder expansion does not scroll back to that file.

Cmd+F in a file editor uses Pierre's existing file Find panel. It supports match
count, next/previous, and changed text. Escape restores file focus and selection.
The shared labeling/focus hook extends the existing editor labeling behavior;
it does not add a second search engine. Chat Find still handles chat focus, and
the existing browser/terminal guards remain in place. Find text uses the app UI
font settings.

## Measurements

These paired measurements rerun the research report's method against base
`3f0f9bdaf69af9fe08f1a909744e6ae0d5892815` and the Files changes. They use a
separate home, copied synthetic fixture, browser profile, and unused loopback
ports. The production desktop app and its data home were not used.

| Case | Before | After |
| --- | ---: | ---: |
| 30-row hover pass, full body reads | 30 | 1 |
| Hover decoded response bytes | 10,348,000 | 325,265 |
| 256 child folders, child `readdir` calls | 256 | 0 |
| Directory probe median, six paired trials | 24.85 ms | 0.85 ms |
| Cached 15,000-line file open | 527 ms | 517 ms |
| Mounted editor rows | 15,000 | 100 |
| Typing p95, keydown to next frame, 26 keys | 74.6 ms | 31.1 ms |
| Typing long tasks / total time | 28 / 1,792 ms | 2 / 104 ms |
| Cached 1,500-file folder expand | 558 ms | 139 ms |
| Mounted file rows in the wide folder | 1,500 | 35 |
| Wide-folder expand long tasks / total time | 3 / 331 ms | 1 / 57 ms |
| File-focused Cmd+F | Transcript Find | File Find |

The hover pass uses 20 ms per row, then a 300 ms hold on the final row. The one
after-read comes from that final intentional hold. Brief passes followed by
leave read no file bodies in the focused regression test. File and folder open
timings use a cached body/listing, DOM-ready, and two animation frames. The
directory probe alternates the unchanged default with the opt-out, six trials
each, over 256 folders with 100 files each. Total directory reads fall from 257
to 1. Input p95 uses sorted sample index `floor((n - 1) * 0.95)`.

The browser uses the production web build in headless Chrome at 1440 by 900.
PerformanceObserver records long tasks, frames, and input latency. The timing
samples share a busy host: the 10 ms file-open difference does not establish a
reliable open-time gain. Thirty wheel events have no long tasks in either run;
their frame p95 changes from 16.7 to 33.4 ms. No scroll-speed gain is claimed.

## Regression coverage and limits

Focused tests cover brief hover/click/focus, directory opt-out and picker
defaults, wide-tree focus/selection/drag/context menus/collapse/font size, and
file versus chat Find routing. Real editor tests cover 15,000 and 100,000 lines,
an over-budget single line, offscreen edits, undo/redo, save/reload, clear/save,
Markdown Preview/Source history, autosave, save conflict, and concurrent edits.
The hover, child-read, mounted-row, and expansion-position tests failed against
the prior behavior and passed after the changes.

Cold-click latency, retained heap after GC, native IME/paste, real embedded
browser/terminal Find, and a packaged desktop run remain unmeasured. The related
changed-file review tree is outside this change. The full workspace unit suite
stops on the unchanged native macOS icon test's five-second timeout. Separate
focused runs reproduce failures in the unchanged sidebar snooze and inbox
done-today tests; these failures prevent a full-suite pass.
