import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { buildTypedCommandView, buildTypedWebSearchView } from "../../lib/toolCallDetails";
import {
  SubagentLaunchDetails,
  ToolCallDetailsContent,
  TranscriptNoticeDetails,
  TypedCommandDetails,
  TypedWebSearchDetails,
} from "./ToolCallDetailsDialog";

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("TypedCommandDetails", () => {
  it("shows Claude output once and the exit code only in the footer", () => {
    const ticks = "tick1\ntick2\ntick3\n";
    const split = renderToStaticMarkup(
      <TypedCommandDetails
        running={false}
        view={buildTypedCommandView({
          command: { command: "for i in 1 2 3", output: ticks, stdout: ticks, exitCode: 0 },
          status: "completed",
        })}
      />,
    );
    expect(count(split, "tick1")).toBe(1);

    const failed = renderToStaticMarkup(
      <TypedCommandDetails
        running={false}
        view={buildTypedCommandView({
          command: {
            command: "ls /nonexistent",
            output: "Exit code 1\nls: /nonexistent: No such file or directory",
            exitCode: 1,
          },
          status: "failed",
        })}
      />,
    );
    expect(count(failed, "Exit code 1")).toBe(1);
    expect(failed).toContain('data-command-footer="true">Exit code 1<');
  });
});

describe("ToolCallDetailsContent", () => {
  it("does not repeat combined output next to the stdout split", () => {
    const markup = renderToStaticMarkup(
      <ToolCallDetailsContent
        timestampFormat="locale"
        details={{
          kind: "command",
          title: "Bash",
          output: { output: "alpha-line\n", stdout: "alpha-line\n", exitCode: 0 },
        }}
      />,
    );
    expect(count(markup, "alpha-line")).toBe(1);
  });
});

describe("TypedWebSearchDetails", () => {
  it("lists each page once with its title or host and path", () => {
    const markup = renderToStaticMarkup(
      <TypedWebSearchDetails
        view={buildTypedWebSearchView({
          query: "bun",
          results: [
            { url: "https://www.thoughtworks.com/radar/tools/bun" },
            { url: "https://www.thoughtworks.com/radar/tools/bun/" },
            { url: "https://bun.sh/blog/bun-v1.3", title: "Bun 1.3 | Bun Blog" },
          ],
        })}
      />,
    );
    expect(count(markup, 'data-web-search-result-link="true"')).toBe(2);
    expect(markup).toContain(">www.thoughtworks.com/radar/tools/bun<");
    expect(markup).toContain(">Bun 1.3 | Bun Blog<");
  });
});

describe("SubagentLaunchDetails", () => {
  it("shows status, model and prompt as plain text", () => {
    const markup = renderToStaticMarkup(
      <SubagentLaunchDetails
        view={{ status: "Running", model: "sonnet", prompt: "Sleep <75> seconds" }}
      />,
    );
    expect(markup).toContain(">Running<");
    expect(markup).toContain(">sonnet<");
    expect(markup).toContain("Sleep &lt;75&gt; seconds");
  });
});

describe("TranscriptNoticeDetails", () => {
  it("shows the hook body as plain text", () => {
    const markup = renderToStaticMarkup(
      <TranscriptNoticeDetails
        notice={{
          noticeKind: "hook",
          severity: "info",
          status: "completed",
          title: "Ran PostToolUse hook",
          detail: "lint",
          body: "Event: PostToolUse\nMatcher: Bash\nHook: lint\nOutcome: success\nOutput:\n<ok>",
        }}
      />,
    );
    expect(markup).toContain('data-transcript-notice-body="true"');
    expect(markup).toContain("Matcher: Bash");
    expect(markup).toContain("&lt;ok&gt;");
  });
});
