import type { LegendListRef } from "@legendapp/list/react";
import { ThreadId } from "@synara/contracts";
import { Debouncer } from "@tanstack/react-pacer";
import type { RefObject } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";
import { flushSync } from "react-dom";
import {
  getScrollContainerDistanceFromBottom,
  isScrollContainerNearBottom,
} from "../../chat-scroll";
import { isEditableEventTarget } from "../../lib/editableEventTarget";
import type { TimelineEntry } from "../../session-logic";
import { buildTranscriptAutoFollowSignal, buildTranscriptTailKey } from "../ChatView.logic";
import {
  FOLLOW_ZONE_PX,
  isTranscriptListRevealing,
  isUpwardMoveFromUserInput,
  PINNED_END_SLACK_PX,
  pinScrollContainerToEnd,
  scrollTranscriptToSettledEnd,
  setScrollingToEndOnItsOwn,
  stopTranscriptScrollAtCurrentOffset,
} from "./transcriptScroll";

const PRESS_DRAG_THRESHOLD_PX = 8;
const PRIMARY_POINTER_BUTTON = 0;
const SECONDARY_POINTER_BUTTON = 2;
const INTERACTION_ANCHOR_SELECTOR = "button, summary, [role='button'], [data-scroll-anchor-target]";
const DISCLOSURE_TRIGGER_SELECTOR = "summary, [aria-expanded], [data-scroll-anchor-target]";
const TIMELINE_ROW_SELECTOR = "[data-timeline-row-kind]";
const NON_CONTENT_TIMELINE_ROW_KINDS = new Set(["working", "worktree-setup"]);

function isScrollbarPointer(container: HTMLElement, event: PointerEvent<HTMLDivElement>): boolean {
  if (event.target !== container) return false;
  const bounds = container.getBoundingClientRect();
  return (
    event.clientX >= bounds.left + container.clientLeft + container.clientWidth ||
    event.clientY >= bounds.top + container.clientTop + container.clientHeight
  );
}

function isTailContentRow(container: HTMLElement, row: Element): boolean {
  let tailRow: Element | null = null;
  let tailTop = Number.NEGATIVE_INFINITY;
  for (const candidate of container.querySelectorAll<HTMLElement>(TIMELINE_ROW_SELECTOR)) {
    if (NON_CONTENT_TIMELINE_ROW_KINDS.has(candidate.dataset.timelineRowKind ?? "")) continue;
    const top = candidate.getBoundingClientRect().top;
    if (top >= tailTop) {
      tailRow = candidate;
      tailTop = top;
    }
  }
  return tailRow === row;
}

function hasSelectionInside(container: HTMLElement): boolean {
  const selection = document.getSelection();
  return (
    selection !== null &&
    !selection.isCollapsed &&
    selection.anchorNode !== null &&
    container.contains(selection.anchorNode)
  );
}

interface ChatTranscriptScrollInput {
  activeThreadId: ThreadId | null;
  legendListRef: RefObject<LegendListRef | null>;
  timelineEntries: readonly TimelineEntry[];
  hasStreamingAssistantText: boolean;
  composerTranscriptInsetPx: number;
  isInactiveSplitPane: boolean;
}

export function useChatTranscriptScroll({
  activeThreadId,
  legendListRef,
  timelineEntries,
  hasStreamingAssistantText,
  composerTranscriptInsetPx,
  isInactiveSplitPane,
}: ChatTranscriptScrollInput) {
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const isAtEndRef = useRef(true);
  const autoFollowThreadIdRef = useRef<ThreadId | null>(null);
  const pendingInteractionAnchorRef = useRef<{
    element: HTMLElement;
    top: number;
  } | null>(null);
  const pendingInteractionAnchorFrameRef = useRef<number | null>(null);
  const showScrollDebouncer = useRef(
    new Debouncer(() => setShowScrollToBottom(true), { wait: 150 }),
  );

  useEffect(() => {
    const scrollDebouncer = showScrollDebouncer.current;
    return () => {
      scrollDebouncer.cancel();
      const pendingFrame = pendingInteractionAnchorFrameRef.current;
      if (pendingFrame !== null) {
        window.cancelAnimationFrame(pendingFrame);
      }
    };
  }, []);

  const tailAnchorScrollInFlightRef = useRef(false);
  const followEvidenceRef = useRef({
    lastWheelUpAt: Number.NEGATIVE_INFINITY,
    lastUpKeyAt: Number.NEGATIVE_INFINITY,
    touchActive: false,
    lastTouchEndAt: Number.NEGATIVE_INFINITY,
    pointerDownAt: null as number | null,
    lastScrollTop: null as number | null,
  });

  // Scroll helpers stay list-owned so transcript updates stop bouncing through
  // a separate measurement/controller loop during streaming.
  // Guards isAtEndRef from flipping during reflow-induced scroll events that
  // fire immediately after an explicit scrollToEnd.
  const programmaticScrollUntilRef = useRef(0);
  // User scroll gestures take ownership from streaming auto-follow. Ref updates
  // are immediate; state updates project into the `followLiveOutput` prop.
  const [isUserScrollDetached, setIsUserScrollDetached] = useState(false);
  const isUserScrollDetachedRef = useRef(isUserScrollDetached);
  const setTranscriptScrollDetached = useCallback((detached: boolean) => {
    isUserScrollDetachedRef.current = detached;
    setIsUserScrollDetached(detached);
  }, []);
  const pendingScrollGestureRef = useRef<{
    container: HTMLElement;
    scrollTop: number;
    wasFollowing: boolean;
    keyboard?: boolean;
  } | null>(null);
  const pendingScrollGestureFrameRef = useRef<number | null>(null);
  const pointerPressHoldsDetachRef = useRef(false);
  const disclosureDetachScrollTopRef = useRef<number | null>(null);
  const cancelPendingScrollGesture = useCallback(() => {
    const frameId = pendingScrollGestureFrameRef.current;
    if (frameId !== null) window.cancelAnimationFrame(frameId);
    pendingScrollGestureFrameRef.current = null;
    pendingScrollGestureRef.current = null;
  }, []);
  useEffect(() => cancelPendingScrollGesture, [activeThreadId, cancelPendingScrollGesture]);
  // The arrow's smooth jump is followed by one exact settle after LegendList
  // has measured the tail. A user gesture invalidates that pending settle.
  const settledScrollRequestRef = useRef(0);
  const settledScrollInFlightRef = useRef(false);
  const setSettledScrollInFlight = useCallback(
    (inFlight: boolean) => {
      settledScrollInFlightRef.current = inFlight;
      const container = legendListRef.current?.getScrollableNode?.();
      if (container instanceof HTMLElement) setScrollingToEndOnItsOwn(container, inFlight);
    },
    [legendListRef],
  );
  // Smooth only the first auto-follow after a send; live stream re-sticks stay cheap.
  const animateNextAutoFollowScrollRef = useRef(false);
  const automaticEndScrollRequestRef = useRef(0);
  const automaticEndScrollInFlightRef = useRef(false);
  const requestAutomaticEndScroll = useCallback(
    (target: Pick<LegendListRef, "scrollToEnd">, animated: boolean): Promise<void> => {
      const request = automaticEndScrollRequestRef.current + 1;
      automaticEndScrollRequestRef.current = request;
      automaticEndScrollInFlightRef.current = true;
      const settled = () => {
        if (automaticEndScrollRequestRef.current === request)
          automaticEndScrollInFlightRef.current = false;
      };
      return Promise.resolve(target.scrollToEnd({ animated })).then(settled, (error: unknown) => {
        settled();
        throw error;
      });
    },
    [],
  );
  const scrollToEnd = useCallback(
    (animated = false) => {
      programmaticScrollUntilRef.current = performance.now() + 200;
      const target = legendListRef.current;
      if (target?.scrollToEnd) void requestAutomaticEndScroll(target, animated).catch(() => {});
    },
    [legendListRef, requestAutomaticEndScroll],
  );
  const armTranscriptAutoFollow = useCallback(
    (targetThreadId: ThreadId, animated = false) => {
      cancelPendingScrollGesture();
      disclosureDetachScrollTopRef.current = null;
      autoFollowThreadIdRef.current = targetThreadId;
      animateNextAutoFollowScrollRef.current = animated;
      isAtEndRef.current = true;
      setTranscriptScrollDetached(false);
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
    },
    [cancelPendingScrollGesture, setTranscriptScrollDetached],
  );
  const clearTranscriptAutoFollow = useCallback(
    (synchronous = false) => {
      cancelPendingScrollGesture();
      disclosureDetachScrollTopRef.current = null;
      const listScrollToRelease =
        settledScrollInFlightRef.current || automaticEndScrollInFlightRef.current
          ? legendListRef.current
          : null;
      automaticEndScrollRequestRef.current += 1;
      automaticEndScrollInFlightRef.current = false;
      autoFollowThreadIdRef.current = null;
      animateNextAutoFollowScrollRef.current = false;
      settledScrollRequestRef.current += 1;
      setSettledScrollInFlight(false);
      programmaticScrollUntilRef.current = 0;
      // A user scroll gesture takes over from any in-flight tail-anchor slide.
      tailAnchorScrollInFlightRef.current = false;
      const container = legendListRef.current?.getScrollableNode();
      const detached =
        container instanceof HTMLElement && container.scrollHeight > container.clientHeight + 1;
      if (detached !== isUserScrollDetachedRef.current) {
        // Disable list-owned follow before an already queued animation frame can
        // run. Continuous wheel events otherwise defer this prop update in React.
        if (synchronous) flushSync(() => setTranscriptScrollDetached(detached));
        else setTranscriptScrollDetached(detached);
      }
      if (listScrollToRelease) {
        void stopTranscriptScrollAtCurrentOffset(listScrollToRelease).catch(() => {});
      }
    },
    [
      legendListRef,
      cancelPendingScrollGesture,
      setSettledScrollInFlight,
      setTranscriptScrollDetached,
    ],
  );
  const onTranscriptNavigate = useCallback(() => {
    // Search can navigate from an effect. Its ref ownership changes immediately,
    // while React applies the list prop before the animated jump's next frame.
    clearTranscriptAutoFollow();
    isAtEndRef.current = false;
    showScrollDebouncer.current.maybeExecute();
  }, [clearTranscriptAutoFollow]);
  const transcriptMessageCount = useMemo(
    () => timelineEntries.filter((entry) => entry.kind === "message").length,
    [timelineEntries],
  );
  const latestTranscriptMessage = useMemo(() => {
    for (let index = timelineEntries.length - 1; index >= 0; index -= 1) {
      const entry = timelineEntries[index];
      if (entry?.kind === "message") {
        return entry.message;
      }
    }
    return null;
  }, [timelineEntries]);
  const transcriptTailKey = buildTranscriptTailKey(latestTranscriptMessage);
  const transcriptAutoFollowSignal = buildTranscriptAutoFollowSignal({
    messageCount: transcriptMessageCount,
    tailKey: transcriptTailKey,
  });
  const restoreFollowAfterLayoutMove = useCallback((container: HTMLElement): boolean => {
    const evidence = followEvidenceRef.current;
    const previousScrollTop = evidence.lastScrollTop;
    evidence.lastScrollTop = container.scrollTop;
    const movedUp =
      previousScrollTop !== null && container.scrollTop < previousScrollTop - FOLLOW_ZONE_PX;
    const followOwnsScroll =
      !isUserScrollDetachedRef.current &&
      pendingScrollGestureRef.current === null &&
      !tailAnchorScrollInFlightRef.current &&
      !settledScrollInFlightRef.current;
    if (
      !movedUp ||
      !followOwnsScroll ||
      getScrollContainerDistanceFromBottom(container) <= FOLLOW_ZONE_PX ||
      isUpwardMoveFromUserInput({ ...evidence, now: performance.now() })
    ) {
      return false;
    }
    if (pinScrollContainerToEnd(container) !== "pinned") return false;
    programmaticScrollUntilRef.current = performance.now() + 200;
    evidence.lastScrollTop = container.scrollTop;
    isAtEndRef.current = true;
    return true;
  }, []);
  const onIsAtEndChange = useCallback(
    (isAtEnd: boolean) => {
      const container = legendListRef.current?.getScrollableNode();
      if (container instanceof HTMLElement && restoreFollowAfterLayoutMove(container)) return;
      const pending = pendingScrollGestureRef.current;
      if (pending?.keyboard && container === pending.container) {
        // Native key scrolling can begin after keyup and after multiple frames.
        if (container.scrollTop >= pending.scrollTop || isScrollContainerNearBottom(container, 1))
          return;
        pendingScrollGestureRef.current = null;
      }
      if (!isAtEnd && !isUserScrollDetachedRef.current) {
        if (
          hasStreamingAssistantText &&
          container instanceof HTMLElement &&
          !isScrollContainerNearBottom(container, 1) &&
          !tailAnchorScrollInFlightRef.current &&
          !settledScrollInFlightRef.current &&
          performance.now() >= programmaticScrollUntilRef.current
        ) {
          const request = settledScrollRequestRef.current;
          programmaticScrollUntilRef.current = performance.now() + 200;
          window.requestAnimationFrame(() => {
            if (
              request === settledScrollRequestRef.current &&
              !isUserScrollDetachedRef.current &&
              !tailAnchorScrollInFlightRef.current &&
              !settledScrollInFlightRef.current &&
              legendListRef.current?.getScrollableNode() === container &&
              !isScrollContainerNearBottom(container, 1)
            )
              scrollToEnd();
          });
        }
        return;
      }
      if (
        !isAtEnd &&
        (tailAnchorScrollInFlightRef.current ||
          settledScrollInFlightRef.current ||
          performance.now() < programmaticScrollUntilRef.current)
      ) {
        return;
      }
      // The list can report its content end while the viewport is still inside
      // the bottom inset. A detached reader resumes only at the actual bottom.
      const atEnd =
        isAtEnd &&
        (!isUserScrollDetachedRef.current ||
          !(container instanceof HTMLElement) ||
          isScrollContainerNearBottom(container, 1));
      if (atEnd && isUserScrollDetachedRef.current && pointerPressHoldsDetachRef.current) return;
      const disclosureDetachScrollTop = disclosureDetachScrollTopRef.current;
      const readerStillAtDisclosureDetach =
        disclosureDetachScrollTop !== null &&
        container instanceof HTMLElement &&
        Math.abs(container.scrollTop - disclosureDetachScrollTop) <= FOLLOW_ZONE_PX;
      if (atEnd && isUserScrollDetachedRef.current && readerStillAtDisclosureDetach) return;
      if (atEnd === isAtEndRef.current && (!atEnd || !isUserScrollDetachedRef.current)) return;
      // A gesture can detach without changing the previous edge notification.
      if (atEnd) {
        setTranscriptScrollDetached(false);
        showScrollDebouncer.current.cancel();
        setShowScrollToBottom(false);
      } else {
        // A changing layout can temporarily leave the end during output. Only
        // user gestures detach live follow; a geometry notification must not.
        showScrollDebouncer.current.maybeExecute();
      }
      isAtEndRef.current = atEnd;
    },
    [
      legendListRef,
      hasStreamingAssistantText,
      restoreFollowAfterLayoutMove,
      scrollToEnd,
      setTranscriptScrollDetached,
    ],
  );
  const cancelPendingInteractionAnchorAdjustment = useCallback(() => {
    const pendingFrame = pendingInteractionAnchorFrameRef.current;
    if (pendingFrame === null) return;
    pendingInteractionAnchorFrameRef.current = null;
    window.cancelAnimationFrame(pendingFrame);
  }, []);
  const onMessagesClickCaptureBase = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const scrollContainer = legendListRef.current?.getScrollableNode?.();
      if (!(scrollContainer instanceof HTMLElement) || !(event.target instanceof Element)) return;

      const trigger = event.target.closest<HTMLElement>(INTERACTION_ANCHOR_SELECTOR);
      if (!trigger || !scrollContainer.contains(trigger)) return;
      if (!isUserScrollDetachedRef.current && trigger.matches(DISCLOSURE_TRIGGER_SELECTOR)) {
        const row = trigger.closest(TIMELINE_ROW_SELECTOR);
        if (row && isTailContentRow(scrollContainer, row)) return;
        clearTranscriptAutoFollow(true);
        disclosureDetachScrollTopRef.current = scrollContainer.scrollTop;
      }
      if (trigger.closest("[data-scroll-anchor-ignore]")) return;

      pendingInteractionAnchorRef.current = {
        element: trigger,
        top: trigger.getBoundingClientRect().top,
      };

      cancelPendingInteractionAnchorAdjustment();
      pendingInteractionAnchorFrameRef.current = window.requestAnimationFrame(() => {
        pendingInteractionAnchorFrameRef.current = null;
        const anchor = pendingInteractionAnchorRef.current;
        pendingInteractionAnchorRef.current = null;
        const activeScrollContainer = legendListRef.current?.getScrollableNode?.();
        if (!(activeScrollContainer instanceof HTMLElement) || !anchor) return;
        if (!anchor.element.isConnected || !activeScrollContainer.contains(anchor.element)) return;

        const nextTop = anchor.element.getBoundingClientRect().top;
        const delta = nextTop - anchor.top;
        if (Math.abs(delta) < 0.5) return;

        activeScrollContainer.scrollTop += delta;
      });
    },
    [legendListRef, cancelPendingInteractionAnchorAdjustment, clearTranscriptAutoFollow],
  );
  const endPointerPressRef = useRef<(() => void) | null>(null);
  const endPointerPress = useCallback(() => {
    const end = endPointerPressRef.current;
    endPointerPressRef.current = null;
    pointerPressHoldsDetachRef.current = false;
    followEvidenceRef.current.pointerDownAt = null;
    end?.();
  }, []);
  useEffect(() => endPointerPress, [endPointerPress]);
  const onMessagesPointerDownBase = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      endPointerPress();
      if (event.button === SECONDARY_POINTER_BUTTON) return;
      followEvidenceRef.current.pointerDownAt = performance.now();
      const container = legendListRef.current?.getScrollableNode();
      if (
        !(container instanceof HTMLElement) ||
        event.button !== PRIMARY_POINTER_BUTTON ||
        isScrollbarPointer(container, event)
      ) {
        clearTranscriptAutoFollow(true);
        return;
      }
      const { pointerId, clientX: originX, clientY: originY } = event;
      let lastScrollTop = container.scrollTop;
      let released = false;
      const releaseFollow = () => {
        if (released) return;
        released = true;
        pointerPressHoldsDetachRef.current = true;
        clearTranscriptAutoFollow(true);
      };
      const onPointerMove = (moveEvent: globalThis.PointerEvent) => {
        if (moveEvent.buttons === 0) {
          endPointerPress();
          return;
        }
        if (released || moveEvent.pointerId !== pointerId) return;
        const distance = Math.hypot(moveEvent.clientX - originX, moveEvent.clientY - originY);
        if (distance > PRESS_DRAG_THRESHOLD_PX) releaseFollow();
      };
      const onSelectionChange = () => {
        if (hasSelectionInside(container)) releaseFollow();
      };
      const onScroll = () => {
        if (released) return;
        const scrollTop = container.scrollTop;
        const movedUpFromEnd =
          scrollTop < lastScrollTop - 1 && !isScrollContainerNearBottom(container, 1);
        lastScrollTop = scrollTop;
        if (movedUpFromEnd) releaseFollow();
      };
      const onPressEnd = (endEvent: globalThis.PointerEvent) => {
        if (endEvent.pointerId !== pointerId) return;
        if (hasSelectionInside(container)) releaseFollow();
        endPointerPress();
      };
      window.addEventListener("pointermove", onPointerMove, true);
      window.addEventListener("pointerup", onPressEnd, true);
      window.addEventListener("pointercancel", onPressEnd, true);
      window.addEventListener("blur", endPointerPress);
      document.addEventListener("selectionchange", onSelectionChange);
      container.addEventListener("scroll", onScroll, { passive: true });
      endPointerPressRef.current = () => {
        window.removeEventListener("pointermove", onPointerMove, true);
        window.removeEventListener("pointerup", onPressEnd, true);
        window.removeEventListener("pointercancel", onPressEnd, true);
        window.removeEventListener("blur", endPointerPress);
        document.removeEventListener("selectionchange", onSelectionChange);
        container.removeEventListener("scroll", onScroll);
      };
    },
    [legendListRef, clearTranscriptAutoFollow, endPointerPress],
  );
  const releaseTranscriptScrollGesture = useCallback(() => {
    const state = legendListRef.current?.getState();
    if (state) onIsAtEndChange(state.isAtEnd);
  }, [legendListRef, onIsAtEndChange]);
  const onMessagesPointerCancelBase = releaseTranscriptScrollGesture;
  const onMessagesPointerUpBase = useCallback(() => {
    const container = legendListRef.current?.getScrollableNode();
    if (container instanceof HTMLElement && hasSelectionInside(container)) return;
    releaseTranscriptScrollGesture();
  }, [legendListRef, releaseTranscriptScrollGesture]);
  const onMessagesScrollBase = useCallback(() => {}, []);
  const onMessagesTouchEndBase = useCallback(() => {
    followEvidenceRef.current.touchActive = false;
    followEvidenceRef.current.lastTouchEndAt = performance.now();
    releaseTranscriptScrollGesture();
  }, [releaseTranscriptScrollGesture]);
  const onMessagesTouchMoveBase = useCallback(() => {
    clearTranscriptAutoFollow(true);
  }, [clearTranscriptAutoFollow]);
  const onMessagesTouchStartBase = useCallback(() => {
    followEvidenceRef.current.touchActive = true;
    const endTouch = () => {
      followEvidenceRef.current.touchActive = false;
      followEvidenceRef.current.lastTouchEndAt = performance.now();
      window.removeEventListener("touchend", endTouch, true);
      window.removeEventListener("touchcancel", endTouch, true);
    };
    window.addEventListener("touchend", endTouch, true);
    window.addEventListener("touchcancel", endTouch, true);
  }, []);
  const onMessagesScrollGesture = useCallback(
    (upward: boolean) => {
      const container = legendListRef.current?.getScrollableNode();
      if (!(container instanceof HTMLElement)) return;
      if (!upward && isAtEndRef.current && isScrollContainerNearBottom(container, 1)) return;
      const pending = pendingScrollGestureRef.current;
      const origin =
        pending?.container === container
          ? pending
          : {
              container,
              scrollTop: container.scrollTop,
              wasFollowing:
                isAtEndRef.current &&
                !isUserScrollDetachedRef.current &&
                (!upward || isScrollContainerNearBottom(container, 1)),
            };
      clearTranscriptAutoFollow(true);
      pendingScrollGestureRef.current = origin;
      // Native scrolling can settle on the next rendering pass. Keep one
      // pending check per gesture burst, preserving ownership from its first event.
      pendingScrollGestureFrameRef.current = window.requestAnimationFrame(() => {
        pendingScrollGestureFrameRef.current = window.requestAnimationFrame(() => {
          pendingScrollGestureFrameRef.current = null;
          pendingScrollGestureRef.current = null;
          if (origin.wasFollowing && container.scrollTop >= origin.scrollTop) {
            // A nested or no-op wheel must not strand follow, even if new text
            // increased the distance from the bottom while the gesture settled.
            setTranscriptScrollDetached(false);
            onIsAtEndChange(true);
            scrollToEnd();
          } else {
            releaseTranscriptScrollGesture();
          }
        });
      });
    },
    [
      legendListRef,
      clearTranscriptAutoFollow,
      onIsAtEndChange,
      releaseTranscriptScrollGesture,
      scrollToEnd,
      setTranscriptScrollDetached,
    ],
  );
  const onMessagesWheelBase = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      // Horizontal scroll, zoom, and scrolling down at the end do not leave it.
      if (event.ctrlKey || event.deltaY === 0) return;
      if (event.deltaY < 0) followEvidenceRef.current.lastWheelUpAt = performance.now();
      onMessagesScrollGesture(event.deltaY < 0);
    },
    [onMessagesScrollGesture],
  );
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Tab" && event.shiftKey) {
        followEvidenceRef.current.lastUpKeyAt = performance.now();
      }
      const container = legendListRef.current?.getScrollableNode();
      if (
        !(container instanceof HTMLElement) ||
        !(event.target instanceof Element) ||
        !container.contains(event.target) ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        isEditableEventTarget(event)
      )
        return;
      if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key))
        return;
      if (event.key === " " && event.target.closest("button, a, [role='button']")) return;
      const upward =
        event.key === "ArrowUp" ||
        event.key === "PageUp" ||
        event.key === "Home" ||
        (event.key === " " && event.shiftKey);
      if (upward) {
        followEvidenceRef.current.lastUpKeyAt = performance.now();
        if (container.scrollTop <= 0) return;
        const pending = pendingScrollGestureRef.current;
        const origin =
          pending?.keyboard && pending.container === container
            ? pending
            : {
                container,
                scrollTop: container.scrollTop,
                wasFollowing: isAtEndRef.current && !isUserScrollDetachedRef.current,
                keyboard: true,
              };
        clearTranscriptAutoFollow(true);
        pendingScrollGestureRef.current = origin;
        isAtEndRef.current = false;
        showScrollDebouncer.current.maybeExecute();
      } else {
        onMessagesScrollGesture(false);
      }
    };
    const releaseKeyboardGesture = () => {
      const origin = pendingScrollGestureRef.current;
      if (!origin?.keyboard) return;
      const previousFrame = pendingScrollGestureFrameRef.current;
      if (previousFrame !== null) window.cancelAnimationFrame(previousFrame);
      // Native key scrolling may begin after keyup. Give it rendering time to
      // move, then recover a no-op/nested gesture instead of holding indefinitely.
      const deadline = performance.now() + 150;
      const check = () => {
        pendingScrollGestureFrameRef.current = null;
        if (pendingScrollGestureRef.current !== origin) return;
        const movedUp = origin.container.scrollTop < origin.scrollTop - 1;
        if (!movedUp && performance.now() < deadline) {
          pendingScrollGestureFrameRef.current = window.requestAnimationFrame(check);
          return;
        }
        pendingScrollGestureRef.current = null;
        if (origin.wasFollowing && !movedUp) {
          setTranscriptScrollDetached(false);
          onIsAtEndChange(true);
          scrollToEnd();
        } else {
          releaseTranscriptScrollGesture();
        }
      };
      pendingScrollGestureFrameRef.current = window.requestAnimationFrame(check);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", releaseKeyboardGesture);
    window.addEventListener("blur", releaseKeyboardGesture);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", releaseKeyboardGesture);
      window.removeEventListener("blur", releaseKeyboardGesture);
    };
  }, [
    legendListRef,
    clearTranscriptAutoFollow,
    onIsAtEndChange,
    onMessagesScrollGesture,
    releaseTranscriptScrollGesture,
    scrollToEnd,
    setTranscriptScrollDetached,
  ]);
  // A thread switch hands scroll ownership back to follow. This must be a
  // layout effect declared before the auto-follow effect below: that effect
  // reads the detached ref in the same commit, and a passive reset would run
  // after it had already skipped the new thread, without re-triggering it.
  useLayoutEffect(() => {
    isAtEndRef.current = true;
    disclosureDetachScrollTopRef.current = null;
    settledScrollRequestRef.current += 1;
    setSettledScrollInFlight(false);
    programmaticScrollUntilRef.current = 0;
    setTranscriptScrollDetached(false);
    showScrollDebouncer.current.cancel();
    const settle = window.setTimeout(() => setShowScrollToBottom(false), 0);
    return () => window.clearTimeout(settle);
  }, [activeThreadId, setSettledScrollInFlight, setTranscriptScrollDetached]);
  useLayoutEffect(() => {
    const shouldFollowPendingTurn =
      activeThreadId !== null && autoFollowThreadIdRef.current === activeThreadId;
    if (isUserScrollDetachedRef.current || (!isAtEndRef.current && !shouldFollowPendingTurn)) {
      return;
    }
    // Re-apply the bottom stick only for real transcript messages; tool/work
    // rows can arrive quickly and should not churn scroll/layout work.
    const frameId = window.requestAnimationFrame(() => {
      // The tail-anchor slide owns the scroll after a send; a re-snap here
      // would hard-jump past the smooth slide mid-flight. Once the anchor
      // settles the spacer keeps the end position exact, so nothing is missed.
      if (tailAnchorScrollInFlightRef.current || isUserScrollDetachedRef.current) {
        return;
      }
      const shouldAnimate = animateNextAutoFollowScrollRef.current;
      animateNextAutoFollowScrollRef.current = false;
      const container = legendListRef.current?.getScrollableNode?.();
      const alreadyPinned =
        container instanceof HTMLElement &&
        !isTranscriptListRevealing(container) &&
        getScrollContainerDistanceFromBottom(container) <= PINNED_END_SLACK_PX;
      if (!alreadyPinned) scrollToEnd(shouldAnimate);
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [activeThreadId, legendListRef, scrollToEnd, transcriptAutoFollowSignal]);

  // A composer that grows (attachments, approval cards, queued turns) eats into the
  // transcript's bottom content inset, which would push the tail behind the frosted
  // surface. Re-stick a transcript that was already parked at the end.
  //
  // This is driven by the *committed* inset rather than by a ResizeObserver on the
  // composer: the inset lands a render after the measurement, so a scroll scheduled
  // from the observer would race the padding it is supposed to compensate for. Here
  // the new padding is already in the DOM, so the pre-resize viewport is simply the
  // current one with the inset delta backed out.
  const previousComposerTranscriptInsetRef = useRef({
    threadId: activeThreadId ?? null,
    insetPx: composerTranscriptInsetPx,
  });
  useLayoutEffect(() => {
    const threadId = activeThreadId ?? null;
    const previous = previousComposerTranscriptInsetRef.current;
    previousComposerTranscriptInsetRef.current = {
      threadId,
      insetPx: composerTranscriptInsetPx,
    };
    if (previous.threadId !== threadId) return;

    const insetDeltaPx = composerTranscriptInsetPx - previous.insetPx;
    if (isInactiveSplitPane || Math.abs(insetDeltaPx) < 0.5) return;

    const scrollContainer = legendListRef.current?.getScrollableNode?.();
    if (!(scrollContainer instanceof HTMLElement)) return;
    const wasNearEndBeforeResize = isScrollContainerNearBottom({
      scrollTop: scrollContainer.scrollTop,
      clientHeight: scrollContainer.clientHeight,
      scrollHeight: scrollContainer.scrollHeight - insetDeltaPx,
    });
    if (!wasNearEndBeforeResize) return;

    // Compensate by the exact inset delta rather than asking the list to scroll to its
    // end: LegendList re-measures the padded viewport on its own schedule, so an
    // end-scroll issued in this commit would aim at the pre-padding content height and
    // land a composer-growth short of the tail.
    programmaticScrollUntilRef.current = performance.now() + 200;
    scrollContainer.scrollTop += insetDeltaPx;
  }, [legendListRef, activeThreadId, composerTranscriptInsetPx, isInactiveSplitPane]);

  const onScrollToBottom = useCallback(() => {
    cancelPendingScrollGesture();
    disclosureDetachScrollTopRef.current = null;
    tailAnchorScrollInFlightRef.current = false;
    setTranscriptScrollDetached(false);
    isAtEndRef.current = true;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    const target = legendListRef.current;
    if (!target) {
      return;
    }

    const requestId = settledScrollRequestRef.current + 1;
    settledScrollRequestRef.current = requestId;
    setSettledScrollInFlight(true);
    programmaticScrollUntilRef.current = performance.now() + 200;
    void scrollTranscriptToSettledEnd({
      target,
      isCurrent: () =>
        settledScrollRequestRef.current === requestId && legendListRef.current === target,
      beforeFinalScroll: () => {
        programmaticScrollUntilRef.current = performance.now() + 200;
      },
    })
      .then((settled) => {
        if (settledScrollRequestRef.current !== requestId) {
          return;
        }
        setSettledScrollInFlight(false);
        if (!settled) {
          return;
        }
        isAtEndRef.current = true;
        showScrollDebouncer.current.cancel();
        setShowScrollToBottom(false);
      })
      .catch(() => {
        if (settledScrollRequestRef.current === requestId) {
          setSettledScrollInFlight(false);
        }
      });
  }, [
    legendListRef,
    cancelPendingScrollGesture,
    setSettledScrollInFlight,
    setTranscriptScrollDetached,
  ]);

  const previousThreadIdRef = useRef(activeThreadId);
  const pendingStreamingThreadRef = useRef<ThreadId | null>(null);
  useEffect(() => {
    if (previousThreadIdRef.current !== activeThreadId) {
      previousThreadIdRef.current = activeThreadId;
      pendingStreamingThreadRef.current = activeThreadId;
    }
    if (
      activeThreadId === null ||
      !hasStreamingAssistantText ||
      pendingStreamingThreadRef.current !== activeThreadId
    )
      return;
    pendingStreamingThreadRef.current = null;

    // The replacement list can expand after its first end-scroll as virtual rows
    // acquire their measured heights. Keep the live response at the end while
    // that initial layout settles, but yield immediately to a reader gesture.
    let cancelled = false;
    const settleAtEnd = async () => {
      const target = legendListRef.current;
      if (!target) return;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (
          cancelled ||
          tailAnchorScrollInFlightRef.current ||
          isUserScrollDetachedRef.current ||
          legendListRef.current !== target
        )
          return;
        programmaticScrollUntilRef.current = performance.now() + 200;
        await requestAutomaticEndScroll(target, false);
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        });
        if (
          cancelled ||
          tailAnchorScrollInFlightRef.current ||
          isUserScrollDetachedRef.current ||
          legendListRef.current !== target
        )
          return;
        const node = target.getScrollableNode();
        if (node instanceof HTMLElement && isScrollContainerNearBottom(node, 1)) return;
      }
    };
    const frameId = window.requestAnimationFrame(() => void settleAtEnd());
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
    };
  }, [activeThreadId, hasStreamingAssistantText, legendListRef, requestAutomaticEndScroll]);

  return {
    showScrollToBottom,
    isUserScrollDetached,
    tailAnchorScrollInFlightRef,
    armTranscriptAutoFollow,
    onTranscriptNavigate,
    onIsAtEndChange,
    onScrollToBottom,
    onMessagesClickCaptureBase,
    onMessagesPointerDownBase,
    onMessagesPointerUpBase,
    onMessagesPointerCancelBase,
    onMessagesScrollBase,
    onMessagesTouchEndBase,
    onMessagesTouchMoveBase,
    onMessagesTouchStartBase,
    onMessagesWheelBase,
  };
}
