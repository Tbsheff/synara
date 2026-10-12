import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Effect, Fiber } from "effect";
import { afterEach, expect, it, vi } from "vitest";

import { WorkspaceEntries } from "../Services/WorkspaceEntries";
import { WorkspaceEntriesLive } from "./WorkspaceEntries";

let cwd: string | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  cwd = null;
});

it("interrupting a content search stops the file scan", async () => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "synara-content-search-interrupt-"));
  for (let index = 0; index < 400; index += 1) {
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", `file${index}.ts`), `nothing ${index}\n`);
  }
  const searchCwd = cwd;
  const run = <A, E>(effect: Effect.Effect<A, E, WorkspaceEntries>) =>
    Effect.runPromise(effect.pipe(Effect.provide(WorkspaceEntriesLive)));
  await run(
    Effect.flatMap(WorkspaceEntries.asEffect(), (entries) =>
      entries.searchContent({ cwd: searchCwd, query: "warm" }),
    ),
  );

  let reachedTenOpens!: () => void;
  const tenOpens = new Promise<void>((resolve) => {
    reachedTenOpens = resolve;
  });
  const realOpen = fsPromises.open;
  const openSpy = vi
    .spyOn(fsPromises, "open")
    .mockImplementation((...args: Parameters<typeof fsPromises.open>) => {
      if (openSpy.mock.calls.length === 10) reachedTenOpens();
      return realOpen(...args);
    });

  await run(
    Effect.gen(function* () {
      const entries = yield* WorkspaceEntries;
      const fiber = yield* Effect.forkChild(
        entries.searchContent({ cwd: searchCwd, query: "absent" }),
      );
      yield* Effect.promise(() => tenOpens);
      yield* Fiber.interrupt(fiber);
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  const settledOpens = openSpy.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(openSpy.mock.calls.length).toBe(settledOpens);
  expect(settledOpens).toBeLessThan(40);
});
