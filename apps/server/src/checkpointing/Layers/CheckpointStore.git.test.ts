import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { CheckpointRef } from "@synara/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { parseCheckpointFilesFromUnifiedDiff } from "../Diffs.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import { CheckpointStoreLive } from "./CheckpointStore.ts";

const tempRoots: string[] = [];
let runtime: ManagedRuntime.ManagedRuntime<CheckpointStore, unknown> | null = null;
const commands: string[] = [];

afterEach(async () => {
  await runtime?.dispose();
  runtime = null;
  commands.length = 0;
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 256 * 1024 * 1024,
  }).toString();
}

function write(cwd: string, relativePath: string, content: string | Buffer): void {
  const target = join(cwd, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "synara-checkpoint-git-test-"));
  tempRoots.push(root);
  const cwd = join(root, "repo");
  mkdirSync(cwd);
  git(cwd, ["init", "-q", "-b", "main"]);
  for (const [key, value] of [
    ["user.email", "test@example.com"],
    ["user.name", "Test"],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", "/dev/null"],
    ["gc.auto", "0"],
  ] as const) {
    git(cwd, ["config", key, value]);
  }
  return cwd;
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "--no-verify", "-m", message]);
}

function freshCaptureTree(cwd: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "synara-checkpoint-oracle-"));
  try {
    const tempIndexPath = join(scratch, "index");
    const env = { GIT_INDEX_FILE: tempIndexPath };
    const workingIndexPath = resolve(cwd, git(cwd, ["rev-parse", "--git-path", "index"]).trim());
    if (existsSync(workingIndexPath)) {
      const workingIndexInfo = statSync(workingIndexPath);
      copyFileSync(workingIndexPath, tempIndexPath);
      try {
        git(cwd, ["update-index", "--really-refresh"], env);
      } catch {}
      utimesSync(tempIndexPath, workingIndexInfo.atime, workingIndexInfo.mtime);
    } else {
      git(cwd, ["read-tree", "HEAD"], env);
    }
    git(cwd, ["add", "-A", "--", "."], env);
    return git(cwd, ["write-tree"], env).trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function startRuntime(): ManagedRuntime.ManagedRuntime<CheckpointStore, unknown> {
  const recordingGit = Layer.effect(
    GitCore,
    Effect.gen(function* () {
      const base = yield* GitCore;
      return {
        ...base,
        execute: (input) => {
          commands.push(input.args.slice(0, 2).join(" "));
          return base.execute(input);
        },
      } satisfies GitCoreShape;
    }),
  ).pipe(Layer.provide(GitCoreLive));
  runtime = ManagedRuntime.make(
    CheckpointStoreLive.pipe(
      Layer.provide(recordingGit),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "synara-checkpoint-git-" })),
      Layer.provide(NodeServices.layer),
    ),
  );
  return runtime;
}

const checkpointRef = (name: string) => CheckpointRef.makeUnsafe(`refs/synara-test/${name}`);

async function capture(cwd: string, name: string): Promise<{ tree: string; commands: string[] }> {
  commands.length = 0;
  await runtime!.runPromise(
    Effect.flatMap(CheckpointStore.asEffect(), (store) =>
      store.captureCheckpoint({ cwd, checkpointRef: checkpointRef(name) }),
    ),
  );
  return {
    tree: git(cwd, ["rev-parse", `${checkpointRef(name)}^{tree}`]).trim(),
    commands: [...commands],
  };
}

function persistentIndexFiles(gitDir: string): string[] {
  return readdirSync(gitDir).filter(
    (entry) => entry.startsWith("synara-checkpoint-index-") && !entry.endsWith(".lock"),
  );
}

describe("CheckpointStoreLive persistent checkpoint index", () => {
  it("captures the same tree as a fresh temporary index across worktree and index changes", async () => {
    const cwd = makeRepo();
    write(cwd, ".gitignore", "*.log\nbuild/\n");
    write(cwd, "a.txt", "alpha\n");
    write(cwd, "b.txt", "bravo\n");
    write(cwd, "dir/c.txt", "charlie\n");
    write(cwd, "x.txt", "x-ray\n");
    write(cwd, "tracked.log", "tracked but ignored\n");
    write(cwd, "script.sh", "echo hi\n");
    write(cwd, "stable.txt", "stable\n");
    git(cwd, ["add", "-f", "tracked.log"]);
    commitAll(cwd, "base");
    startRuntime();

    const steps: Array<readonly [string, () => void]> = [
      [
        "initial dirty worktree",
        () => {
          write(cwd, "a.txt", "alpha changed\n");
          write(cwd, "new.txt", "untracked\n");
          write(cwd, "build/out.js", "ignored output\n");
          write(cwd, "debug.log", "ignored untracked\n");
        },
      ],
      ["no changes", () => {}],
      ["same-size rewrite right after capture", () => write(cwd, "a.txt", "ALPHA CHANGED\n")],
      [
        "delete, rename, and add",
        () => {
          rmSync(join(cwd, "b.txt"));
          renameSync(join(cwd, "dir/c.txt"), join(cwd, "dir/c2.txt"));
          write(cwd, "other.txt", "another untracked\n");
        },
      ],
      [
        "ignore a captured untracked file",
        () => appendFileSync(join(cwd, ".gitignore"), "new.txt\n"),
      ],
      ["delete a tracked ignored file", () => rmSync(join(cwd, "tracked.log"))],
      ["recreate a tracked ignored file", () => write(cwd, "tracked.log", "back again\n")],
      ["delete a tracked file", () => rmSync(join(cwd, "x.txt"))],
      ["ignore the deleted tracked file", () => appendFileSync(join(cwd, ".gitignore"), "x.txt\n")],
      ["recreate the deleted tracked file", () => write(cwd, "x.txt", "x-ray again\n")],
      [
        "nested self-ignoring directory",
        () => {
          write(cwd, "gen/a.js", "generated\n");
        },
      ],
      ["self-ignore file appears", () => write(cwd, "gen/.gitignore", "*\n")],
      ["mode change", () => chmodSync(join(cwd, "script.sh"), 0o755)],
      ["symlink added", () => symlinkSync("a.txt", join(cwd, "link.txt"))],
      [
        "file replaced by directory",
        () => {
          rmSync(join(cwd, "other.txt"));
          write(cwd, "other.txt/inner.txt", "nested\n");
        },
      ],
      ["user stages a file", () => git(cwd, ["add", "a.txt"])],
      [
        "user unstages a tracked ignored file",
        () => git(cwd, ["rm", "-q", "--cached", "tracked.log"]),
      ],
      ["user force-adds an ignored file", () => git(cwd, ["add", "-f", "debug.log"])],
      [
        "user marks an unmodified file assume-unchanged",
        () => git(cwd, ["update-index", "--assume-unchanged", "stable.txt"]),
      ],
      ["assume-unchanged file modified", () => write(cwd, "stable.txt", "stable modified\n")],
      ["assume-unchanged file deleted", () => rmSync(join(cwd, "stable.txt"))],
      [
        "user clears assume-unchanged",
        () => git(cwd, ["update-index", "--no-assume-unchanged", "stable.txt"]),
      ],
      ["user commits", () => commitAll(cwd, "user commit")],
      ["edit after commit", () => write(cwd, "a.txt", "after commit\n")],
    ];

    const persistentSteps: string[] = [];
    for (const [index, [label, mutate]] of steps.entries()) {
      mutate();
      const result = await capture(cwd, `step-${index}`);
      expect({ label, tree: result.tree }).toEqual({ label, tree: freshCaptureTree(cwd) });
      if (!result.commands.includes("update-index --really-refresh")) {
        persistentSteps.push(label);
      }
    }

    expect(persistentSteps).toEqual(
      expect.arrayContaining([
        "no changes",
        "same-size rewrite right after capture",
        "delete, rename, and add",
        "edit after commit",
      ]),
    );
    expect(persistentIndexFiles(join(cwd, ".git"))).toHaveLength(1);
  });

  it("resolves git paths once per worktree and keeps linked worktrees separate", async () => {
    const cwd = makeRepo();
    write(cwd, "a.txt", "alpha\n");
    commitAll(cwd, "base");
    const linked = join(dirname(cwd), "linked");
    git(cwd, ["worktree", "add", "-q", "-b", "linked", linked]);
    startRuntime();

    write(cwd, "a.txt", "main change\n");
    write(linked, "a.txt", "linked change\n");
    const first = await capture(cwd, "main-1");
    const linkedFirst = await capture(linked, "linked-1");
    write(cwd, "b.txt", "main new\n");
    const second = await capture(cwd, "main-2");

    expect(
      first.commands.filter((command) => command.startsWith("rev-parse --git-path")),
    ).toHaveLength(1);
    expect(second.commands.some((command) => command.startsWith("rev-parse --git-path"))).toBe(
      false,
    );
    expect(first.tree).not.toBe(linkedFirst.tree);
    expect(second.tree).toBe(freshCaptureTree(cwd));
    expect(await capture(linked, "linked-2").then((result) => result.tree)).toBe(
      freshCaptureTree(linked),
    );
    expect(persistentIndexFiles(join(cwd, ".git"))).toHaveLength(1);
    expect(persistentIndexFiles(join(cwd, ".git", "worktrees", "linked"))).toHaveLength(1);
  });

  it("keeps a separate persistent index for a subdirectory workspace", async () => {
    const cwd = makeRepo();
    write(cwd, "top.txt", "top\n");
    write(cwd, "pkg/inner.txt", "inner\n");
    commitAll(cwd, "base");
    const subdirectory = join(cwd, "pkg");
    startRuntime();

    write(cwd, "top.txt", "top changed\n");
    write(subdirectory, "inner.txt", "inner changed\n");
    for (const round of [1, 2, 3]) {
      write(cwd, `top-${round}.txt`, "root file\n");
      write(subdirectory, `inner-${round}.txt`, "package file\n");
      write(cwd, "staged-outside.txt", `staged in round ${round}\n`);
      git(cwd, ["add", "staged-outside.txt"]);
      expect((await capture(cwd, `root-${round}`)).tree).toBe(freshCaptureTree(cwd));
      expect((await capture(subdirectory, `pkg-${round}`)).tree).toBe(
        freshCaptureTree(subdirectory),
      );
    }
    expect(persistentIndexFiles(join(cwd, ".git"))).toHaveLength(2);
  });

  it("falls back to a temporary index when the persistent index is locked", async () => {
    const cwd = makeRepo();
    write(cwd, "a.txt", "alpha\n");
    commitAll(cwd, "base");
    startRuntime();

    write(cwd, "a.txt", "one\n");
    await capture(cwd, "warm-1");
    const [persistentIndex] = persistentIndexFiles(join(cwd, ".git"));
    const lockPath = join(cwd, ".git", `${persistentIndex}.lock`);
    writeFileSync(lockPath, "");

    write(cwd, "a.txt", "two\n");
    const locked = await capture(cwd, "locked");
    expect(locked.tree).toBe(freshCaptureTree(cwd));
    expect(locked.commands).toContain("update-index --really-refresh");
    expect(existsSync(lockPath)).toBe(true);
  });

  it("serializes concurrent captures of one worktree", async () => {
    const cwd = makeRepo();
    write(cwd, "a.txt", "alpha\n");
    commitAll(cwd, "base");
    startRuntime();
    write(cwd, "a.txt", "changed\n");
    await capture(cwd, "seed");
    write(cwd, "b.txt", "new\n");

    await runtime!.runPromise(
      Effect.flatMap(CheckpointStore.asEffect(), (store) =>
        Effect.all(
          ["left", "right", "third"].map((name) =>
            store.captureCheckpoint({ cwd, checkpointRef: checkpointRef(name) }),
          ),
          { concurrency: "unbounded" },
        ),
      ),
    );

    const expected = freshCaptureTree(cwd);
    for (const name of ["left", "right", "third"]) {
      expect(git(cwd, ["rev-parse", `${checkpointRef(name)}^{tree}`]).trim()).toBe(expected);
    }
  });
});

describe("CheckpointStoreLive.diffCheckpointFiles", () => {
  const summarize = (cwd: string, from: string, to: string) =>
    runtime!.runPromise(
      Effect.flatMap(CheckpointStore.asEffect(), (store) =>
        Effect.all({
          numstat: store.diffCheckpointFiles({
            cwd,
            fromCheckpointRef: checkpointRef(from),
            toCheckpointRef: checkpointRef(to),
          }),
          patch: store
            .diffCheckpoints({
              cwd,
              fromCheckpointRef: checkpointRef(from),
              toCheckpointRef: checkpointRef(to),
              ignoreWhitespace: false,
            })
            .pipe(
              Effect.flatMap(parseCheckpointFilesFromUnifiedDiff),
              Effect.catch((error) => Effect.succeed(error.message)),
            ),
        }),
      ),
    );

  it("matches the parsed patch summary for every change kind", async () => {
    const cwd = makeRepo();
    write(cwd, "modified.txt", "a\nb\nc\n");
    write(cwd, "deleted.txt", "x\ny\n");
    write(cwd, "renamed.txt", Array.from({ length: 50 }, (_, line) => `${line}\n`).join(""));
    write(cwd, "renamed-edit.txt", Array.from({ length: 60 }, (_, line) => `${line}\n`).join(""));
    write(cwd, "binary.dat", Buffer.from([0, 1, 2, 3, 0, 5]));
    write(cwd, "mode.sh", "echo mode\n");
    write(cwd, "typechange.txt", "target\n");
    write(cwd, "no-newline.txt", "tail");
    write(cwd, "dir with space/file name.txt", "spaced\n");
    commitAll(cwd, "base");
    startRuntime();
    await capture(cwd, "from");

    write(cwd, "modified.txt", "a\nB\nc\nd\n");
    rmSync(join(cwd, "deleted.txt"));
    renameSync(join(cwd, "renamed.txt"), join(cwd, "renamed-pure.txt"));
    renameSync(join(cwd, "renamed-edit.txt"), join(cwd, "renamed-changed.txt"));
    appendFileSync(join(cwd, "renamed-changed.txt"), "60\n");
    write(cwd, "binary.dat", Buffer.from([0, 1, 2, 3, 0, 6, 7]));
    chmodSync(join(cwd, "mode.sh"), 0o755);
    rmSync(join(cwd, "typechange.txt"));
    symlinkSync("modified.txt", join(cwd, "typechange.txt"));
    write(cwd, "no-newline.txt", "tail\n");
    write(cwd, "added.txt", "new\nlines\n");
    write(cwd, "empty.txt", "");
    appendFileSync(join(cwd, "dir with space/file name.txt"), "more\n");
    await capture(cwd, "to");

    const { numstat, patch } = await summarize(cwd, "from", "to");
    expect(numstat).toEqual(patch);
    expect(numstat.map((file) => [file.path, file.kind])).toEqual([
      ["added.txt", "added"],
      ["binary.dat", "modified"],
      ["deleted.txt", "deleted"],
      ["dir with space/file name.txt", "modified"],
      ["empty.txt", "added"],
      ["mode.sh", "modified"],
      ["modified.txt", "modified"],
      ["no-newline.txt", "modified"],
      ["renamed-changed.txt", "renamed"],
      ["renamed-pure.txt", "renamed"],
      ["typechange.txt", "added"],
    ]);
  });

  it("reports non-ASCII paths unquoted in summaries and patches", async () => {
    const cwd = makeRepo();
    write(cwd, "café.txt", "one\n");
    commitAll(cwd, "base");
    startRuntime();
    await capture(cwd, "from");
    write(cwd, "café.txt", "one\ntwo\n");
    await capture(cwd, "to");

    const { numstat, patch } = await summarize(cwd, "from", "to");
    expect(numstat).toEqual([{ path: "café.txt", kind: "modified", additions: 1, deletions: 0 }]);
    expect(patch).toEqual(numstat);
    const rawPatch = await runtime!.runPromise(
      Effect.flatMap(CheckpointStore.asEffect(), (store) =>
        store.diffCheckpoints({
          cwd,
          fromCheckpointRef: checkpointRef("from"),
          toCheckpointRef: checkpointRef("to"),
          ignoreWhitespace: false,
        }),
      ),
    );
    expect(rawPatch).toContain("diff --git a/café.txt b/café.txt");
  });

  it("summarizes turns whose patch exceeds the diff output cap", async () => {
    const cwd = makeRepo();
    write(cwd, "seed.txt", "seed\n");
    commitAll(cwd, "base");
    startRuntime();
    await capture(cwd, "from");
    const line = "0123456789".repeat(9) + "\n";
    for (let file = 0; file < 12; file += 1) {
      write(cwd, `large/file-${file}.txt`, line.repeat(10_000));
    }
    await capture(cwd, "to");

    const { numstat, patch } = await summarize(cwd, "from", "to");
    expect(typeof patch).toBe("string");
    expect(numstat).toHaveLength(12);
    expect(numstat.every((file) => file.kind === "added" && file.additions === 10_000)).toBe(true);
  });
});
