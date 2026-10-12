import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __codexNativeLaunchTesting, resolveCodexNativeLaunch } from "./codexNativeLaunch";

const DARWIN_ARM64 = { platform: "darwin", arch: "arm64" } as const;

function writeExecutable(filePath: string, content = "#!/bin/sh\n"): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  chmodSync(filePath, 0o755);
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value));
}

function installNpmCodex(
  prefix: string,
  options: { readonly platformPackage?: "nested" | "vendor" | "none" } = {},
) {
  const packageRoot = path.join(prefix, "lib", "node_modules", "@openai", "codex");
  const wrapperPath = path.join(packageRoot, "bin", "codex.js");
  writeJson(path.join(packageRoot, "package.json"), {
    name: "@openai/codex",
    bin: { codex: "bin/codex.js" },
  });
  writeExecutable(wrapperPath, "#!/usr/bin/env node\n");
  const binDir = path.join(prefix, "bin");
  mkdirSync(binDir, { recursive: true });
  symlinkSync(wrapperPath, path.join(binDir, "codex"));

  const placement = options.platformPackage ?? "nested";
  const nativeRoot =
    placement === "nested"
      ? path.join(packageRoot, "node_modules", "@openai", "codex-darwin-arm64")
      : packageRoot;
  if (placement === "nested") {
    writeJson(path.join(nativeRoot, "package.json"), { name: "@openai/codex-darwin-arm64" });
  }
  const nativePath = path.join(nativeRoot, "vendor", "aarch64-apple-darwin", "bin", "codex");
  if (placement !== "none") writeExecutable(nativePath);
  return { packageRoot, wrapperPath, binDir, nativePath };
}

describe("resolveCodexNativeLaunch", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "synara-codex-native-")));
    __codexNativeLaunchTesting.reset();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("launches the platform binary behind an npm wrapper found on PATH with the wrapper env", async () => {
    const install = installNpmCodex(path.join(tempDir, "prefix"));
    const env = {
      PATH: install.binDir,
      CODEX_MANAGED_BY_BUN: "1",
      CODEX_MANAGED_BY_PNPM: "1",
      KEEP: "yes",
    };

    const launch = await resolveCodexNativeLaunch("codex", env, DARWIN_ARM64);

    expect(launch.binaryPath).toBe(install.nativePath);
    expect(launch.env).toEqual({
      PATH: install.binDir,
      KEEP: "yes",
      CODEX_MANAGED_PACKAGE_ROOT: install.packageRoot,
      CODEX_MANAGED_BY_NPM: "1",
    });
    expect(env.CODEX_MANAGED_BY_BUN).toBe("1");
  });

  it("uses the vendor directory inside the wrapper package when no platform package resolves", async () => {
    const install = installNpmCodex(path.join(tempDir, "prefix"), { platformPackage: "vendor" });

    const launch = await resolveCodexNativeLaunch(install.wrapperPath, {}, DARWIN_ARM64);

    expect(launch.binaryPath).toBe(install.nativePath);
  });

  it("keeps the wrapper when the platform binary is missing", async () => {
    const install = installNpmCodex(path.join(tempDir, "prefix"), { platformPackage: "none" });
    const env = { PATH: install.binDir };

    expect(await resolveCodexNativeLaunch("codex", env, DARWIN_ARM64)).toEqual({
      binaryPath: "codex",
      env,
    });
  });

  it("keeps a custom binary that is not the npm wrapper", async () => {
    const custom = path.join(tempDir, "custom", "codex");
    writeExecutable(custom);
    const env = { PATH: path.dirname(custom) };

    expect(await resolveCodexNativeLaunch(custom, env, DARWIN_ARM64)).toEqual({
      binaryPath: custom,
      env,
    });
    expect((await resolveCodexNativeLaunch("codex", env, DARWIN_ARM64)).binaryPath).toBe("codex");
  });

  it("keeps a codex.js that does not belong to the @openai/codex package", async () => {
    const packageRoot = path.join(tempDir, "other");
    writeJson(path.join(packageRoot, "package.json"), {
      name: "codex-fork",
      bin: { codex: "bin/codex.js" },
    });
    const wrapperPath = path.join(packageRoot, "bin", "codex.js");
    writeExecutable(wrapperPath);

    expect((await resolveCodexNativeLaunch(wrapperPath, {}, DARWIN_ARM64)).binaryPath).toBe(
      wrapperPath,
    );
  });

  it("keeps the configured command on Windows", async () => {
    const install = installNpmCodex(path.join(tempDir, "prefix"));
    const env = { PATH: install.binDir };

    expect(
      await resolveCodexNativeLaunch(install.wrapperPath, env, { platform: "win32", arch: "x64" }),
    ).toEqual({ binaryPath: install.wrapperPath, env });
  });

  it("keeps the configured command on an unsupported architecture", async () => {
    const install = installNpmCodex(path.join(tempDir, "prefix"));

    expect(
      (
        await resolveCodexNativeLaunch(
          install.wrapperPath,
          {},
          { platform: "darwin", arch: "ia32" },
        )
      ).binaryPath,
    ).toBe(install.wrapperPath);
  });

  it("re-resolves after the wrapper is replaced", async () => {
    const install = installNpmCodex(path.join(tempDir, "prefix"), { platformPackage: "none" });
    const env = { PATH: install.binDir };
    expect((await resolveCodexNativeLaunch("codex", env, DARWIN_ARM64)).binaryPath).toBe("codex");

    writeExecutable(install.nativePath);
    expect((await resolveCodexNativeLaunch("codex", env, DARWIN_ARM64)).binaryPath).toBe("codex");

    writeExecutable(install.wrapperPath, "#!/usr/bin/env node\n// upgraded\n");
    expect((await resolveCodexNativeLaunch("codex", env, DARWIN_ARM64)).binaryPath).toBe(
      install.nativePath,
    );
  });

  it("falls back to the wrapper when a cached platform binary disappears", async () => {
    const install = installNpmCodex(path.join(tempDir, "prefix"));
    const env = { PATH: install.binDir };
    expect((await resolveCodexNativeLaunch("codex", env, DARWIN_ARM64)).binaryPath).toBe(
      install.nativePath,
    );

    rmSync(install.nativePath);
    expect((await resolveCodexNativeLaunch("codex", env, DARWIN_ARM64)).binaryPath).toBe("codex");
  });

  it("marks bun-managed installs from the child env", async () => {
    const install = installNpmCodex(path.join(tempDir, "prefix"));

    const launch = await resolveCodexNativeLaunch(
      "codex",
      { PATH: install.binDir, npm_config_user_agent: "bun/1.3.0 npm/? node/v22" },
      DARWIN_ARM64,
    );

    expect(launch.env.CODEX_MANAGED_BY_BUN).toBe("1");
    expect(launch.env.CODEX_MANAGED_BY_NPM).toBeUndefined();
  });

  it("marks bun global installs from the package location", async () => {
    const install = installNpmCodex(path.join(tempDir, ".bun", "install", "global"));

    const launch = await resolveCodexNativeLaunch("codex", { PATH: install.binDir }, DARWIN_ARM64);

    expect(launch.binaryPath).toBe(install.nativePath);
    expect(launch.env.CODEX_MANAGED_BY_BUN).toBe("1");
  });

  it("marks pnpm-owned installs", async () => {
    const install = installNpmCodex(path.join(tempDir, "prefix"));
    writeFileSync(path.join(tempDir, "prefix", "lib", "node_modules", ".modules.yaml"), "");

    const launch = await resolveCodexNativeLaunch("codex", { PATH: install.binDir }, DARWIN_ARM64);

    expect(launch.env.CODEX_MANAGED_BY_PNPM).toBe("1");
    expect(launch.env.CODEX_MANAGED_BY_NPM).toBeUndefined();
  });
});
