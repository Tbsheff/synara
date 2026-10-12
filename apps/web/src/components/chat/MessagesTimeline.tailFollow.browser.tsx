import "../../index.css";

import { MessageId, TurnId } from "@synara/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import type { deriveTimelineEntries } from "../../session-logic";
import type { WorkLogEntry } from "../../workLog";
import { MessagesTimeline } from "./MessagesTimeline";

type TimelineEntries = ReturnType<typeof deriveTimelineEntries>;

const VIEWPORT_HEIGHT_PX = 420;
const BOTTOM_INSET_PX = 64;
const GAP_SLACK_PX = 1;
const CREATED_AT = "2026-10-09T20:04:14.000Z";
const TURN_ID = "turn-follow";
const STREAM_ID = "streaming-assistant";

function messageEntry(
  id: string,
  role: "user" | "assistant",
  text: string,
  streaming = false,
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
      streaming,
      turnId: TurnId.makeUnsafe(id.startsWith("seed") ? `turn-${id}` : TURN_ID),
    },
  };
}

function commandEntry(index: number): TimelineEntries[number] {
  const entry: WorkLogEntry = {
    id: `command-${index}`,
    createdAt: CREATED_AT,
    turnId: TurnId.makeUnsafe(TURN_ID),
    label: "Ran command",
    tone: "tool",
    itemType: "command_execution",
    activityKind: "tool.completed",
    toolCallId: `command-item-${index}`,
    toolStatus: "completed",
    command: `echo step ${index}`,
    commandExecution: { command: `echo step ${index}`, exitCode: 0, output: "done" },
  };
  return { id: `entry-command-${index}`, kind: "work", createdAt: CREATED_AT, entry };
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
  entries.push(messageEntry("live-user", "user", "Explain the change."));
  entries.push(messageEntry(STREAM_ID, "assistant", "Starting.", true));
  return entries;
}

interface Harness {
  listRef: React.RefObject<LegendListRef | null>;
  appendStreamText: (text: string) => void;
  appendCommandRow: () => void;
}

function FollowTimeline({ harnessRef }: { harnessRef: { current: Harness | null } }) {
  const listRef = useRef<LegendListRef | null>(null);
  const [entries, setEntries] = useState<TimelineEntries>(seedEntries);

  harnessRef.current = {
    listRef,
    appendStreamText: (text) => {
      setEntries((current) =>
        current.map((entry) =>
          entry.kind === "message" && entry.message.id === STREAM_ID
            ? messageEntry(STREAM_ID, "assistant", `${entry.message.text}${text}`, true)
            : entry,
        ),
      );
    },
    appendCommandRow: () => {
      setEntries((current) => [...current, commandEntry(current.length)]);
    },
  };

  return (
    <div style={{ height: VIEWPORT_HEIGHT_PX }}>
      <MessagesTimeline
        threadId="thread-follow"
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        listRef={listRef}
        followLiveOutput
        contentInsetBottomPx={BOTTOM_INSET_PX}
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

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

async function settleFrames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await nextFrame();
}

function tailRowBottomPx(container: HTMLElement): number {
  let bottom = Number.NEGATIVE_INFINITY;
  for (const row of container.querySelectorAll<HTMLElement>("[data-timeline-row-kind]")) {
    const rect = row.getBoundingClientRect();
    if (rect.height > 0 && rect.top > -100_000) bottom = Math.max(bottom, rect.bottom);
  }
  return bottom;
}

interface FrameSample {
  frame: number;
  phase: string;
  gapPx: number;
  tailShiftPx: number;
  scrollWrites: number;
  sameFrameFollowWrites: number;
  scrollHeight: number;
  scrollTop: number;
  contentHeight: string;
}

interface FrameProbe {
  samples: FrameSample[];
  setPhase: (phase: string) => void;
  stop: () => void;
}

function startFrameProbe(container: HTMLElement): FrameProbe {
  const samples: FrameSample[] = [];
  let phase = "idle";
  let frame = 0;
  let writes = 0;
  let sameFrameFollowWrites = 0;
  const countWrite = () => {
    writes += 1;
    if (new Error().stack?.includes("useTimelineRowOverlapGuard")) sameFrameFollowWrites += 1;
  };
  const proto = Object.getPrototypeOf(container) as object;
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
  Object.defineProperty(container, "scrollTop", {
    configurable: true,
    get() {
      return descriptor.get!.call(this);
    },
    set(value: number) {
      countWrite();
      descriptor.set!.call(this, value);
    },
  });
  const nativeScrollTo = container.scrollTo.bind(container);
  container.scrollTo = ((options?: ScrollToOptions) => {
    countWrite();
    nativeScrollTo(options);
  }) as HTMLElement["scrollTo"];
  const viewportBottom = () =>
    container.getBoundingClientRect().bottom -
    Number.parseFloat(getComputedStyle(container).paddingBottom);
  const restingTailOffset = viewportBottom() - tailRowBottomPx(container);

  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;";
  document.body.append(probe);
  const observer = new ResizeObserver(() => {
    samples.push({
      frame,
      phase,
      gapPx: container.scrollHeight - container.clientHeight - container.scrollTop,
      tailShiftPx: viewportBottom() - tailRowBottomPx(container) - restingTailOffset,
      scrollWrites: writes,
      sameFrameFollowWrites,
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
      contentHeight: (container.firstElementChild as HTMLElement | null)?.style.height ?? "",
    });
    writes = 0;
    sameFrameFollowWrites = 0;
  });
  observer.observe(probe);
  let running = true;
  const tick = () => {
    if (!running) return;
    frame += 1;
    probe.style.height = `${(frame % 2) + 1}px`;
    window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
  return {
    samples,
    setPhase: (next) => {
      phase = next;
    },
    stop: () => {
      running = false;
      observer.disconnect();
      probe.remove();
      delete (container as { scrollTop?: number }).scrollTop;
      container.scrollTo = (proto as HTMLElement).scrollTo.bind(container);
    },
  };
}

function printFrameLog(name: string, samples: readonly FrameSample[]): void {
  console.log(`[frame-log:${name}]\n${samples.map((sample) => JSON.stringify(sample)).join("\n")}`);
}

function summarize(samples: readonly FrameSample[]) {
  const lagging = samples.filter(
    (sample) => sample.gapPx > GAP_SLACK_PX || Math.abs(sample.tailShiftPx) > GAP_SLACK_PX,
  );
  return {
    frames: samples.length,
    laggingFrames: lagging.length,
    maxGapPx: Math.max(0, ...samples.map((sample) => sample.gapPx)),
    maxTailShiftPx: Math.max(0, ...samples.map((sample) => Math.abs(sample.tailShiftPx))),
    maxWritesPerFrame: Math.max(0, ...samples.map((sample) => sample.scrollWrites)),
    maxSameFrameFollowWritesPerFrame: Math.max(
      0,
      ...samples.map((sample) => sample.sameFrameFollowWrites),
    ),
  };
}

async function mountAtBottom(harnessRef: { current: Harness | null }): Promise<Harness> {
  await expect.poll(() => harnessRef.current?.listRef.current != null).toBe(true);
  const harness = harnessRef.current!;
  await settleFrames(3);
  void harness.listRef.current?.scrollToEnd?.({ animated: false });
  await expect
    .poll(() => {
      const container = scrollContainer(harness);
      return container.scrollHeight - container.clientHeight - container.scrollTop;
    })
    .toBeLessThanOrEqual(GAP_SLACK_PX);
  await settleFrames(10);
  return harness;
}

describe("MessagesTimeline same-frame tail follow", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps a following reader at the bottom on every painted frame while text streams", async () => {
    const harnessRef: { current: Harness | null } = { current: null };
    const screen = await render(<FollowTimeline harnessRef={harnessRef} />);
    try {
      const harness = await mountAtBottom(harnessRef);
      const container = scrollContainer(harness);
      const probe = startFrameProbe(container);
      await settleFrames(2);

      probe.setPhase("words");
      for (let frame = 0; frame < 120; frame += 1) {
        harness.appendStreamText(frame % 9 === 8 ? "\n\nNext paragraph begins " : "word by word ");
        await nextFrame();
      }

      probe.setPhase("small-growth");
      const streamRow = document.querySelector<HTMLElement>(`[data-message-id="${STREAM_ID}"]`);
      const grower = document.createElement("div");
      streamRow?.append(grower);
      for (let frame = 1; frame <= 25; frame += 1) {
        grower.style.height = `${frame * 3}px`;
        await nextFrame();
      }

      probe.setPhase("tool-rows");
      for (let frame = 0; frame < 40; frame += 1) {
        if (frame % 4 === 0) harness.appendCommandRow();
        await nextFrame();
      }
      await settleFrames(4);
      probe.stop();
      grower.remove();

      const samples = probe.samples.filter((sample) => sample.phase !== "idle");
      printFrameLog("stream-follow", samples);
      const summary = summarize(samples);
      console.log(`[tail-follow] ${JSON.stringify(summary)}`);
      expect(samples.length).toBeGreaterThan(150);
      expect(summary.maxSameFrameFollowWritesPerFrame).toBeLessThanOrEqual(1);
      expect(
        samples.filter((sample) => sample.gapPx > GAP_SLACK_PX),
        "frames painted with a gap below the tail",
      ).toEqual([]);
      expect(
        samples.filter((sample) => Math.abs(sample.tailShiftPx) > GAP_SLACK_PX),
        "frames painted with the tail row off its resting line",
      ).toEqual([]);
    } finally {
      await screen.unmount();
    }
  });

  it("undoes a same-frame layout clamp before paint while following", async () => {
    const harnessRef: { current: Harness | null } = { current: null };
    const screen = await render(<FollowTimeline harnessRef={harnessRef} />);
    try {
      const harness = await mountAtBottom(harnessRef);
      const container = scrollContainer(harness);
      const streamRow = document.querySelector<HTMLElement>(`[data-message-id="${STREAM_ID}"]`);
      let block = document.createElement("pre");
      block.style.cssText = "margin:0;height:240px;";
      streamRow?.append(block);
      await settleFrames(4);
      void harness.listRef.current?.scrollToEnd?.({ animated: false });
      await settleFrames(6);
      const probe = startFrameProbe(container);
      await settleFrames(2);

      probe.setPhase("turn-end-rows-remount-shorter");
      for (let step = 0; step < 6; step += 1) {
        const height = Number.parseFloat(block.style.height);
        block.style.height = `${height - 150}px`;
        void container.scrollHeight;
        block.style.height = `${height - 10}px`;
        await settleFrames(3);
      }

      probe.setPhase("highlight-pass-swaps-pre");
      for (let step = 0; step < 8; step += 1) {
        const height = Number.parseFloat(block.style.height);
        const next = document.createElement("pre");
        next.style.cssText = `margin:0;height:${height + (step % 2 === 0 ? -6 : 24)}px;`;
        block.remove();
        void container.scrollHeight;
        streamRow?.append(next);
        block = next;
        await settleFrames(2);
      }

      probe.setPhase("whole-code-block-in-one-chunk");
      block.style.height = `${Number.parseFloat(block.style.height) + 320}px`;
      await settleFrames(6);

      probe.stop();
      block.remove();

      const samples = probe.samples.filter((sample) => sample.phase !== "idle");
      printFrameLog("layout-clamp", samples);
      const summary = summarize(samples);
      console.log(`[layout-clamp] ${JSON.stringify(summary)}`);
      expect(samples.length).toBeGreaterThan(30);
      expect(summary.maxTailShiftPx, "tail row moved off its resting line").toBeLessThanOrEqual(12);
      expect(summary.maxSameFrameFollowWritesPerFrame).toBeLessThanOrEqual(1);
      expect(
        samples.filter((sample) => sample.gapPx > GAP_SLACK_PX),
        "frames painted with a gap below the tail",
      ).toEqual([]);
    } finally {
      await screen.unmount();
    }
  });
});
