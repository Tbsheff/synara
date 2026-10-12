import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect } from "vitest";

import { ServerConfig } from "../../config.ts";
import { summarizeGitNumstatOutputs } from "../gitStatusParsing.ts";
import { GitCore } from "../Services/GitCore.ts";
import { GitCoreLive, makeGitCore } from "./GitCore.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "synara-git-parity-test-",
});
const TestLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provide(NodeServices.layer),
);

const supportsPosixNames = process.platform !== "win32";
const createdDirectories: string[] = [];

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function gitSync(cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { code: result.status ?? -1, stdout: result.stdout.toString("utf8") };
}

function gitOk(cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv): string {
  const result = gitSync(cwd, args, env);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed with ${result.code}`);
  return result.stdout;
}

function makeRepo(options: { readonly commit?: boolean } = {}): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "synara-git-parity-")));
  createdDirectories.push(root);
  gitOk(root, ["init", "-q"]);
  gitOk(root, ["config", "user.email", "test@test.com"]);
  gitOk(root, ["config", "user.name", "Test"]);
  gitOk(root, ["config", "core.autocrlf", "false"]);
  if (options.commit !== false) {
    writeFile(root, "README.md", "# parity\n");
    writeFile(
      root,
      ".gitattributes",
      "*.nodiff -diff\n*.bin2 binary\n*.forcetext diff\n*.dup filter=dup\n*.utf16 working-tree-encoding=UTF-16LE\n",
    );
    gitOk(root, ["add", "."]);
    gitOk(root, ["commit", "-qm", "initial"]);
  }
  gitOk(root, ["config", "filter.dup.clean", "sed p"]);
  return root;
}

function writeFile(root: string, relativePath: string, contents: string | Uint8Array) {
  const absolute = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents);
}

function lines(prefix: string, count: number, separator = "\n", trailing = true): string {
  const body = Array.from({ length: count }, (_, index) => `${prefix} ${index}`).join(separator);
  return trailing ? `${body}${separator}` : body;
}

function writeUntrackedFixture(root: string) {
  writeFile(root, "text.txt", lines("text", 3));
  writeFile(root, "no-newline.txt", lines("no newline", 5, "\n", false));
  writeFile(root, "empty.txt", "");
  writeFile(root, "crlf.txt", lines("crlf", 7, "\r\n"));
  writeFile(root, "lone-cr.txt", "a\rb\rc");
  writeFile(
    root,
    "binary.dat",
    Buffer.concat([Buffer.from("bin"), Buffer.alloc(3), Buffer.from("x\n")]),
  );
  writeFile(
    root,
    "late-nul.txt",
    Buffer.concat([Buffer.from(lines("late", 1_000)), Buffer.alloc(1), Buffer.from("tail\n")]),
  );
  writeFile(
    root,
    "edge-nul.txt",
    Buffer.concat([Buffer.alloc(7_999, 0x61), Buffer.alloc(1), Buffer.from("\n")]),
  );
  writeFile(root, "lockfile.nodiff", lines("lock", 11));
  writeFile(root, "image.bin2", lines("image", 13));
  writeFile(
    root,
    "forced.forcetext",
    Buffer.concat([Buffer.from(lines("forced", 17)), Buffer.alloc(2), Buffer.from("x\n")]),
  );
  writeFile(root, "doubled.dup", lines("dup", 19));
  writeFile(root, "wide.utf16", Buffer.from(lines("wide", 23), "utf16le"));
  writeFile(root, "with space.txt", lines("space", 29));
  writeFile(root, "ünïcödé.txt", lines("unicode", 31));
  writeFile(root, "[glob]*?.txt", lines("glob", 37));
  writeFile(root, ":(top)magic.txt", lines("magic", 41));
  writeFile(root, "-dash.txt", lines("dash", 43));
  writeFile(root, "new-dir/deep/nested.ts", lines("nested", 47));
  writeFile(root, "sub/inside.txt", lines("inside", 53));
  writeFile(root, "sub/more/inside.txt", lines("inside more", 59));
  writeFile(root, "script.sh", `#!/bin/sh\n${lines("echo", 61)}`);
  fs.chmodSync(path.join(root, "script.sh"), 0o755);
  if (supportsPosixNames) {
    writeFile(root, "tab\tname.txt", lines("tab", 67));
    writeFile(root, "new\nline.txt", lines("newline", 71));
    writeFile(root, 'quo"te\\slash.txt', lines("quote", 73));
    fs.symlinkSync("text.txt", path.join(root, "link-to-text"));
    fs.symlinkSync("missing-target", path.join(root, "dangling-link"));
  }
}

function listUntracked(cwd: string): string[] {
  return gitOk(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter((entry) => entry.length > 0);
}

function legacyUntrackedStats(cwd: string) {
  const outputs = listUntracked(cwd).map(
    (filePath) =>
      gitSync(cwd, ["diff", "--no-index", "--numstat", "-z", "--", "/dev/null", filePath]).stdout,
  );
  const totals = summarizeGitNumstatOutputs(outputs);
  return {
    additions: totals.insertions,
    deletions: totals.deletions,
    fileCount: totals.files.length,
  };
}

function legacyUntrackedPatch(cwd: string): string {
  return listUntracked(cwd)
    .toSorted()
    .map(
      (filePath) =>
        gitSync(cwd, [
          "diff",
          "--no-index",
          "--patch",
          "--no-color",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "--",
          "/dev/null",
          filePath,
        ]).stdout,
    )
    .join("");
}

function legacyMoveAwareSummary(root: string) {
  const indexDirectory = fs.mkdtempSync(path.join(tmpdir(), "synara-git-parity-index-"));
  createdDirectories.push(indexDirectory);
  const tempIndex = path.join(indexDirectory, "index");
  const realIndex = path.resolve(root, gitOk(root, ["rev-parse", "--git-path", "index"]).trim());
  if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tempIndex);
  const env = { GIT_INDEX_FILE: tempIndex };
  gitOk(root, ["add", "-A", "--", ":/"], env);
  const numstat = gitSync(root, ["diff", "--cached", "--numstat", "-z", "--find-renames"], env);
  return summarizeGitNumstatOutputs([numstat.stdout]);
}

function looseObjectCount(root: string): string {
  return gitOk(root, ["count-objects"]).trim();
}

describe("GitCore untracked parity with per-file git diff --no-index", () => {
  it.layer(TestLayer)("untracked reads", (it) => {
    it.effect("matches legacy untracked diff stats and patches for many file kinds", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const root = makeRepo();
        writeUntrackedFixture(root);

        const stats = yield* core.readDiffStats(root, "unstaged");
        expect(stats).toEqual(legacyUntrackedStats(root));
        expect(stats.fileCount).toBe(listUntracked(root).length);

        const patch = yield* core.readUnstagedPatch(root);
        expect(patch.truncated).toBe(false);
        expect(patch.patch).toBe(legacyUntrackedPatch(root));
      }),
    );

    it.effect("matches legacy output when the workspace is a repository subdirectory", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const root = makeRepo();
        writeUntrackedFixture(root);
        const cwd = path.join(root, "sub");

        expect(yield* core.readDiffStats(cwd, "unstaged")).toEqual(legacyUntrackedStats(cwd));
        const patch = yield* core.readUnstagedPatch(cwd);
        expect(patch.patch).toBe(legacyUntrackedPatch(cwd));
        expect(patch.patch).toContain("diff --git a/more/inside.txt b/more/inside.txt");
      }),
    );

    it.effect("matches legacy stats across many untracked files", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const root = makeRepo();
        for (let index = 0; index < 240; index += 1) {
          const name = `generated/${"long-directory-name-".repeat(3)}${index}/file-${index}.ts`;
          writeFile(root, name, lines(`file ${index}`, (index % 9) + 1, "\n", index % 2 === 0));
        }

        expect(yield* core.readDiffStats(root, "workingTree")).toEqual(legacyUntrackedStats(root));
        expect((yield* core.readUnstagedPatch(root)).patch).toBe(legacyUntrackedPatch(root));
      }),
    );

    it.effect("falls back to per-file patches when the batched read fails", () =>
      Effect.gen(function* () {
        const realCore = yield* GitCore;
        const root = makeRepo();
        writeUntrackedFixture(root);
        let perFileReads = 0;
        const core = yield* makeGitCore({
          executeOverride: (input) => {
            if (input.operation.endsWith(".untrackedIntentToAdd")) {
              return Effect.succeed({ code: 128, stdout: "", stderr: "fatal: simulated" });
            }
            if (input.args.includes("--no-index")) perFileReads += 1;
            return realCore.execute(input);
          },
        }).pipe(Effect.provide(Layer.provideMerge(ServerConfigLayer, NodeServices.layer)));

        const patch = yield* core.readUnstagedPatch(root);
        expect(patch.patch).toBe(legacyUntrackedPatch(root));
        expect(perFileReads).toBe(listUntracked(root).length);
      }),
    );

    it.effect("keeps the patch byte budget and ordered prefix across a batched read", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const root = makeRepo();
        for (let index = 0; index < 40; index += 1) {
          writeFile(root, `bulk/file-${String(index).padStart(2, "0")}.txt`, "x".repeat(40_000));
        }

        const patch = yield* core.readUnstagedPatch(root);
        const legacy = legacyUntrackedPatch(root);
        expect(patch.truncated).toBe(true);
        expect(Buffer.byteLength(patch.patch)).toBe(1_000_000);
        expect(legacy.startsWith(patch.patch)).toBe(true);
      }),
    );
  });

  it.layer(TestLayer)("move-aware status summary", (it) => {
    it.effect("matches the legacy add -A summary for moves, edits, staging and new files", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const root = makeRepo();
        for (let index = 1; index <= 20; index += 1) {
          writeFile(root, `lib/file-${index}.txt`, lines(`lib ${index}`, index * 7));
        }
        writeFile(root, "keep.txt", lines("keep", 9));
        writeFile(root, "staged.txt", lines("staged", 5));
        writeFile(root, "gone.txt", lines("gone", 4));
        gitOk(root, ["add", "."]);
        gitOk(root, ["commit", "-qm", "fixture"]);

        fs.renameSync(path.join(root, "lib"), path.join(root, "lib-moved"));
        fs.appendFileSync(path.join(root, "lib-moved/file-3.txt"), "edited after move\n");
        fs.appendFileSync(path.join(root, "keep.txt"), "unstaged edit\n");
        fs.appendFileSync(path.join(root, "staged.txt"), "staged edit\n");
        gitOk(root, ["add", "staged.txt"]);
        fs.rmSync(path.join(root, "gone.txt"));
        writeUntrackedFixture(root);
        fs.appendFileSync(path.join(root, ".git/info/exclude"), "node_modules/\n*.log\n");
        writeFile(root, "new-dir/node_modules/pkg/index.js", lines("ignored", 500));
        writeFile(root, "new-dir/debug.log", lines("ignored log", 300));
        writeFile(root, "embedded/inner.txt", lines("embedded", 8));
        const embedded = path.join(root, "embedded");
        gitOk(embedded, ["init", "-q"]);
        gitOk(embedded, ["add", "."]);
        gitOk(embedded, ["-c", "user.email=t@t", "-c", "user.name=T", "commit", "-qm", "inner"]);
        gitOk(root, ["hash-object", "-w", "--stdin"]);
        const indexBefore = fs.readFileSync(path.join(root, ".git/index"));
        const objectsBefore = looseObjectCount(root);

        const details = yield* core.statusDetails(root);
        const objectsAfter = looseObjectCount(root);

        expect(fs.readFileSync(path.join(root, ".git/index"))).toEqual(indexBefore);
        expect(objectsAfter).toBe(objectsBefore);
        expect(details.workingTree).toEqual(legacyMoveAwareSummary(root));
        const paths = details.workingTree.files.map((file) => file.path);
        expect(paths).toContain("lib-moved/file-3.txt");
        expect(paths.some((filePath) => filePath.includes("node_modules"))).toBe(false);
        expect(paths).not.toContain("new-dir/debug.log");
      }),
    );

    it.effect("matches the legacy summary before the first commit", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const root = makeRepo({ commit: false });
        writeFile(root, "added.txt", lines("added", 6));
        gitOk(root, ["add", "added.txt"]);
        fs.rmSync(path.join(root, "added.txt"));
        writeFile(root, "fresh/one.txt", lines("one", 3));
        writeFile(root, "fresh/two.txt", lines("two", 4, "\n", false));

        const details = yield* core.statusDetails(root);

        expect(details.workingTree).toEqual(legacyMoveAwareSummary(root));
        expect(details.workingTree.insertions).toBe(7);
      }),
    );
  });
});
