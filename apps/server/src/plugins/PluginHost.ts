import { createHash } from "node:crypto";
import { existsSync, watch } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type PluginCallInput,
  type PluginEditInput,
  type PluginListResult,
} from "@synara/contracts";
import {
  createPluginRegistry,
  type JsonValue,
  type PluginKvStorage,
  type PluginRegistry,
  type RegisteredPluginAgentTool,
  type SynaraPlugin,
  type PluginThreadStartInput,
} from "@synara/plugin-sdk";
import { reviewQueueManifest } from "@synara/plugin-review-queue/manifest";
import reviewQueuePlugin from "@synara/plugin-review-queue/server";
import { Effect, Layer, Option, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import { ServerSettingsService } from "../serverSettings";
import { ServerConfig } from "../config";
import { makeKeyedLock } from "../provider/keyedLock";
import { ensurePluginAuthoringSkill, makePluginEditPrompt } from "./authoringSkill";
import { findPluginSource, PLUGIN_CONTROL_FILE, readPluginControl } from "./control";
import { pluginBuildOutputRoot } from "./build";
import { pluginAssetKey, readPluginManifest, type LocalPluginManifest } from "./manifest";
import { removePluginSkills, syncPluginSkills } from "./skills";
import {
  assertPluginThreadStartAuthority,
  assertPluginWriteAuthority,
  bindPluginInvocationAuthority,
  hasPluginInvocationAuthority,
  runWithPluginInvocationAuthority,
  type PluginAgentToolAuthority,
} from "./invocationAuthority";

export interface PluginHostShape {
  readonly list: () => Effect.Effect<PluginListResult, Error>;
  readonly call: (input: PluginCallInput) => Effect.Effect<{ readonly output: JsonValue }, Error>;
  readonly edit: (input: PluginEditInput) => Effect.Effect<{ readonly threadId: string }, Error>;
  readonly agentTools: () => Effect.Effect<ReadonlyArray<RegisteredPluginAgentTool>, Error>;
  readonly callAgentTool: (
    input: PluginHostAgentToolCallInput,
    authority: PluginAgentToolAuthority,
  ) => Effect.Effect<JsonValue, Error>;
  readonly resolveAppAsset: (
    assetKey: string,
    fileName: string,
  ) => Effect.Effect<{ readonly path: string; readonly contentType: string } | undefined, Error>;
}

export type PluginHostAgentToolCallInput = Pick<
  Parameters<PluginRegistry["callAgentTool"]>[0],
  "pluginId" | "generation" | "toolId" | "input"
>;

export class PluginHostService extends ServiceMap.Service<PluginHostService, PluginHostShape>()(
  "synara/plugins/PluginHostService",
) {}

function stableId(pluginId: string, input: PluginThreadStartInput, suffix: string): string {
  return createHash("sha256")
    .update(JSON.stringify([pluginId, input.idempotencyKey, suffix]))
    .digest("hex")
    .slice(0, 32);
}

async function loadExternalPlugin(
  manifest: LocalPluginManifest,
  reloadToken: string,
): Promise<SynaraPlugin> {
  const serverEntry = path.join(
    pluginBuildOutputRoot(manifest.sourceRoot, reloadToken),
    "server.js",
  );
  if (!existsSync(serverEntry)) {
    throw new Error(`Plugin is not built: ${manifest.id}. Run synara plugin build first.`);
  }
  const url = pathToFileURL(serverEntry);
  url.searchParams.set("synaraReload", reloadToken || manifest.version);
  const loaded = (await import(url.href)) as { readonly default?: unknown };
  if (typeof loaded.default !== "function") {
    throw new Error(`Plugin server entry has no default factory: ${manifest.id}`);
  }
  return loaded.default as SynaraPlugin;
}

interface ActivePluginSource {
  readonly id: string;
  readonly displayName: string;
  readonly sourceRoot: string;
  readonly skillRoots?: ReadonlyArray<string>;
  readonly assetKey?: string;
  readonly appPath?: string;
  readonly appCssPath?: string;
}

interface PluginActivationAssets {
  readonly assetKey: string;
  readonly appPath?: string;
  readonly appCssPath?: string;
  readonly appUrl?: string;
  readonly appCssUrl?: string;
}

function pluginActivationAssets(
  manifest: LocalPluginManifest,
  reloadToken: string,
): PluginActivationAssets {
  const outputRoot = pluginBuildOutputRoot(manifest.sourceRoot, reloadToken);
  const assetKey = pluginAssetKey(manifest.id);
  const appPath = path.join(outputRoot, "app.js");
  const appCssPath = path.join(outputRoot, "app.css");
  const versionKey = encodeURIComponent(reloadToken || manifest.version);
  return {
    assetKey,
    ...(manifest.appEntry
      ? {
          appPath,
          appUrl: `/api/plugin-assets/${assetKey}/app.js?v=${versionKey}`,
        }
      : {}),
    ...(existsSync(appCssPath)
      ? {
          appCssPath,
          appCssUrl: `/api/plugin-assets/${assetKey}/app.css?v=${versionKey}`,
        }
      : {}),
  };
}

function reviewQueueSourceRoot(): string | undefined {
  if (!reviewQueueManifest.sourcePath) return undefined;
  return (
    findPluginSource(process.cwd(), reviewQueueManifest.sourcePath) ??
    findPluginSource(path.dirname(fileURLToPath(import.meta.url)), reviewQueueManifest.sourcePath)
  );
}

export const PluginHostLive = Layer.effect(
  PluginHostService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const orchestration = yield* OrchestrationEngineService;
    const projections = yield* ProjectionSnapshotQuery;
    const settings = yield* ServerSettingsService;
    const config = yield* ServerConfig;
    yield* ensurePluginAuthoringSkill(config.baseDir).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Plugin authoring skill could not be installed; plugins remain usable.", {
          cause,
        }),
      ),
    );
    let controlChanged = true;
    let cachedControl = (() => {
      try {
        return readPluginControl(config.baseDir);
      } catch (cause) {
        console.error("Plugin control file is invalid; starting with built-in plugins only.", cause);
        return { plugins: {} };
      }
    })();
    const controlWatcher = watch(config.baseDir, { persistent: false }, (_event, fileName) => {
      if (!fileName || fileName.toString() === PLUGIN_CONTROL_FILE) controlChanged = true;
    });
    controlWatcher.on("error", (cause) => {
      controlChanged = true;
      console.error("Plugin control watcher failed; plugin changes require a server restart.", cause);
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => controlWatcher.close()));
    const currentControl = () => {
      if (controlChanged) {
        try {
          cachedControl = readPluginControl(config.baseDir);
        } catch (cause) {
          console.error("Plugin control file is invalid; keeping the last valid state.", cause);
        }
        controlChanged = false;
      }
      return cachedControl;
    };
    const storageUpdates = makeKeyedLock<string>();

    const makeStorage = (pluginId: string): PluginKvStorage => {
      const get = (key: string) =>
        Effect.runPromise(
          sql<{ readonly valueJson: string }>`
            SELECT value_json AS "valueJson"
            FROM plugin_storage
            WHERE plugin_id = ${pluginId} AND key = ${key}
          `.pipe(
            Effect.map((rows) => {
              const value = rows[0]?.valueJson;
              return value === undefined ? undefined : (JSON.parse(value) as JsonValue);
            }),
          ),
        );
      const setRaw = (key: string, value: JsonValue) =>
        Effect.runPromise(
          sql`
            INSERT INTO plugin_storage (plugin_id, key, value_json, updated_at)
            VALUES (${pluginId}, ${key}, ${JSON.stringify(value)}, ${new Date().toISOString()})
            ON CONFLICT (plugin_id, key) DO UPDATE SET
              value_json = excluded.value_json,
              updated_at = excluded.updated_at
          `.pipe(Effect.asVoid),
        );
      const deleteRaw = (key: string) =>
        Effect.runPromise(
          sql`
            DELETE FROM plugin_storage WHERE plugin_id = ${pluginId} AND key = ${key}
          `.pipe(Effect.asVoid),
        );

      return {
        get,
        set: async (key, value) => {
          await assertPluginWriteAuthority();
          await setRaw(key, value);
        },
        delete: async (key) => {
          await assertPluginWriteAuthority();
          await deleteRaw(key);
        },
        update: (key, updateValue) =>
          bindPluginInvocationAuthority(() =>
            Effect.runPromise(
              storageUpdates.withLock(
                `${pluginId}\0${key}`,
                Effect.tryPromise(async () => {
                  const result = await updateValue(await get(key));
                  await assertPluginWriteAuthority();
                  if (result === undefined) await deleteRaw(key);
                  else await setRaw(key, result);
                  return result;
                }),
              ),
            ),
          )(),
      };
    };

    const startThread = async (pluginId: string, input: PluginThreadStartInput) => {
      const agentInvocation = hasPluginInvocationAuthority();
      await assertPluginWriteAuthority();
      await assertPluginThreadStartAuthority();
      return Effect.runPromise(
        Effect.gen(function* () {
          const projectId = ProjectId.makeUnsafe(input.projectId);
          const project = yield* projections.getProjectShellById(projectId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new Error(`Project not found: ${input.projectId}`)),
                onSome: Effect.succeed,
              }),
            ),
          );
          const serverSettings = yield* settings.getSettings;
          const modelSelection =
            project.defaultModelSelection ?? serverSettings.textGenerationModelSelection;
          const digest = stableId(pluginId, input, "thread");
          const threadId = ThreadId.makeUnsafe(`plugin-${digest}`);
          yield* Effect.tryPromise(() => assertPluginWriteAuthority());
          yield* orchestration.dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe(`plugin:${digest}:create`),
            threadId,
            projectId,
            title: input.title,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            envMode: "local",
            branch: null,
            worktreePath: null,
            createdAt: input.createdAt,
          });
          yield* Effect.tryPromise(() => assertPluginWriteAuthority());
          yield* orchestration.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(`plugin:${digest}:turn`),
            threadId,
            message: {
              messageId: MessageId.makeUnsafe(`plugin:${digest}:message`),
              role: "user",
              text: input.prompt,
              attachments: [],
            },
            dispatchMode: "queue",
            dispatchOrigin: agentInvocation ? "agent" : "user",
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: input.createdAt,
          });
          return { threadId };
        }),
      ).then(({ threadId }) => ({ threadId }));
    };

    const registry = createPluginRegistry({
      storage: makeStorage,
      host: (pluginId) => ({
        threads: {
          start: (input) => startThread(pluginId, input),
        },
      }),
    });
    const appliedControl = new Map<string, string>();
    const activationFailures = new Map<
      string,
      { readonly fingerprint: string; readonly attempt: number; readonly retryAt: number }
    >();
    const activeSources = new Map<string, ActivePluginSource>();
    let activeSync: Promise<void> | undefined;
    let cachedAgentTools: ReadonlyArray<RegisteredPluginAgentTool> = [];
    const retryIsDue = () =>
      [...activationFailures.values()].some((failure) => Date.now() >= failure.retryAt);
    const syncControl = () => {
      if (activeSync) return activeSync;
      if (!controlChanged && !retryIsDue()) return Promise.resolve();
      const operation = (async () => {
        do {
          const control = currentControl();
          const configuredReviewQueue = control.plugins[reviewQueueManifest.id];
          const desired = [
            {
              id: reviewQueueManifest.id,
              enabled: configuredReviewQueue?.enabled ?? true,
              reloadToken: configuredReviewQueue?.reloadToken ?? "",
              sourceRoot: reviewQueueSourceRoot(),
              builtIn: true as const,
            },
            ...Object.entries(control.plugins)
              .filter(([id, entry]) => id !== reviewQueueManifest.id && entry.sourceRoot)
              .map(([id, entry]) => ({
                id,
                enabled: entry.enabled,
                reloadToken: entry.reloadToken,
                sourceRoot: entry.sourceRoot,
                builtIn: false as const,
              })),
          ];
          const desiredIds = new Set(desired.map((entry) => entry.id));
          for (const pluginId of appliedControl.keys()) {
            if (desiredIds.has(pluginId)) continue;
            await registry.deactivate(pluginId);
            activeSources.delete(pluginId);
            appliedControl.delete(pluginId);
            activationFailures.delete(pluginId);
            removePluginSkills(config.baseDir, pluginId);
          }

          for (const entry of desired) {
            const fingerprint = JSON.stringify([
              entry.enabled,
              entry.reloadToken,
              entry.sourceRoot ?? null,
            ]);
            if (appliedControl.get(entry.id) === fingerprint) continue;
            const activationFailure = activationFailures.get(entry.id);
            if (
              activationFailure?.fingerprint === fingerprint &&
              Date.now() < activationFailure.retryAt
            ) {
              continue;
            }
            if (!entry.enabled) {
              await registry.deactivate(entry.id);
              activeSources.delete(entry.id);
              removePluginSkills(config.baseDir, entry.id);
              appliedControl.set(entry.id, fingerprint);
              activationFailures.delete(entry.id);
              continue;
            }
            try {
              if (entry.builtIn) {
                if (entry.sourceRoot && entry.reloadToken) {
                  const manifest = readPluginManifest(entry.sourceRoot);
                  if (manifest.id !== entry.id) {
                    throw new Error(
                      `Built-in plugin id ${entry.id} does not match manifest id ${manifest.id}.`,
                    );
                  }
                  const plugin = await loadExternalPlugin(manifest, entry.reloadToken);
                  const assets = pluginActivationAssets(manifest, entry.reloadToken);
                  await registry.activate(
                    {
                      id: manifest.id,
                      displayName: manifest.displayName,
                      version: manifest.version,
                      apiVersion: manifest.apiVersion,
                      editable: true,
                      ...(manifest.appEntry
                        ? {
                            app: manifest.appKey,
                            appUrl: assets.appUrl!,
                            ...(assets.appCssUrl ? { appCssUrl: assets.appCssUrl } : {}),
                          }
                        : {}),
                    },
                    plugin,
                  );
                  activeSources.set(entry.id, {
                    id: entry.id,
                    displayName: manifest.displayName,
                    sourceRoot: manifest.sourceRoot,
                    skillRoots: manifest.skillRoots,
                    assetKey: assets.assetKey,
                    ...(assets.appPath ? { appPath: assets.appPath } : {}),
                    ...(assets.appCssPath ? { appCssPath: assets.appCssPath } : {}),
                  });
                } else {
                  await registry.activate(
                    { ...reviewQueueManifest, editable: entry.sourceRoot !== undefined },
                    reviewQueuePlugin,
                  );
                  if (entry.sourceRoot) {
                    activeSources.set(entry.id, {
                      id: entry.id,
                      displayName: reviewQueueManifest.displayName,
                      sourceRoot: entry.sourceRoot,
                    });
                  }
                }
              } else {
                if (!entry.sourceRoot) throw new Error(`Plugin source is missing: ${entry.id}`);
                const manifest = readPluginManifest(entry.sourceRoot);
                if (manifest.id !== entry.id) {
                  throw new Error(
                    `Installed plugin id ${entry.id} does not match manifest id ${manifest.id}.`,
                  );
                }
                const plugin = await loadExternalPlugin(manifest, entry.reloadToken);
                const assets = pluginActivationAssets(manifest, entry.reloadToken);
                syncPluginSkills(config.baseDir, manifest.id, manifest.skillRoots);
                await registry.activate(
                  {
                    id: manifest.id,
                    displayName: manifest.displayName,
                    version: manifest.version,
                    apiVersion: manifest.apiVersion,
                    editable: true,
                    ...(manifest.appEntry
                      ? {
                          app: manifest.appKey,
                          appUrl: assets.appUrl!,
                          ...(assets.appCssUrl ? { appCssUrl: assets.appCssUrl } : {}),
                        }
                      : {}),
                  },
                  plugin,
                );
                activeSources.set(entry.id, {
                  id: entry.id,
                  displayName: manifest.displayName,
                  sourceRoot: manifest.sourceRoot,
                  skillRoots: manifest.skillRoots,
                  assetKey: assets.assetKey,
                  ...(assets.appPath ? { appPath: assets.appPath } : {}),
                  ...(assets.appCssPath ? { appCssPath: assets.appCssPath } : {}),
                });
              }
              appliedControl.set(entry.id, fingerprint);
              activationFailures.delete(entry.id);
            } catch (cause) {
              const lastGenerationIsActive = registry
                .list()
                .some((plugin) => plugin.id === entry.id);
              const previousFailure = activationFailures.get(entry.id);
              const attempt =
                previousFailure?.fingerprint === fingerprint ? previousFailure.attempt + 1 : 1;
              activationFailures.set(entry.id, {
                fingerprint,
                attempt,
                retryAt: Date.now() + Math.min(30_000, 500 * 2 ** (attempt - 1)),
              });
              if (!lastGenerationIsActive) {
                await registry.deactivate(entry.id);
                activeSources.delete(entry.id);
                removePluginSkills(config.baseDir, entry.id);
                console.error(
                  `Plugin activation failed for ${entry.id}; Synara will continue.`,
                  cause,
                );
                continue;
              }
              const previousSkillRoots = activeSources.get(entry.id)?.skillRoots;
              if (previousSkillRoots !== undefined) {
                syncPluginSkills(config.baseDir, entry.id, previousSkillRoots);
              } else {
                removePluginSkills(config.baseDir, entry.id);
              }
              console.error(
                `Plugin reload failed for ${entry.id}; the last active generation remains in use.`,
                cause,
              );
            }
          }
        } while (controlChanged);
      })()
        .catch((cause) => {
          controlChanged = true;
          throw cause;
        })
        .finally(() => {
          cachedAgentTools = registry.listAgentTools();
        });
      activeSync = operation;
      void operation.then(
        () => {
          if (activeSync === operation) activeSync = undefined;
        },
        () => {
          if (activeSync === operation) activeSync = undefined;
        },
      );
      return operation;
    };
    yield* Effect.tryPromise({
      try: syncControl,
      catch: (cause) => (cause instanceof Error ? cause : new Error("Plugin activation failed")),
    });

    return {
      list: () =>
        Effect.tryPromise({
          try: () => syncControl().then(() => registry.list()),
          catch: (cause) =>
            cause instanceof Error ? cause : new Error("Plugin catalog refresh failed", { cause }),
        }),
      call: (input) =>
        Effect.tryPromise({
          try: () =>
            syncControl()
              .then(() => registry.call(input))
              .then((output) => ({ output })),
          catch: (cause) =>
            cause instanceof Error ? cause : new Error("Plugin call failed", { cause }),
        }),
      edit: (input) =>
        Effect.tryPromise({
          try: async () => {
            await syncControl();
            const active = registry.list().find((plugin) => plugin.id === input.pluginId);
            if (!active) throw new Error(`Plugin is not active: ${input.pluginId}`);
            if (active.generation !== input.generation) {
              throw new Error(`Plugin generation is stale: ${input.pluginId}`);
            }
            const source = activeSources.get(input.pluginId);
            if (!source) throw new Error(`Plugin source is not available: ${input.pluginId}`);
            return startThread(input.pluginId, {
              projectId: input.projectId,
              title: `Edit ${source.displayName} plugin`,
              prompt: makePluginEditPrompt({
                pluginId: source.id,
                displayName: source.displayName,
                sourceRoot: source.sourceRoot,
                baseDir: config.baseDir,
              }),
              idempotencyKey: input.operationId,
              createdAt: input.createdAt,
            });
          },
          catch: (cause) =>
            cause instanceof Error ? cause : new Error("Plugin edit chat failed", { cause }),
        }),
      agentTools: () =>
        Effect.tryPromise({
          try: async () => {
            await syncControl();
            return cachedAgentTools;
          },
          catch: (cause) =>
            cause instanceof Error
              ? cause
              : new Error("Plugin agent tool refresh failed", { cause }),
        }),
      callAgentTool: (input, authority) =>
        Effect.tryPromise({
          try: async () => {
            await syncControl();
            const tool = registry
              .listAgentTools()
              .find(
                (candidate) =>
                  candidate.pluginId === input.pluginId &&
                  candidate.generation === input.generation &&
                  candidate.id === input.toolId,
              );
            if (!tool) {
              throw new Error(`Plugin agent tool is not active: ${input.toolId}`);
            }
            return runWithPluginInvocationAuthority({ access: tool.access, ...authority }, () =>
              registry.callAgentTool({ ...input, signal: authority.signal }),
            );
          },
          catch: (cause) =>
            cause instanceof Error ? cause : new Error("Plugin agent tool call failed", { cause }),
        }),
      resolveAppAsset: (assetKey, fileName) =>
        Effect.tryPromise({
          try: async () => {
            await syncControl();
            const source = [...activeSources.values()].find(
              (candidate) => candidate.assetKey === assetKey,
            );
            if (!source) return undefined;
            if (fileName === "app.js" && source.appPath) {
              return { path: source.appPath, contentType: "text/javascript; charset=utf-8" };
            }
            if (fileName === "app.css" && source.appCssPath) {
              return { path: source.appCssPath, contentType: "text/css; charset=utf-8" };
            }
            return undefined;
          },
          catch: (cause) =>
            cause instanceof Error ? cause : new Error("Plugin asset lookup failed", { cause }),
        }),
    } satisfies PluginHostShape;
  }),
);
