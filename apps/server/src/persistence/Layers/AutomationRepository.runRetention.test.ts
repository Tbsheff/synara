import { assert, it } from "@effect/vitest";
import {
  AutomationId,
  AutomationRunId,
  DEFAULT_AUTOMATION_STOP_CONFIDENCE_THRESHOLD,
  ProjectId,
  ThreadId,
  type AutomationCreateInput,
} from "@synara/contracts";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import { AutomationRepository } from "../Services/AutomationRepository.ts";
import { AutomationRepositoryLive } from "./AutomationRepository.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(AutomationRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const RETAINED_RUNS_PER_AUTOMATION = 500;
const RUNS_CREATED = 540;

const permissionSnapshot = {
  provider: "codex",
  modelSelection: { provider: "codex", model: "gpt-5-codex" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  worktreeMode: "worktree",
  allowedCapabilities: ["send-turn", "create-worktree"],
  createdAt: "2026-06-16T10:00:00.000Z",
} as const;

const baseInput = (projectId: string) =>
  ({
    name: "Recurring check",
    projectId: ProjectId.makeUnsafe(projectId),
    prompt: "Check the build.",
    schedule: { type: "manual" },
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
  }) satisfies AutomationCreateInput;

const minuteAfter = (index: number) =>
  new Date(Date.parse("2026-07-01T00:00:00.000Z") + index * 60_000).toISOString();

const summary = "x".repeat(1_500);

const runStats = (automationId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly total: number;
      readonly terminal: number;
      readonly results: number;
      readonly bytes: number;
    }>`
      SELECT
        COUNT(*) AS "total",
        SUM(CASE WHEN result_json IS NOT NULL AND result_json != 'null' THEN 1 ELSE 0 END) AS "results",
        SUM(CASE WHEN status IN ('succeeded', 'failed', 'cancelled', 'interrupted', 'skipped') THEN 1 ELSE 0 END) AS "terminal",
        COALESCE(SUM(LENGTH(COALESCE(result_json, '')) + LENGTH(permission_snapshot_json)), 0) AS "bytes"
      FROM automation_runs
      WHERE automation_id = ${automationId}
    `;
    return rows[0]!;
  });

layer("AutomationRepository run history retention", (it) => {
  it.effect(
    "keeps the newest 500 results and preserves scheduled occurrence deduplication and active runs",
    () =>
      Effect.gen(function* () {
        const repository = yield* AutomationRepository;
        yield* runMigrations();
        const projectId = ProjectId.makeUnsafe("project-retention");
        const automationId = AutomationId.makeUnsafe("automation-retention");
        const siblingId = AutomationId.makeUnsafe("automation-retention-sibling");
        yield* repository.createDefinition({
          id: automationId,
          input: baseInput("project-retention"),
          now: "2026-06-30T00:00:00.000Z",
        });
        yield* repository.createDefinition({
          id: siblingId,
          input: baseInput("project-retention"),
          now: "2026-06-30T00:00:00.000Z",
        });

        for (let index = 0; index < 3; index += 1) {
          const sibling = yield* repository.createRun({
            id: AutomationRunId.makeUnsafe(`sibling-run-${index}`),
            automationId: siblingId,
            projectId,
            threadId: null,
            trigger: { type: "manual" },
            scheduledFor: minuteAfter(-1_000 + index),
            permissionSnapshot,
            now: minuteAfter(-1_000 + index),
          });
          yield* repository.markRunSucceeded({
            id: sibling.id,
            turnId: null,
            result: { outcome: "no-findings", summary, unread: true, archivedAt: null },
            finishedAt: minuteAfter(-1_000 + index),
            accountedAt: minuteAfter(-1_000 + index),
          });
        }

        const activeOldest = yield* repository.createRun({
          id: AutomationRunId.makeUnsafe("run-active-oldest"),
          automationId,
          projectId,
          threadId: null,
          trigger: { type: "manual" },
          scheduledFor: minuteAfter(-1),
          permissionSnapshot,
          now: minuteAfter(-1),
        });

        for (let index = 0; index < RUNS_CREATED; index += 1) {
          const run = yield* repository.createRun({
            id: AutomationRunId.makeUnsafe(`run-${String(index).padStart(4, "0")}`),
            automationId,
            projectId,
            threadId: null,
            trigger: { type: "scheduled" },
            scheduledFor: minuteAfter(index),
            permissionSnapshot,
            now: minuteAfter(index),
          });
          yield* repository.markRunSucceeded({
            id: run.id,
            turnId: null,
            result: { outcome: "findings", summary, unread: true, archivedAt: null },
            finishedAt: minuteAfter(index),
            accountedAt: minuteAfter(index),
          });
        }

        const stats = yield* runStats(automationId);
        assert.strictEqual(stats.results, RETAINED_RUNS_PER_AUTOMATION);
        assert.strictEqual(stats.terminal, RUNS_CREATED);
        assert.strictEqual(stats.total, RUNS_CREATED + 1);

        assert.isTrue(Option.isSome(yield* repository.getRunById({ id: activeOldest.id })));
        assert.strictEqual(
          Option.getOrThrow(yield* repository.getRunById({ id: activeOldest.id })).status,
          "pending",
        );
        assert.isTrue(
          Option.isSome(
            yield* repository.getRunById({ id: AutomationRunId.makeUnsafe("run-0000") }),
          ),
        );
        assert.isTrue(
          Option.isSome(
            yield* repository.getRunById({ id: AutomationRunId.makeUnsafe("run-0039") }),
          ),
        );
        assert.isTrue(
          Option.isSome(
            yield* repository.getRunById({ id: AutomationRunId.makeUnsafe("run-0040") }),
          ),
        );

        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE automation_runs SET result_json = NULL, error = 'old failure payload'
          WHERE run_id = 'run-0000'`;
        const replay = yield* repository.createRun({
          id: AutomationRunId.makeUnsafe("retry-old-occurrence"),
          automationId,
          projectId,
          threadId: null,
          trigger: { type: "scheduled" },
          scheduledFor: minuteAfter(0),
          permissionSnapshot,
          now: minuteAfter(RUNS_CREATED + 1),
        });
        assert.strictEqual(replay.id, "run-0000");
        assert.strictEqual(replay.status, "succeeded");
        assert.strictEqual(replay.result, null);
        assert.strictEqual(
          Option.getOrThrow(yield* repository.getRunById({ id: replay.id })).error,
          null,
        );
        assert.strictEqual((yield* runStats(automationId)).total, RUNS_CREATED + 1);

        const history = yield* repository.listRunsForDefinition({ automationId, limit: 1_000 });
        assert.strictEqual(history[0]?.id, "run-0539");
        assert.strictEqual(history.length, RUNS_CREATED + 1);

        const listed = yield* repository.list({ projectId, includeArchived: true });
        assert.strictEqual(listed.runs.length, RETAINED_RUNS_PER_AUTOMATION);
        assert.strictEqual(listed.runs[0]?.id, "run-0539");
        assert.strictEqual(listed.runs.at(-1)?.id, "run-0040");

        assert.strictEqual((yield* runStats(siblingId)).total, 3);
      }),
    { timeout: 60_000 },
  );

  it.effect(
    "does not prune a finished run that still waits for its completion evaluation",
    () =>
      Effect.gen(function* () {
        const repository = yield* AutomationRepository;
        yield* runMigrations();
        const projectId = ProjectId.makeUnsafe("project-retention-eval");
        const automationId = AutomationId.makeUnsafe("automation-retention-eval");
        const threadId = ThreadId.makeUnsafe("thread-retention-eval");
        yield* repository.createDefinition({
          id: automationId,
          input: {
            ...baseInput("project-retention-eval"),
            mode: "heartbeat",
            targetThreadId: threadId,
            completionPolicy: {
              type: "ai-evaluated",
              stopWhen: "the build is green",
              confidenceThreshold: DEFAULT_AUTOMATION_STOP_CONFIDENCE_THRESHOLD,
            },
          },
          now: "2026-06-30T00:00:00.000Z",
        });

        const awaitingEvaluation = yield* repository.createRun({
          id: AutomationRunId.makeUnsafe("run-awaiting-evaluation"),
          automationId,
          projectId,
          threadId,
          trigger: { type: "manual" },
          scheduledFor: minuteAfter(-1),
          permissionSnapshot,
          now: minuteAfter(-1),
        });
        yield* repository.markRunSucceeded({
          id: awaitingEvaluation.id,
          turnId: null,
          result: { outcome: "unknown", summary: null, unread: true, archivedAt: null },
          finishedAt: minuteAfter(-1),
          accountedAt: minuteAfter(-1),
        });

        for (let index = 0; index < RETAINED_RUNS_PER_AUTOMATION + 5; index += 1) {
          const run = yield* repository.createRun({
            id: AutomationRunId.makeUnsafe(`eval-run-${String(index).padStart(4, "0")}`),
            automationId,
            projectId,
            threadId,
            trigger: { type: "manual" },
            scheduledFor: minuteAfter(index),
            permissionSnapshot,
            now: minuteAfter(index),
          });
          yield* repository.markRunSucceeded({
            id: run.id,
            turnId: null,
            result: {
              outcome: "unknown",
              summary: null,
              unread: true,
              archivedAt: null,
              completionEvaluation: {
                stopMatched: false,
                confidence: 0,
                reason: "Stop condition was not met.",
              },
            },
            finishedAt: minuteAfter(index),
            accountedAt: minuteAfter(index),
          });
        }

        assert.isTrue(Option.isSome(yield* repository.getRunById({ id: awaitingEvaluation.id })));
        assert.deepStrictEqual(
          (yield* repository.listRunsNeedingCompletionEvaluation({ limit: 10 })).map(
            (run) => run.id,
          ),
          [awaitingEvaluation.id],
        );
        assert.strictEqual((yield* runStats(automationId)).total, RETAINED_RUNS_PER_AUTOMATION + 1);
      }),
    { timeout: 60_000 },
  );
});
