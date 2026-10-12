import { Fragment } from "react";

import { htmlAttributesToReactProps, parseShikiHtml } from "../lib/shikiHtmlLines";

export function StableShikiHtml(props: { html: string; plainTail: string; combinedHtml: string }) {
  const parsed = parseShikiHtml(props.html);
  if (!parsed) {
    return (
      <div
        className="chat-markdown-shiki"
        dangerouslySetInnerHTML={{ __html: props.combinedHtml }}
      />
    );
  }
  return (
    <div className="chat-markdown-shiki">
      <pre {...htmlAttributesToReactProps(parsed.preAttributes)}>
        <code {...htmlAttributesToReactProps(parsed.codeAttributes)}>
          {parsed.lines.map((line, index) => (
            <Fragment key={index}>
              {index > 0 ? "\n" : null}
              <span
                {...htmlAttributesToReactProps(line.attributes)}
                dangerouslySetInnerHTML={{ __html: line.html }}
              />
            </Fragment>
          ))}
          {props.plainTail}
        </code>
      </pre>
    </div>
  );
}
