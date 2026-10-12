import type {
  CloudCapabilities,
  CloudRequestId,
  CloudSubmission,
  CloudTask,
  CloudTaskId,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  cloudAttemptOptions,
  cloudCapabilityNotice,
  cloudEnvironmentSuggestions,
  cloudErrorMessage,
  cloudNoDiffReason,
  cloudTaskStatusPresentation,
  compareCliVersions,
  currentBranchName,
  isCloudTaskTerminal,
  mergeCloudEntries,
  shouldLoadCloudDiff,
  withLatestTask,
} from "./cloud.logic";

function task(overrides: Omit<Partial<CloudTask>, "id"> & { id: string }): CloudTask {
  return {
    provider: "codex",
    url: `https://chatgpt.com/codex/tasks/${overrides.id}`,
    title: `Task ${overrides.id}`,
    status: "pending",
    rawStatus: null,
    updatedAt: "2026-10-10T10:00:00.000Z",
    environmentId: null,
    environmentLabel: "web",
    diffSummary: null,
    attemptTotal: null,
    isReview: false,
    ...overrides,
    id: overrides.id as CloudTaskId,
  } as CloudTask;
}

function submission(
  overrides: Omit<Partial<CloudSubmission>, "requestId"> & { requestId: string },
): CloudSubmission {
  return {
    provider: "codex",
    projectId: null,
    environment: "web",
    branch: "main",
    promptSummary: "Fix the flaky test",
    state: "submitted",
    taskId: null,
    taskUrl: null,
    lastStatus: null,
    errorDetail: null,
    createdAt: "2026-10-10T09:00:00.000Z",
    updatedAt: "2026-10-10T09:00:00.000Z",
    ...overrides,
    requestId: overrides.requestId as CloudRequestId,
  } as CloudSubmission;
}

function capabilities(overrides: Partial<CloudCapabilities>): CloudCapabilities {
  return {
    provider: "codex",
    executablePath: "/usr/local/bin/codex",
    cliVersion: "0.170.0",
    available: true,
    unavailableKind: null,
    unavailableReason: null,
    canSubmit: true,
    canList: true,
    canStatus: true,
    canDiff: true,
    canApply: true,
    canFollowUp: false,
    canCancel: false,
    canListEnvironments: true,
    maxAttempts: 4,
    ...overrides,
  };
}

describe("cloud status presentation", () => {
  it("maps each task status to a Tasks chip tone", () => {
    expect(cloudTaskStatusPresentation("pending")).toEqual({ kind: "running", label: "Running" });
    expect(cloudTaskStatusPresentation("ready")).toEqual({ kind: "review", label: "Ready" });
    expect(cloudTaskStatusPresentation("error").kind).toBe("stopped");
    expect(cloudTaskStatusPresentation("cancelled").kind).toBe("starting");
    expect(cloudTaskStatusPresentation("unknown").kind).toBe("starting");
  });

  it("treats ready, error and cancelled as terminal", () => {
    expect(isCloudTaskTerminal("ready")).toBe(true);
    expect(isCloudTaskTerminal("cancelled")).toBe(true);
    expect(isCloudTaskTerminal("pending")).toBe(false);
    expect(isCloudTaskTerminal("unknown")).toBe(false);
    expect(isCloudTaskTerminal(undefined)).toBe(false);
  });
});

describe("mergeCloudEntries", () => {
  it("joins a submission to its listed task once and keeps the submission branch", () => {
    const entries = mergeCloudEntries({
      provider: "codex",
      submissions: [submission({ requestId: "r1", taskId: "t1" as CloudTaskId, branch: "dev" })],
      tasks: [task({ id: "t1", status: "ready" }), task({ id: "t1" })],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: "task:t1",
      branch: "dev",
      taskStatus: "ready",
      status: { label: "Ready" },
    });
  });

  it("keeps uncertain and failed submissions with their reason", () => {
    const entries = mergeCloudEntries({
      provider: "codex",
      submissions: [
        submission({ requestId: "r1", state: "uncertain", errorDetail: "The CLI timed out." }),
        submission({ requestId: "r2", state: "failed", errorDetail: "Bad environment." }),
      ],
      tasks: [],
    });
    expect(entries.map((entry) => [entry.key, entry.status.label, entry.problem])).toEqual([
      ["submission:r1", "Uncertain", "The CLI timed out."],
      ["submission:r2", "Failed", "Bad environment."],
    ]);
  });

  it("drops other providers and sorts by newest update", () => {
    const entries = mergeCloudEntries({
      provider: "codex",
      submissions: [submission({ requestId: "r9", provider: "claude" })],
      tasks: [
        task({ id: "old", updatedAt: "2026-10-01T00:00:00.000Z" }),
        task({ id: "new", updatedAt: "2026-10-09T00:00:00.000Z" }),
        task({ id: "none", updatedAt: null }),
      ],
    });
    expect(entries.map((entry) => entry.key)).toEqual(["task:new", "task:old", "task:none"]);
  });

  it("refreshes an entry from the latest polled task", () => {
    const [entry] = mergeCloudEntries({
      provider: "codex",
      submissions: [],
      tasks: [task({ id: "t1" })],
    });
    const refreshed = withLatestTask(entry!, task({ id: "t1", status: "error" }));
    expect(refreshed.status.label).toBe("Error");
    expect(withLatestTask(entry!, task({ id: "other", status: "ready" }))).toBe(entry);
  });
});

describe("diff loading", () => {
  it("loads a diff only for ready tasks with changes and the diff capability", () => {
    const [ready] = mergeCloudEntries({
      provider: "codex",
      submissions: [],
      tasks: [
        task({
          id: "t1",
          status: "ready",
          diffSummary: { filesChanged: 2, linesAdded: 3, linesRemoved: 1 },
        }),
      ],
    });
    const [empty] = mergeCloudEntries({
      provider: "codex",
      submissions: [],
      tasks: [
        task({
          id: "t2",
          status: "ready",
          diffSummary: { filesChanged: 0, linesAdded: 0, linesRemoved: 0 },
        }),
      ],
    });
    expect(shouldLoadCloudDiff(ready!, true)).toBe(true);
    expect(shouldLoadCloudDiff(ready!, false)).toBe(false);
    expect(shouldLoadCloudDiff(empty!, true)).toBe(false);
  });

  it("reads the no-diff reason from the server error", () => {
    expect(
      cloudNoDiffReason({
        code: "CloudNoDiffError",
        message: "codex cloud task t1 has no diff (not-ready).",
      }),
    ).toBe("not-ready");
    expect(cloudNoDiffReason({ code: "CloudCliFailedError", message: "boom" })).toBeNull();
  });
});

describe("capability notice", () => {
  it("names the old version, path and minimum when Codex is too old", () => {
    const notice = cloudCapabilityNotice(
      capabilities({
        available: false,
        cliVersion: "0.150.0",
        unavailableKind: "too-old",
      }),
    );
    expect(notice?.detail).toBe(
      "Codex CLI 0.150.0 at /usr/local/bin/codex is too old. Cloud needs 0.162.0 or newer. Update Codex or set SYNARA_CLOUD_CODEX_BIN to a newer binary.",
    );
  });

  it("explains a missing CLI and stays quiet when everything works", () => {
    expect(
      cloudCapabilityNotice(
        capabilities({
          available: false,
          executablePath: null,
          cliVersion: null,
          unavailableKind: "not-found",
        }),
      )?.title,
    ).toBe("Codex CLI not found");
    expect(cloudCapabilityNotice(capabilities({}))).toBeNull();
  });

  it("compares CLI versions numerically", () => {
    expect(compareCliVersions("0.162.0", "0.162.0")).toBe(0);
    expect(compareCliVersions("codex-cli 0.99.1", "0.162.0")).toBe(-1);
    expect(compareCliVersions("1.0.0", "0.162.0")).toBe(1);
    expect(compareCliVersions("dev", "0.162.0")).toBeNull();
  });
});

describe("errors and form helpers", () => {
  it("turns server error codes into readable text", () => {
    expect(cloudErrorMessage({ code: "CLOUD_AGENTS_UNAVAILABLE", message: "x" })).toBe(
      "Cloud agents are available in Synara Beta.",
    );
    expect(cloudErrorMessage({ code: "CloudSubmitInFlightError", message: "x" })).toMatch(
      /still running/,
    );
    expect(cloudErrorMessage(new Error("plain failure"))).toBe("plain failure");
  });

  it("builds attempts, environment suggestions and the current branch", () => {
    expect(cloudAttemptOptions(0)).toEqual([1]);
    expect(cloudAttemptOptions(9)).toEqual([1, 2, 3, 4]);
    expect(
      cloudEnvironmentSuggestions([
        { id: "env_1", label: "web" },
        { id: null, label: "web" },
        { id: "env_2", label: null },
      ]),
    ).toEqual(["env_1", "web", "env_2"]);
    expect(
      currentBranchName([
        { name: "origin/main", current: true, isRemote: true },
        { name: "feature", current: true },
      ]),
    ).toBe("feature");
  });
});
