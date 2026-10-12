import type { HtmlRenderTheme } from "@synara/shared/htmlRender";
import { useSyncExternalStore } from "react";

const DEFAULT_THEME: HtmlRenderTheme = {
  appearance: "light",
  variables: {
    "--foreground": "#222",
    "--font-sans": "system-ui, sans-serif",
    "--font-mono": "monospace",
    "--font-size": "1rem",
  },
};
const TOKENS = [
  "background",
  "foreground",
  "muted",
  "muted-foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "secondary",
  "secondary-foreground",
  "border",
  "input",
  "ring",
  "primary",
  "primary-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "warning",
  "warning-foreground",
  "success",
  "success-foreground",
  "info",
  "info-foreground",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "radius",
] as const;
let snapshot = DEFAULT_THEME;
let stale = true;
let observer: MutationObserver | null = null;
const listeners = new Set<() => void>();

function readTheme(): HtmlRenderTheme {
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function")
    return DEFAULT_THEME;
  if (!stale) return snapshot;
  stale = false;
  const root = document.documentElement;
  const style = window.getComputedStyle(root);
  const next: HtmlRenderTheme = {
    appearance: root.classList.contains("dark") ? "dark" : "light",
    variables: {
      ...Object.fromEntries(
        TOKENS.map((token) => [`--${token}`, style.getPropertyValue(`--${token}`).trim()]),
      ),
      "--font-sans":
        style.getPropertyValue("--font-ui-family").trim() ||
        style.fontFamily ||
        "system-ui, sans-serif",
      "--font-mono": style.getPropertyValue("--font-chat-code-family").trim() || "monospace",
      "--font-size": style.getPropertyValue("--app-font-size-ui").trim() || "1rem",
    },
  };
  if (JSON.stringify(next) !== JSON.stringify(snapshot)) snapshot = next;
  return snapshot;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (observer === null) {
    stale = true;
    observer = new MutationObserver(() => {
      stale = true;
      for (const listener of listeners) listener();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = null;
      stale = true;
    }
  };
}

export function useHtmlRenderTheme(): HtmlRenderTheme {
  return useSyncExternalStore(subscribe, readTheme, () => DEFAULT_THEME);
}
