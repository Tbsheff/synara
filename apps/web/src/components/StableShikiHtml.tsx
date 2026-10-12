import { Fragment, useMemo } from "react";

import {
  appendPlainTextToHighlightedHtml,
  htmlAttributesToReactProps,
  parseShikiHtml,
} from "../lib/shikiHtmlLines";

export function StableShikiHtml(props: { html: string; plainTail: string }) {
  const parsed = useMemo(() => parseShikiHtml(props.html), [props.html]);
  const lines = useMemo(
    () =>
      parsed?.lines.map((line, index) => (
        <Fragment key={index}>
          {index > 0 ? "\n" : null}
          <span
            {...htmlAttributesToReactProps(line.attributes)}
            dangerouslySetInnerHTML={{ __html: line.html }}
          />
        </Fragment>
      )),
    [parsed],
  );
  if (!parsed) {
    return (
      <div
        className="chat-markdown-shiki"
        dangerouslySetInnerHTML={{
          __html: appendPlainTextToHighlightedHtml(props.html, props.plainTail),
        }}
      />
    );
  }
  return (
    <div className="chat-markdown-shiki">
      <pre {...htmlAttributesToReactProps(parsed.preAttributes)}>
        <code {...htmlAttributesToReactProps(parsed.codeAttributes)}>
          {lines}
          {props.plainTail}
        </code>
      </pre>
    </div>
  );
}
