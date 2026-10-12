// FILE: betaImport.ts
// Purpose: Beta-side consumer of the stable app's "Copy my data to Beta" handoff.
// Layer: Startup hook — runs before the beta server creates/opens its own database.
//
// Stable writes `<betaHome>/import-requested.json` when the user picks
// "Copy my data to Beta". The beta server finds the marker here (baseDir is the
// beta home), snapshots the stable home with a consistent `VACUUM INTO` copy of
// `userdata/state.sqlite` plus the small non-database files, then deletes the
// marker and reports through `<betaHome>/import-result.json` for the stable UI.
//
// The marker file is untrusted input: the source path is resolved and must not
// point back at this install's own home before anything is read or written.

import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  cpSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import {
  BETA_IMPORT_REQUEST_FILE_NAME,
  BETA_IMPORT_RESULT_FILE_NAME,
  SYNARA_STABLE_HOME_ENV,
  type BetaImportRequest,
} from "@synara/shared/betaChannel";

import { BETA_CHECKPOINT_REFS_PREFIX, parseManagedCheckpointRef } from "./checkpointing/Utils";
import { runProcess } from "./processRunner";

/** Entries that describe this install's live runtime, not user data. */
const EXCLUDED_STATE_ENTRIES = new Set([
  "logs",
  "diagnostics",
  "server-runtime.json",
  "quit-resume.json",
  BETA_IMPORT_REQUEST_FILE_NAME,
  BETA_IMPORT_RESULT_FILE_NAME,
]);

/**
 * `state.sqlite` plus every adjacent sidecar that belongs to the live
 * database — WAL/SHM/journal files, the `.lifecycle-lock/` directory, and the
 * importer's own `.import-*` staging files all share this stem.
 */
const STATE_DB_ENTRY_PATTERN = /^state\.sqlite(?:[.-].*)?$/;

/**
 * A marker left behind by an aborted handoff must never import over a beta
 * home that has since accumulated its own data. Requests older than this are
 * discarded instead of consumed.
 */
const IMPORT_REQUEST_MAX_AGE_MS = 60 * 60 * 1000;

const sqlStringLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

function readImportRequest(markerPath: string): BetaImportRequest | null {
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.version !== 1 ||
      typeof parsed.requestedAt !== "string" ||
      typeof parsed.sourceHomeDir !== "string" ||
      parsed.sourceHomeDir.trim() === ""
    ) {
      return null;
    }
    return parsed as BetaImportRequest;
  } catch {
    return null;
  }
}

function writeImportResult(betaHomeDir: string, result: { ok: boolean; error?: string }): void {
  const resultPath = join(betaHomeDir, BETA_IMPORT_RESULT_FILE_NAME);
  const tempPath = `${resultPath}.tmp-${process.pid}`;
  writeFileSync(
    tempPath,
    `${JSON.stringify({ version: 1, completedAt: new Date().toISOString(), ...result })}\n`,
    "utf8",
  );
  renameSync(tempPath, resultPath);
}

function rejectLinkedEntry(path: string): boolean {
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error(`Cannot import a linked state entry: ${path}`);
  }
  return true;
}

function copyStateEntries(
  sourceStateDir: string,
  stagedStateDir: string,
  existingStateDir: string,
): string[] {
  mkdirSync(stagedStateDir, { recursive: true });
  const copiedEntries: string[] = [];
  for (const entry of readdirSync(sourceStateDir)) {
    if (EXCLUDED_STATE_ENTRIES.has(entry)) continue;
    if (STATE_DB_ENTRY_PATTERN.test(entry)) continue;
    if (entry.endsWith(".lifecycle-lock")) continue;
    const sourcePath = join(sourceStateDir, entry);
    const stagedPath = join(stagedStateDir, entry);
    const stats = lstatSync(sourcePath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Cannot import a linked state entry: ${sourcePath}`);
    }
    if (stats.isDirectory()) {
      const existingPath = join(existingStateDir, entry);
      const existing = lstatSync(existingPath, { throwIfNoEntry: false });
      if (existing?.isDirectory()) {
        // The old overlay semantics keep Beta-only files inside a shared
        // directory, such as provider secrets absent from Stable.
        cpSync(existingPath, stagedPath, {
          recursive: true,
          force: true,
          filter: rejectLinkedEntry,
        });
      } else if (existing?.isSymbolicLink()) {
        throw new Error(`Cannot replace a linked Beta state entry: ${existingPath}`);
      }
      cpSync(sourcePath, stagedPath, {
        recursive: true,
        force: true,
        filter: rejectLinkedEntry,
      });
    } else if (stats.isFile()) {
      cpSync(sourcePath, stagedPath, { force: true });
    } else {
      continue;
    }
    copiedEntries.push(entry);
  }
  return copiedEntries;
}

/** Sidecars that carry committed state. `-shm` is only a rebuildable index. */
const SNAPSHOT_SIDECAR_SUFFIXES = ["-wal", "-journal"] as const;
const LIVE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
const LIVE_COPY_ATTEMPTS = 5;

/**
 * Identifies the moments a live copy can tear: a checkpoint rewrites the main
 * file (size/mtime change) and a WAL restart rewrites the WAL header salts.
 */
function liveDatabaseSignature(sourceDbPath: string): string {
  const main = statSync(sourceDbPath);
  let walHeader = "none";
  try {
    const fd = openSync(`${sourceDbPath}-wal`, "r");
    try {
      const header = Buffer.alloc(32);
      walHeader = header.subarray(0, readSync(fd, header, 0, 32, 0)).toString("hex");
    } finally {
      closeSync(fd);
    }
  } catch {
    // No WAL: nothing to tear against.
  }
  return `${main.size}:${main.mtimeMs}:${walHeader}`;
}

/** Highest applied migration in a database file, or null without a tracker. */
async function readMigrationHighWaterMark(dbPath: string): Promise<number | null> {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const table = database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'",
      )
      .get();
    if (!table) return null;
    const row = database
      .prepare("SELECT max(migration_id) AS id FROM effect_sql_migrations")
      .get() as { id: number | null } | undefined;
    return typeof row?.id === "number" ? row.id : null;
  } finally {
    database.close();
  }
}

async function vacuumInto(sourceDbPath: string, targetPath: string): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(sourceDbPath);
  try {
    database.exec(`VACUUM INTO ${sqlStringLiteral(targetPath)}`);
  } finally {
    database.close();
  }
}

/**
 * File-level snapshot of a database another process holds open. The stable
 * server keeps `state.sqlite` under `PRAGMA locking_mode = EXCLUSIVE`, so no
 * second connection can `VACUUM INTO` it while it runs. The main file and WAL
 * are only a consistent pair if no checkpoint or WAL restart lands between
 * the two copies, so the copy is retried until the database signature is the
 * same before and after, and fails rather than import a torn pair. Appends to
 * the WAL during the copy are fine: a torn tail frame fails its checksum and
 * is discarded on recovery.
 */
export function copyLiveDatabase(
  sourceDbPath: string,
  stagingDir: string,
  signature: (dbPath: string) => string = liveDatabaseSignature,
): string {
  const stagedDbPath = join(stagingDir, "state.sqlite");
  for (let attempt = 0; attempt < LIVE_COPY_ATTEMPTS; attempt += 1) {
    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(stagingDir, { recursive: true });
    const before = signature(sourceDbPath);
    cpSync(sourceDbPath, stagedDbPath, { force: true });
    for (const suffix of SNAPSHOT_SIDECAR_SUFFIXES) {
      const sidecarPath = `${sourceDbPath}${suffix}`;
      if (existsSync(sidecarPath) && statSync(sidecarPath).isFile()) {
        cpSync(sidecarPath, join(stagingDir, `state.sqlite${suffix}`), { force: true });
      }
    }
    if (signature(sourceDbPath) === before) return stagedDbPath;
  }
  throw new Error("Synara kept rewriting its database during the copy. Try again in a moment.");
}

async function snapshotStableDatabase(
  sourceDbPath: string,
  targetDbPath: string,
  latestMigrationId: number,
): Promise<void> {
  const stagingPath = `${targetDbPath}.import-${process.pid}`;
  const stagingDir = `${stagingPath}.src`;
  rmSync(stagingPath, { force: true });
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(resolve(targetDbPath, ".."), { recursive: true });
  try {
    try {
      await vacuumInto(sourceDbPath, stagingPath);
    } catch {
      // VACUUM INTO refuses an existing target; drop any partial output.
      rmSync(stagingPath, { force: true });
      const stagedDbPath = copyLiveDatabase(sourceDbPath, stagingDir);
      // Opening the staged copy replays its WAL, so the vacuumed output is a
      // fully checkpointed database — and a corrupt copy surfaces here as an
      // error instead of landing in the beta home.
      await vacuumInto(stagedDbPath, stagingPath);
    }
    const sourceMigration = await readMigrationHighWaterMark(stagingPath);
    if (sourceMigration !== null && sourceMigration > latestMigrationId) {
      throw new Error(
        "Synara is newer than this Synara Beta. Update Synara Beta, then copy your data again.",
      );
    }
    // A leftover WAL from an earlier unclean beta exit is not tied to a
    // database file and would replay old pages over the imported one.
    for (const suffix of LIVE_SIDECAR_SUFFIXES) {
      rmSync(`${targetDbPath}${suffix}`, { force: true });
    }
    renameSync(stagingPath, targetDbPath);
  } finally {
    rmSync(stagingPath, { force: true });
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

function commitStagedImport(
  stagedStateDir: string,
  targetStateDir: string,
  copiedEntries: readonly string[],
): void {
  mkdirSync(targetStateDir, { recursive: true });
  const backupDir = mkdtempSync(join(resolve(targetStateDir, ".."), ".beta-import-backup-"));
  const committed: Array<{ name: string; hadPrevious: boolean }> = [];
  const entries = [
    ...copiedEntries,
    ...LIVE_SIDECAR_SUFFIXES.map((suffix) => `state.sqlite${suffix}`),
    "state.sqlite",
  ];

  try {
    for (const name of entries) {
      const targetPath = join(targetStateDir, name);
      const previousPath = join(backupDir, name);
      const stagedPath = join(stagedStateDir, name);
      const hadPrevious = lstatSync(targetPath, { throwIfNoEntry: false }) !== undefined;
      if (hadPrevious) renameSync(targetPath, previousPath);
      committed.push({ name, hadPrevious });
      if (lstatSync(stagedPath, { throwIfNoEntry: false }) !== undefined) {
        renameSync(stagedPath, targetPath);
      }
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const { name, hadPrevious } of committed.reverse()) {
      try {
        rmSync(join(targetStateDir, name), { recursive: true, force: true });
        if (hadPrevious) renameSync(join(backupDir, name), join(targetStateDir, name));
      } catch (rollbackError) {
        rollbackErrors.push(`${name}: ${String(rollbackError)}`);
      }
    }
    if (rollbackErrors.length > 0) {
      // Preserve the backup for manual recovery instead of deleting the only
      // remaining copy of Beta data after a filesystem failure.
      throw new Error(
        `Beta import failed and rollback was incomplete. Previous data remains at ${backupDir}: ${rollbackErrors.join("; ")}`,
        { cause: error },
      );
    }
    rmSync(backupDir, { recursive: true, force: true });
    throw error;
  }

  rmSync(backupDir, { recursive: true, force: true });
}

type StagedDatabase = InstanceType<typeof import("node:sqlite").DatabaseSync>;

const BETA_CHECKPOINT_NAMESPACE = "synara-beta";
const DETACHED_WORKTREE_KEYS = new Set([
  "worktreePath",
  "associatedWorktreePath",
  "workingDirectory",
]);
const ACTIVE_AUTOMATION_RUN_STATUSES = ["pending", "claimed", "running", "waiting-for-approval"];
const GIT_REF_COPY_TIMEOUT_MS = 30_000;

function tableColumns(db: StagedDatabase, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${sqlStringLiteral(table)})`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((row) => row.name));
}

function toBetaCheckpointRef(ref: string): string {
  const parsed = parseManagedCheckpointRef(ref);
  if (!parsed || parsed.namespace === BETA_CHECKPOINT_NAMESPACE) return ref;
  return `${BETA_CHECKPOINT_REFS_PREFIX}/${ref.slice(`refs/${parsed.namespace}/checkpoints/`.length)}`;
}

function isWithinAny(candidate: string, roots: readonly string[]): boolean {
  const resolved = resolve(candidate);
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}${sep}`));
}

function rewriteJsonStrings(
  node: unknown,
  rewrite: (key: string, value: string) => string | null,
): boolean {
  if (!node || typeof node !== "object") return false;
  let changed = false;
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === "string") {
      const next = rewrite(key, value);
      if (next !== value) {
        (node as Record<string, unknown>)[key] = next;
        changed = true;
      }
    } else if (rewriteJsonStrings(value, rewrite)) {
      changed = true;
    }
  }
  return changed;
}

function disableImportedSchedules(db: StagedDatabase, now: string): void {
  const definitions = tableColumns(db, "automation_definitions");
  if (definitions.has("enabled")) {
    const reason =
      definitions.has("disabled_reason") && definitions.has("disabled_at")
        ? ", disabled_reason = 'user', disabled_at = :now"
        : "";
    db.prepare(`UPDATE automation_definitions SET enabled = 0${reason} WHERE enabled <> 0`).run(
      reason ? { now } : {},
    );
  }
  if (tableColumns(db, "automation_scheduler_leases").size > 0) {
    db.exec("DELETE FROM automation_scheduler_leases");
  }
  const runs = tableColumns(db, "automation_runs");
  if (runs.has("status")) {
    const clears = ["claimed_by", "lease_expires_at", "deferred_until"]
      .filter((column) => runs.has(column))
      .map((column) => `, ${column} = NULL`)
      .join("");
    const finished = runs.has("finished_at") ? ", finished_at = COALESCE(finished_at, :now)" : "";
    const updated = runs.has("updated_at") ? ", updated_at = :now" : "";
    db.prepare(
      `UPDATE automation_runs SET status = 'interrupted'${clears}${finished}${updated}
       WHERE status IN (${ACTIVE_AUTOMATION_RUN_STATUSES.map(sqlStringLiteral).join(", ")})`,
    ).run(finished || updated ? { now } : {});
  }
  const autoFix = tableColumns(db, "pull_request_auto_fix");
  if (autoFix.has("status")) {
    const pauseReason = autoFix.has("pause_reason") ? ", pause_reason = NULL" : "";
    const updated = autoFix.has("updated_at") ? ", updated_at = :now" : "";
    db.prepare(
      `UPDATE pull_request_auto_fix SET status = 'paused'${pauseReason}${updated}
       WHERE status <> 'paused'`,
    ).run(updated ? { now } : {});
  }
}

function collectCheckpointRepositories(db: StagedDatabase): string[] {
  const directories = new Set<string>();
  if (tableColumns(db, "projection_projects").has("workspace_root")) {
    for (const row of db
      .prepare("SELECT DISTINCT workspace_root AS path FROM projection_projects")
      .all() as Array<{ path: unknown }>) {
      if (typeof row.path === "string" && row.path.trim() !== "") directories.add(row.path);
    }
  }
  if (tableColumns(db, "projection_threads").has("worktree_path")) {
    for (const row of db
      .prepare(
        "SELECT DISTINCT worktree_path AS path FROM projection_threads WHERE worktree_path IS NOT NULL",
      )
      .all() as Array<{ path: unknown }>) {
      if (typeof row.path === "string" && row.path.trim() !== "") directories.add(row.path);
    }
  }
  return [...directories];
}

function moveCheckpointRefsToBetaNamespace(db: StagedDatabase): void {
  if (tableColumns(db, "projection_turns").has("checkpoint_ref")) {
    const update = db.prepare("UPDATE projection_turns SET checkpoint_ref = ? WHERE row_id = ?");
    for (const row of db
      .prepare(
        "SELECT row_id AS rowId, checkpoint_ref AS ref FROM projection_turns WHERE checkpoint_ref LIKE 'refs/%/checkpoints/%'",
      )
      .all() as Array<{ rowId: number; ref: string }>) {
      const next = toBetaCheckpointRef(row.ref);
      if (next !== row.ref) update.run(next, row.rowId);
    }
  }
}

function detachSourceHomeWorktrees(db: StagedDatabase, sourceWorktreeRoots: readonly string[]) {
  const threads = tableColumns(db, "projection_threads");
  if (!threads.has("worktree_path")) return;
  if (!threads.has("env_mode")) {
    throw new Error("Synara's data is too old to copy. Update Synara, then copy your data again.");
  }
  const pathColumns = ["worktree_path", "associated_worktree_path", "working_directory"].filter(
    (column) => threads.has(column),
  );
  for (const column of pathColumns) {
    const update = db.prepare(`UPDATE projection_threads SET ${column} = NULL WHERE thread_id = ?`);
    for (const row of db
      .prepare(
        `SELECT thread_id AS threadId, ${column} AS path FROM projection_threads WHERE ${column} IS NOT NULL`,
      )
      .all() as Array<{ threadId: string; path: string }>) {
      if (isWithinAny(row.path, sourceWorktreeRoots)) update.run(row.threadId);
    }
  }
}

function rewriteImportedEventPayloads(
  db: StagedDatabase,
  sourceWorktreeRoots: readonly string[],
): void {
  if (!tableColumns(db, "orchestration_events").has("payload_json")) return;
  const pathNeedles = sourceWorktreeRoots.map((root) => JSON.stringify(root).slice(1, -1));
  const update = db.prepare("UPDATE orchestration_events SET payload_json = ? WHERE sequence = ?");
  const candidates = db
    .prepare(
      `SELECT sequence, payload_json AS payload FROM orchestration_events
       WHERE instr(payload_json, '"checkpointRef"') > 0
          OR ${pathNeedles.map(() => "instr(payload_json, ?) > 0").join(" OR ")}`,
    )
    .all(...pathNeedles) as Array<{ sequence: number; payload: string }>;
  for (const row of candidates) {
    const payload: unknown = JSON.parse(row.payload);
    const changed = rewriteJsonStrings(payload, (key, value) => {
      if (key === "checkpointRef") return toBetaCheckpointRef(value);
      if (DETACHED_WORKTREE_KEYS.has(key) && isWithinAny(value, sourceWorktreeRoots)) return null;
      return value;
    });
    if (changed) update.run(JSON.stringify(payload), row.sequence);
  }
}

function forgetSourceHomeSessionCwds(db: StagedDatabase, sourceWorktreeRoots: readonly string[]) {
  const columns = tableColumns(db, "provider_session_runtime");
  if (!columns.has("runtime_payload_json")) return;
  const update = db.prepare(
    "UPDATE provider_session_runtime SET runtime_payload_json = ? WHERE thread_id = ?",
  );
  for (const row of db
    .prepare(
      "SELECT thread_id AS threadId, runtime_payload_json AS payload FROM provider_session_runtime WHERE runtime_payload_json IS NOT NULL",
    )
    .all() as Array<{ threadId: string; payload: string }>) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (!payload || typeof payload !== "object") continue;
    const record = payload as Record<string, unknown>;
    if (typeof record.cwd === "string" && isWithinAny(record.cwd, sourceWorktreeRoots)) {
      delete record.cwd;
      update.run(JSON.stringify(record), row.threadId);
    }
  }
}

async function isolateImportedDatabase(input: {
  readonly dbPath: string;
  readonly sourceWorktreeRoots: readonly string[];
  readonly now?: string;
}): Promise<string[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(input.dbPath);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const repositories = collectCheckpointRepositories(db);
      disableImportedSchedules(db, input.now ?? new Date().toISOString());
      moveCheckpointRefsToBetaNamespace(db);
      detachSourceHomeWorktrees(db, input.sourceWorktreeRoots);
      rewriteImportedEventPayloads(db, input.sourceWorktreeRoots);
      forgetSourceHomeSessionCwds(db, input.sourceWorktreeRoots);
      db.exec("COMMIT");
      return repositories;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

async function runGit(cwd: string, args: readonly string[], stdin?: string) {
  return runProcess("git", args, {
    cwd,
    timeoutMs: GIT_REF_COPY_TIMEOUT_MS,
    allowNonZeroExit: true,
    ...(stdin === undefined ? {} : { stdin }),
  });
}

function betaCheckpointRefUpdates(forEachRefOutput: string): string[] {
  const targets = new Map<string, { objectName: string; fromStable: boolean }>();
  for (const line of forEachRefOutput.split("\n")) {
    const [objectName, refName] = line.trim().split(" ");
    if (!objectName || !refName) continue;
    const betaRef = toBetaCheckpointRef(refName);
    if (betaRef === refName) continue;
    const fromStable = refName.startsWith("refs/synara/");
    if (targets.get(betaRef)?.fromStable && !fromStable) continue;
    targets.set(betaRef, { objectName, fromStable });
  }
  return [...targets].map(([betaRef, { objectName }]) => `update ${betaRef} ${objectName}\n`);
}

async function copyCheckpointRefsToBetaNamespace(repositories: readonly string[]): Promise<number> {
  const visitedCommonDirs = new Set<string>();
  let failedRepositories = 0;
  for (const repository of repositories) {
    let commonDirPath: string;
    try {
      const commonDir = await runGit(repository, ["rev-parse", "--git-common-dir"]);
      if (commonDir.code !== 0 || commonDir.stdout.trim() === "") continue;
      commonDirPath = resolve(repository, commonDir.stdout.trim());
    } catch {
      continue;
    }
    if (visitedCommonDirs.has(commonDirPath)) continue;
    visitedCommonDirs.add(commonDirPath);
    try {
      const listed = await runGit(repository, [
        "for-each-ref",
        "--format=%(objectname) %(refname)",
        "refs/",
      ]);
      if (listed.code !== 0) {
        failedRepositories += 1;
        continue;
      }
      const updates = betaCheckpointRefUpdates(listed.stdout);
      if (updates.length === 0) continue;
      const updated = await runGit(repository, ["update-ref", "--stdin"], updates.join(""));
      if (updated.code !== 0) failedRepositories += 1;
    } catch {
      failedRepositories += 1;
    }
  }
  return failedRepositories;
}

/** Stable homes a beta may import from: the one stable handed over, else the default. */
export function allowedImportSourceHomes(env: NodeJS.ProcessEnv = process.env): string[] {
  const handedOver = env[SYNARA_STABLE_HOME_ENV]?.trim();
  return [handedOver ? resolve(handedOver) : resolve(homedir(), ".synara")];
}

export async function runBetaImportIfRequested(input: {
  readonly betaHomeDir: string;
  readonly stateDir: string;
  /** Newest migration this beta build knows; newer source databases are refused. */
  readonly latestMigrationId: number;
  readonly allowedSourceHomes?: readonly string[];
  readonly copyCheckpointRefs?: (repositories: readonly string[]) => Promise<number>;
}): Promise<{
  readonly consumed: boolean;
  readonly ok: boolean;
  readonly error?: string;
  readonly checkpointRefCopyFailures?: number;
}> {
  const markerPath = join(input.betaHomeDir, BETA_IMPORT_REQUEST_FILE_NAME);
  if (!existsSync(markerPath)) {
    return { consumed: false, ok: true };
  }

  const finish = (ok: boolean, error?: string) => {
    try {
      writeImportResult(input.betaHomeDir, { ok, ...(error ? { error } : {}) });
    } catch {
      // Result reporting is best-effort.
    }
    try {
      // recursive: a stray directory named like the marker must not throw
      // here — any throw out of this path is a StartupError on every launch.
      rmSync(markerPath, { recursive: true, force: true });
    } catch {
      // The marker is gone or unremovable; startup continues either way.
    }
    return { consumed: true, ok, ...(error ? { error } : {}) };
  };

  const request = readImportRequest(markerPath);
  if (!request) {
    return finish(false, "import marker was malformed");
  }

  const requestedAtMs = Date.parse(request.requestedAt);
  if (Number.isFinite(requestedAtMs) && Date.now() - requestedAtMs > IMPORT_REQUEST_MAX_AGE_MS) {
    // A stale marker would overwrite beta data accumulated since it was
    // written; delete it without importing and without touching any older
    // import-result the stable UI may still show.
    try {
      rmSync(markerPath, { recursive: true, force: true });
    } catch {
      // best effort
    }
    return { consumed: true, ok: true };
  }

  const sourceHomeDir = resolve(request.sourceHomeDir);
  if (sourceHomeDir === resolve(input.betaHomeDir)) {
    return finish(false, "import source points at the beta home itself");
  }
  if (!(input.allowedSourceHomes ?? allowedImportSourceHomes()).includes(sourceHomeDir)) {
    return finish(false, "import source is not the Synara data folder");
  }

  const sourceStateDir = join(sourceHomeDir, "userdata");
  const sourceDbPath = join(sourceStateDir, "state.sqlite");
  if (!existsSync(sourceDbPath)) {
    return finish(false, `stable database not found at ${sourceDbPath}`);
  }

  try {
    const realSourceHomeDir = realpathSync(sourceHomeDir);
    if (realSourceHomeDir === realpathSync(input.betaHomeDir)) {
      return finish(false, "import source points at the beta home itself");
    }
    for (const sourcePath of [
      sourceStateDir,
      sourceDbPath,
      ...LIVE_SIDECAR_SUFFIXES.map((suffix) => `${sourceDbPath}${suffix}`),
    ]) {
      if (lstatSync(sourcePath, { throwIfNoEntry: false })?.isSymbolicLink()) {
        return finish(false, `Cannot import a linked state entry: ${sourcePath}`);
      }
    }
    if (lstatSync(input.stateDir, { throwIfNoEntry: false })?.isSymbolicLink()) {
      return finish(false, "beta state folder cannot be a symbolic link");
    }
    // Validate and copy every source entry before changing Beta. An unreadable
    // secret or a linked file must not report success after replacing its DB.
    let checkpointRefCopyFailures = 0;
    const stagedRoot = mkdtempSync(join(input.betaHomeDir, ".beta-import-"));
    try {
      const stagedStateDir = join(stagedRoot, "userdata");
      const stagedDbPath = join(stagedStateDir, "state.sqlite");
      await snapshotStableDatabase(sourceDbPath, stagedDbPath, input.latestMigrationId);
      const repositories = await isolateImportedDatabase({
        dbPath: stagedDbPath,
        sourceWorktreeRoots: [
          ...new Set([join(sourceHomeDir, "worktrees"), join(realSourceHomeDir, "worktrees")]),
        ],
      });
      checkpointRefCopyFailures = await (
        input.copyCheckpointRefs ?? copyCheckpointRefsToBetaNamespace
      )(repositories);
      const copiedEntries = copyStateEntries(sourceStateDir, stagedStateDir, input.stateDir);
      commitStagedImport(stagedStateDir, input.stateDir, copiedEntries);
    } finally {
      rmSync(stagedRoot, { recursive: true, force: true });
    }
    return checkpointRefCopyFailures > 0
      ? { ...finish(true), checkpointRefCopyFailures }
      : finish(true);
  } catch (error) {
    return finish(false, error instanceof Error ? error.message : String(error));
  }
}
