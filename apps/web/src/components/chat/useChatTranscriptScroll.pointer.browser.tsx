import "../../index.css";

import { MessageId, ThreadId, TurnId } from "@synara/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { deriveTimelineEntries } from "../../session-logic";
import type { WorkLogEntry } from "../../workLog";
import { MessagesTimeline } from "./MessagesTimeline";
import { useChatTranscriptScroll } from "./useChatTranscriptScroll";

type TimelineEntries = ReturnType<typeof deriveTimelineEntries>;

const VIEWPORT_HEIGHT_PX = 420;
const BOTTOM_SLACK_PX = 1;
const THREAD_ID = ThreadId.makeUnsafe("thread-pointer");
const TURN_ID = "turn-pointer";
const PREVIOUS_TURN_ID = "turn-pointer-previous";
const STREAM_ID = "pointer-streaming-assistant";
const CREATED_AT = "2026-10-09T20:04:14.000Z";
const STREAM_CHUNK = `\n\n${"More streamed output for the reader. ".repeat(6)}`;

function messageEntry(
  id: string,
  role: "user" | "assistant",
  text: string,
  turnId = TURN_ID,
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
      turnId: TurnId.makeUnsafe(id.startsWith("seed") ? `turn-${id}` : turnId),
    },
  };
}

function commandEntry(id: string, turnId = TURN_ID): TimelineEntries[number] {
  const entry: WorkLogEntry = {
    id,
    createdAt: CREATED_AT,
    turnId: TurnId.makeUnsafe(turnId),
    label: "Ran command",
    tone: "tool",
    itemType: "command_execution",
    activityKind: "tool.completed",
    toolCallId: `${id}-item`,
    toolStatus: "completed",
    command: "bun run test",
    commandExecution: {
      command: "bun run test",
      exitCode: 0,
      output: Array.from({ length: 12 }, (_, index) => `test output line ${index}`).join("\n"),
    },
  };
  return { id: `entry-${id}`, kind: "work", createdAt: CREATED_AT, entry };
}

function seedEntries(tail: "assistant" | "command"): TimelineEntries {
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
  if (tail === "command") {
    entries.push(messageEntry("live-user", "user", "Run the tests."));
    entries.push(commandEntry("live-command"));
    return entries;
  }
  entries.push(messageEntry("previous-user", "user", "Run the tests.", PREVIOUS_TURN_ID));
  entries.push(commandEntry("previous-command", PREVIOUS_TURN_ID));
  entries.push(messageEntry("previous-answer", "assistant", "The tests passed.", PREVIOUS_TURN_ID));
  entries.push(messageEntry("live-user", "user", "Explain the result."));
  entries.push(
    messageEntry(STREAM_ID, "assistant", "The tests ran and this is the explanation. ".repeat(5)),
  );
  return entries;
}

interface Harness {
  listRef: React.RefObject<LegendListRef | null>;
  controls: ReturnType<typeof useChatTranscriptScroll>;
  grow: () => void;
}

function PointerTimeline({
  harnessRef,
  tail,
}: {
  harnessRef: { current: Harness | null };
  tail: "assistant" | "command";
}) {
  const listRef = useRef<LegendListRef | null>(null);
  const [entries, setEntries] = useState<TimelineEntries>(() => seedEntries(tail));
  const controls = useChatTranscriptScroll({
    activeThreadId: THREAD_ID,
    legendListRef: listRef,
    timelineEntries: entries,
    hasStreamingAssistantText: tail === "assistant",
    composerTranscriptInsetPx: 0,
    isInactiveSplitPane: false,
  });
  harnessRef.current = {
    listRef,
    controls,
    grow: () => {
      setEntries((current) =>
        current.map((entry) =>
          entry.kind === "message" && entry.message.id === STREAM_ID
            ? messageEntry(STREAM_ID, "assistant", `${entry.message.text}${STREAM_CHUNK}`)
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
        tailAnchorScrollInFlightRef={controls.tailAnchorScrollInFlightRef}
        followLiveOutput={!controls.isUserScrollDetached}
        onIsAtEndChange={controls.onIsAtEndChange}
        onNavigate={controls.onTranscriptNavigate}
        onMessagesClickCapture={controls.onMessagesClickCaptureBase}
        onMessagesPointerDown={controls.onMessagesPointerDownBase}
        onMessagesPointerUp={controls.onMessagesPointerUpBase}
        onMessagesPointerCancel={controls.onMessagesPointerCancelBase}
        onMessagesWheel={controls.onMessagesWheelBase}
        onMessagesTouchStart={controls.onMessagesTouchStartBase}
        onMessagesTouchMove={controls.onMessagesTouchMoveBase}
        onMessagesTouchEnd={controls.onMessagesTouchEndBase}
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
    </div>
  );
}

function scrollContainer(harness: Harness): HTMLElement {
  const node: unknown = harness.listRef.current?.getScrollableNode?.();
  if (!(node instanceof HTMLElement)) throw new Error("scroll container not available");
  return node;
}

function distanceFromBottomPx(container: HTMLElement): number {
  return container.scrollHeight - container.clientHeight - container.scrollTop;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

async function settleFrames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await nextFrame();
}

function streamParagraph(): HTMLElement {
  const paragraph = document.querySelector<HTMLElement>(`[data-message-id="${STREAM_ID}"] p`);
  if (!paragraph) throw new Error("streaming paragraph not rendered");
  return paragraph;
}

function timelineRowsByPosition(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-timeline-row-kind]")]
    .filter((row) => row.dataset.timelineRowKind !== "working")
    .toSorted(
      (left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top,
    );
}

function tailRowDisclosure(): HTMLElement {
  const toggle = timelineRowsByPosition().at(-1)?.querySelector<HTMLElement>("[aria-expanded]");
  if (!toggle) throw new Error("tail row disclosure not rendered");
  return toggle;
}

function disclosureAboveTailRow(container: HTMLElement): HTMLElement {
  const viewport = container.getBoundingClientRect();
  const toggle = timelineRowsByPosition()
    .slice(0, -1)
    .flatMap((row) => Array.from(row.querySelectorAll<HTMLElement>("[aria-expanded]")))
    .findLast((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.top > viewport.top && rect.bottom < viewport.bottom;
    });
  if (!toggle) throw new Error("visible disclosure above the tail row not rendered");
  return toggle;
}

function pointerAt(
  type: string,
  target: Element,
  point: { x: number; y: number },
  init: PointerEventInit = {},
): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX: point.x,
      clientY: point.y,
      ...init,
    }),
  );
}

function centerOf(element: Element): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

async function mountFollowing(
  tail: "assistant" | "command" = "assistant",
): Promise<{ harness: Harness; container: HTMLElement; unmount: () => Promise<void> }> {
  const harnessRef: { current: Harness | null } = { current: null };
  const screen = await render(<PointerTimeline harnessRef={harnessRef} tail={tail} />);
  await expect.poll(() => harnessRef.current?.listRef.current != null).toBe(true);
  await settleFrames(3);
  void harnessRef.current!.listRef.current?.scrollToEnd?.({ animated: false });
  await expect
    .poll(() => distanceFromBottomPx(scrollContainer(harnessRef.current!)))
    .toBeLessThanOrEqual(BOTTOM_SLACK_PX);
  await settleFrames(8);
  const harness = harnessRef.current!;
  expect(harness.controls.isUserScrollDetached).toBe(false);
  return {
    get harness() {
      return harnessRef.current!;
    },
    container: scrollContainer(harness),
    unmount: () => screen.unmount(),
  };
}

async function growDuringFrames(mounted: { harness: Harness }, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    mounted.harness.grow();
    await nextFrame();
  }
  await settleFrames(3);
}

describe("transcript pointer input and end-follow", () => {
  afterEach(() => {
    document.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
  });

  it("keeps follow through a plain click while text streams during the press", async () => {
    const mounted = await mountFollowing();
    try {
      const { container } = mounted;
      const target = streamParagraph();
      const point = centerOf(target);
      const heightAtPress = container.scrollHeight;
      pointerAt("pointerdown", target, point);
      await growDuringFrames(mounted, 3);
      expect(container.scrollHeight).toBeGreaterThan(heightAtPress);
      expect(mounted.harness.controls.isUserScrollDetached).toBe(false);
      expect(distanceFromBottomPx(container)).toBeLessThanOrEqual(BOTTOM_SLACK_PX);
      pointerAt("pointerup", streamParagraph(), point);
      streamParagraph().click();
      await growDuringFrames(mounted, 2);
      expect(mounted.harness.controls.isUserScrollDetached).toBe(false);
      expect(distanceFromBottomPx(container)).toBeLessThanOrEqual(BOTTOM_SLACK_PX);
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps follow through a native click on streaming text", async () => {
    const mounted = await mountFollowing();
    try {
      const { container } = mounted;
      await growDuringFrames(mounted, 2);
      await userEvent.click(streamParagraph());
      await growDuringFrames(mounted, 3);
      expect(mounted.harness.controls.isUserScrollDetached).toBe(false);
      expect(distanceFromBottomPx(container)).toBeLessThanOrEqual(BOTTOM_SLACK_PX);
    } finally {
      await mounted.unmount();
    }
  });

  it("ignores hover movement after a press whose pointerup was lost", async () => {
    const mounted = await mountFollowing();
    try {
      const { container } = mounted;
      const target = streamParagraph();
      const point = centerOf(target);
      pointerAt("pointerdown", target, point);
      pointerAt("pointermove", target, { x: point.x + 20, y: point.y }, { buttons: 0 });
      await growDuringFrames(mounted, 2);
      expect(mounted.harness.controls.isUserScrollDetached).toBe(false);
      expect(distanceFromBottomPx(container)).toBeLessThanOrEqual(BOTTOM_SLACK_PX);
      pointerAt("pointermove", target, { x: point.x + 40, y: point.y }, { buttons: 0 });
      await nextFrame();
      expect(mounted.harness.controls.isUserScrollDetached).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });

  it("releases follow when the press drags to select text and keeps the reader in place", async () => {
    const mounted = await mountFollowing();
    try {
      const { container } = mounted;
      const target = streamParagraph();
      const point = centerOf(target);
      pointerAt("pointerdown", target, point);
      pointerAt("pointermove", target, { x: point.x + 4, y: point.y });
      await nextFrame();
      expect(mounted.harness.controls.isUserScrollDetached).toBe(false);
      pointerAt("pointermove", target, { x: point.x + 20, y: point.y });
      await nextFrame();
      expect(mounted.harness.controls.isUserScrollDetached).toBe(true);
      const scrollTopAtSelect = container.scrollTop;
      await growDuringFrames(mounted, 3);
      pointerAt("pointerup", target, { x: point.x + 20, y: point.y });
      await settleFrames(3);
      expect(mounted.harness.controls.isUserScrollDetached).toBe(true);
      expect(Math.abs(container.scrollTop - scrollTopAtSelect)).toBeLessThanOrEqual(1);
      expect(distanceFromBottomPx(container)).toBeGreaterThan(BOTTOM_SLACK_PX);
    } finally {
      await mounted.unmount();
    }
  });

  it("releases follow when a press selects text without moving", async () => {
    const mounted = await mountFollowing();
    try {
      const { container } = mounted;
      const target = streamParagraph();
      const point = centerOf(target);
      pointerAt("pointerdown", target, point);
      const range = document.createRange();
      range.selectNodeContents(target);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
      await expect.poll(() => mounted.harness.controls.isUserScrollDetached).toBe(true);
      const scrollTopAtSelect = container.scrollTop;
      pointerAt("pointerup", target, point);
      await growDuringFrames(mounted, 3);
      expect(Math.abs(container.scrollTop - scrollTopAtSelect)).toBeLessThanOrEqual(1);
      expect(mounted.harness.controls.isUserScrollDetached).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });

  it("releases follow for a press on the scrollbar and for a scroll up during a press", async () => {
    const scrollbarStyle = document.createElement("style");
    scrollbarStyle.textContent =
      "[data-chat-scroll-container='true']::-webkit-scrollbar { width: 12px; }";
    document.head.append(scrollbarStyle);
    const mounted = await mountFollowing();
    try {
      const { container } = mounted;
      const scrollbarWidth = container.offsetWidth - container.clientWidth;
      expect(scrollbarWidth).toBeGreaterThan(0);
      const rect = container.getBoundingClientRect();
      const scrollbarPoint = { x: rect.right - scrollbarWidth / 2, y: rect.top + rect.height / 2 };
      pointerAt("pointerdown", container, scrollbarPoint);
      expect(mounted.harness.controls.isUserScrollDetached).toBe(true);
      pointerAt("pointerup", container, scrollbarPoint);
      mounted.harness.controls.onScrollToBottom();
      await expect.poll(() => distanceFromBottomPx(container)).toBeLessThanOrEqual(BOTTOM_SLACK_PX);
      await settleFrames(4);
      expect(mounted.harness.controls.isUserScrollDetached).toBe(false);

      const target = streamParagraph();
      const point = centerOf(target);
      pointerAt("pointerdown", target, point);
      await nextFrame();
      expect(mounted.harness.controls.isUserScrollDetached).toBe(false);
      container.scrollTop -= 160;
      await expect.poll(() => mounted.harness.controls.isUserScrollDetached).toBe(true);
      const scrollTopAfterDrag = container.scrollTop;
      pointerAt("pointerup", target, point);
      await growDuringFrames(mounted, 3);
      expect(Math.abs(container.scrollTop - scrollTopAfterDrag)).toBeLessThanOrEqual(1);
    } finally {
      await mounted.unmount();
      scrollbarStyle.remove();
    }
  });

  it("releases follow and holds the trigger when a disclosure above the tail row opens", async () => {
    const mounted = await mountFollowing();
    try {
      const { container } = mounted;
      const toggle = disclosureAboveTailRow(container);
      const containerBottom = container.getBoundingClientRect().bottom;
      expect(containerBottom - toggle.getBoundingClientRect().top).toBeGreaterThan(100);
      const topBefore = toggle.getBoundingClientRect().top;
      const point = centerOf(toggle);
      pointerAt("pointerdown", toggle, point);
      pointerAt("pointerup", toggle, point);
      toggle.click();
      await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("true");
      await settleFrames(4);
      expect(mounted.harness.controls.isUserScrollDetached).toBe(true);
      expect(toggle.isConnected).toBe(true);
      expect(Math.abs(toggle.getBoundingClientRect().top - topBefore)).toBeLessThanOrEqual(1);
      const scrollTopAfterOpen = container.scrollTop;
      await growDuringFrames(mounted, 2);
      expect(Math.abs(container.scrollTop - scrollTopAfterOpen)).toBeLessThanOrEqual(1);
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps follow when the disclosure in the tail row opens", async () => {
    const mounted = await mountFollowing("command");
    try {
      const { container } = mounted;
      const toggle = tailRowDisclosure();
      const point = centerOf(toggle);
      const heightBefore = container.scrollHeight;
      pointerAt("pointerdown", toggle, point);
      pointerAt("pointerup", toggle, point);
      toggle.click();
      await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("true");
      await expect.poll(() => container.scrollHeight).toBeGreaterThan(heightBefore);
      await settleFrames(4);
      expect(mounted.harness.controls.isUserScrollDetached).toBe(false);
      expect(distanceFromBottomPx(container)).toBeLessThanOrEqual(BOTTOM_SLACK_PX);
    } finally {
      await mounted.unmount();
    }
  });

  it("does not rearm a detached reader on click", async () => {
    const mounted = await mountFollowing();
    try {
      const { container } = mounted;
      container.scrollTop -= 200;
      mounted.harness.controls.onTranscriptNavigate();
      await settleFrames(3);
      expect(mounted.harness.controls.isUserScrollDetached).toBe(true);
      const scrollTopDetached = container.scrollTop;
      const viewport = container.getBoundingClientRect();
      const target = [...container.querySelectorAll<HTMLElement>("[data-message-id] p")].find(
        (paragraph) => {
          const rect = paragraph.getBoundingClientRect();
          return rect.top > viewport.top && rect.bottom < viewport.bottom;
        },
      )!;
      const point = centerOf(target);
      pointerAt("pointerdown", target, point);
      pointerAt("pointerup", target, point);
      target.click();
      await growDuringFrames(mounted, 3);
      expect(mounted.harness.controls.isUserScrollDetached).toBe(true);
      expect(Math.abs(container.scrollTop - scrollTopDetached)).toBeLessThanOrEqual(1);
    } finally {
      await mounted.unmount();
    }
  });
});

function touchTranscriptDom(container: HTMLElement): void {
  const marker = document.createElement("span");
  container.querySelector("[data-timeline-row-kind]")?.append(marker);
  marker.remove();
}

function wheelUp(container: HTMLElement): void {
  container.dispatchEvent(
    new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120 }),
  );
}

describe("transcript layout moves while following", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  for (const tail of ["command", "assistant"] as const) {
    it(`restores the end after a layout-driven upward move (${tail} tail)`, async () => {
      const mounted = await mountFollowing(tail);
      try {
        const { container } = mounted;
        touchTranscriptDom(container);
        container.scrollTop -= 132;
        await settleFrames(2);
        expect(distanceFromBottomPx(container)).toBeLessThanOrEqual(BOTTOM_SLACK_PX + 1);
        expect(mounted.harness.controls.isUserScrollDetached).toBe(false);
        await settleFrames(12);
        expect(mounted.harness.controls.showScrollToBottom).toBe(false);
        expect(distanceFromBottomPx(container)).toBeLessThanOrEqual(BOTTOM_SLACK_PX + 1);
      } finally {
        await mounted.unmount();
      }
    });
  }

  it("lets a wheel-up during a layout change release follow", async () => {
    const mounted = await mountFollowing("command");
    try {
      const { container } = mounted;
      touchTranscriptDom(container);
      wheelUp(container);
      container.scrollTop -= 132;
      await settleFrames(4);
      expect(mounted.harness.controls.isUserScrollDetached).toBe(true);
      expect(distanceFromBottomPx(container)).toBeGreaterThan(100);
    } finally {
      await mounted.unmount();
    }
  });

  it("does not pull a detached reader back when the layout changes", async () => {
    const mounted = await mountFollowing("command");
    try {
      const { container } = mounted;
      container.scrollTop -= 200;
      mounted.harness.controls.onTranscriptNavigate();
      await settleFrames(3);
      expect(mounted.harness.controls.isUserScrollDetached).toBe(true);
      const scrollTopDetached = container.scrollTop;
      touchTranscriptDom(container);
      container.scrollTop -= 40;
      await settleFrames(4);
      expect(mounted.harness.controls.isUserScrollDetached).toBe(true);
      expect(Math.abs(container.scrollTop - (scrollTopDetached - 40))).toBeLessThanOrEqual(1);
    } finally {
      await mounted.unmount();
    }
  });
});
