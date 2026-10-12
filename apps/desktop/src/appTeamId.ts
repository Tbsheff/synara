import { execProcessFile } from "@synara/shared/processRuntime";

import type { ExpectedTeamId } from "./betaInstaller";

export interface CodesignDetails {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface AppTeamIdLookup {
  readonly prefetch: () => void;
  readonly resolve: () => Promise<ExpectedTeamId>;
}

const TEAM_ID_LINE_PATTERN = /^TeamIdentifier=(not set|\S+)$/m;
const UNSIGNED_OUTPUT_PATTERN = /not signed|unsigned/i;
const CODESIGN_OUTPUT_LIMIT_BYTES = 256 * 1024;

export function teamIdFromCodesignDetails(details: CodesignDetails): ExpectedTeamId {
  if (details.exitCode !== 0) {
    return UNSIGNED_OUTPUT_PATTERN.test(`${details.stderr}\n${details.stdout}`)
      ? null
      : "unavailable";
  }
  const teamId = TEAM_ID_LINE_PATTERN.exec(details.stderr)?.[1];
  if (teamId === undefined) return "unavailable";
  return teamId === "not set" ? null : teamId;
}

export function readCodesignDetails(
  bundlePath: string,
  timeoutMs: number,
): Promise<CodesignDetails> {
  return new Promise((resolve, reject) => {
    execProcessFile(
      "/usr/bin/codesign",
      ["-dv", "--verbose=4", bundlePath],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: CODESIGN_OUTPUT_LIMIT_BYTES },
      (error, stdout, stderr) => {
        if (error && (error.killed || typeof error.code !== "number")) {
          reject(error);
          return;
        }
        resolve({ exitCode: error ? Number(error.code) : 0, stdout, stderr });
      },
    );
  });
}

export function createAppTeamIdLookup(input: {
  readonly signedBundle: boolean;
  readonly readDetails: () => Promise<CodesignDetails>;
  readonly deadlineMs: number;
}): AppTeamIdLookup {
  let lookup: Promise<ExpectedTeamId> | null = null;

  const lookUpWithDeadline = (): Promise<ExpectedTeamId> => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<ExpectedTeamId>((resolve) => {
      deadline = setTimeout(() => resolve("unavailable"), input.deadlineMs);
      deadline.unref?.();
    });
    const read = Promise.resolve()
      .then(input.readDetails)
      .then(teamIdFromCodesignDetails, (): ExpectedTeamId => "unavailable");
    return Promise.race([read, expired]).finally(() => clearTimeout(deadline));
  };

  const resolve = (): Promise<ExpectedTeamId> => {
    if (!input.signedBundle) return Promise.resolve(null);
    if (lookup) return lookup;
    const current = lookUpWithDeadline().then((teamId) => {
      if (teamId === "unavailable" && lookup === current) lookup = null;
      return teamId;
    });
    lookup = current;
    return current;
  };

  return {
    prefetch: () => {
      void resolve();
    },
    resolve,
  };
}
