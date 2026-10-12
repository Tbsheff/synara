import { memo, useMemo, useState } from "react";

import { renderPendingDisplayMath } from "../../lib/pendingDisplayMath";

export const PendingDisplayMath = memo(function PendingDisplayMath({ tex }: { tex: string }) {
  const [lastRenderedHtml, setLastRenderedHtml] = useState<string | null>(null);
  const renderedHtml = useMemo(() => renderPendingDisplayMath(tex), [tex]);
  if (renderedHtml !== null && renderedHtml !== lastRenderedHtml) {
    setLastRenderedHtml(renderedHtml);
  }
  const html = renderedHtml ?? lastRenderedHtml;
  if (html === null) return <div className="chat-markdown-pending-math" />;
  return <div className="chat-markdown-pending-math" dangerouslySetInnerHTML={{ __html: html }} />;
});
