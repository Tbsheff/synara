import type { LegendListRef } from "@legendapp/list/react";
import { ThreadId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useChatTranscriptScroll } from "./useChatTranscriptScroll";
import type { TimelineEntry } from "../../session-logic";

const EMPTY_TIMELINE: [] = [];
const waitForFrames = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

describe("transcript follow after switching threads", () => {
  it("follows an idle destination after leaving a detached transcript", async () => {
    // Detached nodes have no layout, so model an overflowing viewport directly.
    const node = document.createElement("div");
    Object.defineProperties(node, {
      scrollHeight: { value: 1_000 },
      clientHeight: { value: 200 },
      scrollTop: { value: 300, writable: true },
    });
    const scrollToEnd = vi.fn(async () => {
      node.scrollTop = 800;
    });
    const listRef = {
      current: {
        scrollToEnd,
        getScrollableNode: () => node,
      } as unknown as LegendListRef,
    };
    let controls: ReturnType<typeof useChatTranscriptScroll> | undefined;
    function Harness({
      threadId,
      timelineEntries = EMPTY_TIMELINE,
    }: {
      threadId: string;
      timelineEntries?: TimelineEntry[];
    }) {
      controls = useChatTranscriptScroll({
        activeThreadId: ThreadId.makeUnsafe(threadId),
        legendListRef: listRef,
        timelineEntries,
        hasStreamingAssistantText: false,
        composerTranscriptInsetPx: 0,
        isInactiveSplitPane: false,
      });
      return null;
    }
    const screen = await render(<Harness threadId="first" />);
    try {
      await waitForFrames();
      controls!.onTranscriptNavigate();
      await screen.rerender(<Harness threadId="first" />);
      await waitForFrames();
      expect(controls!.isUserScrollDetached).toBe(true);

      for (const threadId of ["second", "first"]) {
        node.scrollTop = 300;
        scrollToEnd.mockClear();
        await screen.rerender(<Harness threadId={threadId} />);
        await waitForFrames();
        expect(controls!.isUserScrollDetached).toBe(false);
        expect(scrollToEnd).toHaveBeenCalledTimes(1);
        expect(node.scrollTop).toBe(800);
        scrollToEnd.mockClear();
        for (const detail of ["Inspecting the boundary", "Verifying cancellation"]) {
          await screen.rerender(
            <Harness
              threadId={threadId}
              timelineEntries={[
                {
                  kind: "work",
                  id: "live-reasoning",
                  createdAt: "2026-03-17T19:12:28.000Z",
                  entry: {
                    id: "live-reasoning",
                    createdAt: "2026-03-17T19:12:28.000Z",
                    tone: "tool",
                    label: "Reasoning trace",
                    toolCallId: "reasoning-item",
                    toolStatus: "running",
                    detail,
                  },
                },
              ]}
            />,
          );
          await waitForFrames();
          expect(scrollToEnd).not.toHaveBeenCalled();
        }
        // Detach again so the return trip starts from a detached reader too.
        controls!.onTranscriptNavigate();
        await screen.rerender(<Harness threadId={threadId} />);
      }
    } finally {
      await screen.unmount();
    }
  });

  it("preserves send-anchor ownership when an idle destination starts streaming", async () => {
    const node = document.createElement("div");
    const scrollToEnd = vi.fn(async () => {});
    const listRef = {
      current: {
        scrollToEnd,
        getScrollableNode: () => node,
      } as unknown as LegendListRef,
    };
    let controls: ReturnType<typeof useChatTranscriptScroll> | undefined;
    function Harness({ threadId, streaming }: { threadId: string; streaming: boolean }) {
      controls = useChatTranscriptScroll({
        activeThreadId: ThreadId.makeUnsafe(threadId),
        legendListRef: listRef,
        timelineEntries: EMPTY_TIMELINE,
        hasStreamingAssistantText: streaming,
        composerTranscriptInsetPx: 0,
        isInactiveSplitPane: false,
      });
      return null;
    }
    const screen = await render(<Harness threadId="first" streaming={false} />);
    try {
      await waitForFrames();
      await screen.rerender(<Harness threadId="second" streaming={false} />);
      await waitForFrames();
      scrollToEnd.mockClear();

      // Sending owns the scroll before the optimistic row appears. Provider text
      // can arrive while the 320ms anchor slide is still moving that row.
      controls!.tailAnchorScrollInFlightRef.current = true;
      await screen.rerender(<Harness threadId="second" streaming />);
      await waitForFrames();
      expect(scrollToEnd).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});

describe("transcript follow after a layout-driven upward move", () => {
  function mountFollowingNode() {
    const node = document.createElement("div");
    document.body.append(node);
    let scrollTop = 800;
    Object.defineProperties(node, {
      scrollHeight: { value: 1_000 },
      clientHeight: { value: 200 },
      scrollTop: {
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
    });
    const listRef = {
      current: {
        scrollToEnd: vi.fn(async () => {
          scrollTop = 800;
        }),
        getScrollableNode: () => node,
        getState: () => ({ isAtEnd: scrollTop >= 800 }),
      } as unknown as LegendListRef,
    };
    let controls: ReturnType<typeof useChatTranscriptScroll> | undefined;
    function Harness() {
      controls = useChatTranscriptScroll({
        activeThreadId: ThreadId.makeUnsafe("clamp"),
        legendListRef: listRef,
        timelineEntries: EMPTY_TIMELINE,
        hasStreamingAssistantText: false,
        composerTranscriptInsetPx: 0,
        isInactiveSplitPane: false,
      });
      return null;
    }
    const moveUp = (px: number) => {
      scrollTop -= px;
      controls!.onIsAtEndChange(false);
    };
    return {
      node,
      controls: () => controls!,
      moveUp,
      scrollTop: () => scrollTop,
      render: () => render(<Harness />),
    };
  }

  it("restores the end when a layout change explains the move", async () => {
    const mounted = mountFollowingNode();
    const screen = await mounted.render();
    try {
      await waitForFrames();
      mounted.controls().onIsAtEndChange(true);
      mounted.node.append(document.createElement("span"));
      await Promise.resolve();
      mounted.moveUp(132);
      expect(mounted.scrollTop()).toBe(800);
      await waitForFrames();
      expect(mounted.controls().isUserScrollDetached).toBe(false);
      expect(mounted.controls().showScrollToBottom).toBe(false);
    } finally {
      await screen.unmount();
      mounted.node.remove();
    }
  });

  it("leaves the move to the reader after a wheel up", async () => {
    const mounted = mountFollowingNode();
    const screen = await mounted.render();
    try {
      await waitForFrames();
      mounted.controls().onIsAtEndChange(true);
      mounted.node.append(document.createElement("span"));
      await Promise.resolve();
      mounted.controls().onMessagesWheelBase({
        ctrlKey: false,
        deltaY: -120,
      } as unknown as Parameters<
        ReturnType<typeof useChatTranscriptScroll>["onMessagesWheelBase"]
      >[0]);
      mounted.moveUp(132);
      expect(mounted.scrollTop()).toBe(668);
    } finally {
      await screen.unmount();
      mounted.node.remove();
    }
  });

  it("restores a move that no reader input explains, long after any layout change", async () => {
    const mounted = mountFollowingNode();
    const screen = await mounted.render();
    try {
      await waitForFrames();
      mounted.controls().onIsAtEndChange(true);
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      mounted.moveUp(132);
      expect(mounted.scrollTop()).toBe(800);
      await waitForFrames();
      expect(mounted.controls().isUserScrollDetached).toBe(false);
    } finally {
      await screen.unmount();
      mounted.node.remove();
    }
  });

  it("leaves the move to the reader after an up key", async () => {
    const mounted = mountFollowingNode();
    const screen = await mounted.render();
    try {
      await waitForFrames();
      mounted.controls().onIsAtEndChange(true);
      mounted.node.tabIndex = 0;
      mounted.node.focus();
      mounted.node.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
      mounted.moveUp(132);
      expect(mounted.scrollTop()).toBe(668);
      await waitForFrames();
      expect(mounted.controls().isUserScrollDetached).toBe(true);
    } finally {
      await screen.unmount();
      mounted.node.remove();
    }
  });
});

it("keeps a detached reader detached after the content shrinks to the viewport", async () => {
  const node = document.createElement("div");
  let height = 1000;
  Object.defineProperties(node, {
    scrollHeight: { get: () => height },
    clientHeight: { value: 200 },
    scrollTop: { value: 300, writable: true },
  });
  const listRef = {
    current: {
      getScrollableNode: () => node,
      scrollToEnd: vi.fn(async () => {}),
    } as unknown as LegendListRef,
  };
  let controls: ReturnType<typeof useChatTranscriptScroll> | undefined;
  function Harness() {
    controls = useChatTranscriptScroll({
      activeThreadId: ThreadId.makeUnsafe("shrink"),
      legendListRef: listRef,
      timelineEntries: EMPTY_TIMELINE,
      hasStreamingAssistantText: false,
      composerTranscriptInsetPx: 0,
      isInactiveSplitPane: false,
    });
    return null;
  }
  const screen = await render(<Harness />);
  try {
    await waitForFrames();
    controls!.onTranscriptNavigate();
    await waitForFrames();
    expect(controls!.isUserScrollDetached).toBe(true);
    height = 200;
    node.scrollTop = 0;
    controls!.onIsAtEndChange(true);
    await waitForFrames();
    expect(controls!.isUserScrollDetached).toBe(true);
  } finally {
    await screen.unmount();
  }
});
