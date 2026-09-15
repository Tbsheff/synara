import { describe, expect, it, vi } from "vitest";

import { definePluginApp, isSynaraPluginAppDefinition } from "./app";

describe("definePluginApp", () => {
  it("returns an inert branded definition", () => {
    const setup = vi.fn();

    const definition = definePluginApp(setup);

    expect(setup).not.toHaveBeenCalled();
    expect(definition).toEqual({ __synaraPluginApp: true, setup });
    expect(isSynaraPluginAppDefinition(definition)).toBe(true);
    expect(isSynaraPluginAppDefinition(setup)).toBe(false);
  });
});
