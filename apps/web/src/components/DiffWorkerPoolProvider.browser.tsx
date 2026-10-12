import { useWorkerPool } from "@pierre/diffs/react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { StrictMode, useState } from "react";
import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

const { workers } = vi.hoisted(() => ({ workers: new Set<Worker>() }));
vi.mock("@pierre/diffs/worker/worker.js?worker", async (importOriginal) => {
  const { default: DiffWorker } = await importOriginal<{ default: new () => Worker }>();
  return {
    default: class extends DiffWorker {
      constructor() {
        super();
        workers.add(this);
        const terminate = this.terminate.bind(this);
        this.terminate = () => {
          workers.delete(this);
          terminate();
        };
      }
    },
  };
});
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

function Probe() {
  const pool = useWorkerPool();
  const [value, setValue] = useState(0);
  return (
    <button onClick={() => setValue(value + 1)}>
      {pool ? "Pool" : "No pool"}: {value}
    </button>
  );
}

afterEach(async () => {
  await cleanup();
  expect(workers.size).toBe(0);
});

it("creates no workers before files arrive and one worker for one or two files", async () => {
  const view = await render(
    <DiffWorkerPoolProvider fileCount={0}>
      <Probe />
    </DiffWorkerPoolProvider>,
  );
  expect(workers.size).toBe(0);
  await view.rerender(
    <DiffWorkerPoolProvider fileCount={1}>
      <Probe />
    </DiffWorkerPoolProvider>,
  );
  await expect.poll(() => workers.size, { timeout: 10_000 }).toBe(1);
  await view.rerender(
    <DiffWorkerPoolProvider fileCount={2}>
      <Probe />
    </DiffWorkerPoolProvider>,
  );
  expect(workers.size).toBe(1);
  await view.unmount();
});

it("grows a small pool to the CPU cap for 64 files and shares it across surfaces", async () => {
  const view = await render(
    <DiffWorkerPoolProvider fileCount={1}>
      <Probe />
    </DiffWorkerPoolProvider>,
  );
  await expect.poll(() => workers.size, { timeout: 10_000 }).toBe(1);
  await view.rerender(
    <DiffWorkerPoolProvider fileCount={64}>
      <Probe />
    </DiffWorkerPoolProvider>,
  );
  const cap = Math.max(2, Math.min(6, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
  await expect.poll(() => workers.size, { timeout: 10_000 }).toBe(cap);
  const second = await render(
    <DiffWorkerPoolProvider fileCount={1}>
      <Probe />
    </DiffWorkerPoolProvider>,
  );
  expect(workers.size).toBe(cap);
  await second.unmount();
  expect(workers.size).toBe(cap);
  await view.rerender(
    <DiffWorkerPoolProvider fileCount={1}>
      <Probe />
    </DiffWorkerPoolProvider>,
  );
  await expect.poll(() => workers.size, { timeout: 10_000 }).toBe(1);
  await view.unmount();
});

it("keeps the pool and child state through refresh, empty, and error states", async () => {
  const view = await render(
    <DiffWorkerPoolProvider fileCount={1}>
      <Probe />
    </DiffWorkerPoolProvider>,
  );
  await expect.poll(() => workers.size, { timeout: 10_000 }).toBe(1);
  await view.getByRole("button").click();
  const worker = Array.from(workers)[0];
  await view.rerender(
    <DiffWorkerPoolProvider fileCount={0} enabled={false}>
      <Probe />
    </DiffWorkerPoolProvider>,
  );
  await expect.element(view.getByRole("button")).toHaveTextContent("Pool: 1");
  expect(Array.from(workers)).toEqual([worker]);
  await view.unmount();
});

it("stops workers when StrictMode closes a pool during initialization", async () => {
  const view = await render(
    <StrictMode>
      <DiffWorkerPoolProvider fileCount={64}>
        <Probe />
      </DiffWorkerPoolProvider>
    </StrictMode>,
  );
  await view.unmount();
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(workers.size).toBe(0);
});
