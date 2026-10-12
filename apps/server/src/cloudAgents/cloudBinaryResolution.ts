import nodePath from "node:path";

import { CODEX_CLOUD_MINIMUM_CLI_VERSION } from "@synara/contracts";
import { Effect } from "effect";

import { compareSemverVersions } from "../provider/providerMaintenance.ts";

export const CLOUD_CODEX_BIN_ENV = "SYNARA_CLOUD_CODEX_BIN";
export const CLOUD_CLAUDE_BIN_ENV = "SYNARA_CLOUD_CLAUDE_BIN";

const POSIX_CODEX_FALLBACK_DIRECTORIES = ["/opt/homebrew/bin", "/usr/local/bin"] as const;
const POSIX_HOME_CODEX_FALLBACK_DIRECTORIES = [".local/bin", ".bun/bin"] as const;

export interface CloudBinaryCandidateInput {
  readonly env: NodeJS.ProcessEnv;
  readonly settingsBinaryPath: string;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly resolve: (command: string) => string | null;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function uniqueResolved(
  commands: ReadonlyArray<string>,
  resolve: (command: string) => string | null,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const resolved: Array<string> = [];
  for (const command of commands) {
    const path = resolve(command);
    if (path === null || seen.has(path)) continue;
    seen.add(path);
    resolved.push(path);
  }
  return resolved;
}

export function codexCloudBinaryCandidates(
  input: CloudBinaryCandidateInput,
): ReadonlyArray<string> {
  const override = nonEmpty(input.env[CLOUD_CODEX_BIN_ENV]);
  if (override !== null) {
    return uniqueResolved([override], input.resolve);
  }
  const settingsPath = nonEmpty(input.settingsBinaryPath) ?? "codex";
  const fallbackDirectories =
    input.platform === "win32"
      ? []
      : [
          ...POSIX_CODEX_FALLBACK_DIRECTORIES,
          ...POSIX_HOME_CODEX_FALLBACK_DIRECTORIES.map((relative) =>
            nodePath.join(input.homeDir, relative),
          ),
        ];
  return uniqueResolved(
    [
      settingsPath,
      "codex",
      ...fallbackDirectories.map((directory) => nodePath.join(directory, "codex")),
    ],
    input.resolve,
  );
}

export function claudeCloudBinaryPath(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly settingsBinaryPath: string;
}): string {
  return (
    nonEmpty(input.env[CLOUD_CLAUDE_BIN_ENV]) ?? nonEmpty(input.settingsBinaryPath) ?? "claude"
  );
}

export function codexBinaryUnresolvedFallback(input: CloudBinaryCandidateInput): string {
  return nonEmpty(input.env[CLOUD_CODEX_BIN_ENV]) ?? nonEmpty(input.settingsBinaryPath) ?? "codex";
}

export const selectCodexCloudBinary = <E, R>(
  candidates: ReadonlyArray<string>,
  probeVersion: (path: string) => Effect.Effect<string | null, E, R>,
): Effect.Effect<string | null, E, R> =>
  Effect.gen(function* () {
    let firstVersioned: string | null = null;
    for (const candidate of candidates) {
      const version = yield* probeVersion(candidate);
      if (version === null) continue;
      if (compareSemverVersions(version, CODEX_CLOUD_MINIMUM_CLI_VERSION) >= 0) {
        return candidate;
      }
      firstVersioned ??= candidate;
    }
    return firstVersioned ?? candidates[0] ?? null;
  });
