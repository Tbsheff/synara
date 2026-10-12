import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { BETA_IMPORT_RESULT_FILE_NAME } from "@synara/shared/betaChannel";

export async function readBetaImportCompletedAtMs(homeDir: string): Promise<number | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(homeDir, BETA_IMPORT_RESULT_FILE_NAME), "utf8"),
    );
    if (!parsed || typeof parsed !== "object") return null;
    const result = parsed as { version?: unknown; ok?: unknown; completedAt?: unknown };
    if (result.version !== 1 || result.ok !== true || typeof result.completedAt !== "string") {
      return null;
    }
    const completedAtMs = Date.parse(result.completedAt);
    return Number.isFinite(completedAtMs) ? completedAtMs : null;
  } catch {
    return null;
  }
}

export function predatesBetaImport(
  completedAtMs: number | null,
  timestamp: string | null | undefined,
): boolean {
  if (completedAtMs === null || !timestamp) return false;
  const timestampMs = Date.parse(timestamp);
  return Number.isFinite(timestampMs) && timestampMs <= completedAtMs;
}
