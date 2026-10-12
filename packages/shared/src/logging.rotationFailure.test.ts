import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RotatingFileSink } from "./logging";

const tempRoots: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-rotation-failure-"));
  tempRoots.push(dir);
  return dir;
}

function blockOldestBackup(logPath: string, maxFiles: number): void {
  const blocker = `${logPath}.${maxFiles}`;
  fs.mkdirSync(blocker);
  fs.writeFileSync(path.join(blocker, "keep"), "x");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("RotatingFileSink rotation failure", () => {
  it("keeps the current file within maxBytes when rotation keeps failing", () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, "blocked.log");
    blockOldestBackup(logPath, 1);
    const onRotationError = vi.fn();
    const sink = new RotatingFileSink({
      filePath: logPath,
      maxBytes: 100,
      maxFiles: 1,
      onRotationError,
    });

    for (let index = 0; index < 200; index += 1) {
      sink.write("0123456789");
    }

    expect(fs.statSync(logPath).size).toBeLessThanOrEqual(100);
    expect(fs.readFileSync(logPath, "utf8").endsWith("0123456789")).toBe(true);
    expect(onRotationError).toHaveBeenCalledTimes(1);
  });

  it("throttles rotation retries while rotation is failing", () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, "blocked.log");
    blockOldestBackup(logPath, 1);
    const sink = new RotatingFileSink({
      filePath: logPath,
      maxBytes: 20,
      maxFiles: 1,
      rotationRetryMs: 60_000,
      onRotationError: () => {},
    });
    const rmSpy = vi.spyOn(fs, "rmSync");

    for (let index = 0; index < 50; index += 1) {
      sink.write("0123456789");
    }

    expect(rmSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("resumes normal rotation and reports again after the blocker clears", () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, "blocked.log");
    blockOldestBackup(logPath, 1);
    const onRotationError = vi.fn();
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const sink = new RotatingFileSink({
      filePath: logPath,
      maxBytes: 20,
      maxFiles: 1,
      rotationRetryMs: 1_000,
      onRotationError,
    });

    for (let index = 0; index < 5; index += 1) sink.write("0123456789");
    expect(onRotationError).toHaveBeenCalledTimes(1);

    fs.rmSync(`${logPath}.1`, { recursive: true, force: true });
    now += 1_000;
    sink.write("abcdefghij");
    sink.write("klmnopqrst");
    sink.write("uvwxyz");

    expect(fs.readFileSync(`${logPath}.1`, "utf8")).toBe("0123456789abcdefghij");
    expect(fs.readFileSync(logPath, "utf8")).toBe("klmnopqrstuvwxyz");

    fs.rmSync(`${logPath}.1`, { force: true });
    blockOldestBackup(logPath, 1);
    now += 1_000;
    for (let index = 0; index < 5; index += 1) sink.write("0123456789");
    expect(onRotationError).toHaveBeenCalledTimes(2);
  });

  it("warns once on the console when no rotation error handler is set", () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, "blocked.log");
    blockOldestBackup(logPath, 1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sink = new RotatingFileSink({ filePath: logPath, maxBytes: 20, maxFiles: 1 });

    for (let index = 0; index < 20; index += 1) sink.write("0123456789");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(fs.statSync(logPath).size).toBeLessThanOrEqual(20);
  });

  it("writeMany appends each batch with one call per file and rotates at maxBytes", () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, "batched.log");
    const sink = new RotatingFileSink({ filePath: logPath, maxBytes: 50, maxFiles: 3 });
    const appendSpy = vi.spyOn(fs, "appendFileSync");
    const lines = Array.from(
      { length: 12 },
      (_, index) => `line-${String(index).padStart(2, "0")}\n`,
    );

    sink.writeMany(lines);

    const files = [logPath, `${logPath}.1`, `${logPath}.2`].filter((file) => fs.existsSync(file));
    expect(appendSpy).toHaveBeenCalledTimes(files.length);
    for (const file of files) {
      expect(fs.statSync(file).size).toBeLessThanOrEqual(50);
    }
    const combined = [`${logPath}.2`, `${logPath}.1`, logPath]
      .filter((file) => fs.existsSync(file))
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("");
    expect(combined).toBe(lines.join(""));
  });
});

describe("RotatingFileSink async writes", () => {
  it("keeps async batches bounded and private when rotation fails", async () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, "async-blocked.log");
    blockOldestBackup(logPath, 1);
    const onRotationError = vi.fn();
    const sink = await RotatingFileSink.createAsync({
      filePath: logPath,
      maxBytes: 100,
      maxFiles: 1,
      mode: 0o600,
      onRotationError,
    });
    const syncAppend = vi.spyOn(fs, "appendFileSync");
    const asyncAppend = vi.spyOn(fs.promises, "appendFile");
    await sink.writeManyAsync(Array.from({ length: 200 }, () => "0123456789"));
    expect(fs.statSync(logPath).size).toBeLessThanOrEqual(100);
    expect(onRotationError).toHaveBeenCalledTimes(1);
    expect(syncAppend).not.toHaveBeenCalled();
    expect(asyncAppend).toHaveBeenCalledTimes(20);
    if (process.platform !== "win32") expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
  });
});
