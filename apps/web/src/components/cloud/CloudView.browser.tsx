import "../../index.css";

import type {
  CloudCapabilities,
  CloudRequestId,
  CloudSubmission,
  CloudTask,
  CloudTaskId,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  getCapabilities: vi.fn(),
  listTasks: vi.fn(),
  listSubmissions: vi.fn(),
  listEnvironments: vi.fn(),
  getTask: vi.fn(),
  getDiff: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/nativeApi")>()),
  ensureNativeApi: () => ({
    cloud: {
      getCapabilities: harness.getCapabilities,
      listTasks: harness.listTasks,
      listSubmissions: harness.listSubmissions,
      listEnvironments: harness.listEnvironments,
      getTask: harness.getTask,
      getDiff: harness.getDiff,
    },
    shell: { openExternal: harness.openExternal },
  }),
}));
vi.mock("../RouteInsetSurface", () => ({
  RouteInsetSurface: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../RouteSurface", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../RouteSurface")>()),
  RouteSurfaceHeader: ({ children }: { children?: ReactNode }) => <header>{children}</header>,
}));

import CloudView from "./CloudView";

const PATCH = [
  "diff --git a/src/greeting.ts b/src/greeting.ts",
  "index 1111111..2222222 100644",
  "--- a/src/greeting.ts",
  "+++ b/src/greeting.ts",
  "@@ -1 +1 @@",
  '-export const greeting = "hi";',
  '+export const greeting = "hello";',
  "",
].join("\n");

function capabilities(overrides: Partial<CloudCapabilities> = {}): CloudCapabilities {
  return {
    provider: "codex",
    executablePath: "/opt/homebrew/bin/codex",
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

const readyTask = {
  provider: "codex",
  id: "task_ready" as CloudTaskId,
  url: "https://chatgpt.com/codex/tasks/task_ready",
  title: "Rename the greeting",
  status: "ready",
  rawStatus: "ready",
  updatedAt: "2026-10-10T10:00:00.000Z",
  environmentId: null,
  environmentLabel: "web-env",
  diffSummary: { filesChanged: 1, linesAdded: 1, linesRemoved: 1 },
  attemptTotal: 1,
  isReview: false,
} as CloudTask;

const runningTask = {
  ...readyTask,
  id: "task_running" as CloudTaskId,
  url: "https://chatgpt.com/codex/tasks/task_running",
  title: "Add retries",
  status: "pending",
  rawStatus: "running",
  diffSummary: null,
  updatedAt: "2026-10-10T09:00:00.000Z",
} as CloudTask;

const uncertainSubmission = {
  provider: "codex",
  requestId: "req-1" as CloudRequestId,
  projectId: null,
  environment: "web-env",
  branch: "main",
  promptSummary: "Write the release notes",
  state: "uncertain",
  taskId: null,
  taskUrl: null,
  lastStatus: null,
  errorDetail: "The CLI exited before it printed a task ID.",
  createdAt: "2026-10-10T08:00:00.000Z",
  updatedAt: "2026-10-10T08:00:00.000Z",
} as CloudSubmission;

let unmount: (() => Promise<void> | void) | null = null;

async function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = await render(
    <QueryClientProvider client={client}>
      <div style={{ height: 720, display: "flex" }}>
        <CloudView />
      </div>
    </QueryClientProvider>,
  );
  unmount = () => view.unmount();
  return view;
}

beforeEach(() => {
  harness.getCapabilities.mockReset().mockResolvedValue(capabilities());
  harness.listTasks
    .mockReset()
    .mockResolvedValue({ tasks: [readyTask, runningTask], cursor: null });
  harness.listSubmissions.mockReset().mockResolvedValue({ submissions: [uncertainSubmission] });
  harness.listEnvironments.mockReset().mockResolvedValue({ environments: [] });
  harness.getTask.mockReset().mockResolvedValue(runningTask);
  harness.getDiff.mockReset().mockResolvedValue({
    provider: "codex",
    taskId: readyTask.id,
    attempt: null,
    patch: PATCH,
    truncated: false,
  });
  harness.openExternal.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await unmount?.();
  unmount = null;
});

describe("CloudView", () => {
  it("lists merged tasks and submissions with status chips", async () => {
    await mount();
    await expect.element(page.getByText("Rename the greeting")).toBeVisible();
    await expect.element(page.getByText("Add retries")).toBeVisible();
    await expect.element(page.getByText("Write the release notes")).toBeVisible();
    await expect.element(page.getByText("Ready", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Running", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Uncertain", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("The CLI exited before it printed a task ID."))
      .toBeVisible();
    expect(harness.listTasks).toHaveBeenCalledWith({ provider: "codex", limit: 20 });
  });

  it("shows the detail with Open in ChatGPT and the diff file", async () => {
    await mount();
    await page.getByText("Rename the greeting").click();
    const openButton = page.getByRole("button", { name: "Open in ChatGPT" });
    await expect.element(openButton).toBeVisible();
    await openButton.click();
    expect(harness.openExternal).toHaveBeenCalledWith(readyTask.url);
    await expect.poll(() => harness.getDiff.mock.calls.length).toBeGreaterThan(0);
    expect(harness.getDiff).toHaveBeenCalledWith({ provider: "codex", taskId: readyTask.id });
    await expect.element(page.getByText("greeting.ts").first()).toBeVisible();
    expect(harness.getTask).not.toHaveBeenCalled();
  });

  it("polls a running task for its status", async () => {
    await mount();
    await page.getByText("Add retries").click();
    await expect.poll(() => harness.getTask.mock.calls.length).toBeGreaterThan(0);
    expect(harness.getTask).toHaveBeenCalledWith({ provider: "codex", taskId: runningTask.id });
    await expect.element(page.getByText("The task is still running.")).toBeVisible();
  });

  it("explains a too-old Codex CLI and skips the task list", async () => {
    harness.getCapabilities.mockResolvedValue(
      capabilities({
        available: false,
        cliVersion: "0.150.0",
        unavailableKind: "too-old",
        canSubmit: false,
        canList: false,
      }),
    );
    await mount();
    await expect
      .element(
        page.getByText(
          "Codex CLI 0.150.0 at /opt/homebrew/bin/codex is too old. Cloud needs 0.162.0 or newer. Update Codex or set SYNARA_CLOUD_CODEX_BIN to a newer binary.",
        ),
      )
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "New task" })).toBeDisabled();
    harness.getCapabilities.mockResolvedValue(capabilities());
    await page.getByRole("button", { name: "Check again" }).click();
    await expect
      .poll(() => harness.getCapabilities.mock.calls.at(-1)?.[0])
      .toEqual({ provider: "codex", refresh: true });
    await expect.element(page.getByText("Rename the greeting")).toBeVisible();
    expect(harness.listTasks).toHaveBeenCalledTimes(1);
  });

  it("shows the Claude start note and no task list", async () => {
    harness.getCapabilities.mockImplementation(async ({ provider }: { provider: string }) =>
      provider === "claude"
        ? capabilities({ provider: "claude", canSubmit: false, canList: false, canFollowUp: true })
        : capabilities(),
    );
    await mount();
    await page.getByRole("radio", { name: "Claude" }).click();
    await expect.element(page.getByText(/claude --cloud/)).toBeVisible();
    await expect.element(page.getByRole("textbox", { name: "Follow-up message" })).toBeVisible();
    expect(harness.listTasks.mock.calls.every(([input]) => input.provider === "codex")).toBe(true);
  });
});
