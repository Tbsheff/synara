import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterAll, beforeAll, describe } from "vitest";

import { makeCloudAgents } from "./CloudAgents.ts";
import { CloudCliRunnerLive } from "./CloudCliRunner.ts";

const LIVE_SMOKE_ENABLED = process.env.SYNARA_CLOUD_LIVE === "1";
const LIVE_SMOKE_TIMEOUT_MS = 120_000;

describe.skipIf(!LIVE_SMOKE_ENABLED)("CloudAgents live smoke (read-only)", () => {
  let scratchDir = "";
  beforeAll(() => {
    scratchDir = mkdtempSync(nodePath.join(tmpdir(), "synara-cloud-live-"));
  });
  afterAll(() => {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  });

  it.effect(
    "reads Codex Cloud tasks through `codex cloud list --json`",
    () =>
      Effect.gen(function* () {
        const service = yield* makeCloudAgents({
          scratchDir,
          codex: { binaryPath: process.env.SYNARA_CLOUD_CODEX_BIN ?? "codex" },
          claude: { binaryPath: process.env.SYNARA_CLOUD_CLAUDE_BIN ?? "claude" },
        }).pipe(Effect.provide(CloudCliRunnerLive));
        const capabilities = yield* service.capabilities("codex");
        assert.isTrue(capabilities.available, capabilities.unavailableReason ?? undefined);
        assert.isTrue(capabilities.canList);
        const page = yield* service.listTasks({ provider: "codex", limit: 5 });
        assert.isArray(page.tasks);
        assert.isAtMost(page.tasks.length, 5);
        for (const task of page.tasks) {
          assert.strictEqual(task.provider, "codex");
          assert.include(["pending", "ready", "error", "cancelled", "unknown"], task.status);
        }
      }),
    LIVE_SMOKE_TIMEOUT_MS,
  );
});
