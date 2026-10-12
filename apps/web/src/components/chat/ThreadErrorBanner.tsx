// FILE: ThreadErrorBanner.tsx
// Purpose: Presents runtime errors and persistent turn failures with recovery actions.
// Layer: Chat status presentation
// Exports: ThreadErrorBanner
//
// Live session errors sit above the transcript; durable turn failures reuse
// the same banner inside the timeline. Threads off screen still toast live
// session errors via useThreadErrorToast.

import { isProviderDeliveryBlockDetail } from "@synara/shared/providerDeliveryBlock";
import { pluralize } from "@synara/shared/text";
import { useId, useLayoutEffect, useRef, useState } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { CopyTextButton } from "../ui/copyTextButton";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { IconButton } from "../ui/icon-button";
import { CircleAlertIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import type { ProviderErrorDetail } from "../../workLog";

const PROVIDER_STOP_REASON_TITLES: Readonly<Record<string, string>> = {
  error_max_turns: "Stopped: max turns reached",
  error_max_budget_usd: "Stopped: budget limit reached",
  error_max_structured_output_retries: "Stopped: structured output retries exhausted",
  error_during_execution: "Stopped: error during execution",
};

export function providerStopReasonTitle(stopReason: string | undefined): string | undefined {
  return stopReason === undefined ? undefined : PROVIDER_STOP_REASON_TITLES[stopReason];
}

function providerErrorDetailLines(detail: ProviderErrorDetail | undefined): string[] {
  if (!detail) return [];
  const lines = [...(detail.errors ?? [])];
  if (detail.errorsTruncated) lines.push("More errors were omitted.");
  if (detail.permissionDenials) {
    const count = detail.permissionDenials;
    lines.push(
      `${count} ${pluralize(count, "tool call was", "tool calls were")} denied permission.`,
    );
  }
  if (detail.terminalReason) lines.push(`Reason: ${detail.terminalReason}`);
  return lines;
}

function providerRecoveryAdvice(error: string): string | null {
  if (
    /not authenticated|unauthenticated|authentication (?:failed|required)|invalid api key|token expired|401\b/i.test(
      error,
    )
  ) {
    return "Sign in to this provider in Settings, then continue the task.";
  }
  if (/not installed|not on PATH|(?:spawn|executable).*ENOENT|CLI.*not found/i.test(error)) {
    return "Install this provider's CLI or set its path in Settings, then continue the task.";
  }
  if (/rate limit|too many requests|429\b/i.test(error)) {
    return "Wait for the provider's rate limit to reset, then continue the task.";
  }
  if (
    /connection (?:closed|lost|refused)|network|timed? out|timeout|ECONNRESET|ETIMEDOUT/i.test(
      error,
    )
  ) {
    return "Retry after you check the connection. The task may have stopped before its result arrived.";
  }
  return null;
}

type ThreadErrorBannerProps = {
  error: string | null;
  title?: string;
  stopReason?: string;
  detail?: ProviderErrorDetail;
  onContinue?: () => void;
  onChangeModel?: () => void;
  recoveryDisabled?: boolean;
  onDismiss?: () => void;
  /** Recovery action offered only when the error is a provider-delivery quarantine. */
  onUnblock?: () => void;
  unblocking?: boolean;
  className?: string;
};

export function ThreadErrorBanner(props: ThreadErrorBannerProps) {
  if (!props.error) return null;
  // A different failure starts collapsed, with fresh copy feedback.
  return <ThreadErrorBannerContent key={props.error} {...props} error={props.error} />;
}

function ThreadErrorBannerContent({
  error,
  title: fallbackTitle,
  stopReason,
  detail,
  onContinue,
  onChangeModel,
  recoveryDisabled,
  onDismiss,
  onUnblock,
  unblocking,
  className,
}: ThreadErrorBannerProps & { error: string }) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const detailsId = useId();
  // Offer "Show details" only when the collapsed text actually hides something.
  useLayoutEffect(() => {
    const node = textRef.current;
    if (!node || expanded) return;
    const measure = () => setClamped(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [error, expanded]);
  const canUnblock = onUnblock !== undefined && isProviderDeliveryBlockDetail(error);
  const title = providerStopReasonTitle(stopReason) ?? fallbackTitle;
  const advice = providerRecoveryAdvice(error);
  const detailLines = providerErrorDetailLines(detail);
  const copyText = detailLines.length > 0 ? [error, ...detailLines].join("\n") : error;
  return (
    <Alert variant="error" className={cn("w-full max-w-[36rem] shadow-sm", className)}>
      <CircleAlertIcon />
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      <AlertDescription className="min-w-0">
        <p
          ref={textRef}
          id={detailsId}
          className={cn(
            "whitespace-pre-wrap [overflow-wrap:anywhere]",
            expanded ? "max-h-60 overflow-y-auto" : "line-clamp-3",
          )}
          tabIndex={expanded ? 0 : undefined}
        >
          {error}
        </p>
        {advice ? (
          <p className="text-ui-sm" data-thread-error-recovery="true">
            {advice}
          </p>
        ) : null}
        {expanded && detailLines.length > 0 ? (
          <ul className="space-y-0.5 text-ui-xs" data-thread-error-detail="true">
            {detailLines.map((line, index) => (
              <li key={index} className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                {line}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-center gap-1">
          {clamped || expanded || detailLines.length > 0 ? (
            <Button
              size="xs"
              variant="ghost"
              aria-expanded={expanded}
              aria-controls={detailsId}
              onClick={() => setExpanded((value) => !value)}
            >
              <DisclosureChevron open={expanded} />
              {expanded ? "Hide details" : "Show details"}
            </Button>
          ) : null}
          <CopyTextButton text={copyText} label="error" />
          {onContinue ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={recoveryDisabled}
              onClick={onContinue}
            >
              Continue task
            </Button>
          ) : null}
          {onContinue && onChangeModel ? (
            <Button size="xs" variant="outline" disabled={recoveryDisabled} onClick={onChangeModel}>
              Change model
            </Button>
          ) : null}
          {canUnblock ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={unblocking}
              onClick={() => onUnblock?.()}
            >
              {unblocking ? "Unblocking…" : "Unblock thread"}
            </Button>
          ) : null}
        </div>
      </AlertDescription>
      {onDismiss ? (
        <AlertAction className="items-center">
          <IconButton
            label="Dismiss error"
            className="size-6 text-destructive/60 hover:text-destructive sm:size-6"
            onClick={onDismiss}
          >
            <XIcon className="size-3.5" />
          </IconButton>
        </AlertAction>
      ) : null}
    </Alert>
  );
}
