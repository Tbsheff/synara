import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  CLOUD_CLAUDE_BIN_ENV,
  CLOUD_CODEX_BIN_ENV,
  claudeCloudBinaryPath,
  codexBinaryUnresolvedFallback,
  codexCloudBinaryCandidates,
  selectCodexCloudBinary,
} from "./cloudBinaryResolution";

const existing = new Set([
  "/nvm/bin/codex",
  "/opt/homebrew/bin/codex",
  "/home/me/.local/bin/codex",
  "/custom/codex",
]);

const resolve = (command: string) => {
  if (command === "codex") return "/nvm/bin/codex";
  return existing.has(command) ? command : null;
};

const baseInput = {
  env: {},
  settingsBinaryPath: "codex",
  platform: "darwin" as const,
  homeDir: "/home/me",
  resolve,
};

describe("codexCloudBinaryCandidates", () => {
  it("lists PATH first, then the known install directories, without duplicates", () => {
    expect(codexCloudBinaryCandidates(baseInput)).toEqual([
      "/nvm/bin/codex",
      "/opt/homebrew/bin/codex",
      "/home/me/.local/bin/codex",
    ]);
  });

  it("puts an explicit settings path first", () => {
    expect(
      codexCloudBinaryCandidates({ ...baseInput, settingsBinaryPath: "/custom/codex" })[0],
    ).toBe("/custom/codex");
  });

  it("uses only the environment override when it is set", () => {
    expect(
      codexCloudBinaryCandidates({ ...baseInput, env: { [CLOUD_CODEX_BIN_ENV]: "/custom/codex" } }),
    ).toEqual(["/custom/codex"]);
    expect(
      codexBinaryUnresolvedFallback({
        ...baseInput,
        env: { [CLOUD_CODEX_BIN_ENV]: "/gone/codex" },
      }),
    ).toBe("/gone/codex");
  });

  it("skips the POSIX directories on Windows", () => {
    expect(codexCloudBinaryCandidates({ ...baseInput, platform: "win32" })).toEqual([
      "/nvm/bin/codex",
    ]);
  });
});

describe("selectCodexCloudBinary", () => {
  const versions: Record<string, string | null> = {
    "/nvm/bin/codex": "0.160.1",
    "/opt/homebrew/bin/codex": "0.162.1",
    "/broken/codex": null,
  };
  const probe = (path: string) => Effect.succeed(versions[path] ?? null);

  it("prefers the first binary at or above the minimum version", async () => {
    await expect(
      Effect.runPromise(
        selectCodexCloudBinary(["/nvm/bin/codex", "/opt/homebrew/bin/codex"], probe),
      ),
    ).resolves.toBe("/opt/homebrew/bin/codex");
  });

  it("falls back to the first readable binary so the UI can say it is too old", async () => {
    await expect(
      Effect.runPromise(selectCodexCloudBinary(["/broken/codex", "/nvm/bin/codex"], probe)),
    ).resolves.toBe("/nvm/bin/codex");
    await expect(Effect.runPromise(selectCodexCloudBinary([], probe))).resolves.toBeNull();
  });
});

describe("claudeCloudBinaryPath", () => {
  it("prefers the environment override, then settings", () => {
    expect(claudeCloudBinaryPath({ env: {}, settingsBinaryPath: " " })).toBe("claude");
    expect(claudeCloudBinaryPath({ env: {}, settingsBinaryPath: "/x/claude" })).toBe("/x/claude");
    expect(
      claudeCloudBinaryPath({
        env: { [CLOUD_CLAUDE_BIN_ENV]: "/y/claude" },
        settingsBinaryPath: "/x/claude",
      }),
    ).toBe("/y/claude");
  });
});
