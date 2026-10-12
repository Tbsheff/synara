import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { TerminalOpenInput } from "@synara/contracts";
import { Effect, Encoding } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProcessTreeKiller } from "../processTreeKiller";
import type { PtyAdapterShape, PtyExitEvent, PtyProcess, PtySpawnError } from "../Services/PTY";
import { TerminalManagerRuntime } from "./Manager";

const PERSIST_TICK_MS = 260;

class FakePtyProcess implements PtyProcess {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();

  constructor(readonly pid: number) {}

  write(): void {}
  resize(): void {}
  kill(): void {}
  pause(): void {}
  resume(): void {}

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => this.dataListeners.delete(callback);
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(event: PtyExitEvent): void {
    for (const listener of this.exitListeners) listener(event);
  }
}

class FakePtyAdapter implements PtyAdapterShape {
  readonly processes: FakePtyProcess[] = [];
  private nextPid = 7000;

  spawn(): Effect.Effect<PtyProcess, PtySpawnError> {
    const process = new FakePtyProcess(this.nextPid++);
    this.processes.push(process);
    return Effect.succeed(process);
  }
}

const inertTreeKiller: ProcessTreeKiller = {
  capture: () => ({ descendants: [] }),
  signal: () => {},
};

interface HistoryWriteStats {
  calls: number;
  bytes: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function openInput(overrides: Partial<TerminalOpenInput> = {}): TerminalOpenInput {
  return { threadId: "thread-1", cwd: process.cwd(), cols: 100, rows: 24, ...overrides };
}

function historyPath(logsDir: string, threadId = "thread-1"): string {
  return path.join(logsDir, `terminal_${Encoding.encodeBase64Url(threadId)}.log`);
}

function lines(prefix: string, bytes: number): string {
  let text = "";
  let index = 0;
  while (Buffer.byteLength(text, "utf8") < bytes) {
    text += `${prefix} line ${index} \u001b[32mok\u001b[0m ${"x".repeat(40)}\n`;
    index += 1;
  }
  return text;
}

describe("TerminalManager history persistence", () => {
  const tempDirs: string[] = [];
  const runtimes: TerminalManagerRuntime[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const runtime of runtimes.splice(0)) runtime.dispose();
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeLogsDir(): string {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-terminal-persist-"));
    tempDirs.push(logsDir);
    return logsDir;
  }

  function makeRuntime(
    logsDir: string,
    limits: {
      historyByteLimit: number;
      historyLineLimit: number;
      inactiveHistoryMaxAgeMs?: number;
      inactiveHistoryMaxBytes?: number;
    },
  ) {
    const ptyAdapter = new FakePtyAdapter();
    const runtime = new TerminalManagerRuntime({
      logsDir,
      ptyAdapter,
      ...limits,
      shellResolver: () => "/bin/bash",
      processTreeKiller: inertTreeKiller,
      processKillGraceMs: 10,
    });
    runtimes.push(runtime);
    return { runtime, ptyAdapter };
  }

  function trackHistoryWrites(logsDir: string, gate?: () => Promise<void>): HistoryWriteStats {
    const stats: HistoryWriteStats = { calls: 0, bytes: 0 };
    const isHistoryFile = (file: unknown) =>
      typeof file === "string" &&
      file.startsWith(logsDir) &&
      path.basename(file).startsWith("terminal_");
    const record = async (file: unknown, data: unknown) => {
      if (!isHistoryFile(file)) return;
      stats.calls += 1;
      stats.bytes += Buffer.byteLength(String(data), "utf8");
      await gate?.();
    };
    const realWriteFile = fs.promises.writeFile.bind(fs.promises);
    const realAppendFile = fs.promises.appendFile.bind(fs.promises);
    vi.spyOn(fs.promises, "writeFile").mockImplementation((async (
      file: Parameters<typeof fs.promises.writeFile>[0],
      data: Parameters<typeof fs.promises.writeFile>[1],
      options?: Parameters<typeof fs.promises.writeFile>[2],
    ) => {
      await record(file, data);
      return realWriteFile(file, data, options);
    }) as typeof fs.promises.writeFile);
    vi.spyOn(fs.promises, "appendFile").mockImplementation((async (
      file: Parameters<typeof fs.promises.appendFile>[0],
      data: Parameters<typeof fs.promises.appendFile>[1],
      options?: Parameters<typeof fs.promises.appendFile>[2],
    ) => {
      await record(file, data);
      return realAppendFile(file, data, options);
    }) as typeof fs.promises.appendFile);
    return stats;
  }

  it("expires inactive histories at startup and keeps newer files within the byte budget", async () => {
    const logsDir = makeLogsDir();
    const now = Date.now();
    const seed = (name: string, ageMs: number) => {
      const file = path.join(logsDir, name);
      fs.writeFileSync(file, "x".repeat(800));
      fs.utimesSync(file, new Date(now - ageMs), new Date(now - ageMs));
      return file;
    };
    const expired = seed("terminal_expired.log", 10_000);
    const oldest = seed("terminal_old.log", 2_000);
    const fresh = seed("terminal_fresh.log", 1_000);
    const newest = seed("legacy-thread.log", 0);
    const { runtime } = makeRuntime(logsDir, {
      historyByteLimit: 64 * 1024,
      historyLineLimit: 5000,
      inactiveHistoryMaxAgeMs: 5_000,
      inactiveHistoryMaxBytes: 1600,
    });
    await runtime.open(openInput());
    expect(fs.existsSync(expired)).toBe(false);
    expect(fs.existsSync(oldest)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(newest)).toBe(true);
    await runtime.disposeForShutdown();
  });

  it("prunes archived histories after close without deleting active terminal output", async () => {
    const logsDir = makeLogsDir();
    const { runtime, ptyAdapter } = makeRuntime(logsDir, {
      historyByteLimit: 64 * 1024,
      historyLineLimit: 5000,
      inactiveHistoryMaxAgeMs: 30 * 24 * 60 * 60_000,
      inactiveHistoryMaxBytes: 500,
    });
    await runtime.open(openInput());
    ptyAdapter.processes[0]!.emitData("active output".repeat(100));
    await sleep(PERSIST_TICK_MS * 2);
    const archived = historyPath(logsDir, "archived");
    fs.writeFileSync(archived, "x".repeat(1000));
    await runtime.open(openInput({ threadId: "other" }));
    await runtime.close({ threadId: "other" });
    expect(fs.existsSync(archived)).toBe(false);
    expect(fs.existsSync(historyPath(logsDir))).toBe(true);
    expect((await runtime.open(openInput())).history).toBe("active output".repeat(100));
    await runtime.disposeForShutdown();
  });

  it("writes only the new output on each persist tick once scrollback is full", async () => {
    const historyByteLimit = 64 * 1024;
    const deltaBytes = 1024;
    const ticks = 8;
    const logsDir = makeLogsDir();
    const { runtime, ptyAdapter } = makeRuntime(logsDir, {
      historyByteLimit,
      historyLineLimit: 1_000_000,
    });
    await runtime.open(openInput());
    const pty = ptyAdapter.processes[0]!;

    pty.emitData(lines("prefill", historyByteLimit * 2));
    await sleep(PERSIST_TICK_MS * 2);
    expect(fs.statSync(historyPath(logsDir)).size).toBeGreaterThan(historyByteLimit / 2);

    const stats = trackHistoryWrites(logsDir);
    for (let tick = 0; tick < ticks; tick += 1) {
      pty.emitData(lines(`tick-${tick}`, deltaBytes));
      await sleep(PERSIST_TICK_MS);
    }
    await sleep(PERSIST_TICK_MS);

    expect(stats.calls).toBeGreaterThan(0);
    expect(stats.bytes).toBeLessThanOrEqual(ticks * deltaBytes * 2 + historyByteLimit * 2);
  });

  it("keeps one history write in flight and merges later output on a slow disk", async () => {
    const logsDir = makeLogsDir();
    const { runtime, ptyAdapter } = makeRuntime(logsDir, {
      historyByteLimit: 64 * 1024,
      historyLineLimit: 1_000_000,
    });
    await runtime.open(openInput());
    const pty = ptyAdapter.processes[0]!;

    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stats = trackHistoryWrites(logsDir, () => released);

    let expected = "";
    for (let tick = 0; tick < 8; tick += 1) {
      const chunk = lines(`slow-${tick}`, 512);
      expected += chunk;
      pty.emitData(chunk);
      await sleep(PERSIST_TICK_MS);
    }
    expect(stats.calls).toBe(1);

    release();
    await runtime.close({ threadId: "thread-1" });

    expect(stats.calls).toBeLessThanOrEqual(3);
    expect(fs.readFileSync(historyPath(logsDir), "utf8")).toBe(expected);
  });

  it.each([
    { name: "byte cap", historyByteLimit: 16 * 1024, historyLineLimit: 1_000_000 },
    { name: "line cap", historyByteLimit: 16 * 1024, historyLineLimit: 50 },
  ])(
    "restores the same history after shutdown with appends and compaction ($name)",
    async ({ historyByteLimit, historyLineLimit }) => {
      const logsDir = makeLogsDir();
      const limits = { historyByteLimit, historyLineLimit };
      const first = makeRuntime(logsDir, limits);
      await first.runtime.open(openInput());
      const pty = first.ptyAdapter.processes[0]!;

      let maxFileBytes = 0;
      for (let tick = 0; tick < 6; tick += 1) {
        pty.emitData(lines(`busy-${tick}`, historyByteLimit / 2));
        await sleep(PERSIST_TICK_MS);
        const size = fs.statSync(historyPath(logsDir), { throwIfNoEntry: false })?.size ?? 0;
        maxFileBytes = Math.max(maxFileBytes, size);
      }
      pty.emitData("final output inside the debounce window\n");
      const before = await first.runtime.open(openInput());
      expect(before.history.endsWith("final output inside the debounce window\n")).toBe(true);

      await first.runtime.disposeForShutdown();

      expect(maxFileBytes).toBeLessThanOrEqual(historyByteLimit * 2 + historyByteLimit / 2);
      const second = makeRuntime(logsDir, limits);
      const after = await second.runtime.open(openInput());
      expect(after.history).toBe(before.history);
      expect(fs.statSync(historyPath(logsDir)).size).toBeLessThanOrEqual(historyByteLimit);
    },
  );

  it("does not restore output from before a clear", async () => {
    const logsDir = makeLogsDir();
    const limits = { historyByteLimit: 64 * 1024, historyLineLimit: 1_000_000 };
    const first = makeRuntime(logsDir, limits);
    await first.runtime.open(openInput());
    const pty = first.ptyAdapter.processes[0]!;

    pty.emitData("persisted before clear\n");
    await sleep(PERSIST_TICK_MS * 2);
    pty.emitData("pending before clear\n");
    await sleep(50);
    await first.runtime.clear({ threadId: "thread-1", terminalId: "default" });
    pty.emitData("after clear\n");
    await sleep(50);
    await first.runtime.disposeForShutdown();

    const second = makeRuntime(logsDir, limits);
    const restored = await second.runtime.open(openInput());
    expect(restored.history).toBe("after clear\n");
  });

  it("starts persisting history as soon as the process exits", async () => {
    const logsDir = makeLogsDir();
    const { runtime, ptyAdapter } = makeRuntime(logsDir, {
      historyByteLimit: 64 * 1024,
      historyLineLimit: 1_000_000,
    });
    await runtime.open(openInput());
    const pty = ptyAdapter.processes[0]!;
    const stats = trackHistoryWrites(logsDir);

    pty.emitData("last words\n");
    pty.emitExit({ exitCode: 0, signal: 0 });
    await new Promise((resolve) => setImmediate(resolve));

    expect(stats.calls).toBe(1);
    await runtime.close({ threadId: "thread-1" });
    expect(fs.readFileSync(historyPath(logsDir), "utf8")).toBe("last words\n");
  });
});
