import "../../index.css";

import { MessageId, ThreadId, TurnId } from "@synara/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import {
  applyLiveToolOutputUpdate,
  clearAllLiveToolOutput,
  clearLiveToolOutputItem,
} from "../../liveToolOutputStore";
import type { deriveTimelineEntries } from "../../session-logic";
import type { WorkLogEntry } from "../../workLog";
import { MessagesTimeline } from "./MessagesTimeline";

type TimelineEntries = ReturnType<typeof deriveTimelineEntries>;

const VIEWPORT_HEIGHT_PX = 420;
const FOLLOW_TOLERANCE_PX = 96;
const DETACHED_OFFSET_PX = 400;
const STABLE_ROW_FRAMES = 6;
const FOLLOWED_TAIL_LINE_COUNTS = [6, 11] as const;
const CLIPPED_TAIL_LINE_COUNTS = [40, 60, 80] as const;
const BOX_BOTTOM_SLACK_PX = 1;
const BOX_READER_SCROLL_UP_PX = 120;
const THREAD_ID = "thread-live";
const TURN_ID = "turn-live";
const LIVE_ITEM_ID = "call-live";
const CREATED_AT = "2026-10-09T20:04:14.000Z";

function messageEntry(
  id: string,
  role: "user" | "assistant",
  text: string,
): TimelineEntries[number] {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: CREATED_AT,
    message: {
      id: MessageId.makeUnsafe(id),
      role,
      text,
      createdAt: CREATED_AT,
      streaming: false,
      turnId: TurnId.makeUnsafe(role === "user" && id.startsWith("live") ? TURN_ID : `turn-${id}`),
    },
  };
}

function commandEntry(input: {
  id: string;
  itemId: string;
  command: string;
  running: boolean;
  output?: string;
}): TimelineEntries[number] {
  const entry: WorkLogEntry = {
    id: input.id,
    createdAt: CREATED_AT,
    turnId: TurnId.makeUnsafe(TURN_ID),
    label: input.running ? "Running command" : "Ran command",
    tone: "tool",
    itemType: "command_execution",
    activityKind: input.running ? "tool.updated" : "tool.completed",
    toolCallId: input.itemId,
    toolStatus: input.running ? "running" : "completed",
    command: input.command,
    commandExecution: {
      command: input.command,
      ...(input.running ? {} : { exitCode: 0 }),
      ...(input.output !== undefined ? { output: input.output } : {}),
    },
  };
  return { id: `entry-${input.id}`, kind: "work", createdAt: CREATED_AT, entry };
}

function seedEntries(): TimelineEntries {
  const entries: TimelineEntries = [];
  for (let index = 0; index < 6; index += 1) {
    entries.push(messageEntry(`seed-user-${index}`, "user", `Earlier question ${index}.`));
    entries.push(
      messageEntry(
        `seed-assistant-${index}`,
        "assistant",
        `Earlier answer ${index}. ${"Settled response text. ".repeat(8)}`,
      ),
    );
  }
  entries.push(messageEntry("live-user", "user", "Run the tests."));
  entries.push(
    commandEntry({
      id: "live-command",
      itemId: LIVE_ITEM_ID,
      command: "bun run test",
      running: true,
    }),
  );
  return entries;
}

interface Harness {
  listRef: React.RefObject<LegendListRef | null>;
  setFollow: (follow: boolean) => void;
  appendToolRows: (count: number) => void;
  completeLiveCommand: (output: string) => void;
  atEndReports: boolean[];
}

function LiveOutputTimeline({ harnessRef }: { harnessRef: { current: Harness | null } }) {
  const listRef = useRef<LegendListRef | null>(null);
  const atEndReportsRef = useRef<boolean[]>([]);
  const [entries, setEntries] = useState<TimelineEntries>(seedEntries);
  const [follow, setFollow] = useState(true);

  harnessRef.current = {
    listRef,
    setFollow,
    atEndReports: atEndReportsRef.current,
    appendToolRows: (count) => {
      setEntries((current) => [
        ...current,
        ...Array.from({ length: count }, (_, index) =>
          commandEntry({
            id: `extra-${current.length + index}`,
            itemId: `extra-item-${current.length + index}`,
            command: `echo extra ${index}`,
            running: false,
            output: "done",
          }),
        ),
      ]);
    },
    completeLiveCommand: (output) => {
      setEntries((current) =>
        current.map((entry) =>
          entry.id === "entry-live-command"
            ? commandEntry({
                id: "live-command",
                itemId: LIVE_ITEM_ID,
                command: "bun run test",
                running: false,
                output,
              })
            : entry,
        ),
      );
    },
  };

  return (
    <div style={{ height: VIEWPORT_HEIGHT_PX }}>
      <MessagesTimeline
        threadId={THREAD_ID}
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnId={TurnId.makeUnsafe(TURN_ID)}
        activeTurnStartedAt={CREATED_AT}
        listRef={listRef}
        followLiveOutput={follow}
        timelineEntries={entries}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-10-09T20:05:00.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        onIsAtEndChange={(isAtEnd) => atEndReportsRef.current.push(isAtEnd)}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />
    </div>
  );
}

function scrollContainer(harness: Harness): HTMLElement {
  const node: unknown = harness.listRef.current?.getScrollableNode?.();
  if (!(node instanceof HTMLElement)) throw new Error("scroll container not available");
  return node;
}

function distanceFromBottomPx(harness: Harness): number {
  const container = scrollContainer(harness);
  return container.scrollHeight - container.clientHeight - container.scrollTop;
}

async function settleFrames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  }
}

let liveUpdateClock = 0;

function pushLiveTail(lines: number): void {
  liveUpdateClock += 1;
  applyLiveToolOutputUpdate({
    kind: "tool-output",
    threadId: ThreadId.makeUnsafe(THREAD_ID),
    turnId: TurnId.makeUnsafe(TURN_ID),
    itemId: LIVE_ITEM_ID as never,
    streamKind: "command_output",
    tail: Array.from({ length: lines }, (_, index) => `test output line ${index}`).join("\n"),
    truncated: false,
    totalChars: lines * 20,
    updatedAt: new Date(Date.parse(CREATED_AT) + liveUpdateClock * 1000).toISOString(),
  });
}

function liveRowHeightPx(): number {
  const row = document
    .querySelector('[data-timeline-row-kind="work"] [data-command-live-output]')
    ?.closest<HTMLElement>("[data-timeline-row-kind]");
  return row?.getBoundingClientRect().height ?? 0;
}

function liveOutputIsClipped(): boolean {
  const output = document.querySelector<HTMLElement>("[data-command-live-output]");
  return output !== null && output.scrollHeight > output.clientHeight;
}

function liveOutputBox(): HTMLElement {
  const output = document.querySelector<HTMLElement>("[data-command-live-output]");
  if (!output) throw new Error("live output box not rendered");
  return output;
}

function liveOutputDistanceFromBottomPx(): number {
  const box = liveOutputBox();
  return box.scrollHeight - box.clientHeight - box.scrollTop;
}

function liveOutputLastLine(): string | undefined {
  return document.querySelector("[data-command-live-output]")?.textContent?.split("\n").at(-1);
}

async function waitForStableLiveRowHeight(): Promise<void> {
  let previous = -1;
  let stableFrames = 0;
  await expect
    .poll(
      async () => {
        await settleFrames(1);
        const height = liveRowHeightPx();
        stableFrames = height === previous ? stableFrames + 1 : 0;
        previous = height;
        return stableFrames;
      },
      { timeout: 5_000, interval: 0 },
    )
    .toBeGreaterThanOrEqual(STABLE_ROW_FRAMES);
}

async function expandLiveCommandRow(): Promise<void> {
  if (document.querySelector("[data-command-live-output]")) return;
  const toggle = [
    ...document.querySelectorAll<HTMLElement>(
      '[data-timeline-row-kind="work"] [aria-expanded="false"]',
    ),
  ].at(-1);
  toggle?.click();
  await expect
    .poll(() => document.querySelector("[data-command-live-output]") !== null, { timeout: 5_000 })
    .toBe(true);
}

async function mountAtBottom(harnessRef: { current: Harness | null }): Promise<Harness> {
  await expect.poll(() => harnessRef.current?.listRef.current != null).toBe(true);
  const harness = harnessRef.current!;
  pushLiveTail(1);
  await expandLiveCommandRow();
  await waitForStableLiveRowHeight();
  await harness.listRef.current?.scrollToEnd?.({ animated: false });
  await expect
    .poll(() => distanceFromBottomPx(harness), { timeout: 5_000 })
    .toBeLessThanOrEqual(FOLLOW_TOLERANCE_PX);
  return harness;
}

describe("MessagesTimeline live tool output", () => {
  afterEach(() => {
    clearAllLiveToolOutput();
    document.body.innerHTML = "";
  });

  it("keeps a reader at the bottom following while the live tail grows", async () => {
    const harnessRef: { current: Harness | null } = { current: null };
    const screen = await render(<LiveOutputTimeline harnessRef={harnessRef} />);
    try {
      const harness = await mountAtBottom(harnessRef);
      for (const lines of FOLLOWED_TAIL_LINE_COUNTS) {
        const before = liveRowHeightPx();
        pushLiveTail(lines);
        await expect.poll(() => liveRowHeightPx(), { timeout: 5_000 }).toBeGreaterThan(before);
        await waitForStableLiveRowHeight();
        expect(liveOutputIsClipped()).toBe(false);
        expect(liveRowHeightPx() - before).toBeGreaterThan(FOLLOW_TOLERANCE_PX);
        await expect
          .poll(() => distanceFromBottomPx(harness), { timeout: 5_000 })
          .toBeLessThanOrEqual(FOLLOW_TOLERANCE_PX);
      }
    } finally {
      await screen.unmount();
    }
  });

  it("leaves a detached reader in place while the tail grows and tool rows arrive", async () => {
    const harnessRef: { current: Harness | null } = { current: null };
    const screen = await render(<LiveOutputTimeline harnessRef={harnessRef} />);
    try {
      const harness = await mountAtBottom(harnessRef);
      const container = scrollContainer(harness);
      harness.setFollow(false);
      await settleFrames(2);
      container.scrollTop = Math.max(0, container.scrollTop - DETACHED_OFFSET_PX);
      await settleFrames(4);
      const detachedScrollTop = container.scrollTop;
      const reportsBefore = harness.atEndReports.length;

      pushLiveTail(30);
      await settleFrames(3);
      harness.appendToolRows(2);
      pushLiveTail(60);
      await settleFrames(8);

      expect(Math.abs(container.scrollTop - detachedScrollTop)).toBeLessThanOrEqual(1);
      expect(distanceFromBottomPx(harness)).toBeGreaterThan(FOLLOW_TOLERANCE_PX);
      expect(harness.atEndReports.slice(reportsBefore)).not.toContain(true);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a following reader at the bottom when the final output replaces the tail", async () => {
    const harnessRef: { current: Harness | null } = { current: null };
    const screen = await render(<LiveOutputTimeline harnessRef={harnessRef} />);
    try {
      const harness = await mountAtBottom(harnessRef);
      pushLiveTail(30);
      await settleFrames(4);
      harness.completeLiveCommand(
        Array.from({ length: 50 }, (_, index) => `final line ${index}`).join("\n"),
      );
      clearLiveToolOutputItem(THREAD_ID, LIVE_ITEM_ID);
      await settleFrames(10);
      await expect
        .poll(() => distanceFromBottomPx(harness), { timeout: 5_000 })
        .toBeLessThanOrEqual(FOLLOW_TOLERANCE_PX);
    } finally {
      await screen.unmount();
    }
  });

  it("tails the clipped live output box while its reader stays at the box bottom", async () => {
    const harnessRef: { current: Harness | null } = { current: null };
    const screen = await render(<LiveOutputTimeline harnessRef={harnessRef} />);
    try {
      await mountAtBottom(harnessRef);
      for (const lines of CLIPPED_TAIL_LINE_COUNTS) {
        pushLiveTail(lines);
        await expect
          .poll(() => liveOutputLastLine(), { timeout: 5_000 })
          .toBe(`test output line ${lines - 1}`);
        await settleFrames(2);
        expect(liveOutputIsClipped()).toBe(true);
        expect(liveOutputDistanceFromBottomPx()).toBeLessThanOrEqual(BOX_BOTTOM_SLACK_PX);
      }
    } finally {
      await screen.unmount();
    }
  });

  it("stops tailing the box when its reader scrolls up in it, without moving the transcript", async () => {
    const harnessRef: { current: Harness | null } = { current: null };
    const screen = await render(<LiveOutputTimeline harnessRef={harnessRef} />);
    try {
      const harness = await mountAtBottom(harnessRef);
      const [firstLines, secondLines, thirdLines] = CLIPPED_TAIL_LINE_COUNTS;
      pushLiveTail(firstLines);
      await expect
        .poll(() => liveOutputDistanceFromBottomPx(), { timeout: 5_000 })
        .toBeLessThanOrEqual(BOX_BOTTOM_SLACK_PX);
      const box = liveOutputBox();
      box.scrollTop -= BOX_READER_SCROLL_UP_PX;
      await settleFrames(2);
      const readerBoxScrollTop = box.scrollTop;

      pushLiveTail(secondLines);
      await expect
        .poll(() => liveOutputLastLine(), { timeout: 5_000 })
        .toBe(`test output line ${secondLines - 1}`);
      await settleFrames(3);
      expect(Math.abs(box.scrollTop - readerBoxScrollTop)).toBeLessThanOrEqual(1);
      expect(distanceFromBottomPx(harness)).toBeLessThanOrEqual(FOLLOW_TOLERANCE_PX);

      box.scrollTop = box.scrollHeight - box.clientHeight;
      await settleFrames(2);
      pushLiveTail(thirdLines);
      await expect
        .poll(() => liveOutputLastLine(), { timeout: 5_000 })
        .toBe(`test output line ${thirdLines - 1}`);
      await settleFrames(2);
      expect(liveOutputDistanceFromBottomPx()).toBeLessThanOrEqual(BOX_BOTTOM_SLACK_PX);
    } finally {
      await screen.unmount();
    }
  });

  it("tails the box without moving a detached transcript reader", async () => {
    const harnessRef: { current: Harness | null } = { current: null };
    const screen = await render(<LiveOutputTimeline harnessRef={harnessRef} />);
    try {
      const harness = await mountAtBottom(harnessRef);
      pushLiveTail(CLIPPED_TAIL_LINE_COUNTS[0]);
      await expect
        .poll(() => liveOutputDistanceFromBottomPx(), { timeout: 5_000 })
        .toBeLessThanOrEqual(BOX_BOTTOM_SLACK_PX);
      await waitForStableLiveRowHeight();
      harness.setFollow(false);
      await settleFrames(2);
      const container = scrollContainer(harness);
      container.scrollTop -= DETACHED_OFFSET_PX;
      await settleFrames(2);
      const readerScrollTop = container.scrollTop;

      pushLiveTail(CLIPPED_TAIL_LINE_COUNTS[1]);
      await expect
        .poll(() => liveOutputLastLine(), { timeout: 5_000 })
        .toBe(`test output line ${CLIPPED_TAIL_LINE_COUNTS[1] - 1}`);
      await settleFrames(3);
      expect(liveOutputDistanceFromBottomPx()).toBeLessThanOrEqual(BOX_BOTTOM_SLACK_PX);
      expect(Math.abs(container.scrollTop - readerScrollTop)).toBeLessThanOrEqual(1);
    } finally {
      await screen.unmount();
    }
  });

  it("shows a grouped running command's live tail behind the group's live line", async () => {
    const entries: TimelineEntries = [
      messageEntry("live-user", "user", "Run the checks."),
      commandEntry({
        id: "done-1",
        itemId: "done-item-1",
        command: "echo one",
        running: false,
        output: "one",
      }),
      commandEntry({
        id: "done-2",
        itemId: "done-item-2",
        command: "echo two",
        running: false,
        output: "two",
      }),
      commandEntry({
        id: "live-command",
        itemId: LIVE_ITEM_ID,
        command: "bun run test",
        running: true,
      }),
    ];
    const screen = await render(
      <div style={{ height: VIEWPORT_HEIGHT_PX }}>
        <MessagesTimeline
          threadId={THREAD_ID}
          hasMessages
          isWorking
          activeTurnInProgress
          activeTurnId={TurnId.makeUnsafe(TURN_ID)}
          activeTurnStartedAt={CREATED_AT}
          timelineEntries={entries}
          turnDiffSummaryByAssistantMessageId={new Map()}
          nowIso="2026-10-09T20:05:00.000Z"
          expandedWorkGroups={{}}
          onToggleWorkGroup={() => {}}
          onOpenTurnDiff={() => {}}
          revertTurnCountByUserMessageId={new Map()}
          onRevertUserMessage={() => {}}
          isRevertingCheckpoint={false}
          onImageExpand={() => {}}
          markdownCwd={undefined}
          resolvedTheme="dark"
          timestampFormat="locale"
          workspaceRoot={undefined}
        />
      </div>,
    );
    try {
      const groupToggle = () =>
        document
          .querySelector('[data-tool-group-live="true"]')
          ?.closest<HTMLButtonElement>("button[aria-expanded]");
      await expect.poll(() => groupToggle() != null, { timeout: 5_000 }).toBe(true);
      pushLiveTail(3);
      groupToggle()!.click();
      await expect
        .poll(() =>
          [...document.querySelectorAll("[data-work-entry-display-text]")].some((node) =>
            node.textContent?.includes("bun run test"),
          ),
        )
        .toBe(true);
      await settleFrames(4);
      await expandLiveCommandRow();
      await expect
        .poll(() => document.querySelector("[data-command-live-output]")?.textContent ?? "")
        .toContain("test output line 2");
      expect(
        document
          .querySelector("[data-command-live-output]")
          ?.textContent?.startsWith("test output line 0\n"),
      ).toBe(true);
    } finally {
      await screen.unmount();
    }
  });
});
