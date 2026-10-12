import { describe, expect, it } from "vitest";

import type { WorkLogLiveActivity } from "../workLog";
import { formatLiveActivityMeta, liveActivityElapsedMs } from "./liveActivityPresentation";

const STARTED_AT = "2026-07-26T14:00:00.000Z";

function runningActivity(overrides: Partial<WorkLogLiveActivity> = {}): WorkLogLiveActivity {
  return {
    state: "running_tool",
    label: "Bash",
    startedAt: STARTED_AT,
    lastActivityAt: "2026-07-26T14:02:11.000Z",
    elapsedSeconds: 131,
    ...overrides,
  };
}

describe("live activity presentation", () => {
  it("renders recent activity and elapsed time from one normalized state", () => {
    const activity = runningActivity();
    const nowMs = Date.parse("2026-07-26T14:02:14.000Z");

    expect(liveActivityElapsedMs(activity, nowMs)).toBe(134_000);
    expect(formatLiveActivityMeta(activity, nowMs)).toBe("Active 3s ago · 2m 14s elapsed");
  });

  it("reports quiet live tools without claiming they are frozen", () => {
    expect(
      formatLiveActivityMeta(
        runningActivity({
          lastActivityAt: "2026-07-26T14:01:44.000Z",
          elapsedSeconds: 104,
        }),
        Date.parse("2026-07-26T14:02:14.000Z"),
      ),
    ).toBe("No activity for 30s · 2m 14s elapsed");
  });

  it("never reports a quiet subagent as idle while it is still running", () => {
    const quietSubagent: WorkLogLiveActivity = {
      state: "running_tool",
      label: "Explore composer model/effort UI",
      startedAt: STARTED_AT,
      lastActivityAt: "2026-07-26T14:00:00.100Z",
    };
    const nowMs = Date.parse("2026-07-26T14:04:55.000Z");

    expect(formatLiveActivityMeta(quietSubagent, nowMs, { subagent: true })).toBe(
      "Subagent working · 4m 55s elapsed",
    );
    // Same activity without the subagent hint keeps the generic idle wording.
    expect(formatLiveActivityMeta(quietSubagent, nowMs)).toBe(
      "No activity for 4m 54s · 4m 55s elapsed",
    );
    // Terminal states are unaffected by the hint.
    expect(
      formatLiveActivityMeta(
        { ...quietSubagent, state: "failed", lastActivityAt: "2026-07-26T14:04:55.000Z" },
        nowMs,
        { subagent: true },
      ),
    ).toBe("Failed in 4m 55s");
  });

  it("keeps progress and terminal states provider-agnostic", () => {
    const completed = runningActivity({
      state: "completed",
      lastActivityAt: "2026-07-26T14:02:14.000Z",
      elapsedSeconds: 134,
      progress: 1,
    });

    // A tool call that simply succeeded says so with its own verb; no status tail.
    expect(formatLiveActivityMeta(completed, Date.parse("2026-07-26T14:03:00.000Z"))).toBeNull();

    expect(
      formatLiveActivityMeta(
        { ...completed, state: "failed" },
        Date.parse("2026-07-26T14:03:00.000Z"),
      ),
    ).toBe("Failed in 2m 14s · 100%");
  });

  it("does not invent elapsed time when a terminal event has no known start", () => {
    const activity: WorkLogLiveActivity = {
      state: "completed",
      label: "Deploy",
      lastActivityAt: "2026-07-26T14:02:14.000Z",
    };

    expect(liveActivityElapsedMs(activity, Date.parse("2026-07-26T14:03:00.000Z"))).toBeNull();
    expect(formatLiveActivityMeta(activity, Date.parse("2026-07-26T14:03:00.000Z"))).toBeNull();
  });

  it("states a settled outcome with its duration, preferring the tool's own duration", () => {
    const failed: WorkLogLiveActivity = {
      state: "failed",
      label: "Bash",
      startedAt: STARTED_AT,
      lastActivityAt: "2026-07-26T14:00:00.400Z",
    };
    const nowMs = Date.parse("2026-07-26T14:03:00.000Z");

    expect(formatLiveActivityMeta(failed, nowMs)).toBe("Failed in 0s");
    expect(formatLiveActivityMeta(failed, nowMs, { settledDurationMs: 65_000 })).toBe(
      "Failed in 1m 5s",
    );
    expect(formatLiveActivityMeta({ ...failed, state: "cancelled" }, nowMs)).toBe(
      "Cancelled after 0s",
    );
    expect(
      formatLiveActivityMeta({ state: "failed", label: "Grep", lastActivityAt: STARTED_AT }, nowMs),
    ).toBe("Failed");
  });

  it("counts idle time from the newest live output, not only lifecycle events", () => {
    const activity = runningActivity({ lastActivityAt: "2026-07-26T14:01:00.000Z" });
    const nowMs = Date.parse("2026-07-26T14:02:14.000Z");

    expect(
      formatLiveActivityMeta(activity, nowMs, { lastOutputAt: "2026-07-26T14:02:14.000Z" }),
    ).toBe("Active now · 3m 25s elapsed");
    expect(
      formatLiveActivityMeta(activity, nowMs, { lastOutputAt: "2026-07-26T14:02:10.000Z" }),
    ).toBe("Active 4s ago · 3m 25s elapsed");
    expect(
      formatLiveActivityMeta(activity, nowMs, { lastOutputAt: "2026-07-26T13:00:00.000Z" }),
    ).toBe("No activity for 1m 14s · 3m 25s elapsed");
  });
});
