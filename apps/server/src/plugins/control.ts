import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const PLUGIN_CONTROL_FILE = "plugins.json";

export interface PluginControlEntry {
  readonly enabled: boolean;
  readonly reloadToken: string;
  readonly sourceRoot?: string;
}

export interface PluginControlState {
  readonly plugins: Readonly<Record<string, PluginControlEntry>>;
}

const EMPTY_STATE: PluginControlState = { plugins: {} };
const CONTROL_LOCK_STALE_MS = 10_000;
const CONTROL_LOCK_WAIT_MS = 5_000;
const CONTROL_LOCK_RETRY_MS = 10;
const controlLockWaiter = new Int32Array(new SharedArrayBuffer(4));

export function pluginControlPath(baseDir: string): string {
  return path.join(baseDir, PLUGIN_CONTROL_FILE);
}

function isControlEntry(value: unknown): value is PluginControlEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { enabled?: unknown }).enabled === "boolean" &&
    typeof (value as { reloadToken?: unknown }).reloadToken === "string" &&
    ((value as { sourceRoot?: unknown }).sourceRoot === undefined ||
      typeof (value as { sourceRoot?: unknown }).sourceRoot === "string")
  );
}

export function readPluginControl(baseDir: string): PluginControlState {
  try {
    const parsed = JSON.parse(readFileSync(pluginControlPath(baseDir), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return EMPTY_STATE;
    const plugins = (parsed as { plugins?: unknown }).plugins;
    if (typeof plugins !== "object" || plugins === null || Array.isArray(plugins)) {
      return EMPTY_STATE;
    }
    return {
      plugins: Object.fromEntries(
        Object.entries(plugins).filter((entry): entry is [string, PluginControlEntry] =>
          isControlEntry(entry[1]),
        ),
      ),
    };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_STATE;
    throw cause;
  }
}

export function writePluginControl(baseDir: string, state: PluginControlState): void {
  mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  const target = pluginControlPath(baseDir);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

function withPluginControlLock<Value>(baseDir: string, operation: () => Value): Value {
  mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  const lockPath = `${pluginControlPath(baseDir)}.lock`;
  const deadline = Date.now() + CONTROL_LOCK_WAIT_MS;
  let handle: number | undefined;
  while (handle === undefined) {
    try {
      handle = openSync(lockPath, "wx", 0o600);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > CONTROL_LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch (inspectionCause) {
        if ((inspectionCause as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw inspectionCause;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for plugin control lock: ${lockPath}`);
      }
      Atomics.wait(controlLockWaiter, 0, 0, CONTROL_LOCK_RETRY_MS);
    }
  }
  try {
    return operation();
  } finally {
    closeSync(handle);
    try {
      unlinkSync(lockPath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
}

export function updatePluginControl(
  baseDir: string,
  pluginId: string,
  update: (current: PluginControlEntry) => PluginControlEntry,
): PluginControlEntry {
  return withPluginControlLock(baseDir, () => {
    const state = readPluginControl(baseDir);
    const next = update(state.plugins[pluginId] ?? { enabled: true, reloadToken: "" });
    writePluginControl(baseDir, {
      plugins: { ...state.plugins, [pluginId]: next },
    });
    return next;
  });
}

export function installPluginControl(
  baseDir: string,
  pluginId: string,
  sourceRoot: string,
  reloadToken = `${Date.now()}-${crypto.randomUUID()}`,
): PluginControlEntry {
  const resolvedSourceRoot = realpathSync(sourceRoot);
  return updatePluginControl(baseDir, pluginId, (current) => ({
    ...current,
    enabled: true,
    reloadToken,
    sourceRoot: resolvedSourceRoot,
  }));
}

export function removePluginControl(baseDir: string, pluginId: string): boolean {
  return withPluginControlLock(baseDir, () => {
    const state = readPluginControl(baseDir);
    if (!(pluginId in state.plugins)) return false;
    const plugins = { ...state.plugins };
    delete plugins[pluginId];
    writePluginControl(baseDir, { plugins });
    return true;
  });
}

export function findPluginSource(startDirectory: string, sourcePath: string): string | undefined {
  let directory = path.resolve(startDirectory);
  for (;;) {
    const candidate = path.join(directory, sourcePath);
    if (existsSync(candidate)) return realpathSync(candidate);
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
