import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  type ServerSettingsPatch,
  type ServerSettingsView,
} from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { Option, Schema } from "effect";
import { createMemoryStorage } from "../lib/storage";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_SETTINGS_STORAGE_KEY = "synara:app-settings:v1";
const APP_SETTINGS_RECOVERY_STORAGE_KEY = "synara:app-settings:v1:unreadable";
const SERVER_SETTINGS_MIGRATION_STORAGE_KEY = "synara:server-settings-migrated:v1";

type PendingSave = {
  readonly patch: ServerSettingsPatch;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
};

const harness = vi.hoisted(() => ({
  serverView: null as unknown as ServerSettingsView,
  client: null as unknown as QueryClient,
  localSettings: undefined as unknown,
  saves: [] as PendingSave[],
  api: {
    server: {
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
      refreshProviders: vi.fn(async () => ({ providers: [] })),
    },
  },
}));

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => harness.api,
  ensureNativeApi: () => harness.api,
}));

import { buildProviderInstanceSettingsPatch, useAppSettings } from "~/appSettings";

function applyServerPatch(
  view: ServerSettingsView,
  patch: ServerSettingsPatch,
): ServerSettingsView {
  return {
    ...view,
    ...(patch.enableAssistantStreaming !== undefined
      ? { enableAssistantStreaming: patch.enableAssistantStreaming }
      : {}),
    ...(patch.providerInstances !== undefined
      ? { providerInstances: patch.providerInstances as ServerSettingsView["providerInstances"] }
      : {}),
  };
}

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: () => undefined,
  useRef: <T>(current: T) => ({ current }),
  useCallback: <T>(callback: T) => callback,
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: harness.serverView }),
  useQueryClient: () => harness.client,
}));
vi.mock("~/hooks/useLocalStorage", () => ({
  useLocalStorage: (key: string, fallback: unknown, schema: Schema.Codec<unknown, unknown>) => {
    const raw = localStorage.getItem(key);
    const decoded = raw ? Schema.decodeUnknownOption(schema)(JSON.parse(raw)) : Option.none();
    harness.localSettings = Option.isSome(decoded) ? decoded.value : fallback;
    return [
      harness.localSettings,
      (update: unknown) => {
        harness.localSettings =
          typeof update === "function" ? update(harness.localSettings) : update;
      },
    ];
  },
}));
const act = (run: () => void) => run();

const clients: QueryClient[] = [];

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
  localStorage.removeItem(APP_SETTINGS_RECOVERY_STORAGE_KEY);
  localStorage.setItem(SERVER_SETTINGS_MIGRATION_STORAGE_KEY, "1");
  harness.serverView = {
    ...DEFAULT_SERVER_SETTINGS_VIEW,
    providerInstances: {
      codex_work: { driver: "codex", displayName: "Work", enabled: true },
    } as ServerSettingsView["providerInstances"],
  };
  harness.saves = [];
  harness.api.server.getSettings.mockReset().mockImplementation(async () => harness.serverView);
  harness.api.server.updateSettings.mockReset().mockImplementation(
    (patch: ServerSettingsPatch) =>
      new Promise<ServerSettingsView>((resolve, reject) => {
        harness.saves.push({
          patch,
          resolve: () => {
            harness.serverView = applyServerPatch(harness.serverView, patch);
            resolve(harness.serverView);
          },
          reject,
        });
      }),
  );
});

afterEach(async () => {
  for (let pass = 0; pass < 5; pass++) {
    for (const save of harness.saves) save.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  for (const client of clients.splice(0)) client.clear();
  localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
  localStorage.removeItem(APP_SETTINGS_RECOVERY_STORAGE_KEY);
  localStorage.removeItem(SERVER_SETTINGS_MIGRATION_STORAGE_KEY);
  vi.unstubAllGlobals();
});

async function renderSettings(client?: QueryClient) {
  const queryClient = client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (!client) clients.push(queryClient);
  harness.client = queryClient;
  const hook = { result: { current: useAppSettings() }, unmount: async () => undefined };
  return { hook, queryClient };
}

describe("useAppSettings persistence", () => {
  it("keeps readable stored settings and a recovery copy when one value cannot be decoded", async () => {
    const raw = JSON.stringify({
      uiDensity: "future-density",
      chatFontSizePx: 18,
      confirmThreadDelete: false,
      openCodeServerPassword: "stored-secret",
    });
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, raw);

    const { hook } = await renderSettings();

    expect(hook.result.current.settings.chatFontSizePx).toBe(18);
    expect(hook.result.current.settings.confirmThreadDelete).toBe(false);
    await vi.waitFor(() =>
      expect(JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? "{}")).toMatchObject({
        chatFontSizePx: 18,
        confirmThreadDelete: false,
      }),
    );
    expect(JSON.parse(localStorage.getItem(APP_SETTINGS_RECOVERY_STORAGE_KEY) ?? "{}")).toEqual({
      uiDensity: "future-density",
      chatFontSizePx: 18,
      confirmThreadDelete: false,
    });
  });

  it("rejects when the server refuses a settings save", async () => {
    const { hook } = await renderSettings();
    let outcome: Promise<void> | undefined;
    act(() => {
      outcome = hook.result.current.updateSettingsAndWait({ enableAssistantStreaming: false });
    });
    const settled = outcome!.then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await vi.waitFor(() => expect(harness.saves).toHaveLength(1));
    harness.saves[0]!.reject(new Error("settings write failed"));
    await expect(settled).resolves.toBe("settings write failed");
  });

  it("keeps saved provider accounts when restoring default settings", async () => {
    harness.serverView = {
      ...harness.serverView,
      enableAssistantStreaming: !DEFAULT_SERVER_SETTINGS_VIEW.enableAssistantStreaming,
    };
    const { hook } = await renderSettings();
    let reset: Promise<void> | undefined;
    act(() => {
      reset = hook.result.current.resetSettings();
    });
    await vi.waitFor(() => expect(harness.saves).toHaveLength(1));
    const patch = harness.saves[0]!.patch;
    expect(patch).not.toHaveProperty("providerInstances");
    expect(patch.providers?.codex ?? {}).not.toHaveProperty("accounts");
    harness.saves[0]!.resolve();
    await reset;
  });

  it("keeps save order across a Settings close and reopen", async () => {
    const first = await renderSettings();
    act(() => {
      void first.hook.result.current
        .updateSettingsAndWait({ enableAssistantStreaming: false })
        .catch(() => undefined);
    });
    await vi.waitFor(() => expect(harness.saves).toHaveLength(1));
    await first.hook.unmount();

    const second = await renderSettings(first.queryClient);
    let latest: Promise<void> | undefined;
    act(() => {
      latest = second.hook.result.current.updateSettingsAndWait({
        enableAssistantStreaming: true,
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.saves).toHaveLength(1);

    harness.saves[0]!.resolve();
    await vi.waitFor(() => expect(harness.saves).toHaveLength(2));
    expect(harness.saves[1]!.patch).toMatchObject({ enableAssistantStreaming: true });
    harness.saves[1]!.resolve();
    await latest;
  });

  it("keeps an earlier queued account edit when a later edit was built before it saved", async () => {
    const { hook } = await renderSettings();
    const rename = buildProviderInstanceSettingsPatch(hook.result.current.settings, "codex_work", {
      displayName: "Office",
    })!;
    let renamed: Promise<void> | undefined;
    act(() => {
      renamed = hook.result.current.updateSettingsAndWait(rename);
    });
    await vi.waitFor(() => expect(harness.saves).toHaveLength(1));

    const settingsBeforeServerReply = hook.result.current.settings;
    const disable = buildProviderInstanceSettingsPatch(settingsBeforeServerReply, "codex_work", {
      enabled: false,
    })!;
    let disabled: Promise<void> | undefined;
    act(() => {
      disabled = hook.result.current.updateSettingsAndWait(disable);
    });

    harness.saves[0]!.resolve();
    await renamed;
    await vi.waitFor(() => expect(harness.saves).toHaveLength(2));
    expect(harness.saves[1]!.patch.providerInstances?.codex_work).toMatchObject({
      displayName: "Office",
      enabled: false,
    });
    harness.saves[1]!.resolve();
    await disabled;
  });

  it("refuses to replace an account that an earlier queued save added under the same id", async () => {
    const { hook } = await renderSettings();
    const seen = hook.result.current.settings.providerInstances;
    const addAccount = (displayName: string) => ({
      providerInstances: {
        ...seen,
        codex_3: { driver: "codex", displayName, enabled: true },
      } as typeof seen,
    });
    let first: Promise<void> | undefined;
    let second: Promise<string> | undefined;
    act(() => {
      first = hook.result.current.updateSettingsAndWait(addAccount("Imported"));
      second = hook.result.current.updateSettingsAndWait(addAccount("Other")).then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    });
    await vi.waitFor(() => expect(harness.saves).toHaveLength(1));
    harness.saves[0]!.resolve();
    await first;

    await expect(second).resolves.toContain("codex_3");
    expect(harness.saves).toHaveLength(1);
    expect(harness.serverView.providerInstances.codex_3).toMatchObject({
      displayName: "Imported",
    });
  });
});
