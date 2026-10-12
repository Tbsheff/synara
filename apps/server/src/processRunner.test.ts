import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runProcess } from "./processRunner";

describe("runProcess", () => {
  it("fails when output exceeds max buffer in default mode", async () => {
    await expect(
      runProcess("node", ["-e", "process.stdout.write('x'.repeat(2048))"], { maxBufferBytes: 128 }),
    ).rejects.toThrow("exceeded stdout buffer limit");
  });

  it("truncates output when outputMode is truncate", async () => {
    const result = await runProcess("node", ["-e", "process.stdout.write('x'.repeat(2048))"], {
      maxBufferBytes: 128,
      outputMode: "truncate",
    });

    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(128);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(false);
  });

  it("does not emit a replacement character when truncation splits UTF-8 output", async () => {
    const result = await runProcess("node", ["-e", "process.stdout.write('ab€cd')"], {
      maxBufferBytes: 4,
      outputMode: "truncate",
    });

    expect(result.stdout).toBe("ab");
    expect(result.stdoutTruncated).toBe(true);
  });

  it("preserves UTF-8 characters split across process chunks and live observers", async () => {
    const stdoutChunks: string[] = [];
    const result = await runProcess(
      "node",
      [
        "-e",
        "process.stdout.write(Buffer.from([0xe2])); setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac])), 25)",
      ],
      { onStdoutChunk: (chunk) => stdoutChunks.push(chunk) },
    );

    expect(result.stdout).toBe("€");
    expect(stdoutChunks.join("")).toBe("€");
  });

  it("reports live stdout and stderr chunks while retaining the final output", async () => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const result = await runProcess(
      "node",
      ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
      {
        onStdoutChunk: (chunk) => stdoutChunks.push(chunk),
        onStderrChunk: (chunk) => stderrChunks.push(chunk),
      },
    );

    expect(stdoutChunks.join("")).toBe("out");
    expect(stderrChunks.join("")).toBe("err");
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });

  it("keeps output observers isolated from the child-process lifecycle", async () => {
    const result = await runProcess("node", ["-e", "process.stdout.write('ok')"], {
      onStdoutChunk: () => {
        throw new Error("observer failed");
      },
    });

    expect(result.stdout).toBe("ok");
    expect(result.code).toBe(0);
  });

  it("rejects without spawning when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runProcess("node", ["-e", "process.exit(99)"], { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("terminates a running child on abort and clears its later timeout", async () => {
    const controller = new AbortController();
    const running = runProcess("node", ["-e", "setInterval(() => {}, 1_000)"], {
      signal: controller.signal,
      timeoutMs: 150,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    // Cross the original deadline: the cleared timeout must not produce a second failure or keep
    // the test process alive after the aborted child has closed.
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  it("keeps timeout failures distinct from explicit aborts", async () => {
    const timedOut = runProcess("node", ["-e", "setInterval(() => {}, 1_000)"], {
      timeoutMs: 30,
    });

    await expect(timedOut).rejects.toMatchObject({
      name: "Error",
      message: expect.stringContaining("timed out"),
    });
  });

  it("keeps the timeout classification when abort arrives after the deadline", async () => {
    const controller = new AbortController();
    const outcome = runProcess("node", ["-e", "setInterval(() => {}, 1_000)"], {
      signal: controller.signal,
      timeoutMs: 30,
    }).catch((error: unknown) => error);

    await new Promise((resolve) => setTimeout(resolve, 60));
    controller.abort();

    expect(await outcome).toMatchObject({
      name: "Error",
      message: expect.stringContaining("timed out"),
    });
  });
});

// The owned ChildProcess handle is sufficient for POSIX cancellation. A missing
// ps executable must never turn a timeout/abort into a wait for natural exit.
describe.skipIf(process.platform === "win32")("cancellation without ps on PATH", () => {
  it.each(["timeout", "abort"] as const)("terminates an owned child on %s", async (cause) => {
    const previousPath = process.env.PATH;
    const controller = new AbortController();
    const started = Date.now();
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      process.env.PATH = "/synara-test-no-executables";
      const running = runProcess(process.execPath, ["-e", "setTimeout(() => {}, 4000)"], {
        timeoutMs: cause === "timeout" ? 30 : 5000,
        signal: controller.signal,
      });
      if (cause === "abort") abortTimer = setTimeout(() => controller.abort(), 30);
      await expect(running).rejects.toThrow(cause === "timeout" ? "timed out" : "aborted");
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

describe.skipIf(process.platform === "win32")("owned process group stop", () => {
  let stdoutChunks: string[] = [];

  const reportedPid = (): number | undefined => {
    const match = /^(\d+)$/m.exec(stdoutChunks.join(""));
    return match ? Number(match[1]) : undefined;
  };

  const waitForReportedPid = async (): Promise<number> => {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const pid = reportedPid();
      if (pid !== undefined) return pid;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("background PID was never reported");
  };

  const collectStdout = (chunk: string) => {
    stdoutChunks.push(chunk);
  };

  beforeEach(() => {
    stdoutChunks = [];
  });

  afterEach(() => {
    const pid = reportedPid();
    if (pid !== undefined && isPidAlive(pid)) process.kill(pid, "SIGKILL");
  });

  it(
    "stops a grandchild that holds stdout open when setup times out",
    { timeout: 10_000 },
    async () => {
      const started = Date.now();
      const result = await runProcess("sh", ["-c", "sleep 600 & echo $!; wait"], {
        ownProcessGroup: true,
        timeoutMs: 300,
        allowNonZeroExit: true,
        onStdoutChunk: collectStdout,
      });
      expect(result.timedOut).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_000);
      const grandchildPid = reportedPid();
      expect(grandchildPid).toBeDefined();
      expect(isPidAlive(grandchildPid!)).toBe(false);
    },
  );

  it(
    "stops a grandchild that holds stdout open when setup is cancelled",
    { timeout: 10_000 },
    async () => {
      const controller = new AbortController();
      const running = runProcess("sh", ["-c", "sleep 600 & echo $!; wait"], {
        ownProcessGroup: true,
        timeoutMs: 60_000,
        signal: controller.signal,
        onStdoutChunk: collectStdout,
      });
      const grandchildPid = await waitForReportedPid();
      controller.abort();
      await expect(running).rejects.toMatchObject({ name: "AbortError" });
      expect(isPidAlive(grandchildPid)).toBe(false);
    },
  );

  it(
    "settles within a deadline when an escaped session still holds stdout",
    { timeout: 10_000 },
    async () => {
      const started = Date.now();
      const result = await runProcess(
        "perl",
        [
          "-e",
          'use POSIX; $| = 1; if (fork()) { sleep 600 } else { POSIX::setsid(); print "$$\\n"; sleep 600 }',
        ],
        {
          ownProcessGroup: true,
          timeoutMs: 300,
          allowNonZeroExit: true,
          onStdoutChunk: collectStdout,
        },
      );
      expect(result.timedOut).toBe(true);
      expect(reportedPid()).toBeDefined();
      expect(Date.now() - started).toBeLessThan(5_000);
    },
  );

  it(
    "force-stops a TERM-ignoring grandchild that released stdout",
    { timeout: 10_000 },
    async () => {
      const result = await runProcess(
        "sh",
        ["-c", "(trap '' TERM; exec sleep 600) </dev/null >/dev/null 2>&1 & echo $!; wait"],
        {
          ownProcessGroup: true,
          timeoutMs: 300,
          allowNonZeroExit: true,
          onStdoutChunk: collectStdout,
        },
      );
      expect(result.timedOut).toBe(true);
      const grandchildPid = reportedPid();
      expect(grandchildPid).toBeDefined();
      expect(isPidAlive(grandchildPid!)).toBe(false);
    },
  );
});
