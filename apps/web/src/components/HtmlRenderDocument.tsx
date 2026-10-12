import {
  buildHtmlRenderSrcdoc,
  HTML_RENDER_SANDBOX,
  htmlRenderThemeMessage,
  readHtmlRenderContentHeight,
} from "@synara/shared/htmlRender";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";
import { cn } from "~/lib/utils";

export function HtmlRenderDocument(props: {
  readonly html: string;
  readonly title: string;
  readonly className?: string;
  readonly height?: number;
  readonly onContentHeight?: (height: number) => void;
  readonly onError?: () => void;
}) {
  const theme = useHtmlRenderTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [initialTheme] = useState(theme);
  const srcdoc = useMemo(
    () => buildHtmlRenderSrcdoc(props.html, initialTheme),
    [props.html, initialTheme],
  );
  const postTheme = () =>
    frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), "*");
  useEffect(postTheme, [theme]);
  const { onContentHeight } = props;
  useLayoutEffect(() => {
    if (!onContentHeight) return;
    const onMessage = (event: MessageEvent<unknown>) => {
      const height = readHtmlRenderContentHeight(event, frameRef.current?.contentWindow);
      if (height !== undefined) onContentHeight(height);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onContentHeight]);
  return (
    <iframe
      ref={frameRef}
      srcDoc={srcdoc}
      title={props.title}
      sandbox={HTML_RENDER_SANDBOX}
      referrerPolicy="no-referrer"
      className={cn("block w-full border-0", props.className)}
      style={{ colorScheme: theme.appearance, height: props.height ?? "100%" }}
      onLoad={postTheme}
      onError={props.onError}
    />
  );
}
