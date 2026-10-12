import type { LegendListRef } from "@legendapp/list/react";
import { ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineEntry } from "../../session-logic";
import { reactHookHarness } from "../../test/reactHookHarness";
import { useChatTranscriptScroll } from "./useChatTranscriptScroll";

vi.mock("react", async (load) => ({
  ...(await load<typeof import("react")>()),
  ...(await import("../../test/reactHookHarness")).reactHookHarnessMock,
}));
vi.mock("react-dom", () => ({ flushSync: (callback: () => void) => callback() }));

class ScrollNode {
  scrollTop = 800;
  scrollHeight = 1_000;
  clientHeight = 200;
  firstElementChild = null;
  scrollTo = vi.fn((options: ScrollToOptions) => {
    this.scrollTop = options.top ?? this.scrollTop;
  });
}

const EMPTY_TIMELINE: TimelineEntry[] = [];
const frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 0;
let frameTime = 0;

async function nextFrame() {
  frameTime += 16;
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(frameTime);
  await Promise.resolve();
}

function mountScroll() {
  const node = new ScrollNode();
  const scrollToEnd = vi.fn(async () => {
    node.scrollTop = node.scrollHeight - node.clientHeight;
  });
  const listRef = {
    current: {
      getScrollableNode: () => node,
      getState: () => ({ isAtEnd: node.scrollTop >= node.scrollHeight - node.clientHeight }),
      scrollToEnd,
      scrollToOffset: vi.fn(async () => {}),
    } as unknown as LegendListRef,
  };
  const render = () => {
    reactHookHarness.beginRender();
    return useChatTranscriptScroll({
      activeThreadId: ThreadId.makeUnsafe("follow"),
      legendListRef: listRef,
      timelineEntries: EMPTY_TIMELINE,
      hasStreamingAssistantText: true,
      composerTranscriptInsetPx: 0,
      isInactiveSplitPane: false,
    });
  };
  render();
  return { node, render, scrollToEnd };
}

beforeEach(() => {
  reactHookHarness.reset();
  frames.clear();
  nextFrameId = 0;
  frameTime = 0;
  vi.useFakeTimers();
  vi.stubGlobal("HTMLElement", ScrollNode);
  vi.stubGlobal("document", { getSelection: () => null, timeline: { currentTime: 0 } });
  vi.stubGlobal("window", {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout,
    clearTimeout,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});

afterEach(() => {
  reactHookHarness.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("reader return to the transcript end", () => {
  it.each([12, 350])("restores follow after a manual return from a %ipx gap", async (gap) => {
    const { node, render } = mountScroll();
    await nextFrame();
    node.scrollTop -= gap;
    render().onTranscriptNavigate();
    expect(render().isUserScrollDetached).toBe(true);
    node.scrollTop = 800;
    const controls = render();
    controls.onMessagesScrollBase();
    controls.onIsAtEndChange(true);
    expect(render().isUserScrollDetached).toBe(false);
  });

  it("keeps a reader detached when content shrink clamps the viewport to the end", async () => {
    const { node, render } = mountScroll();
    await nextFrame();
    node.scrollTop = 450;
    render().onTranscriptNavigate();
    node.scrollHeight = 200;
    node.scrollTop = 0;
    const controls = render();
    controls.onMessagesScrollBase();
    controls.onIsAtEndChange(true);
    expect(render().isUserScrollDetached).toBe(true);
  });

  it("keeps detached ownership through work layout notifications", async () => {
    const { node, render, scrollToEnd } = mountScroll();
    await nextFrame();
    node.scrollTop = 450;
    render().onTranscriptNavigate();
    scrollToEnd.mockClear();
    node.scrollHeight += 200;
    node.scrollTop += 200;
    const controls = render();
    controls.onMessagesScrollBase();
    controls.onIsAtEndChange(false);
    await nextFrame();
    expect(render().isUserScrollDetached).toBe(true);
    expect(scrollToEnd).not.toHaveBeenCalled();
  });
});
