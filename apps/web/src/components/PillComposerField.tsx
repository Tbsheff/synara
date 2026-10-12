import type { ReactNode } from "react";

import { ArrowUpIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { GLASS_RAISED_SURFACE_CLASS_NAME } from "~/surfaceStyles";
import { PR_BODY_TEXT_CLASS_NAME } from "./pullRequest/pullRequestText";

const PILL_COMPOSER_MAX_ROWS = 6;

export function PillComposerField({
  value,
  onValueChange,
  onSubmit,
  canSubmit,
  disabled,
  placeholder,
  ariaLabel,
  submitLabel,
  leading,
  actions,
  maxLength,
}: {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  canSubmit: boolean;
  disabled: boolean;
  placeholder: string;
  ariaLabel: string;
  submitLabel: string;
  leading?: ReactNode;
  actions?: ReactNode;
  maxLength?: number;
}) {
  return (
    <div
      className={`${GLASS_RAISED_SURFACE_CLASS_NAME} flex items-center gap-2 rounded-3xl border border-border/60 bg-background py-1 pl-3 pr-1.5 shadow-sm`}
    >
      {leading}
      <textarea
        rows={Math.min(PILL_COMPOSER_MAX_ROWS, value.split("\n").length)}
        value={value}
        maxLength={maxLength}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          const confirmsImeComposition = event.nativeEvent.isComposing;
          if (event.key === "Enter" && !event.shiftKey && !confirmsImeComposition) {
            event.preventDefault();
            onSubmit();
          }
        }}
        className={cn(
          PR_BODY_TEXT_CLASS_NAME,
          "font-system-ui min-w-0 flex-1 resize-none bg-transparent py-1.5 outline-none placeholder:text-muted-foreground disabled:opacity-60",
        )}
      />
      {actions}
      <button
        type="button"
        disabled={!canSubmit}
        aria-label={submitLabel}
        title={submitLabel}
        onClick={onSubmit}
        className="flex size-7 shrink-0 items-center justify-center self-end rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-35"
      >
        <ArrowUpIcon className="size-4" />
      </button>
    </div>
  );
}
