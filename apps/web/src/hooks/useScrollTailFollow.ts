import { useCallback, useLayoutEffect, useRef } from "react";
import { isScrollContainerNearBottom } from "../chat-scroll";

const TAIL_FOLLOW_ZONE_PX = 4;

export function useScrollTailFollow<Element extends HTMLElement>(input: {
  readonly enabled: boolean;
  readonly content: unknown;
}) {
  const { enabled, content } = input;
  const elementRef = useRef<Element | null>(null);
  const readerAtTailRef = useRef(true);
  const pendingFinalUpdateRef = useRef(false);
  const previousContentRef = useRef(content);

  const onScroll = useCallback(() => {
    const element = elementRef.current;
    if (!element) return;
    readerAtTailRef.current = isScrollContainerNearBottom(element, TAIL_FOLLOW_ZONE_PX);
  }, []);

  useLayoutEffect(() => {
    const followFinalUpdate = pendingFinalUpdateRef.current;
    const contentChanged = !Object.is(previousContentRef.current, content);
    previousContentRef.current = content;
    pendingFinalUpdateRef.current = enabled || (followFinalUpdate && !contentChanged);
    const element = elementRef.current;
    if ((!enabled && !followFinalUpdate) || !element || !readerAtTailRef.current) return;
    const tailScrollTop = element.scrollHeight - element.clientHeight;
    if (tailScrollTop > element.scrollTop) element.scrollTop = tailScrollTop;
  }, [enabled, content]);

  return { ref: elementRef, onScroll };
}
