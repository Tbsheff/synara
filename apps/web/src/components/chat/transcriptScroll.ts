import type { LegendListRef } from "@legendapp/list/react";

export type TranscriptScrollTarget = Pick<LegendListRef, "scrollToEnd">;
export type TranscriptScrollCancellationTarget = Pick<
  LegendListRef,
  "getScrollableNode" | "scrollToOffset"
>;

export function replaceListScrollWithStayAtReaderOffset(
  target: TranscriptScrollCancellationTarget,
): Promise<void> {
  const scrollNode = target.getScrollableNode();
  return target.scrollToOffset({
    get offset() {
      return scrollNode.scrollTop;
    },
    animated: false,
  });
}

/** Stop an in-flight native smooth scroll without changing the visible offset. */
export function stopTranscriptScrollAtCurrentOffset(
  target: TranscriptScrollCancellationTarget,
): Promise<void> {
  const scrollNode = target.getScrollableNode();
  // Cancel the browser's native smooth animation immediately. The LegendList
  // call below then clears its imperative-scroll bookkeeping at the same spot.
  scrollNode.scrollTo({ top: scrollNode.scrollTop, behavior: "auto" });
  return replaceListScrollWithStayAtReaderOffset(target);
}

/** How long the just-sent message takes to glide up to its anchored position. */
export const ANCHOR_SLIDE_DURATION_MS = 320;

/**
 * Where the anchored message sits, measured from the viewport top, this far into
 * its slide. The animation is expressed in the message's own visible offset —
 * not in scrollTop — because that is the thing the reader watches move, and it
 * stays correct while the transcript's scroll geometry changes underneath it
 * (the list reserving end space, rows above settling from estimated to measured
 * heights). The caller converts the offset back into a scroll position against
 * freshly measured layout each frame.
 *
 * Cubic ease-out: quick departure, soft arrival, and — unlike an exponential
 * approach — it lands exactly at `toPx` at a known time instead of trailing off
 * asymptotically.
 */
export function anchorSlideOffsetPx(input: {
  readonly fromPx: number;
  readonly toPx: number;
  readonly elapsedMs: number;
  readonly durationMs?: number;
}): number {
  const durationMs = input.durationMs ?? ANCHOR_SLIDE_DURATION_MS;
  if (!(durationMs > 0) || input.elapsedMs >= durationMs) {
    return input.toPx;
  }
  const progress = Math.max(0, input.elapsedMs) / durationMs;
  const eased = 1 - (1 - progress) ** 3;
  return input.fromPx + (input.toPx - input.fromPx) * eased;
}

/**
 * A smooth virtual-list jump can finish using estimated row sizes, before the
 * newly mounted tail rows have reported their real height. Re-issuing the jump
 * without animation after that first request settles uses those measurements
 * and lands on the actual end. The current-target guard prevents a completed
 * request from moving a replacement list after a thread switch or user scroll.
 */
export async function scrollTranscriptToSettledEnd(input: {
  readonly target: TranscriptScrollTarget;
  readonly isCurrent: () => boolean;
  readonly beforeFinalScroll?: () => void;
}): Promise<boolean> {
  await input.target.scrollToEnd({ animated: true });
  if (!input.isCurrent()) {
    return false;
  }

  input.beforeFinalScroll?.();
  await input.target.scrollToEnd({ animated: false });
  return input.isCurrent();
}

export const FOLLOW_ZONE_PX = 2;
export const PINNED_END_SLACK_PX = 1;
const WHEEL_UP_EXPLAINS_MS = 200;
const UP_KEY_EXPLAINS_MS = 500;
const TOUCH_RELEASE_EXPLAINS_MS = 2_500;
const POINTER_HOLD_EXPLAINS_MS = 15_000;

export interface FollowMoveEvidence {
  readonly now: number;
  readonly lastWheelUpAt: number;
  readonly lastUpKeyAt: number;
  readonly touchActive: boolean;
  readonly lastTouchEndAt: number;
  readonly pointerDownAt: number | null;
}

export function isUpwardMoveFromUserInput(evidence: FollowMoveEvidence): boolean {
  const { now } = evidence;
  const pointerHeld =
    evidence.pointerDownAt !== null && now - evidence.pointerDownAt < POINTER_HOLD_EXPLAINS_MS;
  return (
    evidence.touchActive ||
    pointerHeld ||
    now - evidence.lastWheelUpAt <= WHEEL_UP_EXPLAINS_MS ||
    now - evidence.lastUpKeyAt <= UP_KEY_EXPLAINS_MS ||
    now - evidence.lastTouchEndAt <= TOUCH_RELEASE_EXPLAINS_MS
  );
}

const lastFollowWriteByContainer = new WeakMap<HTMLElement, { frameTime: number; endPx: number }>();
const containersScrollingToEndOnTheirOwn = new WeakSet<HTMLElement>();

export function setScrollingToEndOnItsOwn(container: HTMLElement, scrolling: boolean): void {
  if (scrolling) containersScrollingToEndOnTheirOwn.add(container);
  else containersScrollingToEndOnTheirOwn.delete(container);
}

function currentFrameTime(): number | null {
  const time = document.timeline?.currentTime;
  return typeof time === "number" ? time : null;
}

export type PinToEndResult = "pinned" | "frame-already-written" | "scrolling-to-end-on-its-own";

export function pinScrollContainerToEnd(container: HTMLElement): PinToEndResult {
  if (containersScrollingToEndOnTheirOwn.has(container)) return "scrolling-to-end-on-its-own";
  const endPx = container.scrollHeight - container.clientHeight;
  const frameTime = currentFrameTime();
  const lastWrite = lastFollowWriteByContainer.get(container);
  if (frameTime !== null && lastWrite?.frameTime === frameTime && lastWrite.endPx === endPx) {
    return "frame-already-written";
  }
  if (frameTime !== null) lastFollowWriteByContainer.set(container, { frameTime, endPx });
  container.scrollTop = endPx;
  return "pinned";
}

export function isTranscriptListRevealing(scroller: HTMLElement): boolean {
  const content = scroller.firstElementChild;
  if (!content) return true;
  for (const child of content.children) {
    if (child instanceof HTMLElement && child.style.opacity === "0") return true;
  }
  return false;
}

export function canResumeTranscriptFollow(input: {
  detached: boolean;
  atEnd: boolean;
  userGesture: boolean;
}): boolean {
  return input.atEnd && (!input.detached || input.userGesture);
}
