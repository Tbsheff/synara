import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PLUGIN_SIDEBAR_PREFERENCES,
  persistPluginSidebarPreferences,
  readPluginSidebarPreferences,
} from "./PluginSidebar.preferences";

describe("PluginSidebar preferences", () => {
  let storage = new Map<string, string>();

  beforeEach(() => {
    storage = new Map<string, string>();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
        },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
  });

  it("defaults both exclusive surfaces to Original", () => {
    expect(readPluginSidebarPreferences()).toEqual(DEFAULT_PLUGIN_SIDEBAR_PREFERENCES);
  });

  it("persists valid provider keys", () => {
    const preferences = {
      navigationProvider: '["@acme/sidebar","nav"]',
      threadListProvider: '["@acme/sidebar","threads"]',
    };

    persistPluginSidebarPreferences(preferences);

    expect(readPluginSidebarPreferences()).toEqual(preferences);
  });

  it("drops malformed stored fields without losing a valid sibling", () => {
    window.localStorage.setItem(
      "synara:plugin-sidebar:v1",
      JSON.stringify({ navigationProvider: 42, threadListProvider: '["@acme/sidebar","threads"]' }),
    );

    expect(readPluginSidebarPreferences()).toEqual({
      navigationProvider: "original",
      threadListProvider: '["@acme/sidebar","threads"]',
    });
  });
});
