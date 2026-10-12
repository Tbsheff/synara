# Inline HTML pages

In Stable and Beta, agents can call `synara_html_render` with a title, one self-contained
HTML document, and an optional frame height. The title limit is 200 characters.
The HTML limit is 512 KiB in UTF-8. Height defaults to 480 CSS pixels and must be
an integer from 80 to 2000.

The gateway binds the tool to the caller's active turn and thread. It writes the
page to a `synara.html.rendered` thread activity through the current orchestration
engine. The event store and activity projection retain the HTML for replay and
reload; the current thread-history query limits still apply. No migration or
workspace file is required. Call the tool before the final reply. The timeline
keeps the page visible when it folds the turn's work into the final reply.

The web client builds `srcdoc` from that stored text. It never navigates an
app-origin attachment URL to run the page. Both the inline view and the larger
view use `sandbox="allow-scripts allow-forms"`, with no `allow-same-origin`.
A CSP meta tag precedes all page content. It blocks resource network requests,
fetch, XHR, WebSocket, external frames, objects, base URLs, and form submissions.
Use inline scripts and styles, and data images and fonts. Remote CDNs do not load.
The sandbox does not give a page access to Synara's parent document or storage.

The frame accepts the `ui/notifications/size-changed` postMessage protocol only
from its own window. It clamps the height and fits the page inside the height
reserved before first paint. Loading, errors, and size messages keep that outer
box fixed. Long content scrolls inside the frame. Size messages do not issue
transcript scroll commands. The `ui/notifications/host-context-changed` message
updates light/dark mode, the app's CSS colors, fonts, and chosen UI font size.
The tool description lists the layout rules and theme variables.

**Open in panel** uses the current Dialog, IconButton, Button, Tooltip, and icons.
Synara's file panel has no matching HTML host, so this view uses a large dialog.
Both views share `HtmlRenderDocument`. Settled assistant `html` fences offer
**Preview** and **Code** with Code as the default. Open streaming fences and user
messages do not offer a preview.

The shared `inline-html-render` gate enables the tool, saved pages, and code
previews in Stable and Beta. The gateway still checks the caller's active turn
and thread before it stores a page.

This adapts the upstream HTML frame design and message protocol. The root
[LICENSE](../LICENSE) retains its MIT copyright notice and permission terms.

Follow-up: `html_preview` with headless screenshots and size measurements. This
change does not install or run a screenshot service.

## Checks

```sh
bun run --cwd packages/shared test src/htmlRender.test.ts src/betaFeatures.test.ts
bun run --cwd apps/server test src/agentGateway/htmlTools.test.ts src/agentGateway/Layers/AgentGateway.test.ts src/orchestration/Layers/ProjectionSnapshotQuery.test.ts src/agentGateway/computerToolPermission.test.ts
bun run --cwd apps/web test src/components/chat/MessagesTimeline.logic.test.ts src/workLog.test.ts src/components/ChatMarkdown.test.tsx src/components/HtmlRenderFrame.stable.test.tsx src/components/chat/MessagesTimeline.test.tsx src/uiFontSize.test.ts
cd apps/web
VITEST_BROWSER_API_PORT=51227 ../../node_modules/.bin/vitest run --config vitest.browser.config.ts --root . src/components/HtmlRenderFrame.browser.tsx src/components/HtmlRenderFrame.stable.browser.tsx
```

Choose an unused browser-test port. Browser checks need a host that can launch
Chromium; a successful typecheck does not prove the browser sandbox behavior.
The Stable browser test uses a separate file with a fixed production flavor.
Vitest snapshots primitive mock exports when it imports browser modules, so a
getter changed after import cannot switch the desktop flavor. Both browser files
load the app stylesheet to check the frame size and shared dialog with app styles.
