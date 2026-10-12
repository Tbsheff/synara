import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { syncAnimationsToTimelineOrigin } from "~/lib/animationTimelineSync";
import { DISCLOSURE_CLEANUP_BUFFER_MS, DISCLOSURE_TRANSITION_MS } from "~/lib/disclosureMotion";
import { ActivityLoadingIcon, MessageDeliveryCheckIcon, ThinkingIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "~/surfaceStyles";
import {
  isFreeTextWorkingLabel,
  isProgressStepWorkingLabel,
  paceWorkingLabel,
  type WorkingLabel,
  type WorkingLabelPacing,
} from "../ChatView.logic";
import { MESSAGE_ACTION_ICON_CLASS_NAME } from "./MessageActionButton";
import { renderWorkEntryIcon } from "./TimelineWorkEntryRow";

function workingLabelIcon(label: WorkingLabel) {
  if (label === "Checking message delivery…") return MessageDeliveryCheckIcon;
  return isProgressStepWorkingLabel(label) ? ActivityLoadingIcon : ThinkingIcon;
}

function useSteadyWorkingLabel(target: WorkingLabel): WorkingLabel {
  const [pacing, setPacing] = useState<WorkingLabelPacing>(() => ({
    shown: target,
    shownAtMs: performance.now(),
  }));

  useEffect(() => {
    const step = paceWorkingLabel(pacing, target, performance.now());
    if (step.pacing !== pacing) {
      setPacing(step.pacing);
      return;
    }
    if (step.retryAtMs === null) return;
    const retryAtMs = step.retryAtMs;
    const retry = window.setTimeout(
      () =>
        setPacing(
          (current) =>
            paceWorkingLabel(current, target, Math.max(performance.now(), retryAtMs)).pacing,
        ),
      Math.max(0, retryAtMs - performance.now()),
    );
    return () => window.clearTimeout(retry);
  }, [pacing, target]);

  return pacing.shown;
}

function useOutgoingWorkingLabel(shown: WorkingLabel): WorkingLabel | null {
  const [labels, setLabels] = useState<{ shown: WorkingLabel; outgoing: WorkingLabel | null }>({
    shown,
    outgoing: null,
  });
  if (labels.shown !== shown) {
    setLabels({ shown, outgoing: labels.shown });
  }

  useEffect(() => {
    if (labels.outgoing === null) return;
    const cleanup = window.setTimeout(
      () => setLabels((current) => ({ ...current, outgoing: null })),
      DISCLOSURE_TRANSITION_MS + DISCLOSURE_CLEANUP_BUFFER_MS,
    );
    return () => window.clearTimeout(cleanup);
  }, [labels]);

  return labels.outgoing;
}

function growStatusLineMinWidth(
  line: HTMLElement | null,
  setMinWidthPx: Dispatch<SetStateAction<number>>,
): void {
  if (!line) return;
  const widthPx = Math.ceil(line.getBoundingClientRect().width);
  setMinWidthPx((current) => (widthPx > current ? widthPx : current));
}

export function WorkingStatusLine({
  label,
  fontSizePx,
}: {
  label: WorkingLabel;
  fontSizePx: number;
}) {
  const shown = useSteadyWorkingLabel(label);
  const outgoing = useOutgoingWorkingLabel(shown);
  const lineRef: RefObject<HTMLDivElement | null> = useRef(null);
  const [minWidthPx, setMinWidthPx] = useState(0);
  const attachLine = useCallback((element: HTMLDivElement | null) => {
    lineRef.current = element;
    syncAnimationsToTimelineOrigin(element);
  }, []);

  useLayoutEffect(() => {
    growStatusLineMinWidth(lineRef.current, setMinWidthPx);
  }, [shown, outgoing, fontSizePx]);

  const freeText =
    isFreeTextWorkingLabel(shown) || (outgoing !== null && isFreeTextWorkingLabel(outgoing));

  return (
    <div
      ref={attachLine}
      className={cn(
        "shimmer-group flex w-fit items-center gap-1.5 pt-0.5 font-system-ui",
        freeText && "max-w-full min-w-0",
        MUTED_LABEL_TEXT_CLASS_NAME,
      )}
      style={{
        fontSize: `${fontSizePx}px`,
        ...(minWidthPx > 0 ? { minWidth: `min(${minWidthPx}px, 100%)` } : {}),
      }}
    >
      <span aria-hidden="true" className="flex shrink-0">
        {renderWorkEntryIcon(workingLabelIcon(shown), MESSAGE_ACTION_ICON_CLASS_NAME)}
      </span>
      <span className="grid min-w-0 [&>*]:col-start-1 [&>*]:row-start-1">
        {outgoing !== null ? (
          <span
            key={`label:${outgoing}`}
            aria-hidden="true"
            className="min-w-0 truncate opacity-0 transition-opacity duration-220 ease-out motion-reduce:transition-none"
          >
            {outgoing}
          </span>
        ) : null}
        <span
          key={`label:${shown}`}
          data-working-label-current="true"
          className={cn("min-w-0 truncate", outgoing !== null && "chat-fade-enter")}
          {...(isFreeTextWorkingLabel(shown) ? { title: shown } : {})}
        >
          {shown}
        </span>
      </span>
    </div>
  );
}
