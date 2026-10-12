// FILE: betaImport.test.ts
// Purpose: Coverage for the beta-side stable-data snapshot import.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ThreadMetaUpdatedPayload } from "@synara/contracts";
import {
  BETA_IMPORT_REQUEST_FILE_NAME,
  BETA_IMPORT_RESULT_FILE_NAME,
} from "@synara/shared/betaChannel";
import { copyLiveDatabase, runBetaImportIfRequested } from "./betaImport";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "synara-beta-import-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

async function seedStableHome(root: string): Promise<string> {
  const stableHome = join(root, ".synara");
  const stableState = join(stableHome, "userdata");
  mkdirSync(join(stableState, "secrets"), { recursive: true });
  mkdirSync(join(stableState, "logs"), { recursive: true });
  writeFileSync(join(stableState, "settings.json"), JSON.stringify({ theme: "dark" }));
  writeFileSync(join(stableState, "secrets", "token.json"), JSON.stringify({ token: "x" }));
  writeFileSync(join(stableState, "logs", "server.log"), "log line\n");
  writeFileSync(join(stableState, "server-runtime.json"), JSON.stringify({ pid: 1234 }));

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(stableState, "state.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT)");
  db.exec("INSERT INTO threads VALUES ('t1', 'hello stable')");
  db.close();
  return stableHome;
}

function writeMarker(betaHome: string, sourceHomeDir: string): void {
  mkdirSync(betaHome, { recursive: true });
  writeFileSync(
    join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME),
    JSON.stringify({ version: 1, requestedAt: new Date().toISOString(), sourceHomeDir }),
  );
}

/** Runs the import allowing whatever source the marker names, unless overridden. */
function run(
  input: { readonly betaHomeDir: string; readonly stateDir: string },
  overrides: Partial<Parameters<typeof runBetaImportIfRequested>[0]> = {},
) {
  let allowedSourceHomes: string[] = [];
  try {
    const marker = JSON.parse(
      readFileSync(join(input.betaHomeDir, BETA_IMPORT_REQUEST_FILE_NAME), "utf8"),
    );
    allowedSourceHomes = [resolve(marker.sourceHomeDir)];
  } catch {
    // no or malformed marker
  }
  return runBetaImportIfRequested({
    ...input,
    latestMigrationId: 1_000,
    allowedSourceHomes,
    ...overrides,
  });
}

describe("runBetaImportIfRequested", () => {
  it("does nothing without a marker", async () => {
    const root = makeRoot();
    const betaHome = join(root, ".synara-beta");
    const outcome = await run({
      betaHomeDir: betaHome,
      stateDir: join(betaHome, "userdata"),
    });
    expect(outcome.consumed).toBe(false);
    expect(existsSync(join(betaHome, "userdata"))).toBe(false);
  });

  it("imports the stable snapshot and reports success", async () => {
    const root = await seedStableHome(makeRoot());
    const betaHome = join(root, ".synara-beta");
    const betaState = join(betaHome, "userdata");
    writeMarker(betaHome, root);

    const outcome = await run({ betaHomeDir: betaHome, stateDir: betaState });
    expect(outcome).toEqual({ consumed: true, ok: true });
    expect(existsSync(join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME))).toBe(false);

    // Marker consumed, result written for the stable UI to read back.
    const result = JSON.parse(readFileSync(join(betaHome, BETA_IMPORT_RESULT_FILE_NAME), "utf8"));
    expect(result.ok).toBe(true);

    // Database snapshot is a real, queryable copy.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(betaState, "state.sqlite"), { readOnly: true });
    const rows = db.prepare("SELECT title FROM threads").all() as Array<{ title: string }>;
    db.close();
    expect(rows[0]?.title).toBe("hello stable");

    // Small state copied; runtime files excluded.
    expect(readFileSync(join(betaState, "settings.json"), "utf8")).toContain("dark");
    expect(existsSync(join(betaState, "secrets", "token.json"))).toBe(true);
    expect(existsSync(join(betaState, "logs"))).toBe(false);
    expect(existsSync(join(betaState, "server-runtime.json"))).toBe(false);
  });

  it("keeps the existing Beta database and settings if a Stable secret is linked", async () => {
    const stableHome = await seedStableHome(makeRoot());
    const stableState = join(stableHome, "userdata");
    const betaHome = join(stableHome, "..", ".synara-beta");
    const betaState = join(betaHome, "userdata");
    mkdirSync(betaState, { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const betaDb = new DatabaseSync(join(betaState, "state.sqlite"));
    betaDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT)");
    betaDb.exec("INSERT INTO threads VALUES ('beta', 'Beta-only chat')");
    betaDb.close();
    writeFileSync(join(betaState, "settings.json"), JSON.stringify({ theme: "beta" }));
    symlinkSync(join(stableState, "settings.json"), join(stableState, "secrets", "linked.json"));
    writeMarker(betaHome, stableHome);

    const outcome = await run({ betaHomeDir: betaHome, stateDir: betaState });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("linked state entry");
    const stillBeta = new DatabaseSync(join(betaState, "state.sqlite"), { readOnly: true });
    expect(stillBeta.prepare("SELECT title FROM threads").get()).toEqual({
      title: "Beta-only chat",
    });
    stillBeta.close();
    expect(readFileSync(join(betaState, "settings.json"), "utf8")).toContain("beta");
    expect(existsSync(join(betaState, "secrets", "linked.json"))).toBe(false);
  });

  it.each(["userdata", "state.sqlite"])(
    "rejects a linked Stable %s before changing Beta",
    async (linkedEntry) => {
      const stableHome = await seedStableHome(makeRoot());
      const stableState = join(stableHome, "userdata");
      const betaHome = join(stableHome, "..", ".synara-beta");
      const betaState = join(betaHome, "userdata");
      mkdirSync(betaState, { recursive: true });
      writeFileSync(join(betaState, "settings.json"), "beta-only");

      const sourcePath = linkedEntry === "userdata" ? stableState : join(stableState, linkedEntry);
      const realPath = `${sourcePath}-real`;
      renameSync(sourcePath, realPath);
      symlinkSync(realPath, sourcePath);
      writeMarker(betaHome, stableHome);

      const outcome = await run({ betaHomeDir: betaHome, stateDir: betaState });
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain("linked state entry");
      expect(readFileSync(join(betaState, "settings.json"), "utf8")).toBe("beta-only");
      expect(existsSync(join(betaState, "state.sqlite"))).toBe(false);
    },
  );

  it("preserves Beta-only entries inside a directory while re-copying Stable data", async () => {
    const stableHome = await seedStableHome(makeRoot());
    const betaHome = join(stableHome, "..", ".synara-beta");
    const betaState = join(betaHome, "userdata");
    mkdirSync(join(betaState, "secrets"), { recursive: true });
    writeFileSync(join(betaState, "secrets", "beta-only.json"), "beta-only");
    writeMarker(betaHome, stableHome);

    const outcome = await run({ betaHomeDir: betaHome, stateDir: betaState });
    expect(outcome).toEqual({ consumed: true, ok: true });
    expect(readFileSync(join(betaState, "secrets", "beta-only.json"), "utf8")).toBe("beta-only");
    expect(existsSync(join(betaState, "secrets", "token.json"))).toBe(true);
  });

  it("never carries database sidecars or lifecycle locks into the beta home", async () => {
    const root = await seedStableHome(makeRoot());
    const stableState = join(root, "userdata");
    const lockDir = join(stableState, "state.sqlite.lifecycle-lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "lock.json"), JSON.stringify({ pid: 9999, token: "x" }));
    writeFileSync(join(stableState, "state.sqlite.import-999"), "stale staging file");
    writeFileSync(join(stableState, "other.sqlite.lifecycle-lock"), "foreign lock");

    const betaHome = join(root, ".synara-beta");
    const betaState = join(betaHome, "userdata");
    writeMarker(betaHome, root);

    const outcome = await run({ betaHomeDir: betaHome, stateDir: betaState });
    expect(outcome).toEqual({ consumed: true, ok: true });
    expect(existsSync(join(betaState, "state.sqlite"))).toBe(true);
    // Only the checkpointed snapshot lands — no live-database sidecars.
    expect(readdirSync(betaState).filter((entry) => entry.startsWith("state.sqlite"))).toEqual([
      "state.sqlite",
    ]);
    expect(existsSync(join(betaState, "other.sqlite.lifecycle-lock"))).toBe(false);
  });

  it("imports while the stable database is held under an exclusive lock", async () => {
    const root = await seedStableHome(makeRoot());
    const stableState = join(root, "userdata");
    const betaHome = join(root, ".synara-beta");
    const betaState = join(betaHome, "userdata");
    writeMarker(betaHome, root);

    // The live stable server holds state.sqlite under
    // `PRAGMA locking_mode = EXCLUSIVE` (see persistence/Layers/Sqlite.ts), so
    // VACUUM INTO against it always reports "database is locked" — the importer
    // must fall back to a file-level snapshot of db + WAL.
    const { DatabaseSync } = await import("node:sqlite");
    const liveDb = new DatabaseSync(join(stableState, "state.sqlite"));
    try {
      liveDb.exec("PRAGMA journal_mode = WAL");
      liveDb.exec("PRAGMA locking_mode = EXCLUSIVE");
      liveDb.exec("INSERT INTO threads VALUES ('t2', 'written while locked')");

      const outcome = await run({
        betaHomeDir: betaHome,
        stateDir: betaState,
      });
      expect(outcome).toEqual({ consumed: true, ok: true });
    } finally {
      liveDb.close();
    }

    const db = new DatabaseSync(join(betaState, "state.sqlite"), { readOnly: true });
    const titles = (
      db.prepare("SELECT title FROM threads ORDER BY id").all() as Array<{ title: string }>
    ).map((row) => row.title);
    db.close();
    expect(titles).toEqual(["hello stable", "written while locked"]);
  });

  it("refuses an import that points at the beta home itself", async () => {
    const root = makeRoot();
    const betaHome = join(root, ".synara-beta");
    writeMarker(betaHome, betaHome);

    const outcome = await run({
      betaHomeDir: betaHome,
      stateDir: join(betaHome, "userdata"),
    });
    expect(outcome.consumed).toBe(true);
    expect(outcome.ok).toBe(false);
    const result = JSON.parse(readFileSync(join(betaHome, BETA_IMPORT_RESULT_FILE_NAME), "utf8"));
    expect(result.error).toContain("beta home");
  });

  it("reports a missing stable database without crashing startup", async () => {
    const root = makeRoot();
    const stableHome = join(root, ".synara");
    mkdirSync(join(stableHome, "userdata"), { recursive: true });
    const betaHome = join(root, ".synara-beta");
    writeMarker(betaHome, stableHome);

    const outcome = await run({
      betaHomeDir: betaHome,
      stateDir: join(betaHome, "userdata"),
    });
    expect(outcome.consumed).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("stable database not found");
  });

  it("copies no state entries when the database snapshot fails", async () => {
    const root = makeRoot();
    const stableHome = join(root, ".synara");
    const stableState = join(stableHome, "userdata");
    mkdirSync(stableState, { recursive: true });
    // A corrupt source db fails both VACUUM INTO paths, so the import must
    // fail before any non-db entries land on top of beta's own database.
    writeFileSync(join(stableState, "state.sqlite"), "not a sqlite database");
    writeFileSync(join(stableState, "settings.json"), JSON.stringify({ theme: "dark" }));
    writeFileSync(join(stableState, "secrets.json"), JSON.stringify({ token: "x" }));

    const betaHome = join(root, ".synara-beta");
    const betaState = join(betaHome, "userdata");
    writeMarker(betaHome, stableHome);

    const outcome = await run({
      betaHomeDir: betaHome,
      stateDir: betaState,
    });
    expect(outcome.consumed).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(existsSync(join(betaState, "settings.json"))).toBe(false);
    expect(existsSync(join(betaState, "secrets.json"))).toBe(false);
    expect(existsSync(join(betaState, "state.sqlite"))).toBe(false);
  });

  it("removes a directory-shaped marker without failing startup", async () => {
    const root = makeRoot();
    const betaHome = join(root, ".synara-beta");
    // A stray directory named like the marker must not throw out of finish()
    // — that throw is a StartupError on every launch.
    mkdirSync(join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME), { recursive: true });

    const outcome = await run({
      betaHomeDir: betaHome,
      stateDir: join(betaHome, "userdata"),
    });
    expect(outcome.consumed).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(existsSync(join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME))).toBe(false);
  });

  it("discards a stale import request instead of importing over newer data", async () => {
    const stableHome = await seedStableHome(makeRoot());
    const betaHome = join(stableHome, "..", ".synara-beta");
    const betaState = join(betaHome, "userdata");
    mkdirSync(betaHome, { recursive: true });
    writeFileSync(
      join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME),
      JSON.stringify({
        version: 1,
        requestedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        sourceHomeDir: stableHome,
      }),
    );
    // An existing success result must survive a stale-marker cleanup.
    writeFileSync(
      join(betaHome, BETA_IMPORT_RESULT_FILE_NAME),
      JSON.stringify({ version: 1, completedAt: new Date().toISOString(), ok: true }),
    );

    const outcome = await run({
      betaHomeDir: betaHome,
      stateDir: betaState,
    });
    expect(outcome).toEqual({ consumed: true, ok: true });
    expect(existsSync(join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME))).toBe(false);
    expect(existsSync(join(betaState, "state.sqlite"))).toBe(false);
    expect(existsSync(join(betaState, "settings.json"))).toBe(false);
    const result = JSON.parse(readFileSync(join(betaHome, BETA_IMPORT_RESULT_FILE_NAME), "utf8"));
    expect(result.ok).toBe(true);
  });

  it("replaces a stale marker without retry loops", async () => {
    const root = await seedStableHome(makeRoot());
    const betaHome = join(root, ".synara-beta");
    writeMarker(betaHome, root);
    writeFileSync(join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME), "garbage");

    const outcome = await run({
      betaHomeDir: betaHome,
      stateDir: join(betaHome, "userdata"),
    });
    expect(outcome.consumed).toBe(true);
    expect(outcome.ok).toBe(false);
    // Marker is gone — a second boot does not retry a malformed request.
    expect(existsSync(join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME))).toBe(false);
  });

  it("refuses a source that is not the Synara data folder", async () => {
    const root = await seedStableHome(makeRoot());
    const betaHome = join(root, ".synara-beta");
    const betaState = join(betaHome, "userdata");
    writeMarker(betaHome, root);

    const outcome = await run(
      { betaHomeDir: betaHome, stateDir: betaState },
      { allowedSourceHomes: [join(root, "..", "somewhere-else")] },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("not the Synara data folder");
    expect(existsSync(join(betaState, "state.sqlite"))).toBe(false);
  });

  it("refuses a stable database newer than this beta understands", async () => {
    const root = await seedStableHome(makeRoot());
    const { DatabaseSync } = await import("node:sqlite");
    const stableDb = new DatabaseSync(join(root, "userdata", "state.sqlite"));
    stableDb.exec("CREATE TABLE effect_sql_migrations (migration_id INTEGER, name TEXT)");
    stableDb.exec("INSERT INTO effect_sql_migrations VALUES (1, 'a'), (51, 'from-the-future')");
    stableDb.close();
    const betaHome = join(root, ".synara-beta");
    const betaState = join(betaHome, "userdata");
    writeMarker(betaHome, root);

    const outcome = await run(
      { betaHomeDir: betaHome, stateDir: betaState },
      { latestMigrationId: 50 },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("Update Synara Beta");
    expect(existsSync(join(betaState, "state.sqlite"))).toBe(false);
    expect(existsSync(join(betaState, "settings.json"))).toBe(false);
  });

  it("drops a stale beta WAL so it cannot replay over the imported database", async () => {
    const root = await seedStableHome(makeRoot());
    const betaHome = join(root, ".synara-beta");
    const betaState = join(betaHome, "userdata");
    mkdirSync(betaState, { recursive: true });

    // Leave a real, un-checkpointed WAL from an "unclean" earlier beta run.
    const { DatabaseSync } = await import("node:sqlite");
    const betaDbPath = join(betaState, "state.sqlite");
    const oldBeta = new DatabaseSync(betaDbPath);
    oldBeta.exec("PRAGMA journal_mode = WAL");
    oldBeta.exec("PRAGMA wal_autocheckpoint = 0");
    oldBeta.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT)");
    oldBeta.exec("INSERT INTO threads VALUES ('old', 'stale beta row')");
    const staleWal = readFileSync(`${betaDbPath}-wal`);
    oldBeta.close();
    writeFileSync(`${betaDbPath}-wal`, staleWal);
    writeFileSync(`${betaDbPath}-shm`, "stale index");

    writeMarker(betaHome, root);
    const outcome = await run({ betaHomeDir: betaHome, stateDir: betaState });
    expect(outcome).toEqual({ consumed: true, ok: true });
    expect(existsSync(`${betaDbPath}-wal`)).toBe(false);
    expect(existsSync(`${betaDbPath}-shm`)).toBe(false);

    const db = new DatabaseSync(betaDbPath, { readOnly: true });
    const titles = (db.prepare("SELECT title FROM threads").all() as Array<{ title: string }>).map(
      (row) => row.title,
    );
    db.close();
    expect(titles).toEqual(["hello stable"]);
  });
});

describe("copyLiveDatabase", () => {
  function seedDbFile(root: string): string {
    const dbPath = join(root, "state.sqlite");
    writeFileSync(dbPath, "db");
    writeFileSync(`${dbPath}-wal`, "wal");
    writeFileSync(`${dbPath}-shm`, "shm");
    return dbPath;
  }

  it("retries a copy torn by a checkpoint and skips the shm index", () => {
    const root = makeRoot();
    const dbPath = seedDbFile(root);
    const stagingDir = join(root, "staging");
    const signatures = ["a", "b", "b", "b"];
    const staged = copyLiveDatabase(dbPath, stagingDir, () => signatures.shift() ?? "b");
    expect(signatures).toEqual([]);
    expect(readFileSync(staged, "utf8")).toBe("db");
    expect(readdirSync(stagingDir).toSorted()).toEqual(["state.sqlite", "state.sqlite-wal"]);
  });

  it("fails instead of importing a torn pair when the database never settles", () => {
    const root = makeRoot();
    const dbPath = seedDbFile(root);
    let tick = 0;
    expect(() => copyLiveDatabase(dbPath, join(root, "staging"), () => String(tick++))).toThrow(
      /kept rewriting/,
    );
  });
});

const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;
const sqlJson = (value: unknown) => sqlText(JSON.stringify(value));

describe("Beta import isolation from Stable", () => {
  async function seedStableTables(stableHome: string, statements: readonly string[]) {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(stableHome, "userdata", "state.sqlite"));
    for (const statement of statements) db.exec(statement);
    db.close();
  }

  async function readBeta<T>(betaState: string, query: string): Promise<T[]> {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(betaState, "state.sqlite"), { readOnly: true });
    try {
      return db.prepare(query).all() as T[];
    } finally {
      db.close();
    }
  }

  async function importInto(stableHome: string, copyCheckpointRefs?: () => Promise<number>) {
    const betaHome = join(stableHome, "..", ".synara-beta");
    const betaState = join(betaHome, "userdata");
    writeMarker(betaHome, stableHome);
    const outcome = await run(
      { betaHomeDir: betaHome, stateDir: betaState },
      copyCheckpointRefs ? { copyCheckpointRefs } : {},
    );
    expect(outcome).toEqual({ consumed: true, ok: true });
    return betaState;
  }

  it("imports schedules paused, with no scheduler lease or active run", async () => {
    const stableHome = await seedStableHome(makeRoot());
    await seedStableTables(stableHome, [
      `CREATE TABLE automation_definitions (automation_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL,
         disabled_reason TEXT, disabled_at TEXT)`,
      "INSERT INTO automation_definitions VALUES ('on', 1, NULL, NULL), ('off', 0, 'failures', 'x')",
      `CREATE TABLE automation_scheduler_leases (lease_key TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
         lease_expires_at TEXT NOT NULL)`,
      "INSERT INTO automation_scheduler_leases VALUES ('scheduler', 'stable-server', '2999-01-01')",
      `CREATE TABLE automation_runs (run_id TEXT PRIMARY KEY, status TEXT NOT NULL, claimed_by TEXT,
         lease_expires_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL)`,
      `INSERT INTO automation_runs VALUES
         ('claimed', 'claimed', 'stable-server', '2999-01-01', NULL, 'then'),
         ('done', 'succeeded', NULL, NULL, 'then', 'then')`,
      `CREATE TABLE pull_request_auto_fix (thread_id TEXT NOT NULL, pull_request_url TEXT NOT NULL,
         status TEXT NOT NULL, pause_reason TEXT, updated_at TEXT NOT NULL,
         PRIMARY KEY (thread_id, pull_request_url))`,
      "INSERT INTO pull_request_auto_fix VALUES ('t1', 'https://github.com/o/r/pull/1', 'watching', NULL, 'then')",
    ]);

    const betaState = await importInto(stableHome);

    expect(
      await readBeta(
        betaState,
        "SELECT automation_id AS id, enabled, disabled_reason AS reason FROM automation_definitions ORDER BY automation_id",
      ),
    ).toEqual([
      { id: "off", enabled: 0, reason: "failures" },
      { id: "on", enabled: 0, reason: "user" },
    ]);
    expect(await readBeta(betaState, "SELECT * FROM automation_scheduler_leases")).toEqual([]);
    const runs = await readBeta<{
      id: string;
      status: string;
      claimedBy: string | null;
      lease: string | null;
      finishedAt: string | null;
    }>(
      betaState,
      "SELECT run_id AS id, status, claimed_by AS claimedBy, lease_expires_at AS lease, finished_at AS finishedAt FROM automation_runs ORDER BY run_id",
    );
    expect(runs[0]).toMatchObject({
      id: "claimed",
      status: "interrupted",
      claimedBy: null,
      lease: null,
    });
    expect(runs[0]?.finishedAt).not.toBeNull();
    expect(runs[1]).toEqual({
      id: "done",
      status: "succeeded",
      claimedBy: null,
      lease: null,
      finishedAt: "then",
    });
    expect(
      await readBeta(betaState, "SELECT status, pause_reason AS reason FROM pull_request_auto_fix"),
    ).toEqual([{ status: "paused", reason: null }]);

    const { DatabaseSync } = await import("node:sqlite");
    const stableDb = new DatabaseSync(join(stableHome, "userdata", "state.sqlite"), {
      readOnly: true,
    });
    expect(
      stableDb
        .prepare("SELECT enabled FROM automation_definitions WHERE automation_id = 'on'")
        .get(),
    ).toEqual({ enabled: 1 });
    stableDb.close();
  });

  it("detaches imported threads from Stable's worktrees and scratch folders", async () => {
    const stableHome = await seedStableHome(makeRoot());
    const stableWorktree = join(stableHome, "worktrees", "repo", "feature");
    const externalWorktree = join(stableHome, "..", "elsewhere", "feature");
    const threadCreated = {
      threadId: "t-stable",
      worktreePath: stableWorktree,
      workingDirectory: join(stableWorktree, "packages", "app"),
      nested: { associatedWorktreePath: stableWorktree },
      text: `look in ${stableWorktree}`,
    };
    const sessionPayload = { cwd: stableWorktree, model: "m" };
    const scratchSessionPayload = {
      cwd: join(stableHome, "..", "Caches", ".synara-0", "synara-codex-workspaces", "t-scratch-1"),
      model: "m",
    };
    const projectSessionPayload = { cwd: externalWorktree, model: "m" };
    const metaUpdated = {
      threadId: "t-stable",
      envMode: "worktree",
      branch: "feature",
      worktreePath: stableWorktree,
      workingDirectory: join(stableWorktree, "packages", "app"),
      associatedWorktreePath: stableWorktree,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await seedStableTables(stableHome, [
      `CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, env_mode TEXT NOT NULL,
         worktree_path TEXT, associated_worktree_path TEXT, working_directory TEXT)`,
      `INSERT INTO projection_threads VALUES
         ('t-stable', 'worktree', ${sqlText(stableWorktree)}, ${sqlText(stableWorktree)}, NULL),
         ('t-external', 'worktree', ${sqlText(externalWorktree)}, NULL, NULL)`,
      "CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY, payload_json TEXT NOT NULL)",
      `INSERT INTO orchestration_events VALUES (1, ${sqlJson(threadCreated)})`,
      `INSERT INTO orchestration_events VALUES (2, ${sqlJson(metaUpdated)})`,
      `CREATE TABLE provider_session_runtime (thread_id TEXT PRIMARY KEY, runtime_payload_json TEXT)`,
      `INSERT INTO provider_session_runtime VALUES ('t-stable', ${sqlJson(sessionPayload)}),
         ('t-scratch', ${sqlJson(scratchSessionPayload)}),
         ('t-project', ${sqlJson(projectSessionPayload)})`,
    ]);

    const betaState = await importInto(stableHome, async () => 0);

    expect(
      await readBeta(
        betaState,
        "SELECT thread_id AS id, env_mode AS envMode, worktree_path AS path, associated_worktree_path AS associated FROM projection_threads ORDER BY thread_id",
      ),
    ).toEqual([
      { id: "t-external", envMode: "worktree", path: externalWorktree, associated: null },
      { id: "t-stable", envMode: "worktree", path: null, associated: null },
    ]);
    const [event, metaEvent] = await readBeta<{ payload: string }>(
      betaState,
      "SELECT payload_json AS payload FROM orchestration_events ORDER BY sequence",
    );
    expect(
      Schema.decodeUnknownSync(ThreadMetaUpdatedPayload)(JSON.parse(metaEvent!.payload)),
    ).toMatchObject({
      branch: "feature",
      worktreePath: null,
      workingDirectory: null,
      associatedWorktreePath: null,
    });
    expect(JSON.parse(event!.payload)).toEqual({
      ...threadCreated,
      worktreePath: null,
      workingDirectory: null,
      nested: { associatedWorktreePath: null },
    });
    const sessions = await readBeta<{ id: string; payload: string }>(
      betaState,
      "SELECT thread_id AS id, runtime_payload_json AS payload FROM provider_session_runtime ORDER BY thread_id",
    );
    expect(sessions.map((row) => [row.id, JSON.parse(row.payload)])).toEqual([
      ["t-project", projectSessionPayload],
      ["t-scratch", { model: "m" }],
      ["t-stable", { model: "m" }],
    ]);
  });

  it("reports repositories whose checkpoint refs could not be copied", async () => {
    const stableHome = await seedStableHome(makeRoot());
    const betaHome = join(stableHome, "..", ".synara-beta");
    writeMarker(betaHome, stableHome);
    const outcome = await run(
      { betaHomeDir: betaHome, stateDir: join(betaHome, "userdata") },
      { copyCheckpointRefs: async () => 2 },
    );
    expect(outcome).toEqual({ consumed: true, ok: true, checkpointRefCopyFailures: 2 });
  });

  it("moves checkpoint refs into Beta's namespace and copies them without touching Stable's", async () => {
    const stableHome = await seedStableHome(makeRoot());
    const repo = join(stableHome, "..", "repo");
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", ...args], {
        encoding: "utf8",
      }).trim();
    git("init", "-q");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "c");
    const head = git("rev-parse", "HEAD");
    const stableRef = "refs/synara/checkpoints/dC1zdGFibGU/turn/1";
    const stableStartRef = "refs/synara/checkpoints/dC1zdGFibGU/turn-start/dHVybi0x";
    git("update-ref", stableRef, head);
    git("update-ref", stableStartRef, head);
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "historical",
    );
    const historicalHead = git("rev-parse", "HEAD");
    git("update-ref", "refs/historical/checkpoints/dC1zdGFibGU/turn/1", historicalHead);
    await seedStableTables(stableHome, [
      "CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, workspace_root TEXT NOT NULL)",
      `INSERT INTO projection_projects VALUES ('p1', ${sqlText(repo)})`,
      `CREATE TABLE projection_turns (row_id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL,
         checkpoint_ref TEXT)`,
      `INSERT INTO projection_turns VALUES (1, 't-stable', ${sqlText(stableRef)})`,
      "CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY, payload_json TEXT NOT NULL)",
      `INSERT INTO orchestration_events VALUES (1, ${sqlJson({ checkpointRef: stableRef, text: stableRef })})`,
    ]);

    const betaState = await importInto(stableHome);

    const betaRef = "refs/synara-beta/checkpoints/dC1zdGFibGU/turn/1";
    expect(await readBeta(betaState, "SELECT checkpoint_ref AS ref FROM projection_turns")).toEqual(
      [{ ref: betaRef }],
    );
    const [event] = await readBeta<{ payload: string }>(
      betaState,
      "SELECT payload_json AS payload FROM orchestration_events",
    );
    expect(JSON.parse(event!.payload)).toEqual({ checkpointRef: betaRef, text: stableRef });
    expect(git("rev-parse", betaRef)).toBe(head);
    expect(git("rev-parse", "refs/synara-beta/checkpoints/dC1zdGFibGU/turn-start/dHVybi0x")).toBe(
      head,
    );
    expect(git("rev-parse", stableRef)).toBe(head);
    expect(git("rev-parse", stableStartRef)).toBe(head);
  });
});
