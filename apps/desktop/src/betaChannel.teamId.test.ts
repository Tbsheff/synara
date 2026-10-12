import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExpectedTeamId } from "./betaInstaller";

const installBetaFromFeed = vi.hoisted(() => vi.fn(async () => "/missing/Synara Beta.app"));

vi.mock("./betaInstaller", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./betaInstaller")>()),
  installBetaFromFeed,
}));

import { DesktopBetaChannel } from "./betaChannel";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  installBetaFromFeed.mockClear();
});

describe("DesktopBetaChannel team id", () => {
  it("waits for the deferred signature lookup before installing", async () => {
    const root = mkdtempSync(join(tmpdir(), "synara-beta-team-id-"));
    roots.push(root);
    let answer!: (teamId: ExpectedTeamId) => void;
    const lookup = new Promise<ExpectedTeamId>((resolve) => {
      answer = resolve;
    });
    const channel = new DesktopBetaChannel({
      platform: "darwin",
      homeDir: root,
      betaHomeDir: join(root, ".synara-beta"),
      flavor: "production",
      installDirOverride: join(root, "Applications"),
      expectedTeamId: () => lookup,
    });

    const installing = channel.install();
    await Promise.resolve();
    expect(installBetaFromFeed).not.toHaveBeenCalled();
    answer("ABCDE12345");
    await installing;

    expect(installBetaFromFeed).toHaveBeenCalledWith(
      expect.objectContaining({ expectedTeamId: "ABCDE12345" }),
      expect.any(Function),
    );
  });
});
