import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThreadErrorBanner } from "./ThreadErrorBanner";

describe("failure recovery advice", () => {
  it.each([
    ["Codex CLI is not authenticated.", "Sign in"],
    ["Claude CLI is not installed or not on PATH.", "Install"],
    ["Connection closed while waiting for a response", "Retry"],
    ["Rate limit exceeded (429)", "Wait"],
  ])("gives a cause-based next step for %s", (error, advice) => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error={error} onContinue={() => undefined} />,
    );
    expect(markup).toContain('data-thread-error-recovery="true"');
    expect(markup).toContain(advice);
  });
  it("does not guess a cause for an unknown provider error", () => {
    expect(
      renderToStaticMarkup(<ThreadErrorBanner error="Unknown provider failure" />),
    ).not.toContain('data-thread-error-recovery="true"');
  });
});
