import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ServerSettingsPatch } from "@synara/contracts";
import { Effect, FileSystem, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ServerConfig } from "./config";
import { ServerSettingsLive, ServerSettingsService } from "./serverSettings";

const atomicWrites = vi.hoisted(() => ({
  calls: [] as Array<{ readonly filePath: string; readonly bytes: number }>,
  failPathIncludes: null as string | null,
}));

vi.mock("./atomicWrite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./atomicWrite")>();
  return {
    ...actual,
    writeFileStringAtomically: (input: Parameters<typeof actual.writeFileStringAtomically>[0]) => {
      if (atomicWrites.failPathIncludes && input.filePath.includes(atomicWrites.failPathIncludes)) {
        return Effect.fail(new Error("injected secret write failure"));
      }
      atomicWrites.calls.push({
        filePath: input.filePath,
        bytes:
          typeof input.contents === "string"
            ? Buffer.byteLength(input.contents)
            : input.contents.byteLength,
      });
      return actual.writeFileStringAtomically(input);
    },
  };
});

type ProviderInstancesPatch = NonNullable<ServerSettingsPatch["providerInstances"]>;

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "synara-settings-secret-writes-",
}).pipe(Layer.provide(NodeServices.layer));
const baseLayer = Layer.merge(NodeServices.layer, serverConfigLayer);
const testLayer = Layer.merge(baseLayer, ServerSettingsLive.pipe(Layer.provide(baseLayer)));

const runWithSettings = <A, E>(
  effect: Effect.Effect<A, E, ServerSettingsService | ServerConfig | FileSystem.FileSystem>,
) => Effect.runPromise(effect.pipe(Effect.provide(testLayer)) as Effect.Effect<A, E, never>);

function providerInstancesWithSecrets(count: number): ProviderInstancesPatch {
  const instances: Record<string, unknown> = {};
  for (let index = 0; index < count; index += 1) {
    instances[`grok_${index}`] = {
      driver: "grok",
      enabled: true,
      environment: [{ name: "XAI_API_KEY", value: `secret-token-${index}`, sensitive: true }],
    };
  }
  instances.opencode_work = {
    driver: "opencode",
    enabled: true,
    config: { serverUrl: "http://127.0.0.1:4096", serverPassword: "opencode-password" },
  };
  return instances as ProviderInstancesPatch;
}

const environmentSecretFile = (instanceId: string, name: string) =>
  `provider-env-${Buffer.from(instanceId).toString("base64url")}-${Buffer.from(name).toString("base64url")}.bin`;

const secretWrites = (secretsDir: string) => {
  const writes = atomicWrites.calls.filter((call) => call.filePath.startsWith(secretsDir));
  return { count: writes.length, bytes: writes.reduce((total, call) => total + call.bytes, 0) };
};

beforeEach(() => {
  atomicWrites.calls.length = 0;
  atomicWrites.failPathIncludes = null;
});

describe("ServerSettingsService provider secret writes", () => {
  it.each([1, 16])(
    "does not rewrite %i unchanged environment secrets plus one config secret on an unrelated settings save",
    async (environmentSecretCount) => {
      const result = await runWithSettings(
        Effect.gen(function* () {
          const service = yield* ServerSettingsService;
          const { secretsDir } = yield* ServerConfig;
          yield* service.start;
          yield* service.updateSettings({
            providerInstances: providerInstancesWithSecrets(environmentSecretCount),
          });
          const initial = secretWrites(secretsDir);
          atomicWrites.calls.length = 0;
          const updated = yield* service.updateSettings({ keepAwakeMode: "agent" });
          return { initial, unrelated: secretWrites(secretsDir), updated };
        }),
      );

      expect(result.initial.count).toBe(environmentSecretCount + 1);
      expect(result.unrelated).toEqual({ count: 0, bytes: 0 });
      expect(result.updated.keepAwakeMode).toBe("agent");
      expect(result.updated.providerInstances.grok_0?.environment).toEqual([
        { name: "XAI_API_KEY", value: "secret-token-0", sensitive: true },
      ]);
    },
  );

  it("writes only the changed secret and deletes removed secrets", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const { secretsDir } = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* service.start;
        yield* service.updateSettings({ providerInstances: providerInstancesWithSecrets(3) });
        atomicWrites.calls.length = 0;
        const instances = providerInstancesWithSecrets(3) as Record<string, unknown>;
        instances.grok_1 = {
          driver: "grok",
          enabled: true,
          environment: [{ name: "XAI_API_KEY", value: "rotated-token", sensitive: true }],
        };
        delete instances.grok_2;
        const updated = yield* service.updateSettings({
          providerInstances: instances as ProviderInstancesPatch,
        });
        const writtenPaths = atomicWrites.calls
          .filter((call) => call.filePath.startsWith(secretsDir))
          .map((call) => call.filePath.slice(secretsDir.length + 1));
        const remaining = yield* fs.readDirectory(secretsDir);
        return { updated, writtenPaths, remaining: remaining.toSorted() };
      }),
    );

    expect(result.writtenPaths).toEqual([environmentSecretFile("grok_1", "XAI_API_KEY")]);
    expect(result.remaining).not.toContain(environmentSecretFile("grok_2", "XAI_API_KEY"));
    expect(result.remaining).toContain(environmentSecretFile("grok_0", "XAI_API_KEY"));
    expect(result.updated.providerInstances.grok_1?.environment).toEqual([
      { name: "XAI_API_KEY", value: "rotated-token", sensitive: true },
    ]);
  });

  it("propagates a failed changed-secret write and keeps the previous settings", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        yield* service.start;
        yield* service.updateSettings({ providerInstances: providerInstancesWithSecrets(2) });
        const instances = providerInstancesWithSecrets(2) as Record<string, unknown>;
        instances.grok_0 = {
          driver: "grok",
          enabled: true,
          environment: [{ name: "XAI_API_KEY", value: "rotated-token", sensitive: true }],
        };
        atomicWrites.failPathIncludes = environmentSecretFile("grok_0", "XAI_API_KEY");
        const exit = yield* Effect.exit(
          service.updateSettings({
            providerInstances: instances as ProviderInstancesPatch,
          }),
        );
        atomicWrites.failPathIncludes = null;
        return { exit, settings: yield* service.getSettings };
      }),
    );

    expect(result.exit._tag).toBe("Failure");
    expect(result.settings.providerInstances.grok_0?.environment).toEqual([
      { name: "XAI_API_KEY", value: "secret-token-0", sensitive: true },
    ]);
  });

  it("still moves plaintext secrets found in settings.json into the secret store on startup", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const { settingsPath, secretsDir } = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(secretsDir, { recursive: true });
        yield* fs.writeFileString(
          settingsPath,
          JSON.stringify({
            providerInstances: {
              grok_work: {
                driver: "grok",
                enabled: true,
                environment: [{ name: "XAI_API_KEY", value: "plaintext-token", sensitive: true }],
              },
            },
          }),
        );
        yield* service.start;
        const raw = yield* fs.readFileString(settingsPath);
        const secret = yield* fs.readFileString(
          `${secretsDir}/${environmentSecretFile("grok_work", "XAI_API_KEY")}`,
        );
        return { raw, secret, settings: yield* service.getSettings };
      }),
    );

    expect(result.raw).not.toContain("plaintext-token");
    expect(result.secret).toBe("plaintext-token");
    expect(result.settings.providerInstances.grok_work?.environment).toEqual([
      { name: "XAI_API_KEY", value: "plaintext-token", sensitive: true },
    ]);
  });
});
