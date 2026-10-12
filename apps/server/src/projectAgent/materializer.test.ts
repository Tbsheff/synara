import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Effect, Exit } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  deleteProjectDocumentMirror,
  projectContextRoot,
  readProjectDocumentMirror,
  writeProjectDocumentMirror,
} from "./materializer.ts";

const tempDirs: string[] = [];

const makeTempDir = async (prefix: string) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("projectContextRoot", () => {
  it("keeps the project root a direct child of project-context", () => {
    const stateDir = "/state";
    expect(projectContextRoot(stateDir, "project-1")).toBe(
      path.join(stateDir, "project-context", "project-1"),
    );
    for (const projectId of ["..", ".", "../escape", "a/b", "a\\b", "/abs", "x\0y"]) {
      expect(() => projectContextRoot(stateDir, projectId)).toThrow(
        /escaped the project context|not a valid project context/,
      );
    }
  });
});

describe("project document mirror containment", () => {
  it("does not import a document through a leaf symlink to an outside file", async () => {
    const stateDir = await makeTempDir("synara-mirror-state-");
    const outside = await makeTempDir("synara-mirror-outside-");
    const secret = path.join(outside, "secret.txt");
    await fs.writeFile(secret, "outside secret", "utf8");
    const root = projectContextRoot(stateDir, "project-1");
    await fs.mkdir(root, { recursive: true });
    await fs.symlink(secret, path.join(root, "notes.md"));

    const exit = await Effect.runPromiseExit(
      readProjectDocumentMirror({ stateDir, projectId: "project-1", logicalPath: "notes.md" }),
    );
    expect(Exit.isSuccess(exit) ? exit.value : null).not.toBe("outside secret");
  });

  it("does not import a document through a parent directory symlink", async () => {
    const stateDir = await makeTempDir("synara-mirror-state-");
    const outside = await makeTempDir("synara-mirror-outside-");
    await fs.writeFile(path.join(outside, "notes.md"), "outside secret", "utf8");
    const root = projectContextRoot(stateDir, "project-1");
    await fs.mkdir(root, { recursive: true });
    await fs.symlink(outside, path.join(root, "artifacts"));

    const exit = await Effect.runPromiseExit(
      readProjectDocumentMirror({
        stateDir,
        projectId: "project-1",
        logicalPath: "artifacts/notes.md",
      }),
    );
    expect(Exit.isSuccess(exit) ? exit.value : null).not.toBe("outside secret");
  });

  it("does not write a mirror through a parent directory symlink", async () => {
    const stateDir = await makeTempDir("synara-mirror-state-");
    const outside = await makeTempDir("synara-mirror-outside-");
    await fs.mkdir(path.join(outside, "nested"), { mode: 0o700 });
    const root = projectContextRoot(stateDir, "project-1");
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.symlink(outside, path.join(root, "artifacts"));

    const exit = await Effect.runPromiseExit(
      writeProjectDocumentMirror({
        stateDir,
        projectId: "project-1",
        logicalPath: "artifacts/nested/index.md",
        content: "written",
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    await expect(fs.readdir(path.join(outside, "nested"))).resolves.toEqual([]);
  });

  it("writes and reads a mirror for a project whose context root does not exist yet", async () => {
    const stateDir = await makeTempDir("synara-mirror-state-");
    await Effect.runPromise(
      writeProjectDocumentMirror({
        stateDir,
        projectId: "fresh-project",
        logicalPath: "artifacts/index.md",
        content: "# Artifacts\n",
      }),
    );
    const content = await Effect.runPromise(
      readProjectDocumentMirror({
        stateDir,
        projectId: "fresh-project",
        logicalPath: "artifacts/index.md",
      }),
    );
    expect(content).toBe("# Artifacts\n");
    const missing = await Effect.runPromise(
      readProjectDocumentMirror({ stateDir, projectId: "fresh-project", logicalPath: "none.md" }),
    );
    expect(missing).toBeNull();
  });

  it("does not delete an outside file through a parent directory symlink", async () => {
    const stateDir = await makeTempDir("synara-mirror-state-");
    const outside = await makeTempDir("synara-mirror-outside-");
    const victim = path.join(outside, "note.md");
    await fs.writeFile(victim, "keep me", "utf8");
    const root = projectContextRoot(stateDir, "project-1");
    await fs.mkdir(root, { recursive: true });
    await fs.symlink(outside, path.join(root, "memory"));

    await Effect.runPromiseExit(
      deleteProjectDocumentMirror({
        stateDir,
        projectId: "project-1",
        logicalPath: "memory/note.md",
      }),
    );
    await expect(fs.readFile(victim, "utf8")).resolves.toBe("keep me");
  });
});
