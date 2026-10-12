import "../../index.css";

import { MessageId, ThreadId, TurnId } from "@synara/contracts";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { resolveTranscriptLiveTurn } from "../ChatView.logic";
import type { ChatMessage, TurnDiffSummary } from "../../types";
import { deriveTimelineEntries, type WorkLogEntry } from "../../workLog";
import { MessagesTimeline } from "./MessagesTimeline";
import { ACTIVE_TURN_LAYOUT_SETTLE_DELAY_MS } from "../ChatView.logic";
import { createStreamedLayoutMemory, keepStreamedMessagesWhole } from "./useChatTimelineMessages";

const TURN_ID = TurnId.makeUnsafe("turn-rows");
const THREAD_ID = ThreadId.makeUnsafe("thread-rows");
const BASE_MS = Date.now() - 30_000;
const EASED_STEP_PX = 10;
const DEBUG_PHASES = new Set<string>();

function at(offsetMs: number): string {
  return new Date(BASE_MS + offsetMs).toISOString();
}

function userMessage(id: string, text: string, createdAt: string): ChatMessage {
  return {
    id: MessageId.makeUnsafe(id),
    role: "user",
    text,
    createdAt,
    streaming: false,
    ...(id.startsWith("seed") ? { turnId: TurnId.makeUnsafe(`turn-${id}`) } : {}),
  };
}

function assistantMessage(
  id: string,
  text: string,
  createdAt: string,
  options: { streaming: boolean; completedAt?: string; turnId?: TurnId },
): ChatMessage {
  return {
    id: MessageId.makeUnsafe(id),
    role: "assistant",
    text,
    createdAt,
    streaming: options.streaming,
    turnId: options.turnId ?? TURN_ID,
    ...(options.completedAt ? { completedAt: options.completedAt } : {}),
  };
}

function commandWork(
  id: string,
  command: string,
  createdAt: string,
  status: "inProgress" | "completed",
  live?: { startedAt: string; lastActivityAt: string },
): WorkLogEntry {
  return {
    id,
    createdAt,
    turnId: TURN_ID,
    label: status === "completed" ? "Ran command" : "Running command",
    tone: "tool",
    itemType: "command_execution",
    activityKind: status === "completed" ? "tool.completed" : "tool.started",
    toolCallId: `${id}-call`,
    toolStatus: status === "completed" ? "completed" : "running",
    command,
    ...(status === "completed"
      ? { commandExecution: { command, exitCode: 0, output: "ok" } }
      : {
          liveActivity: {
            state: "running_tool",
            label: `Running ${command}`,
            startedAt: live?.startedAt ?? createdAt,
            lastActivityAt: live?.lastActivityAt ?? createdAt,
          },
        }),
  };
}

function thinkingWork(id: string, label: string, createdAt: string): WorkLogEntry {
  return { id, createdAt, turnId: TURN_ID, label, tone: "thinking" };
}

interface TurnState {
  messages: ChatMessage[];
  work: WorkLogEntry[];
  isWorking: boolean;
  settleGraceActive: boolean;
  activeTurnId: TurnId | null;
  turnStartedAt: string | null;
  diffs: Map<MessageId, TurnDiffSummary>;
  tailAnchorMessageId: MessageId | null;
}

interface TurnHandle {
  set: (mutate: (current: TurnState) => TurnState) => void;
}

function TurnTimeline(props: {
  initial: TurnState;
  handleRef: { current: TurnHandle | null };
  heightPx: number;
  collapseFinishedTurns: boolean;
}) {
  const [state, setState] = useState(props.initial);
  const [layoutMemory] = useState(createStreamedLayoutMemory);
  props.handleRef.current = { set: setState };
  const liveTurn = resolveTranscriptLiveTurn({
    isWorking: state.isWorking,
    settleGraceActive: state.settleGraceActive,
    activeWorkStartedAt: state.isWorking ? state.turnStartedAt : null,
    latestTurnStartedAt: state.turnStartedAt,
  });
  return (
    <div style={{ height: props.heightPx, width: "100%" }}>
      <MessagesTimeline
        hasMessages
        followLiveOutput
        tailAnchorMessageId={state.tailAnchorMessageId}
        animateTailAnchorSlide={!state.messages.some((message) => message.streaming)}
        contentInsetBottomPx={64}
        collapseFinishedTurns={props.collapseFinishedTurns}
        isWorking={liveTurn.showsLiveTurn}
        workingLabel={undefined}
        activeTurnInProgress={state.isWorking || state.settleGraceActive}
        activeTurnStartedAt={liveTurn.turnStartedAt}
        activeTurnId={state.activeTurnId}
        timelineEntries={deriveTimelineEntries(
          keepStreamedMessagesWhole(state.messages, layoutMemory, THREAD_ID),
          [],
          state.work,
        )}
        turnDiffSummaryByAssistantMessageId={state.diffs}
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

function createHost(heightPx: number): HTMLDivElement {
  const host = document.createElement("div");
  host.style.cssText = `display:block;width:640px;height:${heightPx}px;overflow:hidden;`;
  document.body.append(host);
  return host;
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function logMetric(name: string, value: unknown): void {
  console.log(`ROW_STABILITY ${JSON.stringify({ name, value })}`);
}

type Anchor = { key: string; element: Element; top: number; bottom: number; height: number };

function isInFoldClone(element: Element): boolean {
  return element.closest('[data-settled-turn-collapse-transition="true"]') !== null;
}

function readAnchors(): Anchor[] {
  const anchors: Anchor[] = [];
  const seen = new Set<string>();
  const push = (key: string, element: Element | null) => {
    if (!element || seen.has(key) || isInFoldClone(element)) return;
    const rect = element.getBoundingClientRect();
    if (rect.height === 0) return;
    seen.add(key);
    anchors.push({ key, element, top: rect.top, bottom: rect.bottom, height: rect.height });
  };
  for (const row of document.querySelectorAll("[data-timeline-row-kind][data-message-id]")) {
    push(`row:${row.getAttribute("data-message-id")}`, row);
  }
  for (const answer of document.querySelectorAll("[data-assistant-message-id]")) {
    push(`answer-el:${answer.getAttribute("data-assistant-message-id")}`, answer);
  }
  for (const kind of ["working-header", "working"]) {
    push(`transient:${kind}`, document.querySelector(`[data-timeline-row-kind="${kind}"]`));
  }
  for (const doc of document.querySelectorAll("[data-chat-find-document-id]")) {
    if (doc.closest("[data-message-role='user']")) continue;
    push(
      `md:${doc.getAttribute("data-chat-find-document-id")}`,
      doc.querySelector(".chat-markdown"),
    );
  }
  for (const work of document.querySelectorAll("[data-work-entry-id]")) {
    push(`work:${work.getAttribute("data-work-entry-id")}`, work);
  }
  for (const summary of document.querySelectorAll("[data-tool-group-summary]")) {
    push(`group:${summary.textContent?.trim()}`, summary);
  }
  return anchors;
}

function outlineRows(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-timeline-row-kind]")].map((row) => {
    const rect = row.getBoundingClientRect();
    const text = (row.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 48);
    const answer = row.querySelector("[data-assistant-message-id]")?.getBoundingClientRect();
    const inner = answer
      ? ` above=${Math.round(answer.top - rect.top)} below=${Math.round(rect.bottom - answer.bottom)}`
      : "";
    return `${row.dataset.timelineRowKind}@${Math.round(rect.top)}+${Math.round(rect.height)}${inner} "${text}"`;
  });
}

function liveRegion(): { top: number; bottom: number } | null {
  const user = document.querySelector('[data-timeline-row-kind][data-message-id="user-1"]');
  if (!user) return null;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const row of document.querySelectorAll("[data-timeline-row-kind]")) {
    const rect = row.getBoundingClientRect();
    if (rect.height > 0) bottom = Math.max(bottom, rect.bottom);
  }
  return { top: user.getBoundingClientRect().bottom, bottom };
}

type Frame = {
  gap: number | null;
  scrollTop: number | null;
  t: number;
  anchors: Anchor[];
  folding: boolean;
  phase: string;
  region: { top: number; bottom: number } | null;
};

function startRecorder() {
  const frames: Frame[] = [];
  const outlines: Array<{ phase: string; rows: string[] }> = [];
  let phase = "start";
  const layoutShifts: Array<{ phase: string; value: number; sources: string[] }> = [];
  const shiftObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const shift = entry as PerformanceEntry & {
        value: number;
        sources?: Array<{
          node?: Node | null;
          previousRect: DOMRectReadOnly;
          currentRect: DOMRectReadOnly;
        }>;
      };
      layoutShifts.push({
        phase,
        value: shift.value,
        sources: (shift.sources ?? []).map((source) => {
          const node = source.node instanceof Element ? source.node : source.node?.parentElement;
          const label = node
            ? `${node.tagName.toLowerCase()}${node.getAttribute("data-timeline-row-kind") ? `[${node.getAttribute("data-timeline-row-kind")}]` : ""}.${(node.getAttribute("class") ?? "").split(" ").slice(0, 3).join(".")}`
            : "?";
          return `${label} ${Math.round(source.previousRect.top)}->${Math.round(source.currentRect.top)} h${Math.round(source.previousRect.height)}->${Math.round(source.currentRect.height)}`;
        }),
      });
    }
  });
  shiftObserver.observe({ type: "layout-shift", buffered: false });
  const scrollWrites: Array<{ phase: string; value: number; stack: string }> = [];
  const scroller = document.querySelector<HTMLElement>("[data-chat-scroll-container]");
  if (scroller) {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
    const record = (value: number) => {
      const stack = (new Error().stack ?? "")
        .split("\n")
        .slice(3, 7)
        .map((line) => line.trim().replace(/\(?https?:\/\/[^)]*\/([^/?)]+)(\?[^:)]*)?/, "($1"))
        .join(" < ");
      scrollWrites.push({ phase, value: Math.round(value), stack });
    };
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get() {
        return descriptor.get!.call(this);
      },
      set(value: number) {
        record(value);
        descriptor.set!.call(this, value);
      },
    });
    const nativeScrollTo = scroller.scrollTo.bind(scroller);
    scroller.scrollTo = ((options?: ScrollToOptions) => {
      record(options?.top ?? Number.NaN);
      nativeScrollTo(options);
    }) as HTMLElement["scrollTo"];
  }
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;";
  document.body.append(probe);
  let framesInPhase = 0;
  const observer = new ResizeObserver(() => {
    framesInPhase += 1;
    if (DEBUG_PHASES.has(phase) && framesInPhase <= 4) {
      outlines.push({ phase: `${phase}#${framesInPhase}`, rows: outlineRows() });
    }
    const scroller = document.querySelector<HTMLElement>("[data-chat-scroll-container]");
    frames.push({
      gap: scroller
        ? Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop)
        : null,
      scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
      t: performance.now(),
      anchors: readAnchors(),
      folding: document.querySelector('[data-settled-turn-collapse-transition="true"]') !== null,
      phase,
      region: liveRegion(),
    });
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
    setPhase: (next: string) => {
      outlines.push({ phase, rows: outlineRows() });
      phase = next;
      framesInPhase = 0;
    },
    stop: () => {
      running = false;
      observer.disconnect();
      shiftObserver.disconnect();
      probe.remove();
      outlines.push({ phase, rows: outlineRows() });
      if (scroller) delete (scroller as unknown as Record<string, unknown>).scrollTop;
      return { frames, layoutShifts, outlines, scrollWrites };
    },
  };
}

type Recording = ReturnType<ReturnType<typeof startRecorder>["stop"]>;
type Movement = { phase: string; key: string; delta: number };

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function maxAbs(list: ReadonlyArray<{ delta: number }>): number {
  return list.reduce((largest, step) => Math.max(largest, Math.abs(step.delta)), 0);
}

function analyze(recording: Recording, options: { streamKeyAt: (phase: string) => string | null }) {
  const steps: Movement[] = [];
  const remounts: Array<{ phase: string; key: string }> = [];
  const regionJumps: Array<{ phase: string; delta: number }> = [];
  const lastElementByKey = new Map<string, Element>();
  for (let index = 0; index < recording.frames.length; index += 1) {
    const frame = recording.frames[index]!;
    for (const anchor of frame.anchors) {
      const previousElement = lastElementByKey.get(anchor.key);
      if (previousElement && previousElement !== anchor.element) {
        remounts.push({ phase: frame.phase, key: anchor.key });
      }
      lastElementByKey.set(anchor.key, anchor.element);
    }
    if (index === 0) continue;
    const previous = recording.frames[index - 1]!;
    const previousByKey = new Map(previous.anchors.map((anchor) => [anchor.key, anchor]));
    const streamKey = options.streamKeyAt(frame.phase);
    const streamAnchor = streamKey
      ? frame.anchors.find((anchor) => anchor.key === streamKey)
      : undefined;
    for (const anchor of frame.anchors) {
      const before = previousByKey.get(anchor.key);
      if (!before || before.element !== anchor.element) continue;
      if (anchor.key.startsWith("row:")) continue;
      const isStream = anchor.key === streamKey;
      const isAbove = streamAnchor ? anchor.top < streamAnchor.top - 0.5 : false;
      if (!isStream && !isAbove) continue;
      const delta = roundTenth(anchor.top - before.top);
      if (Math.abs(delta) < 0.5) continue;
      steps.push({ phase: frame.phase, key: anchor.key, delta });
    }
    if (frame.region && previous.region) {
      const streamBefore = streamKey ? previousByKey.get(streamKey) : undefined;
      const streamGrowth =
        streamAnchor && streamBefore && streamBefore.element === streamAnchor.element
          ? streamAnchor.height - streamBefore.height
          : 0;
      const regionDelta = roundTenth(
        frame.region.bottom -
          frame.region.top -
          (previous.region.bottom - previous.region.top) -
          streamGrowth,
      );
      if (Math.abs(regionDelta) >= 1) regionJumps.push({ phase: frame.phase, delta: regionDelta });
    }
  }
  const clsByPhase: Record<string, number> = {};
  for (const shift of recording.layoutShifts) {
    clsByPhase[shift.phase] =
      roundTenth(((clsByPhase[shift.phase] ?? 0) + shift.value) * 1e3) / 1e3;
  }
  const jumpSteps = steps.filter((step) => Math.abs(step.delta) > EASED_STEP_PX);
  return {
    frames: recording.frames.length,
    maxStep: maxAbs(steps),
    jumpSteps,
    easedStepCount: steps.length - jumpSteps.length,
    remountCount: remounts.length,
    remounts,
    maxRegionJump: maxAbs(regionJumps),
    regionJumps: regionJumps.filter((jump) => Math.abs(jump.delta) > EASED_STEP_PX),
    cls:
      roundTenth(recording.layoutShifts.reduce((sum, shift) => sum + shift.value, 0) * 1e3) / 1e3,
    clsByPhase,
    topShifts: recording.layoutShifts
      .filter((shift) => shift.value >= 0.01)
      .map((shift) => ({
        phase: shift.phase,
        value: roundTenth(shift.value * 1e3) / 1e3,
        sources: shift.sources,
      })),
  };
}

function findSpikes(steps: ReadonlyArray<{ phase: string; delta: number }>) {
  return steps.filter((step, index) => {
    const magnitude = Math.abs(step.delta);
    const neighbor = Math.max(
      Math.abs(steps[index - 1]?.delta ?? 0),
      Math.abs(steps[index + 1]?.delta ?? 0),
    );
    return magnitude > EASED_STEP_PX && magnitude > neighbor * 2;
  });
}

function anchorTrack(recording: Recording, key: string, options: { skipStreamPhases: boolean }) {
  const samples = recording.frames.flatMap((frame) => {
    const anchor = frame.anchors.find((candidate) => candidate.key === key);
    return anchor
      ? [{ phase: frame.phase, folding: frame.folding, top: anchor.top, height: anchor.height }]
      : [];
  });
  const steps = samples.flatMap((sample, index) => {
    const previous = samples[index - 1];
    if (!previous) return [];
    if (options.skipStreamPhases && sample.phase.endsWith("stream")) return [];
    const delta = roundTenth(sample.top - previous.top);
    const growth = sample.height - previous.height;
    if (options.skipStreamPhases && growth >= 1 && Math.abs(delta + growth) <= 1) return [];
    return Math.abs(delta) >= 1 ? [{ phase: sample.phase, delta }] : [];
  });
  const maxStep = steps.reduce((max, step) => Math.max(max, Math.abs(step.delta)), 0);
  return {
    maxStep,
    jumps: steps.filter((step) => Math.abs(step.delta) > EASED_STEP_PX),
    spikes: findSpikes(steps),
    steps,
  };
}

const PREAMBLE_TEXT =
  "I will check the reducer and run the focused tests before changing anything.";
const ANSWER_TEXT = [
  "The reducer now handles every action and the failing case is covered.",
  "",
  "- `applyDelta` merges text segments in order.",
  "- `settleTurn` keeps the final answer stable.",
  "- The focused tests pass locally.",
  "",
  "I did not change the public API; the store shape is the same as before.",
].join("\n");

function chunks(text: string, count: number): string[] {
  const size = Math.ceil(text.length / count);
  const result: string[] = [];
  for (let end = size; end < text.length + size; end += size) {
    result.push(text.slice(0, Math.min(end, text.length)));
  }
  return result;
}

function replaceMessage(handle: TurnHandle, next: ChatMessage): void {
  handle.set((current) => {
    const exists = current.messages.some((message) => message.id === next.id);
    return {
      ...current,
      messages: exists
        ? current.messages.map((message) => (message.id === next.id ? next : message))
        : [...current.messages, next],
    };
  });
}

async function streamMessage(
  handle: TurnHandle,
  id: string,
  createdAt: string,
  text: string,
  steps: number,
  options?: { prefix?: string; extra?: Partial<ChatMessage>; between?: (step: number) => void },
): Promise<void> {
  let step = 0;
  for (const partial of chunks(text, steps)) {
    replaceMessage(handle, {
      ...assistantMessage(id, `${options?.prefix ?? ""}${partial}`, createdAt, { streaming: true }),
      ...options?.extra,
    });
    options?.between?.(step);
    step += 1;
    await wait(60);
  }
}

function completeMessage(handle: TurnHandle, id: string, completedAt: string): void {
  handle.set((current) => ({
    ...current,
    messages: current.messages.map((message) =>
      message.id === id ? { ...message, streaming: false, completedAt } : message,
    ),
  }));
}

function upsertWork(handle: TurnHandle, entry: WorkLogEntry): void {
  handle.set((current) => {
    const exists = current.work.some((work) => work.id === entry.id);
    return {
      ...current,
      work: exists
        ? current.work.map((work) => (work.id === entry.id ? entry : work))
        : [...current.work, entry],
    };
  });
}

function seedHistory(count: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let index = 0; index < count; index += 1) {
    messages.push(
      userMessage(`seed-user-${index}`, `Earlier question ${index}.`, at(-20_000 + index * 100)),
    );
    messages.push(
      assistantMessage(
        `seed-answer-${index}`,
        `Earlier answer ${index}. ${"Settled response text. ".repeat(10)}`,
        at(-20_000 + index * 100 + 50),
        {
          streaming: false,
          completedAt: at(-20_000 + index * 100 + 60),
          turnId: TurnId.makeUnsafe(`turn-seed-${index}`),
        },
      ),
    );
  }
  return messages;
}

const DIFF_SUMMARY: TurnDiffSummary = {
  turnId: TURN_ID,
  completedAt: at(6_000),
  files: [
    { path: "src/reducer.ts", kind: "modified", additions: 12, deletions: 3 },
    { path: "src/reducer.test.ts", kind: "modified", additions: 30, deletions: 0 },
  ],
  assistantMessageId: MessageId.makeUnsafe("answer-1"),
};

function setDiffSummary(handle: TurnHandle, messageId: string): void {
  handle.set((current) => ({
    ...current,
    diffs: new Map([
      [
        MessageId.makeUnsafe(messageId),
        { ...DIFF_SUMMARY, assistantMessageId: MessageId.makeUnsafe(messageId) },
      ],
    ]),
  }));
}

type Variant = {
  name: string;
  heightPx: number;
  history: number;
  diffTiming: "grace" | "after-fold" | "none";
  collapseFinishedTurns: boolean;
  anchoredSend?: boolean;
  answerRepeat?: number;
  noTools?: boolean;
};

async function mountTurn(variant: Variant) {
  const handleRef: { current: TurnHandle | null } = { current: null };
  const host = createHost(variant.heightPx);
  const screen = await render(
    <TurnTimeline
      handleRef={handleRef}
      heightPx={variant.heightPx}
      collapseFinishedTurns={variant.collapseFinishedTurns}
      initial={{
        messages: [
          ...seedHistory(variant.history),
          userMessage("user-1", "Fix the reducer and run the tests.", at(0)),
        ],
        work: [],
        isWorking: true,
        settleGraceActive: false,
        activeTurnId: TURN_ID,
        turnStartedAt: at(100),
        diffs: new Map(),
        tailAnchorMessageId: null,
      }}
    />,
    { container: host },
  );
  await expect
    .poll(() => document.querySelector('[data-timeline-row-kind="working"]'))
    .not.toBeNull();
  await wait(300);
  if (variant.anchoredSend) {
    handleRef.current!.set((current) => ({
      ...current,
      tailAnchorMessageId: MessageId.makeUnsafe("user-1"),
    }));
    await wait(900);
  }
  return { handle: () => handleRef.current!, screen };
}

async function settleTurn(
  handle: () => TurnHandle,
  recorder: ReturnType<typeof startRecorder>,
  options: { answerId: string; diffTiming: Variant["diffTiming"] },
): Promise<void> {
  recorder.setPhase("answer-complete");
  completeMessage(handle(), options.answerId, at(6_000));
  handle().set((current) => ({ ...current, isWorking: false, settleGraceActive: true }));
  if (options.diffTiming === "grace") setDiffSummary(handle(), options.answerId);
  await wait(ACTIVE_TURN_LAYOUT_SETTLE_DELAY_MS);
  recorder.setPhase("settle");
  handle().set((current) => ({ ...current, settleGraceActive: false, activeTurnId: null }));
  await wait(600);
  if (options.diffTiming === "after-fold") {
    recorder.setPhase("diff-summary");
    setDiffSummary(handle(), options.answerId);
    await wait(600);
  }
}

async function runPreambleAndTools(
  handle: () => TurnHandle,
  recorder: ReturnType<typeof startRecorder>,
): Promise<void> {
  recorder.setPhase("preamble-stream");
  await streamMessage(handle(), "preamble-1", at(1_000), PREAMBLE_TEXT, 6);
  recorder.setPhase("preamble-complete");
  completeMessage(handle(), "preamble-1", at(2_000));
  await wait(150);
  recorder.setPhase("tool-1-start");
  upsertWork(handle(), commandWork("cmd-1", "bun run test reducer", at(3_000), "inProgress"));
  await wait(300);
  recorder.setPhase("tool-1-done");
  upsertWork(handle(), commandWork("cmd-1", "bun run test reducer", at(3_000), "completed"));
  await wait(150);
  recorder.setPhase("tool-2");
  upsertWork(handle(), commandWork("cmd-2", "git diff --stat", at(4_000), "completed"));
  await wait(300);
}

async function runCodexStyleTurn(variant: Variant) {
  const { handle, screen } = await mountTurn(variant);
  const recorder = startRecorder();
  if (!variant.noTools) await runPreambleAndTools(handle, recorder);
  recorder.setPhase("answer-stream");
  const answerText = Array.from({ length: variant.answerRepeat ?? 1 }, () => ANSWER_TEXT).join(
    "\n\n",
  );
  await streamMessage(
    handle(),
    "answer-1",
    at(5_000),
    answerText,
    12 * (variant.answerRepeat ?? 1),
  );
  await wait(200);
  await settleTurn(handle, recorder, { answerId: "answer-1", diffTiming: variant.diffTiming });
  return { recording: recorder.stop(), screen };
}

async function runClaudeStyleTurn(variant: Variant) {
  const { handle, screen } = await mountTurn(variant);
  const recorder = startRecorder();
  recorder.setPhase("thinking");
  upsertWork(handle(), thinkingWork("think-1", "Planning the reducer change", at(500)));
  await wait(200);
  recorder.setPhase("preamble-stream");
  await streamMessage(handle(), "preamble-1", at(1_000), PREAMBLE_TEXT, 6);
  recorder.setPhase("preamble-complete");
  completeMessage(handle(), "preamble-1", at(2_000));
  await wait(150);
  recorder.setPhase("tool-1-start");
  upsertWork(handle(), commandWork("cmd-1", "bun run test reducer", at(3_000), "inProgress"));
  await wait(300);
  recorder.setPhase("tool-1-done");
  upsertWork(handle(), commandWork("cmd-1", "bun run test reducer", at(3_000), "completed"));
  await wait(150);
  recorder.setPhase("answer-stream");
  await streamMessage(handle(), "answer-1", at(5_000), ANSWER_TEXT, 12, {
    between: (step) => {
      if (step === 4) {
        upsertWork(handle(), commandWork("cmd-late", "rg applyDelta", at(4_500), "completed"));
      }
      if (step === 8) {
        upsertWork(handle(), commandWork("cmd-after", "bun run lint", at(5_500), "completed"));
      }
    },
  });
  await wait(200);
  await settleTurn(handle, recorder, { answerId: "answer-1", diffTiming: variant.diffTiming });
  return { recording: recorder.stop(), screen };
}

const SEGMENT_PARTS = [
  "First I read the reducer to find where deltas merge.",
  " Then I checked the store shape for the settled case.",
  " The fix keeps the final answer in place and the tests pass.",
];

async function runSegmentedTurn(variant: Variant, snapshot: "after-complete" | "mid-stream") {
  const { handle, screen } = await mountTurn(variant);
  const recorder = startRecorder();
  const segmentStarts = [at(1_000), at(2_500), at(4_000)];
  const segments = SEGMENT_PARTS.map((text, index) => ({
    sequence: index + 1,
    startedAt: segmentStarts[index]!,
    endedAt: segmentStarts[index]!,
    text,
  }));
  recorder.setPhase("segment-0-stream");
  await streamMessage(handle(), "answer-1", segmentStarts[0]!, SEGMENT_PARTS[0]!, 4);
  recorder.setPhase("tool-1");
  upsertWork(handle(), commandWork("cmd-1", "rg applyDelta", at(2_000), "completed"));
  await wait(200);
  if (snapshot === "mid-stream") {
    recorder.setPhase("snapshot");
    replaceMessage(handle(), {
      ...assistantMessage("answer-1", SEGMENT_PARTS[0]!, segmentStarts[0]!, { streaming: true }),
      textSegments: segments.slice(0, 1),
    });
    await wait(200);
  }
  const extra = snapshot === "mid-stream" ? { textSegments: segments.slice(0, 1) } : {};
  recorder.setPhase("segment-1-stream");
  await streamMessage(handle(), "answer-1", segmentStarts[0]!, SEGMENT_PARTS[1]!, 4, {
    prefix: SEGMENT_PARTS[0]!,
    extra,
  });
  recorder.setPhase("tool-2");
  upsertWork(handle(), commandWork("cmd-2", "bun run test", at(3_500), "completed"));
  await wait(200);
  recorder.setPhase("segment-2-stream");
  await streamMessage(handle(), "answer-1", segmentStarts[0]!, SEGMENT_PARTS[2]!, 4, {
    prefix: `${SEGMENT_PARTS[0]}${SEGMENT_PARTS[1]}`,
    extra,
  });
  await wait(200);
  recorder.setPhase("complete");
  completeMessage(handle(), "answer-1", at(5_000));
  await wait(300);
  if (snapshot === "after-complete") {
    recorder.setPhase("snapshot");
    replaceMessage(handle(), {
      ...assistantMessage("answer-1", SEGMENT_PARTS.join(""), segmentStarts[0]!, {
        streaming: false,
        completedAt: at(5_000),
      }),
      textSegments: segments,
    });
    await wait(400);
  }
  recorder.setPhase("settle-grace");
  handle().set((current) => ({ ...current, isWorking: false, settleGraceActive: true }));
  await wait(ACTIVE_TURN_LAYOUT_SETTLE_DELAY_MS);
  recorder.setPhase("settle");
  handle().set((current) => ({ ...current, settleGraceActive: false, activeTurnId: null }));
  await wait(600);
  return { recording: recorder.stop(), screen };
}

const STREAM_KEY_BY_PHASE: Record<string, string> = {
  thinking: "md:preamble-1",
  "preamble-stream": "md:preamble-1",
  "preamble-complete": "md:preamble-1",
  "tool-1-start": "md:preamble-1",
  "tool-1-done": "md:preamble-1",
  "tool-2": "md:preamble-1",
};

function streamKeyAt(phase: string): string {
  return STREAM_KEY_BY_PHASE[phase] ?? "md:answer-1";
}

const SHORT: Variant = {
  name: "short",
  heightPx: 900,
  history: 0,
  diffTiming: "grace",
  collapseFinishedTurns: true,
};
const PINNED: Variant = { ...SHORT, name: "pinned", heightPx: 600, history: 6 };

function report(name: string, recording: Recording, pinned: boolean) {
  const result = analyze(recording, { streamKeyAt: pinned ? () => null : streamKeyAt });
  const answer = anchorTrack(recording, "md:answer-1", { skipStreamPhases: true });
  const summary = pinned
    ? {
        remountCount: result.remountCount,
        remounts: result.remounts,
        answerMaxStep: answer.maxStep,
        answerJumps: answer.jumps,
        answerSpikes: answer.spikes,
        answerSteps: answer.steps.slice(0, 40),
        cls: result.cls,
        clsByPhase: result.clsByPhase,
      }
    : {
        ...result,
        answerMaxStep: answer.maxStep,
        answerJumps: answer.jumps,
        answerSpikes: answer.spikes,
      };
  logMetric(name, summary);
  logMetric(`${name}-outlines`, recording.outlines);
  return {
    ...summary,
    maxStep: pinned ? answer.maxStep : result.maxStep,
    maxRegionJump: result.maxRegionJump,
  };
}

function expectStableRows(
  summary: ReturnType<typeof report>,
  bounds: { maxStepPx: number; allowWorkReparent: boolean },
) {
  const contentRemounts = summary.remounts.filter(
    (remount) => !(bounds.allowWorkReparent && remount.key.startsWith("work:")),
  );
  expect(contentRemounts).toEqual([]);
  expect(summary.maxStep).toBeLessThanOrEqual(bounds.maxStepPx);
  expect(summary.answerMaxStep).toBeLessThanOrEqual(bounds.maxStepPx);
}

describe("MessagesTimeline row stability", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const codexVariants: Variant[] = [
    SHORT,
    { ...SHORT, name: "short-late-diff", diffTiming: "after-fold" },
    { ...SHORT, name: "short-no-fold", collapseFinishedTurns: false },
    PINNED,
    { ...PINNED, name: "pinned-late-diff", diffTiming: "after-fold" },
    { ...PINNED, name: "pinned-no-fold", collapseFinishedTurns: false },
    { ...PINNED, name: "pinned-long-history", history: 40 },
  ];
  for (const variant of codexVariants) {
    it(`codex turn keeps rows in place (${variant.name})`, async () => {
      const { recording, screen } = await runCodexStyleTurn(variant);
      try {
        const summary = report(`codex-${variant.name}`, recording, variant.history > 0);
        expectStableRows(summary, { maxStepPx: 12, allowWorkReparent: false });
      } finally {
        await screen.unmount();
      }
    });
  }

  for (const variant of [
    { ...PINNED, name: "anchored-long", anchoredSend: true, answerRepeat: 3 },
    { ...PINNED, name: "anchored-short", anchoredSend: true, answerRepeat: 1 },
    { ...PINNED, name: "pinned-long", answerRepeat: 3 },
    { ...PINNED, name: "anchored-no-tools", anchoredSend: true, answerRepeat: 3, noTools: true },
    { ...PINNED, name: "pinned-no-tools", answerRepeat: 3, noTools: true },
  ]) {
    it(`codex turn keeps a following reader pinned through settle (${variant.name})`, async () => {
      const { recording, screen } = await runCodexStyleTurn(variant);
      try {
        const settleFrames = recording.frames.filter((frame) =>
          ["answer-complete", "settle", "diff-summary"].includes(frame.phase),
        );
        const gaps = settleFrames.map((frame) => frame.gap ?? 0);
        const scrollTops = settleFrames.map((frame) => frame.scrollTop ?? 0);
        const scrollSteps = scrollTops.flatMap((top, index) =>
          index === 0 || top === scrollTops[index - 1] ? [] : [top - scrollTops[index - 1]!],
        );
        const streamGaps = recording.frames
          .filter((frame) => frame.phase === "answer-stream")
          .map((frame) => frame.gap ?? 0);
        const answer = anchorTrack(recording, "md:answer-1", { skipStreamPhases: true });
        logMetric(`follow-${variant.name}`, {
          maxGapAtSettle: Math.max(...gaps),
          finalGap: gaps.at(-1),
          maxGapWhileStreaming: Math.max(...streamGaps),
          scrollSteps,
          answerMaxStep: answer.maxStep,
          answerSpikes: answer.spikes,
          answerSteps: answer.steps.slice(0, 30),
          scrollWrites: recording.scrollWrites
            .filter((write) => write.phase !== "answer-stream")
            .slice(0, 30),
        });
        logMetric(`follow-${variant.name}-outlines`, recording.outlines);
        expect(Math.max(...gaps)).toBeLessThanOrEqual(2);
        expect(gaps.at(-1)).toBeLessThanOrEqual(1);
        expect(answer.maxStep).toBeLessThanOrEqual(12);
      } finally {
        await screen.unmount();
      }
    });
  }

  for (const variant of [
    SHORT,
    { ...SHORT, name: "short-no-fold", collapseFinishedTurns: false },
    PINNED,
  ]) {
    it(`claude turn keeps rows in place (${variant.name})`, async () => {
      const { recording, screen } = await runClaudeStyleTurn(variant);
      try {
        const summary = report(`claude-${variant.name}`, recording, variant.history > 0);
        expectStableRows(summary, { maxStepPx: 16, allowWorkReparent: true });
      } finally {
        await screen.unmount();
      }
    });
  }

  for (const snapshot of ["after-complete", "mid-stream"] as const) {
    it(`segmented message keeps its rows when segments land (${snapshot})`, async () => {
      const { recording, screen } = await runSegmentedTurn(
        { ...SHORT, collapseFinishedTurns: false },
        snapshot,
      );
      try {
        const summary = report(`segments-${snapshot}`, recording, false);
        expectStableRows(summary, { maxStepPx: 10, allowWorkReparent: false });
        expect(summary.maxRegionJump).toBeLessThanOrEqual(34);
      } finally {
        await screen.unmount();
      }
    });
  }

  it("keeps the tool row chevron still while its timers tick", async () => {
    const { handle, screen } = await mountTurn({ ...SHORT, name: "timer" });
    try {
      const startedAt = new Date(Date.now() - 58_400).toISOString();
      upsertWork(
        handle(),
        commandWork("cmd-timer", "bun run build", at(1_000), "inProgress", {
          startedAt,
          lastActivityAt: new Date(Date.now() - 400).toISOString(),
        }),
      );
      await expect
        .poll(() =>
          document.querySelector('[data-work-entry-id="cmd-timer"] [data-live-activity-meta]'),
        )
        .not.toBeNull();
      const samples: Array<{ meta: string; chevronLeft: number }> = [];
      const sample = () => {
        const row = document.querySelector('[data-work-entry-id="cmd-timer"]');
        const chevron = row?.querySelector("[data-tool-detail-trigger] > svg:last-child");
        const meta = row?.querySelector("[data-live-activity-meta]")?.textContent ?? "";
        if (chevron) {
          samples.push({ meta, chevronLeft: roundTenth(chevron.getBoundingClientRect().left) });
        }
      };
      for (let index = 0; index < 30; index += 1) {
        sample();
        await wait(100);
      }
      upsertWork(handle(), commandWork("cmd-timer", "bun run build", at(1_000), "completed"));
      await wait(100);
      sample();
      const lefts = [...new Set(samples.map((entry) => entry.chevronLeft))];
      const metas = [...new Set(samples.map((entry) => entry.meta))];
      const liveLefts = new Set(samples.slice(0, -1).map((entry) => entry.chevronLeft));
      expect(metas.length).toBeGreaterThan(3);
      expect(liveLefts.size).toBe(1);
      logMetric("timer-chevron", {
        chevronPositions: lefts.length,
        chevronTravelPx: roundTenth(Math.max(...lefts) - Math.min(...lefts)),
        lefts,
        metas,
      });
    } finally {
      await screen.unmount();
    }
  });
});
