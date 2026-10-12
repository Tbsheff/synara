import { addWsTransportStateListener } from "../wsTransportEvents";

export const TRANSPORT_OUTAGE_NOTICE_DELAY_MS = 1_500;

/** Delay outage notices, but clear them immediately on recovery. Only owns UI timers. */
export function subscribeComposerTransportStatus(listener: (message: string | null) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let message: string | null = null;
  let visible = false;
  const cancelTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const unsubscribe = addWsTransportStateListener(
    (state) => {
      message =
        state === "open"
          ? null
          : state === "incompatible"
            ? "Synara connection is incompatible."
            : state === "disposed"
              ? "Disconnected from Synara."
              : "Reconnecting to Synara…";
      if (message === null) {
        cancelTimer();
        if (visible) listener(null);
        visible = false;
      } else if (visible) {
        listener(message);
      } else if (timer === undefined) {
        // Closed/connecting transitions are one continuous outage, not fresh blips.
        timer = setTimeout(() => {
          timer = undefined;
          visible = true;
          listener(message);
        }, TRANSPORT_OUTAGE_NOTICE_DELAY_MS);
      }
    },
    { replayCurrent: true },
  );
  return () => {
    unsubscribe();
    cancelTimer();
  };
}
