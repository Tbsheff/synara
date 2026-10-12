import { assert, it } from "@effect/vitest";
import { AutomationId, AutomationRunId, ProjectId, ThreadId } from "@synara/contracts";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { prepareStableHubs } from "./StableHubActivation";
import { AutomationRepositoryLive } from "./Layers/AutomationRepository";
import { ProjectAgentRepositoryLive } from "./Layers/ProjectAgentRepository";
import { SqlitePersistenceMemory } from "./Layers/Sqlite";
import { AutomationRepository } from "./Services/AutomationRepository";
import { ProjectAgentRepository } from "./Services/ProjectAgentRepository";

const testLayer = Layer.mergeAll(AutomationRepositoryLive, ProjectAgentRepositoryLive).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const now = "2026-09-15T12:00:00.000Z";

const seedHub = (id: string, pausedAt: string | null = null, archivedAt: string | null = null) =>
  Effect.gen(function* () {
    const hubs = yield* ProjectAgentRepository;
    const automations = yield* AutomationRepository;
    const projectId = ProjectId.makeUnsafe(id);
    const coordinatorThreadId = ThreadId.makeUnsafe(`${id}:coordinator`);
    yield* hubs.saveConfig(
      {
        projectId,
        coordinatorThreadId,
        coordinatorName: "Coordinator",
        coordinatorModelSelection: { provider: "codex", model: "gpt-5-codex" },
        limits: {
          maxConcurrentWorkers: 2,
          maxNewWorkersPerTurn: 4,
          maxWorkerCreationsPerGoal: 12,
          maxAutomaticContinuationsPerGoal: 20,
          maxRepairRoundsPerTask: 2,
        },
        captureEnabled: true,
        enabled: true,
        automationId: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        disabledAt: null,
        pausedAt,
        archivedAt,
      },
      null,
    );
    const definition = yield* automations.createDefinition({
      id: AutomationId.makeUnsafe(`${id}:checkin`),
      input: {
        projectId,
        name: "Check-in",
        prompt: "Check progress",
        schedule: { type: "interval", everySeconds: 60 },
        mode: "heartbeat",
        targetThreadId: coordinatorThreadId,
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        completionPolicy: { type: "ai-evaluated", stopWhen: "Done", confidenceThreshold: 0.8 },
      },
      now,
      nextRunAt: now,
      managedByProject: true,
    });
    return {
      projectId,
      definition: Option.getOrThrow(yield* automations.getDefinitionById({ id: definition.id })),
    };
  });

it.effect(
  "pauses saved Hubs once, clears old check-ins and completion checks, and preserves user state",
  () =>
    Effect.gen(function* () {
      const hubs = yield* ProjectAgentRepository;
      const automations = yield* AutomationRepository;
      const sql = yield* SqlClient.SqlClient;
      const active = yield* seedHub("active");
      const paused = yield* seedHub("paused", now);
      const archived = yield* seedHub("archived", null, now);
      const ordinaryCreated = yield* automations.createDefinition({
        id: AutomationId.makeUnsafe("ordinary"),
        input: {
          ...active.definition,
          projectId: ProjectId.makeUnsafe("ordinary"),
          schedule: { type: "interval", everySeconds: 60 },
        },
        now,
        nextRunAt: now,
      });
      const ordinary = Option.getOrThrow(
        yield* automations.getDefinitionById({ id: ordinaryCreated.id }),
      );
      for (const status of ["pending", "deferred", "succeeded"]) {
        const run = yield* automations.createRun({
          id: AutomationRunId.makeUnsafe(`active:${status}`),
          automationId: active.definition.id,
          projectId: active.projectId,
          threadId: ThreadId.makeUnsafe(`active:${status}:coordinator`),
          trigger: { type: "manual" },
          scheduledFor: now,
          permissionSnapshot: {
            provider: "codex",
            modelSelection: active.definition.modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            worktreeMode: "local",
            allowedCapabilities: ["send-turn"],
            completionPolicyVersion: active.definition.completionPolicyVersion,
            createdAt: now,
          },
          now,
        });
        yield* sql`UPDATE automation_runs SET status = ${status}, finished_at = ${status === "succeeded" ? now : null} WHERE run_id = ${run.id}`;
      }
      yield* prepareStableHubs("beta");
      assert.equal(Option.getOrThrow(yield* hubs.getConfig(active.projectId)).pausedAt, null);
      yield* prepareStableHubs("production");
      const config = Option.getOrThrow(yield* hubs.getConfig(active.projectId));
      assert.isNotNull(config.pausedAt);
      assert.deepEqual(config.pausedAutomationIds, [active.definition.id]);
      const definition = Option.getOrThrow(
        yield* automations.getDefinitionById({ id: active.definition.id }),
      );
      assert.equal(definition.enabled, false);
      assert.equal(definition.nextRunAt, null);
      assert.equal(
        definition.completionPolicyVersion,
        (active.definition.completionPolicyVersion ?? 0) + 1,
      );
      const runs = yield* automations.listRunsForDefinition({
        automationId: definition.id,
        limit: 10,
      });
      assert.deepEqual(runs.map((run) => run.status).sort(), [
        "cancelled",
        "cancelled",
        "succeeded",
      ]);
      assert.deepEqual(
        Option.getOrThrow(yield* automations.getDefinitionById({ id: ordinary.id })),
        ordinary,
      );
      assert.deepEqual(
        Option.getOrThrow(yield* automations.getDefinitionById({ id: paused.definition.id })),
        paused.definition,
      );
      assert.deepEqual(
        Option.getOrThrow(yield* automations.getDefinitionById({ id: archived.definition.id })),
        archived.definition,
      );
      yield* automations.saveDefinition({
        definition: { ...definition, enabled: true, nextRunAt: "2026-10-12T20:00:00.000Z" },
        expectedUpdatedAt: definition.updatedAt,
      });
      assert.deepEqual(yield* automations.listRunsNeedingCompletionEvaluation({ limit: 10 }), []);
      yield* hubs.saveConfig(
        { ...config, pausedAt: null, revision: config.revision + 1 },
        config.revision,
      );
      const fresh = yield* seedHub("fresh");
      yield* prepareStableHubs("production");
      assert.equal(Option.getOrThrow(yield* hubs.getConfig(active.projectId)).pausedAt, null);
      assert.equal(Option.getOrThrow(yield* hubs.getConfig(fresh.projectId)).pausedAt, null);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("records the first launch even without saved Hubs", () =>
  Effect.gen(function* () {
    yield* prepareStableHubs("production");
    const fresh = yield* seedHub("new-after-first-launch");
    yield* prepareStableHubs("production");
    const hubs = yield* ProjectAgentRepository;
    assert.equal(Option.getOrThrow(yield* hubs.getConfig(fresh.projectId)).pausedAt, null);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rolls back the pause and marker when startup preparation fails", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const hubs = yield* ProjectAgentRepository;
    const automations = yield* AutomationRepository;
    const saved = yield* seedHub("rollback");
    yield* sql.unsafe(`CREATE TRIGGER reject_activation_marker BEFORE INSERT ON automation_settings
      WHEN NEW.setting_key = 'stable-hubs-activation-v1'
      BEGIN SELECT RAISE(ABORT, 'test startup failure'); END`);
    const result = yield* prepareStableHubs("production").pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.equal(Option.getOrThrow(yield* hubs.getConfig(saved.projectId)).pausedAt, null);
    assert.deepEqual(
      Option.getOrThrow(yield* automations.getDefinitionById({ id: saved.definition.id })),
      saved.definition,
    );
    const markers =
      yield* sql`SELECT * FROM automation_settings WHERE setting_key = 'stable-hubs-activation-v1'`;
    assert.deepEqual(markers, []);
    yield* sql.unsafe("DROP TRIGGER reject_activation_marker");
    yield* prepareStableHubs("production");
    assert.isNotNull(Option.getOrThrow(yield* hubs.getConfig(saved.projectId)).pausedAt);
  }).pipe(Effect.provide(testLayer)),
);
