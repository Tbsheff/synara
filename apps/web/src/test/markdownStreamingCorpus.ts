export const LONG_STREAMING_MESSAGE_BLOCKS: readonly string[] = [
  "## Summary",
  "I traced the reconnect stall to `ProviderRuntimeIngestion.ts`. The session reader keeps a stale cursor after the socket drops, so the next `orchestration.getSnapshot` call returns **old projections** until the user reloads. See [the projector](./apps/server/src/orchestration/projector.ts) for where the cursor is written.",
  "### What changed",
  "- Reset the cursor when the transport reports `closed`, not only on `error`.\n- Move the snapshot read behind the same lock as the event consumer.\n- Add `retryBudgetMs` to the reconnect options (default `4_000`).",
  "The core of the fix is small:",
  '```ts\nexport function resetCursorOnClose(state: IngestionState, event: TransportEvent): IngestionState {\n  if (event.type !== "closed" && event.type !== "error") {\n    return state;\n  }\n  return { ...state, cursor: null, pendingSince: event.at };\n}\n```',
  "After this change the reader requests a fresh snapshot on the first reconnect tick. The extra round trip costs about *12 ms* on a local socket, which is well inside the budget.",
  "| Scenario | Before | After |\n| --- | ---: | ---: |\n| Clean reconnect | 2.4 s | 0.3 s |\n| Server restart | stalls | 0.9 s |\n| Flaky Wi-Fi (10% loss) | 6.1 s | 1.2 s |",
  "> [!NOTE]\n> The stall only reproduced when the server restarted while a turn was streaming. Idle reconnects were already fine.",
  "1. Start an isolated instance with `bun run dev -- --home /tmp/synara-check`.\n2. Begin a long turn and kill the server process.\n3. Restart it and watch the transcript:\n\n   ```bash\n   bun run dev:server -- --port 3779\n   ```\n\n4. Confirm the turn resumes without a reload.",
  "The latency model is roughly linear in the backlog:",
  "$$\nT_{resume} = T_{connect} + \\frac{B}{r_{drain}}\n$$",
  "where $B$ is the buffered event count and $r_{drain}$ is the drain rate.",
  "### Remaining risks",
  "- [x] Cursor reset on close\n- [x] Snapshot behind the consumer lock\n- [ ] Windows named-pipe transport (not verified)",
  "The Windows transport uses a different close path in `apps/server/src/platform/process.ts`, so the same reset may not fire there. I did **not** test it on a packaged build.",
  '```json\n{\n  "reconnect": {\n    "retryBudgetMs": 4000,\n    "resetCursorOnClose": true\n  }\n}\n```',
  "That is the whole change. The tests in `ProviderRuntimeIngestion.test.ts` cover the close and error paths, and the browser harness covers the transcript resume.",
];

export const LONG_STREAMING_MESSAGE = LONG_STREAMING_MESSAGE_BLOCKS.join("\n\n");

export const MARKDOWN_IDENTITY_CORPUS: readonly { name: string; text: string }[] = [
  { name: "long mixed message", text: LONG_STREAMING_MESSAGE },
  {
    name: "loose list across blank lines",
    text: "Steps:\n\n- first\n\n- second\n\n- third\n\nDone.",
  },
  {
    name: "ordered list with nested fence and blank lines",
    text: "1. Install\n\n   ```sh\n   bun install\n\n   bun run build\n   ```\n\n2. Run\n\nAfter the list.",
  },
  {
    name: "ordered list starting at three",
    text: "Intro.\n\n3. third\n4. fourth\n\nOutro.",
  },
  {
    name: "fence containing blank lines and markdown-looking text",
    text: "Before.\n\n```md\n# not a heading\n\n- not a list\n\n> not a quote\n```\n\nAfter.",
  },
  {
    name: "four-backtick fence containing a triple fence",
    text: "````md\n```ts\nconst a = 1;\n\n```\n````\n\nTail paragraph.",
  },
  { name: "tilde fence", text: "~~~python\nprint('hi')\n\nprint('bye')\n~~~\n\nEnd." },
  {
    name: "indented code with blank lines",
    text: "Paragraph.\n\n    line one\n\n    line two\n\nAfter code.",
  },
  {
    name: "display math with blank lines",
    text: "Math:\n\n$$\na = b\n\nc = d\n$$\n\nAfter math.",
  },
  {
    name: "table then paragraph",
    text: "| a | b |\n| - | - |\n| 1 | 2 |\n\nText after table.",
  },
  {
    name: "blockquotes separated by blank line",
    text: "> first quote\n> continues\n\n> second quote\n\nPlain.",
  },
  {
    name: "blockquote with fence",
    text: "> ```js\n> const x = 1;\n>\n> const y = 2;\n> ```\n\nAfter quote.",
  },
  {
    name: "setext headings",
    text: "Title\n=====\n\nSubtitle\n--------\n\nBody text.",
  },
  {
    name: "paragraph interrupted by list and heading",
    text: "Para line\n- item one\n- item two\n# Heading\nMore text\n\nLast.",
  },
  {
    name: "lazy list continuation",
    text: "- item one\ncontinued lazily\n\n- item two\n\nNot in list.",
  },
  {
    name: "github alerts",
    text: "> [!WARNING]\n> Careful here.\n\n> [!TIP]\n> Try this.\n\nDone.",
  },
  { name: "task list", text: "- [ ] open\n- [x] done\n\nText." },
  { name: "thematic breaks", text: "Above.\n\n---\n\nBelow.\n\n***\n\nEnd." },
  { name: "html-looking text", text: "<div>\nhello\n</div>\n\n<!-- note -->\n\nAfter." },
  {
    name: "html comment spanning blank lines",
    text: "<!--\n\n```\n\n-->\n\nVisible paragraph.",
  },
  {
    name: "inline math and dollars",
    text: "It costs $5 and $10.\n\nThe value $x^2 + y^2$ matters.\n\nTotal: $15.",
  },
  {
    name: "file links and inline code paths",
    text: "Edit `apps/web/src/index.css` and [the file](./src/main.ts:12).\n\nSee `/usr/local/bin/bun`.",
  },
  {
    name: "headings and emphasis",
    text: "# H1\n\nSome *em* and **strong** and ~~strike~~.\n\n## H2\n\nMore.",
  },
  {
    name: "nested lists",
    text: "- a\n  - b\n    - c\n\n  back in a\n\n- d\n\nOut.",
  },
  {
    name: "list then fence at column zero",
    text: "- a\n  ```\n```\n\ncode inside fence\n\nX",
  },
  {
    name: "ordered list interrupted by different marker",
    text: "- a\n2. b\n\n   ```\n\nmore\n\n   ```\n\nZ",
  },
  {
    name: "trailing whitespace and leading blank lines",
    text: "\n\n  Indented para.\n\n\n\nNext para.  \n\n",
  },
];
