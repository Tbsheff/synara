// FILE: windowMaterial.ts
// Purpose: Applies the renderer's window material on macOS: native vibrancy for the opaque
//          shell, or an adjustable desktop blur (native/window-material addon) when translucent.
// Layer: Desktop main process

import {
  DESKTOP_WINDOW_BLUR_RADIUS_MAX,
  DESKTOP_WINDOW_BLUR_RADIUS_MIN,
  type DesktopWindowMaterial,
} from "@synara/contracts";
import type { BrowserWindow } from "electron";

export const MAC_WINDOW_VIBRANCY = "under-window";

export interface WindowMaterialAddon {
  setBackgroundBlurRadius: (nativeWindowHandle: Buffer, radius: number) => boolean;
}

type MaterialWindow = Pick<BrowserWindow, "getNativeWindowHandle" | "setVibrancy">;

export function parseDesktopWindowMaterial(raw: unknown): DesktopWindowMaterial | null {
  if (!raw || typeof raw !== "object") return null;
  const { material, blurRadius } = raw as Record<string, unknown>;
  if (material !== "opaque" && material !== "translucent") return null;
  if (typeof blurRadius !== "number" || !Number.isFinite(blurRadius)) return null;
  const min = material === "translucent" ? DESKTOP_WINDOW_BLUR_RADIUS_MIN : 0;
  return {
    material,
    blurRadius: Math.round(Math.min(DESKTOP_WINDOW_BLUR_RADIUS_MAX, Math.max(min, blurRadius))),
  };
}

interface WindowMaterialState {
  input: DesktopWindowMaterial | null;
  active: boolean;
}

type ActivityWindow = MaterialWindow & Pick<BrowserWindow, "isFocused" | "on">;

export interface WindowMaterialController {
  apply: (window: MaterialWindow, input: DesktopWindowMaterial) => boolean;
  setActive: (window: MaterialWindow, active: boolean) => void;
}

/**
 * Applies the renderer's material and reports whether the adjustable blur took effect. The
 * addon is loaded on first translucent use; when it is missing or the private call is refused,
 * the window keeps plain vibrancy, which still reads as frosted glass. An inactive window
 * (unfocused, hidden, or minimized) drops the custom blur for `followWindow` vibrancy, which
 * macOS renders as a static inactive material instead of re-blurring the desktop behind it.
 */
export function createWindowMaterialController(
  loadAddon: () => WindowMaterialAddon | null,
): WindowMaterialController {
  let addon: WindowMaterialAddon | null | undefined;
  const states = new WeakMap<MaterialWindow, WindowMaterialState>();

  const stateOf = (window: MaterialWindow): WindowMaterialState => {
    let state = states.get(window);
    if (!state) {
      state = { input: null, active: true };
      states.set(window, state);
    }
    return state;
  };

  const paint = (window: MaterialWindow, state: WindowMaterialState): boolean => {
    const input = state.input;
    if (!input) return true;
    if (input.material === "opaque") {
      window.setVibrancy(MAC_WINDOW_VIBRANCY);
      addon?.setBackgroundBlurRadius(window.getNativeWindowHandle(), 0);
      return true;
    }
    if (addon === undefined) addon = loadAddon();
    if (addon && !state.active) {
      window.setVibrancy(MAC_WINDOW_VIBRANCY);
      return addon.setBackgroundBlurRadius(window.getNativeWindowHandle(), 0);
    }
    if (addon) {
      window.setVibrancy(null);
      if (addon.setBackgroundBlurRadius(window.getNativeWindowHandle(), input.blurRadius)) {
        return true;
      }
    }
    window.setVibrancy(MAC_WINDOW_VIBRANCY);
    return false;
  };

  return {
    apply: (window, input) => {
      const state = stateOf(window);
      state.input = input;
      return paint(window, state);
    },
    setActive: (window, active) => {
      const state = stateOf(window);
      if (state.active === active) return;
      state.active = active;
      if (state.input?.material === "translucent") paint(window, state);
    },
  };
}

export function bindWindowMaterialActivity(
  window: ActivityWindow,
  controller: WindowMaterialController,
): void {
  const deactivate = () => controller.setActive(window, false);
  const activateIfFocused = () => controller.setActive(window, window.isFocused());
  controller.setActive(window, window.isFocused());
  window.on("focus", () => controller.setActive(window, true));
  window.on("blur", deactivate);
  window.on("hide", deactivate);
  window.on("minimize", deactivate);
  window.on("show", activateIfFocused);
  window.on("restore", activateIfFocused);
}
