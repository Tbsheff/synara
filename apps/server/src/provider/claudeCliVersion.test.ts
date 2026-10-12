import { describe, expect, it } from "vitest";

import {
  isClaudeThinkingDisplayCliVersionSupported,
  MINIMUM_CLAUDE_THINKING_DISPLAY_CLI_VERSION,
} from "./claudeCliVersion.ts";

describe("isClaudeThinkingDisplayCliVersionSupported", () => {
  it.each([
    [MINIMUM_CLAUDE_THINKING_DISPLAY_CLI_VERSION, true],
    ["2.1.296", true],
    ["2.2.0", true],
    ["2.1.258", false],
    ["2.0.99", false],
    [null, false],
  ])("treats %s as supported: %s", (version, supported) => {
    expect(isClaudeThinkingDisplayCliVersionSupported(version)).toBe(supported);
  });
});
