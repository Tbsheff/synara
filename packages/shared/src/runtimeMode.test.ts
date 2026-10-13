import { describe, expect, it } from "vitest";

import {
  normalizeRuntimeModeForProvider,
  providerSupportsAutoRuntimeMode,
  runtimeModeEscalatesPrivilege,
  providerSupportsAcceptEditsRuntimeMode,
  runtimeModeSelectionIssue,
} from "./runtimeMode";

describe("runtime mode compatibility", () => {
  it("limits Auto to providers with a native reviewer", () => {
    expect(providerSupportsAutoRuntimeMode("codex")).toBe(true);
    expect(providerSupportsAutoRuntimeMode("claudeAgent")).toBe(true);
    expect(providerSupportsAutoRuntimeMode("opencode")).toBe(false);
    expect(providerSupportsAutoRuntimeMode("cursor")).toBe(false);
  });

  it("normalizes only unsupported Auto selections", () => {
    expect(normalizeRuntimeModeForProvider("auto", "opencode")).toBe("approval-required");
    expect(normalizeRuntimeModeForProvider("approval-required", "opencode")).toBe(
      "approval-required",
    );
    expect(normalizeRuntimeModeForProvider("full-access", "opencode")).toBe("full-access");
  });

  it("treats Auto as more privileged than Supervised but less privileged than Full access", () => {
    expect(runtimeModeEscalatesPrivilege("approval-required", "auto")).toBe(true);
    expect(runtimeModeEscalatesPrivilege("auto", "full-access")).toBe(true);
    expect(runtimeModeEscalatesPrivilege("auto", "approval-required")).toBe(false);
  });
});

it("keeps Accept edits scoped to Claude and below Auto privilege", () => {
  expect(providerSupportsAcceptEditsRuntimeMode("claudeAgent")).toBe(true);
  expect(providerSupportsAcceptEditsRuntimeMode("codex")).toBe(false);
  expect(normalizeRuntimeModeForProvider("accept-edits", "codex")).toBe("approval-required");
  expect(normalizeRuntimeModeForProvider("accept-edits", "claudeAgent")).toBe("accept-edits");
  expect(
    runtimeModeSelectionIssue({
      runtimeMode: "accept-edits",
      modelSelection: { provider: "codex", model: "gpt-5.5" },
    }),
  ).toContain("does not support Accept edits");
  expect(runtimeModeEscalatesPrivilege("approval-required", "accept-edits")).toBe(true);
  expect(runtimeModeEscalatesPrivilege("accept-edits", "auto")).toBe(true);
  expect(runtimeModeEscalatesPrivilege("accept-edits", "full-access")).toBe(true);
  expect(runtimeModeEscalatesPrivilege("accept-edits", "approval-required")).toBe(false);
});
