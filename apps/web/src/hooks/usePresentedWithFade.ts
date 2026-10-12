import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { DISCLOSURE_CLEANUP_BUFFER_MS, DISCLOSURE_TRANSITION_MS } from "~/lib/disclosureMotion";

export interface FadePresentation<T> {
  value: T;
  open: boolean;
}

interface FadePresentationState<T> extends FadePresentation<T> {
  shownAtMs: number;
}

interface FadePresentationTimers {
  openFrame: number | null;
  closeTimeout: number | null;
  cleanupTimeout: number | null;
}

export function usePresentedWithFade<T>(
  value: T | null,
  options: { minVisibleMs: number },
): FadePresentation<T> | null {
  const { minVisibleMs } = options;
  const [presented, setPresented] = useState<FadePresentationState<T> | null>(null);
  const timersRef = useRef<FadePresentationTimers>({
    openFrame: null,
    closeTimeout: null,
    cleanupTimeout: null,
  });

  const clearCloseTimers = useCallback(() => {
    const timers = timersRef.current;
    if (timers.closeTimeout !== null) window.clearTimeout(timers.closeTimeout);
    if (timers.cleanupTimeout !== null) window.clearTimeout(timers.cleanupTimeout);
    timers.closeTimeout = null;
    timers.cleanupTimeout = null;
  }, []);

  useLayoutEffect(() => {
    reconcileFadePresentation({
      value,
      presented,
      minVisibleMs,
      timersRef,
      clearCloseTimers,
      setPresented,
    });
  }, [value, presented, minVisibleMs, clearCloseTimers]);

  useLayoutEffect(
    () => () => {
      clearCloseTimers();
      const openFrame = timersRef.current.openFrame;
      if (openFrame !== null) window.cancelAnimationFrame(openFrame);
      timersRef.current.openFrame = null;
    },
    [clearCloseTimers],
  );

  return presented;
}

function reconcileFadePresentation<T>(params: {
  value: T | null;
  presented: FadePresentationState<T> | null;
  minVisibleMs: number;
  timersRef: RefObject<FadePresentationTimers>;
  clearCloseTimers: () => void;
  setPresented: Dispatch<SetStateAction<FadePresentationState<T> | null>>;
}): void {
  const { value, presented, minVisibleMs, timersRef, clearCloseTimers, setPresented } = params;
  const timers = timersRef.current;
  if (value !== null) {
    clearCloseTimers();
    if (presented === null) {
      setPresented({ value, open: false, shownAtMs: performance.now() });
      timers.openFrame = window.requestAnimationFrame(() => {
        timers.openFrame = null;
        setPresented((current) =>
          current && !current.open ? { ...current, open: true } : current,
        );
      });
      return;
    }
    const opening = timers.openFrame !== null;
    if (presented.value !== value || (!presented.open && !opening)) {
      setPresented({ ...presented, value, open: presented.open || !opening });
    }
    return;
  }
  if (presented === null || timers.closeTimeout !== null || timers.cleanupTimeout !== null) {
    return;
  }
  const remainingHoldMs = Math.max(0, minVisibleMs - (performance.now() - presented.shownAtMs));
  timers.closeTimeout = window.setTimeout(() => {
    timers.closeTimeout = null;
    setPresented((current) => (current?.open ? { ...current, open: false } : current));
    timers.cleanupTimeout = window.setTimeout(() => {
      timers.cleanupTimeout = null;
      setPresented(null);
    }, DISCLOSURE_TRANSITION_MS + DISCLOSURE_CLEANUP_BUFFER_MS);
  }, remainingHoldMs);
}
