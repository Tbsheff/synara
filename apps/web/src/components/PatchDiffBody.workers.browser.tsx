import type { ComponentProps } from "react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { workerStarts } = vi.hoisted(() => ({ workerStarts: vi.fn() }));

vi.mock("@pierre/diffs/worker/worker.js?worker", async (importOriginal) => {
  const { default: DiffWorker } = await importOriginal<{ default: new () => Worker }>();
  return {
    default: class extends DiffWorker {
      constructor() {
        super();
        workerStarts();
      }
    },
  };
});

vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("./DiffPanelPatchViewport", () => ({ DiffPanelPatchViewport: () => null }));

import { PatchDiffBody } from "./PatchDiffBody";
import { getSharedHighlighter } from "@pierre/diffs";

const patch = [
  "diff --git a/example.ts b/example.ts",
  "--- a/example.ts",
  "+++ b/example.ts",
  "@@ -1 +1 @@",
  "-const value = 1;",
  "+const value = 2;",
].join("\n");

const pending: ComponentProps<typeof PatchDiffBody> = {
  patch: undefined,
  cacheKey: "worker-start-test",
  truncatedLabel: null,
  isPending: true,
  isFetching: true,
  isSuccess: false,
  error: null,
  workspaceRoot: null,
  loadingLabel: "Loading",
  emptyLabel: "No changes",
  unavailableLabel: "Unavailable",
};

beforeAll(async () => {
  await getSharedHighlighter({ themes: ["github-light"], langs: ["text"] });
});

afterEach(() => workerStarts.mockClear());

it.each([
  { patch: "", error: null, isSuccess: true },
  { patch: undefined, error: "Failed to load diff", isSuccess: false },
  { patch: "invalid diff", error: null, isSuccess: true },
])("starts no workers for pending then $patch / $error", async (result) => {
  const screen = await render(<PatchDiffBody {...pending} />);
  expect(workerStarts).toHaveBeenCalledTimes(0);
  await screen.rerender(
    <PatchDiffBody {...pending} {...result} isPending={false} isFetching={false} />,
  );
  expect(workerStarts).toHaveBeenCalledTimes(0);
  await screen.unmount();
});

it("starts one pool for files and keeps it through refresh, empty, and error states", async () => {
  const screen = await render(<PatchDiffBody {...pending} />);
  expect(workerStarts).toHaveBeenCalledTimes(0);
  await screen.rerender(<PatchDiffBody {...pending} patch={patch} isPending={false} isSuccess />);
  const poolSize = 1;
  await expect.poll(() => workerStarts.mock.calls.length).toBe(poolSize);
  await screen.rerender(<PatchDiffBody {...pending} />);
  await screen.rerender(
    <PatchDiffBody {...pending} patch="" isPending={false} isFetching={false} isSuccess />,
  );
  await screen.rerender(
    <PatchDiffBody {...pending} isPending={false} isFetching={false} error="Failed" />,
  );
  await screen.rerender(<PatchDiffBody {...pending} patch={patch} isPending={false} isSuccess />);
  expect(workerStarts).toHaveBeenCalledTimes(poolSize);
  await screen.unmount();
});
