// FILE: ExpandedImageOverlay.tsx
// Purpose: Shared fullscreen image preview overlay.
// Layer: Chat and composer UI component
// Exports: ExpandedImageOverlay

import { useLayoutEffect } from "react";

import { Dialog, DialogPopup } from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "~/lib/icons";
import { notifyNativeSurfaceOcclusionChange } from "~/lib/nativeSurfaceOcclusion";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

interface ExpandedImageOverlayProps {
  readonly expandedImage: ExpandedImagePreview | null;
  readonly onClose: () => void;
  readonly onNavigate: (direction: -1 | 1) => void;
}

export function ExpandedImageOverlay({
  expandedImage,
  onClose,
  onNavigate,
}: ExpandedImageOverlayProps) {
  const expandedImageItem = expandedImage ? expandedImage.images[expandedImage.index] : null;
  const open = expandedImageItem !== null;

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    notifyNativeSurfaceOcclusionChange();
    return notifyNativeSurfaceOcclusionChange;
  }, [open]);

  if (!expandedImage || !expandedImageItem) {
    return null;
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogPopup
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="relative flex max-h-[92vh] w-auto max-w-[92vw] items-center justify-center border-0 bg-transparent shadow-none [-webkit-app-region:no-drag]"
        aria-label="Expanded image preview"
      >
        {expandedImage.images.length > 1 ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="absolute left-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
            aria-label="Previous image"
            onClick={() => onNavigate(-1)}
          >
            <ChevronLeftIcon className="size-5" />
          </Button>
        ) : null}
        <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="absolute right-2 top-2"
            onClick={onClose}
            aria-label="Close image preview"
          >
            <XIcon />
          </Button>
          <img
            src={expandedImageItem.src}
            alt={expandedImageItem.name}
            className="max-h-[86vh] max-w-[92vw] select-none rounded-lg border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] object-contain shadow-2xl"
            draggable={false}
          />
          <p className="mt-2 max-w-[92vw] truncate text-center text-ui leading-snug text-muted-foreground/80">
            {expandedImageItem.name}
            {expandedImage.images.length > 1
              ? ` (${expandedImage.index + 1}/${expandedImage.images.length})`
              : ""}
          </p>
        </div>
        {expandedImage.images.length > 1 ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="absolute right-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
            aria-label="Next image"
            onClick={() => onNavigate(1)}
          >
            <ChevronRightIcon className="size-5" />
          </Button>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
