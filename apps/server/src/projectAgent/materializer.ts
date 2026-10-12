import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { Effect } from "effect";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import {
  isContainedPath,
  prepareRealPathForWriteWithinRoot,
  resolveRealPathForCreateWithinRoot,
} from "../workspace/realPathContainment.ts";
import { normalizeProjectDocumentPath } from "@synara/shared/projectAgent";

export function projectContextRoot(stateDir: string, projectId: string): string {
  if (!projectId || projectId === "." || projectId === ".." || /[\\/\0:]/.test(projectId)) {
    throw new Error("Project id is not a valid project context child.");
  }
  const parent = path.resolve(stateDir, "project-context");
  const root = path.resolve(parent, projectId);
  if (path.dirname(root) !== parent) throw new Error("Project root escaped the project context.");
  return root;
}

export async function resolveProjectContextRoot(
  stateDir: string,
  projectId: string,
  create = false,
) {
  const root = projectContextRoot(stateDir, projectId);
  const realState = await fs.realpath(stateDir);
  for (const directory of [path.dirname(root), root]) {
    if (create) {
      try {
        await fs.mkdir(directory, { mode: 0o700 });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      }
    }
    const stat = await fs.lstat(directory);
    const realDirectory = await fs.realpath(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !isContainedPath(realState, realDirectory)
    ) {
      throw new Error("Project root escaped the project context.");
    }
  }
  return await fs.realpath(root);
}

export function hashDocumentContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function materializeDocumentPath(
  stateDir: string,
  projectId: string,
  logicalPath: string,
): string {
  const normalized = normalizeProjectDocumentPath(logicalPath);
  const root = projectContextRoot(stateDir, projectId);
  const resolved = path.resolve(root, normalized);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Materialized path escaped project context: ${logicalPath}`);
  }
  return resolved;
}

export function writeProjectDocumentMirror(input: {
  readonly stateDir: string;
  readonly projectId: string;
  readonly logicalPath: string;
  readonly content: string;
}) {
  return Effect.tryPromise({
    try: async () => {
      const target = materializeDocumentPath(input.stateDir, input.projectId, input.logicalPath);
      const root = await resolveProjectContextRoot(input.stateDir, input.projectId, true);
      const filePath = await prepareRealPathForWriteWithinRoot(
        root,
        path.join(root, path.relative(projectContextRoot(input.stateDir, input.projectId), target)),
      );
      if (filePath === null) throw new Error("Project context write escaped its root.");
      return filePath;
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.flatMap((filePath) => writeFileStringAtomically({ filePath, contents: input.content })),
  );
}

export function readProjectDocumentMirror(input: {
  readonly stateDir: string;
  readonly projectId: string;
  readonly logicalPath: string;
}) {
  const filePath = materializeDocumentPath(input.stateDir, input.projectId, input.logicalPath);
  return Effect.tryPromise({
    try: async () => {
      try {
        const root = await resolveProjectContextRoot(input.stateDir, input.projectId);
        const safePath = await resolveRealPathForCreateWithinRoot(
          root,
          path.join(
            root,
            path.relative(projectContextRoot(input.stateDir, input.projectId), filePath),
          ),
        );
        if (safePath === null) throw new Error("Project context read escaped its root.");
        const entry = await fs.lstat(safePath);
        if (!entry.isFile()) throw new Error("Project context path is not a regular file.");
        const handle = await fs.open(
          safePath,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
        );
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino) {
            throw new Error(`Project context path is not a regular file: ${filePath}`);
          }
          return await handle.readFile("utf8");
        } finally {
          await handle.close();
        }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw cause;
      }
    },
    catch: (cause) => cause,
  });
}

export function deleteProjectDocumentMirror(input: {
  readonly stateDir: string;
  readonly projectId: string;
  readonly logicalPath: string;
}) {
  return Effect.tryPromise({
    try: async () => {
      const target = materializeDocumentPath(input.stateDir, input.projectId, input.logicalPath);
      try {
        const root = await resolveProjectContextRoot(input.stateDir, input.projectId);
        const safePath = await resolveRealPathForCreateWithinRoot(
          root,
          path.join(
            root,
            path.relative(projectContextRoot(input.stateDir, input.projectId), target),
          ),
        );
        if (safePath === null) throw new Error("Project context delete escaped its root.");
        await fs.rm(safePath, { force: true });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
    },
    catch: (cause) => cause,
  });
}
