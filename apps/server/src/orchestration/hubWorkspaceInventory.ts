import { watch, type FSWatcher } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { Effect, Semaphore } from "effect";

import {
  isStudioOutputRelativePath,
  MAX_SCAN_DEPTH,
  MAX_SCAN_ENTRIES,
  MAX_SCAN_FILES,
  type StudioWorkspaceScan,
} from "../studioOutputs.ts";
import { isContainedPath } from "../workspace/realPathContainment.ts";

export function makeHubWorkspaceInventory<E, R>(
  root: string,
  scan: Effect.Effect<StudioWorkspaceScan, E, R>,
) {
  return Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    let files: StudioWorkspaceScan | undefined;
    let watcher: FSWatcher | undefined;
    let lost = true;
    const dirty = new Set<string>();
    const close = () => {
      watcher?.close();
      watcher = undefined;
      files = undefined;
      dirty.clear();
      lost = true;
    };
    yield* Effect.addFinalizer(() => Effect.sync(close));
    const snapshot = lock.withPermit(
      Effect.gen(function* () {
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
        if (lost) {
          close();
          yield* Effect.try({
            try: () => {
              const activeWatcher = watch(root, { recursive: true }, (_event, filename) => {
                if (watcher !== activeWatcher) return;
                if (filename === null) {
                  lost = true;
                  return;
                }
                const relative = filename.toString().split(path.sep).join("/");
                if (!isStudioOutputRelativePath(relative)) return;
                dirty.add(relative);
                if (dirty.size > MAX_SCAN_ENTRIES) {
                  dirty.clear();
                  lost = true;
                }
              });
              watcher = activeWatcher;
              activeWatcher.on("error", () => {
                if (watcher === activeWatcher) lost = true;
              });
              activeWatcher.on("close", () => {
                if (watcher === activeWatcher) lost = true;
              });
              lost = false;
            },
            catch: (cause) => cause,
          }).pipe(
            Effect.catch(() =>
              Effect.sync(() => {
                lost = true;
              }),
            ),
          );
          files = yield* scan;
        }
        const changes = [...dirty];
        dirty.clear();
        const next = new Map(files);
        if (changes.length) {
          yield* Effect.tryPromise({
            try: async () => {
              const realRoot = await fs.realpath(root);
              let entries = 0;
              const visit = async (relative: string): Promise<void> => {
                if (++entries > MAX_SCAN_ENTRIES)
                  throw new Error("Hub inventory update exceeded its entry limit.");
                if (
                  !isStudioOutputRelativePath(relative) ||
                  relative.split("/").length > MAX_SCAN_DEPTH
                )
                  return;
                const absolute = path.join(realRoot, ...relative.split("/"));
                try {
                  const stat = await fs.lstat(absolute);
                  if (stat.isSymbolicLink()) return;
                  if (!isContainedPath(realRoot, await fs.realpath(absolute))) return;
                  if (stat.isFile()) next.set(relative, { mtimeMs: stat.mtimeMs, size: stat.size });
                  else if (stat.isDirectory()) {
                    for (const entry of await fs.readdir(absolute))
                      await visit(`${relative}/${entry}`);
                  }
                  if (next.size > MAX_SCAN_FILES)
                    throw new Error("Hub inventory update exceeded its file limit.");
                } catch (cause) {
                  if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
                }
              };
              for (const relative of changes) {
                for (const existing of next.keys())
                  if (existing === relative || existing.startsWith(`${relative}/`))
                    next.delete(existing);
                await visit(relative);
              }
            },
            catch: (cause) => cause,
          }).pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                lost = true;
              }),
            ),
          );
        }
        files = next;
        return new Map(files) as StudioWorkspaceScan;
      }),
    );
    return { snapshot, close };
  });
}
