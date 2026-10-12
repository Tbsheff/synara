import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  MAC_WINDOW_VIBRANCY,
  bindWindowMaterialActivity,
  createWindowMaterialController,
  parseDesktopWindowMaterial,
} from "./windowMaterial";

function fakeWindow() {
  const handle = Buffer.alloc(8);
  return {
    handle,
    getNativeWindowHandle: vi.fn(() => handle),
    setVibrancy: vi.fn(),
  };
}

describe("parseDesktopWindowMaterial", () => {
  it("clamps and rounds the blur radius", () => {
    expect(parseDesktopWindowMaterial({ material: "translucent", blurRadius: 999 })).toEqual({
      material: "translucent",
      blurRadius: 64,
    });
    // An unblurred clear window is see-through, so translucent never drops below the floor.
    expect(parseDesktopWindowMaterial({ material: "translucent", blurRadius: -4.6 })).toEqual({
      material: "translucent",
      blurRadius: 1,
    });
    expect(parseDesktopWindowMaterial({ material: "opaque", blurRadius: 0 })).toEqual({
      material: "opaque",
      blurRadius: 0,
    });
  });

  it("rejects malformed input", () => {
    expect(parseDesktopWindowMaterial(null)).toBeNull();
    expect(parseDesktopWindowMaterial({ material: "glass", blurRadius: 4 })).toBeNull();
    expect(parseDesktopWindowMaterial({ material: "opaque", blurRadius: Number.NaN })).toBeNull();
  });
});

describe("createWindowMaterialController", () => {
  it("drops vibrancy and sets the blur radius when translucent", () => {
    const addon = { setBackgroundBlurRadius: vi.fn(() => true) };
    const { apply } = createWindowMaterialController(() => addon);
    const window = fakeWindow();

    expect(apply(window, { material: "translucent", blurRadius: 0 })).toBe(true);
    expect(window.setVibrancy).toHaveBeenLastCalledWith(null);
    expect(addon.setBackgroundBlurRadius).toHaveBeenLastCalledWith(window.handle, 0);

    expect(apply(window, { material: "opaque", blurRadius: 30 })).toBe(true);
    expect(window.setVibrancy).toHaveBeenLastCalledWith(MAC_WINDOW_VIBRANCY);
    expect(addon.setBackgroundBlurRadius).toHaveBeenLastCalledWith(window.handle, 0);
  });

  it("keeps vibrancy and loads the addon once when it is unavailable", () => {
    const loadAddon = vi.fn(() => null);
    const { apply } = createWindowMaterialController(loadAddon);
    const window = fakeWindow();

    expect(apply(window, { material: "translucent", blurRadius: 20 })).toBe(false);
    expect(apply(window, { material: "translucent", blurRadius: 10 })).toBe(false);
    expect(loadAddon).toHaveBeenCalledTimes(1);
    expect(window.setVibrancy).not.toHaveBeenCalledWith(null);
  });

  it("restores vibrancy when the window server refuses the blur", () => {
    const { apply } = createWindowMaterialController(() => ({
      setBackgroundBlurRadius: () => false,
    }));
    const window = fakeWindow();

    expect(apply(window, { material: "translucent", blurRadius: 20 })).toBe(false);
    expect(window.setVibrancy).toHaveBeenLastCalledWith(MAC_WINDOW_VIBRANCY);
  });
});

function fakeActivityWindow(focused: boolean) {
  const emitter = new EventEmitter();
  const window = Object.assign(fakeWindow(), {
    focused,
    isFocused: () => window.focused,
    on: (event: string, listener: () => void) => {
      emitter.on(event, listener);
      return window;
    },
    emit: (event: string) => {
      if (event === "focus") window.focused = true;
      if (event === "blur") window.focused = false;
      emitter.emit(event);
    },
  });
  return window;
}

describe("bindWindowMaterialActivity", () => {
  function setup(focused: boolean) {
    const addon = { setBackgroundBlurRadius: vi.fn(() => true) };
    const controller = createWindowMaterialController(() => addon);
    const window = fakeActivityWindow(focused);
    bindWindowMaterialActivity(window as never, controller);
    return { addon, controller, window };
  }

  function expectBlurRadius(
    addon: { setBackgroundBlurRadius: ReturnType<typeof vi.fn> },
    window: ReturnType<typeof fakeActivityWindow>,
    radius: number,
  ) {
    expect(addon.setBackgroundBlurRadius).toHaveBeenLastCalledWith(window.handle, radius);
    expect(window.setVibrancy).toHaveBeenLastCalledWith(radius === 0 ? MAC_WINDOW_VIBRANCY : null);
  }

  it("drops the custom blur while inactive and restores the chosen radius on focus", () => {
    const { addon, controller, window } = setup(true);
    expect(controller.apply(window, { material: "translucent", blurRadius: 24 })).toBe(true);
    expectBlurRadius(addon, window, 24);

    for (const [leave, back] of [
      ["blur", "focus"],
      ["minimize", "focus"],
      ["hide", "focus"],
    ] as const) {
      window.emit(leave);
      expectBlurRadius(addon, window, 0);
      window.emit(back);
      expectBlurRadius(addon, window, 24);
    }
  });

  it("restores the blur on show or restore only when the window has focus", () => {
    const { addon, controller, window } = setup(true);
    controller.apply(window, { material: "translucent", blurRadius: 24 });

    window.emit("minimize");
    window.focused = false;
    window.emit("restore");
    expectBlurRadius(addon, window, 0);
    window.focused = true;
    window.emit("show");
    expectBlurRadius(addon, window, 24);
  });

  it("keeps a material chosen while inactive and applies it on focus", () => {
    const { addon, controller, window } = setup(false);

    expect(controller.apply(window, { material: "translucent", blurRadius: 12 })).toBe(true);
    expectBlurRadius(addon, window, 0);
    expect(controller.apply(window, { material: "translucent", blurRadius: 30 })).toBe(true);
    expectBlurRadius(addon, window, 0);

    window.emit("focus");
    expectBlurRadius(addon, window, 30);
  });

  it("leaves an opaque window alone on focus changes", () => {
    const { addon, controller, window } = setup(true);
    controller.apply(window, { material: "opaque", blurRadius: 0 });
    const vibrancyCalls = window.setVibrancy.mock.calls.length;

    window.emit("blur");
    window.emit("focus");

    expect(window.setVibrancy).toHaveBeenCalledTimes(vibrancyCalls);
    expect(addon.setBackgroundBlurRadius).not.toHaveBeenCalled();
  });

  it("keeps vibrancy through focus changes when the addon is unavailable", () => {
    const loadAddon = vi.fn(() => null);
    const controller = createWindowMaterialController(loadAddon);
    const window = fakeActivityWindow(true);
    bindWindowMaterialActivity(window as never, controller);

    expect(controller.apply(window, { material: "translucent", blurRadius: 20 })).toBe(false);
    window.emit("blur");
    window.emit("focus");

    expect(loadAddon).toHaveBeenCalledTimes(1);
    expect(window.setVibrancy).not.toHaveBeenCalledWith(null);
  });
});
