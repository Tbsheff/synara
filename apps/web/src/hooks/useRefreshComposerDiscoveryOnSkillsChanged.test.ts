import { EventId, type OrchestrationThreadActivity } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  composerDiscoveryQueryKeysForProvider,
  hasNewSkillsChangedNotice,
  skillsChangedNoticeFingerprints,
} from "./useRefreshComposerDiscoveryOnSkillsChanged";

function activity(
  id: string,
  kind: string,
  payload: OrchestrationThreadActivity["payload"],
  createdAt = "2026-10-10T00:00:00.000Z",
): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(id),
    createdAt,
    kind,
    summary: "Commands and skills updated",
    tone: "info",
    payload,
    turnId: null,
  };
}

describe("skillsChangedNoticeFingerprints", () => {
  it("collects only skills-changed transcript notices", () => {
    const fingerprints = skillsChangedNoticeFingerprints({
      a: activity("a", "transcript.notice", { noticeKind: "skills-changed", detail: "3 commands" }),
      b: activity("b", "transcript.notice", { noticeKind: "mcp-status" }),
      c: activity("c", "tool.completed", { noticeKind: "skills-changed" }),
    });
    expect(fingerprints.size).toBe(1);
  });

  it("detects an upserted notice whose detail changed", () => {
    const before = skillsChangedNoticeFingerprints({
      a: activity("a", "transcript.notice", { noticeKind: "skills-changed", detail: "3 commands" }),
    });
    const reloaded = skillsChangedNoticeFingerprints({
      a: activity("a", "transcript.notice", { noticeKind: "skills-changed", detail: "3 commands" }),
    });
    const upserted = skillsChangedNoticeFingerprints({
      a: activity("a", "transcript.notice", { noticeKind: "skills-changed", detail: "4 commands" }),
    });
    expect(hasNewSkillsChangedNotice(before, reloaded)).toBe(false);
    expect(hasNewSkillsChangedNotice(before, upserted)).toBe(true);
    expect(hasNewSkillsChangedNotice(before, new Set())).toBe(false);
  });
});

describe("composerDiscoveryQueryKeysForProvider", () => {
  it("targets the provider's command and skill lists only", () => {
    expect(composerDiscoveryQueryKeysForProvider("claudeAgent")).toEqual([
      ["provider-discovery", "commands", "claudeAgent"],
      ["provider-discovery", "skills", "claudeAgent"],
    ]);
  });
});
