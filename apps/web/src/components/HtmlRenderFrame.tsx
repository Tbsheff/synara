import type { HtmlRenderDocument as HtmlDocument } from "@synara/contracts";
import { clampHtmlRenderHeight, htmlRenderFrameHeight } from "@synara/shared/htmlRender";
import { useState } from "react";

import { INLINE_HTML_RENDER_ON } from "../betaFeatures";
import { Maximize2 } from "~/lib/icons";
import { HtmlRenderDocument } from "./HtmlRenderDocument";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "./ui/dialog";
import { IconButton } from "./ui/icon-button";

export function HtmlRenderFrame({ document }: { readonly document: HtmlDocument }) {
  const [open, setOpen] = useState(false);
  const [contentHeight, setContentHeight] = useState<number>();
  const [failed, setFailed] = useState(false);
  if (!INLINE_HTML_RENDER_ON) return null;
  const height = clampHtmlRenderHeight(document.height);
  return (
    <>
      <div className="group/html-render relative w-full" data-html-render-frame style={{ height }}>
        {failed ? (
          <p className="flex h-full items-center justify-center text-ui-sm text-muted-foreground">
            Unable to load {document.title}
          </p>
        ) : (
          <HtmlRenderDocument
            html={document.html}
            title={document.title}
            className="absolute inset-x-0 top-0"
            height={htmlRenderFrameHeight(height, contentHeight)}
            onContentHeight={setContentHeight}
            onError={() => setFailed(true)}
          />
        )}
        <div className="absolute end-2 top-2 opacity-0 focus-within:opacity-100 group-hover/html-render:opacity-100 pointer-coarse:opacity-100">
          <IconButton
            label="Open in panel"
            tooltip="Open in panel"
            onClick={() => setOpen(true)}
            variant="outline"
            size="icon-sm"
          >
            <Maximize2 className="size-4" />
          </IconButton>
        </div>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="h-[85dvh] max-w-6xl" bottomStickOnMobile={false}>
          <DialogHeader>
            <DialogTitle className="text-ui-lg">{document.title}</DialogTitle>
          </DialogHeader>
          <HtmlRenderDocument
            html={document.html}
            title={document.title}
            className="min-h-0 flex-1"
          />
        </DialogPopup>
      </Dialog>
    </>
  );
}
