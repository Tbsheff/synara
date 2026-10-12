import "../../index.css";

import { MessageId, TurnId } from "@synara/contracts";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cdp } from "vitest/browser";
import { render } from "vitest-browser-react";

import { resolveTranscriptLiveTurn } from "../ChatView.logic";
import { MessagesTimeline } from "./MessagesTimeline";
import type { TimelineEntry } from "../../session-logic";

const VIEWPORT_HEIGHT_PX = 900;
const TURN_ID = TurnId.makeUnsafe("turn-smooth");

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function userEntry(id: string, text: string, createdAt: string): TimelineEntry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt,
    message: {
      id: MessageId.makeUnsafe(id),
      role: "user",
      text,
      createdAt,
      streaming: false,
    },
  };
}

function assistantEntry(
  id: string,
  text: string,
  createdAt: string,
  options: { streaming: boolean; completedAt?: string },
): TimelineEntry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt,
    message: {
      id: MessageId.makeUnsafe(id),
      role: "assistant",
      text,
      createdAt,
      streaming: options.streaming,
      turnId: TURN_ID,
      ...(options.completedAt ? { completedAt: options.completedAt } : {}),
    },
  };
}

function commandEntry(id: string, command: string, createdAt: string): TimelineEntry {
  return {
    id: `entry-${id}`,
    kind: "work",
    createdAt,
    entry: {
      id,
      createdAt,
      label: "Ran command",
      tone: "tool",
      itemType: "command_execution",
      toolStatus: "completed",
      command,
      turnId: TURN_ID,
    },
  };
}

interface HarnessState {
  entries: TimelineEntry[];
  isWorking: boolean;
  settleGraceActive: boolean;
  activeWorkStartedAt: string | null;
  latestTurnStartedAt: string | null;
  activeTurnId: TurnId | null;
  workingLabel: string | undefined;
}

interface HarnessHandle {
  set: (mutate: (current: HarnessState) => HarnessState) => void;
}

function SmoothTimeline(props: {
  initial: HarnessState;
  handleRef: { current: HarnessHandle | null };
}) {
  const [state, setState] = useState(props.initial);
  props.handleRef.current = { set: setState };
  const liveTurn = resolveTranscriptLiveTurn({
    isWorking: state.isWorking,
    settleGraceActive: state.settleGraceActive,
    activeWorkStartedAt: state.activeWorkStartedAt,
    latestTurnStartedAt: state.latestTurnStartedAt,
  });
  return (
    <div style={{ height: VIEWPORT_HEIGHT_PX, width: "100%" }}>
      <MessagesTimeline
        hasMessages
        isWorking={liveTurn.showsLiveTurn}
        workingLabel={state.workingLabel}
        activeTurnInProgress={state.isWorking || state.settleGraceActive}
        activeTurnStartedAt={liveTurn.turnStartedAt}
        activeTurnId={state.activeTurnId}
        timelineEntries={state.entries}
        turnDiffSummaryByAssistantMessageId={new Map()}
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

function createHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.style.cssText = `display:block;width:640px;height:${VIEWPORT_HEIGHT_PX}px;overflow:hidden;`;
  document.body.append(host);
  return host;
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function frames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await nextFrame();
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function logMetric(name: string, value: unknown): void {
  console.log(`SMOOTH_METRIC ${JSON.stringify({ name, value })}`);
}

function startFrameSampler<T>(sample: () => T): { stop: () => Array<{ t: number; value: T }> } {
  const samples: Array<{ t: number; value: T }> = [];
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;";
  document.body.append(probe);
  const observer = new ResizeObserver(() => {
    samples.push({ t: performance.now(), value: sample() });
  });
  observer.observe(probe);
  let running = true;
  let size = 1;
  const tick = () => {
    if (!running) return;
    size = size === 1 ? 2 : 1;
    probe.style.width = `${size}px`;
    window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
  return {
    stop: () => {
      running = false;
      observer.disconnect();
      probe.remove();
      return samples;
    },
  };
}

const TURN_HEADER_TEXT = /^Work(ing|ed)( for .+)?$/;

function findTurnHeaderLabel(): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>(
    "[data-timeline-row-kind] div, [data-timeline-row-kind] span, [data-timeline-row-kind] button",
  );
  for (const candidate of candidates) {
    if (candidate.closest('[data-settled-turn-collapse-transition="true"]')) continue;
    const text = candidate.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (!TURN_HEADER_TEXT.test(text)) continue;
    if (candidate.querySelector("div, span, button") && candidate.tagName !== "BUTTON") {
      const child = [...candidate.children].find((element) =>
        TURN_HEADER_TEXT.test(element.textContent?.replace(/\s+/g, " ").trim() ?? ""),
      );
      if (child) continue;
    }
    const rect = candidate.getBoundingClientRect();
    if (rect.height > 0) return candidate;
  }
  return null;
}

function workingStatusText(): string | null {
  const row = document.querySelector<HTMLElement>('[data-timeline-row-kind="working"]');
  if (!row) return null;
  const current = row.querySelector<HTMLElement>('[data-working-label-current="true"]');
  return (current ?? row).textContent?.trim() ?? null;
}

function liveTurnEntries(input: { sentAt: string; finalStreaming: boolean; completedAt?: string }) {
  return [
    userEntry("user-1", "Please refactor the reducer.", input.sentAt),
    commandEntry("cmd-1", "bun run lint", input.sentAt),
    assistantEntry("preamble-1", "Looking at the reducer first.", input.sentAt, {
      streaming: false,
      completedAt: input.sentAt,
    }),
    commandEntry("cmd-2", "bun run typecheck", input.sentAt),
    commandEntry("cmd-3", "git diff --stat", input.sentAt),
    assistantEntry(
      "final-1",
      "Done. The reducer now handles every case and the tests pass.",
      input.sentAt,
      input.completedAt
        ? { streaming: input.finalStreaming, completedAt: input.completedAt }
        : { streaming: input.finalStreaming },
    ),
  ];
}

type FadeSample = { top: number; height: number; opacity: number; fading: boolean };

function sampleFade(selector: string): () => FadeSample | null {
  return () => {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      top: Math.round(rect.top),
      height: Math.round(rect.height),
      opacity: Number(getComputedStyle(element).opacity),
      fading: element.classList.contains("chat-fade-enter"),
    };
  };
}

function summarizeFade(samples: Array<{ value: FadeSample | null }>) {
  const painted = samples.flatMap((sample) => (sample.value ? [sample.value] : []));
  return {
    fadedFrames: painted.filter((sample) => sample.fading).length,
    minOpacity: Math.min(...painted.map((sample) => sample.opacity)),
    firstOpacity: painted[0]?.opacity ?? null,
    lastOpacity: painted.at(-1)?.opacity ?? null,
    boxes: [...new Set(painted.map((sample) => `${sample.top}:${sample.height}`))],
  };
}

describe("MessagesTimeline smooth streaming", () => {
  afterEach(async () => {
    const protocol = cdp() as {
      send(method: string, params: Record<string, unknown>): Promise<void>;
    };
    await protocol.send("Emulation.setEmulatedMedia", { features: [] });
    document.body.innerHTML = "";
  });

  it("keeps one turn header in place and moves the answer one way while the turn settles", async () => {
    const sentAt = isoAgo(4_400);
    const turnStartedAt = isoAgo(4_000);
    const handleRef: { current: HarnessHandle | null } = { current: null };
    const host = createHost();
    const screen = await render(
      <SmoothTimeline
        handleRef={handleRef}
        initial={{
          entries: liveTurnEntries({ sentAt, finalStreaming: true }),
          isWorking: true,
          settleGraceActive: false,
          activeWorkStartedAt: turnStartedAt,
          latestTurnStartedAt: turnStartedAt,
          activeTurnId: TURN_ID,
          workingLabel: undefined,
        }}
      />,
      { container: host },
    );

    try {
      await expect.poll(() => findTurnHeaderLabel() !== null).toBe(true);
      await frames(20);

      const layoutShifts: number[] = [];
      const shiftObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          layoutShifts.push((entry as PerformanceEntry & { value: number }).value);
        }
      });
      shiftObserver.observe({ type: "layout-shift", buffered: false });

      const sampler = startFrameSampler(() => {
        const header = findTurnHeaderLabel();
        const answer = document.querySelector<HTMLElement>('[data-assistant-message-id="final-1"]');
        return {
          headerTop: header ? Math.round(header.getBoundingClientRect().top) : null,
          headerText: header?.textContent?.replace(/\s+/g, " ").trim() ?? null,
          answerTop: answer ? Math.round(answer.getBoundingClientRect().top) : null,
        };
      });
      await frames(4);

      const completedAt = new Date().toISOString();
      handleRef.current!.set((current) => ({
        ...current,
        entries: liveTurnEntries({ sentAt, finalStreaming: false, completedAt }),
        isWorking: false,
        settleGraceActive: true,
        activeWorkStartedAt: null,
      }));
      await wait(180);
      handleRef.current!.set((current) => ({
        ...current,
        settleGraceActive: false,
        activeTurnId: null,
      }));
      await wait(600);
      const samples = sampler.stop();
      shiftObserver.disconnect();

      const gapFrames = samples.filter((sample) => sample.value.headerTop === null).length;
      const headerTops = samples.flatMap((sample) =>
        sample.value.headerTop === null ? [] : [sample.value.headerTop],
      );
      const headerDrift = Math.max(...headerTops) - Math.min(...headerTops);
      const answerTops = samples.flatMap((sample) =>
        sample.value.answerTop === null ? [] : [sample.value.answerTop],
      );
      let reversals = 0;
      let direction = 0;
      for (let index = 1; index < answerTops.length; index += 1) {
        const delta = answerTops[index]! - answerTops[index - 1]!;
        if (Math.abs(delta) <= 1) continue;
        const step = Math.sign(delta);
        if (direction !== 0 && step !== direction) reversals += 1;
        direction = step;
      }
      const answerUpward = answerTops.length > 1 ? answerTops[0]! - answerTops.at(-1)! : 0;
      const largestAnswerStep = answerTops.reduce(
        (largest, top, index) =>
          index === 0 ? largest : Math.max(largest, Math.abs(top - answerTops[index - 1]!)),
        0,
      );
      const headerTexts = [...new Set(samples.map((sample) => sample.value.headerText))];
      const layoutShiftSum = layoutShifts.reduce((sum, value) => sum + value, 0);
      logMetric("settle", {
        frames: samples.length,
        gapFrames,
        headerDrift,
        reversals,
        answerUpward,
        largestAnswerStep,
        headerTexts,
        layoutShiftSum,
        answerTops,
      });

      expect(gapFrames).toBe(0);
      expect(headerDrift).toBeLessThanOrEqual(1);
      expect(reversals).toBe(0);
      expect(largestAnswerStep).toBeLessThan(30);
      expect(headerTexts.at(-1)).toMatch(/^Worked for /);
      await expect
        .poll(() => document.querySelector("[data-settled-turn-collapse-transition='true']"), {
          timeout: 2_000,
        })
        .toBeNull();
      expect(
        document.querySelector('[data-assistant-message-id="final-1"]')?.textContent,
      ).toContain("Done. The reducer");
    } finally {
      await screen.unmount();
    }
  });

  it("shows the turn header from send, before the turn has a start time", async () => {
    const handleRef: { current: HarnessHandle | null } = { current: null };
    const host = createHost();
    const screen = await render(
      <SmoothTimeline
        handleRef={handleRef}
        initial={{
          entries: [userEntry("user-1", "Hello there.", new Date().toISOString())],
          isWorking: true,
          settleGraceActive: false,
          activeWorkStartedAt: null,
          latestTurnStartedAt: null,
          activeTurnId: null,
          workingLabel: undefined,
        }}
      />,
      { container: host },
    );

    try {
      await expect.poll(() => findTurnHeaderLabel()?.textContent?.trim() ?? null).toBe("Working");
      logMetric("header-from-send", { text: findTurnHeaderLabel()?.textContent?.trim() });
    } finally {
      await screen.unmount();
    }
  });

  it("counts with tabular digits and hands off to the same settled number", async () => {
    const sentAt = isoAgo(8_600);
    const handleRef: { current: HarnessHandle | null } = { current: null };
    const host = createHost();
    const screen = await render(
      <SmoothTimeline
        handleRef={handleRef}
        initial={{
          entries: liveTurnEntries({ sentAt, finalStreaming: true }),
          isWorking: true,
          settleGraceActive: false,
          activeWorkStartedAt: isoAgo(8_100),
          latestTurnStartedAt: isoAgo(8_100),
          activeTurnId: TURN_ID,
          workingLabel: undefined,
        }}
      />,
      { container: host },
    );

    try {
      await expect
        .poll(() => findTurnHeaderLabel()?.textContent ?? "")
        .toMatch(/^Working for \d+s$/);
      const header = findTurnHeaderLabel()!;
      const numericStyle = getComputedStyle(header).fontVariantNumeric;

      const sampler = startFrameSampler(() => {
        const label = findTurnHeaderLabel();
        return {
          text: label?.textContent?.replace(/\s+/g, " ").trim() ?? "",
          width: label
            ? Math.round(
                (() => {
                  const range = document.createRange();
                  range.selectNodeContents(label);
                  return range.getBoundingClientRect().width;
                })() * 10,
              ) / 10
            : 0,
        };
      });
      await wait(2_300);
      const samples = sampler.stop();

      const changes: Array<{ t: number; text: string; width: number }> = [];
      for (let index = 1; index < samples.length; index += 1) {
        if (samples[index]!.value.text !== samples[index - 1]!.value.text) {
          changes.push({ t: Math.round(samples[index]!.t), ...samples[index]!.value });
        }
      }
      const widthBySameLength = new Map<number, Set<number>>();
      for (const sample of samples) {
        const set = widthBySameLength.get(sample.value.text.length) ?? new Set<number>();
        set.add(sample.value.width);
        widthBySameLength.set(sample.value.text.length, set);
      }
      const widthJitterAtSameLength = Math.max(
        ...[...widthBySameLength.values()].map((set) => Math.max(...set) - Math.min(...set)),
      );
      const liveText = samples.at(-1)!.value.text;

      const completedAt = new Date().toISOString();
      handleRef.current!.set((current) => ({
        ...current,
        entries: liveTurnEntries({ sentAt, finalStreaming: false, completedAt }),
        isWorking: false,
        settleGraceActive: true,
        activeWorkStartedAt: null,
      }));
      await wait(180);
      handleRef.current!.set((current) => ({
        ...current,
        settleGraceActive: false,
        activeTurnId: null,
      }));
      await expect.poll(() => findTurnHeaderLabel()?.textContent ?? "").toMatch(/^Worked for /);
      const settledText = findTurnHeaderLabel()!.textContent!.replace(/\s+/g, " ").trim();

      logMetric("timer", {
        numericStyle,
        changes,
        widthJitterAtSameLength,
        liveText,
        settledText,
      });

      expect(numericStyle).toContain("tabular-nums");
      expect(widthJitterAtSameLength).toBeLessThanOrEqual(0.5);
      expect(settledText.replace("Worked for", "")).toBe(liveText.replace("Working for", ""));
    } finally {
      await screen.unmount();
    }
  });

  it("holds each status label and never shrinks the status line during a turn", async () => {
    const handleRef: { current: HarnessHandle | null } = { current: null };
    const host = createHost();
    const screen = await render(
      <SmoothTimeline
        handleRef={handleRef}
        initial={{
          entries: [userEntry("user-1", "Investigate the flake.", isoAgo(2_000))],
          isWorking: true,
          settleGraceActive: false,
          activeWorkStartedAt: isoAgo(1_500),
          latestTurnStartedAt: isoAgo(1_500),
          activeTurnId: TURN_ID,
          workingLabel: "Thinking",
        }}
      />,
      { container: host },
    );
    const setLabel = (workingLabel: string) =>
      handleRef.current!.set((current) => ({ ...current, workingLabel }));

    try {
      await expect.poll(() => workingStatusText()).toBe("Thinking");
      await frames(10);
      const sampler = startFrameSampler(() => {
        const row = document.querySelector<HTMLElement>(
          '[data-timeline-row-kind="working"] .shimmer-group',
        );
        return {
          text: workingStatusText(),
          width: row ? Math.round(row.getBoundingClientRect().width) : 0,
        };
      });

      setLabel("Reading the test harness");
      await wait(100);
      setLabel("Tracing the retry path");
      await wait(100);
      setLabel("Inspecting the reducer state machine");
      await wait(900);
      setLabel("Thinking");
      await wait(1_200);
      setLabel("Run");
      await wait(900);
      const samples = sampler.stop();

      const runs: Array<{ text: string | null; ms: number }> = [];
      for (const sample of samples) {
        const last = runs.at(-1);
        if (last && last.text === sample.value.text) continue;
        runs.push({ text: sample.value.text, ms: sample.t });
      }
      const holds = runs.slice(0, -1).map((run, index) => ({
        text: run.text,
        ms: Math.round(runs[index + 1]!.ms - run.ms),
      }));
      let shrinkFrames = 0;
      for (let index = 1; index < samples.length; index += 1) {
        if (samples[index]!.value.width < samples[index - 1]!.value.width - 1) shrinkFrames += 1;
      }
      const totalMs = samples.at(-1)!.t - samples[0]!.t;
      const changesPerSecond = (runs.length - 1) / (totalMs / 1_000);
      logMetric("status-label", {
        runs: runs.map((run) => run.text),
        holds,
        shrinkFrames,
        changesPerSecond,
      });

      expect(runs.map((run) => run.text)).not.toContain("Tracing the retry path");
      expect(runs.slice(1).map((run) => run.text)).not.toContain("Thinking");
      expect(holds.slice(1).every((hold) => hold.ms >= 580)).toBe(true);
      expect(shrinkFrames).toBe(0);
    } finally {
      await screen.unmount();
    }
  });

  it("fades rows that arrive at the live tail without moving layout", async () => {
    const sentAt = isoAgo(3_000);
    const handleRef: { current: HarnessHandle | null } = { current: null };
    const host = createHost();
    const screen = await render(
      <SmoothTimeline
        handleRef={handleRef}
        initial={{
          entries: [userEntry("user-1", "Run the checks.", sentAt)],
          isWorking: true,
          settleGraceActive: false,
          activeWorkStartedAt: sentAt,
          latestTurnStartedAt: sentAt,
          activeTurnId: TURN_ID,
          workingLabel: undefined,
        }}
      />,
      { container: host },
    );
    try {
      await expect
        .poll(() => document.querySelectorAll("[data-timeline-row-kind]").length)
        .toBeGreaterThan(1);
      await wait(300);
      const initialFaded = document.querySelectorAll(".chat-fade-enter").length;

      const toolSampler = startFrameSampler(
        sampleFade('[data-timeline-row-kind="work"]:has([data-work-entry-display-text])'),
      );
      handleRef.current!.set((current) => ({
        ...current,
        entries: [...current.entries, commandEntry("cmd-1", "bun run lint", sentAt)],
      }));
      await wait(400);
      const toolRow = summarizeFade(toolSampler.stop());

      const textSampler = startFrameSampler(sampleFade('[data-assistant-message-id="streamed-1"]'));
      handleRef.current!.set((current) => ({
        ...current,
        entries: [
          ...current.entries,
          assistantEntry("streamed-1", "First streamed words.", sentAt, { streaming: true }),
        ],
      }));
      await wait(400);
      const mergedText = summarizeFade(textSampler.stop());
      logMetric("row-fade", { initialFaded, toolRow, mergedText });

      expect(initialFaded).toBe(0);
      for (const fade of [toolRow, mergedText]) {
        expect(fade.fadedFrames).toBeGreaterThan(0);
        expect(fade.firstOpacity).toBeLessThan(0.5);
        expect(fade.lastOpacity).toBe(1);
        expect(fade.boxes).toHaveLength(1);
      }

      const protocol = cdp() as {
        send(method: string, params: Record<string, unknown>): Promise<void>;
      };
      await protocol.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
      handleRef.current!.set((current) => ({
        ...current,
        entries: [...current.entries, commandEntry("cmd-3", "git diff --stat", sentAt)],
      }));
      await expect
        .poll(() => document.querySelectorAll(".chat-fade-enter").length)
        .toBeGreaterThan(0);
      const reducedAnimating = [...document.querySelectorAll<HTMLElement>(".chat-fade-enter")]
        .flatMap((element) => element.getAnimations())
        .filter(
          (animation) => (animation as CSSAnimation).animationName === "chat-fade-enter",
        ).length;
      logMetric("row-fade-reduced-motion", { reducedAnimating });
      expect(reducedAnimating).toBe(0);
    } finally {
      await screen.unmount();
    }
  });

  it("does not fade rows on initial load", async () => {
    const sentAt = isoAgo(3_000);
    const handleRef: { current: HarnessHandle | null } = { current: null };
    const host = createHost();
    const screen = await render(
      <SmoothTimeline
        handleRef={handleRef}
        initial={{
          entries: liveTurnEntries({ sentAt, finalStreaming: true }),
          isWorking: true,
          settleGraceActive: false,
          activeWorkStartedAt: sentAt,
          latestTurnStartedAt: sentAt,
          activeTurnId: TURN_ID,
          workingLabel: undefined,
        }}
      />,
      { container: host },
    );
    try {
      await expect
        .poll(() => document.querySelectorAll("[data-timeline-row-kind]").length)
        .toBeGreaterThan(3);
      await frames(5);
      expect(document.querySelectorAll(".chat-fade-enter").length).toBe(0);
    } finally {
      await screen.unmount();
    }
  });
});
