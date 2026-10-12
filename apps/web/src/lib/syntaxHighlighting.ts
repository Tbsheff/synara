// FILE: syntaxHighlighting.ts
// Purpose: Shared syntax-highlighting cache and Shiki helpers for read-only code surfaces.
// Layer: Web UI utility
// Depends on: @pierre/diffs shared highlighter and diff theme utilities.

import {
  getFiletypeFromFileName,
  getSharedHighlighter,
  type DiffsHighlighter,
  type SupportedLanguages,
} from "@pierre/diffs";

import { basenameOfPath } from "../file-icons";
import { fnv1a32, resolveDiffThemeName, type DiffThemeName } from "./diffRendering";
import { LRUCache } from "./lruCache";

const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;

export const MAX_SYNTAX_HIGHLIGHT_INPUT_CHARS = 250_000;

const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);
const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();
const failedSyntaxLanguages = new Set<string>();

export function getSyntaxLanguageForPath(pathValue: string): string {
  return getFiletypeFromFileName(basenameOfPath(pathValue));
}

export function createSyntaxHighlightCacheKey(
  code: string,
  language: string,
  themeName: DiffThemeName,
): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

export function getCachedSyntaxHighlightedHtml(cacheKey: string): string | null {
  return highlightedCodeCache.get(cacheKey);
}

export function cacheSyntaxHighlightedHtml(
  cacheKey: string,
  highlightedHtml: string,
  code: string,
) {
  highlightedCodeCache.set(
    cacheKey,
    highlightedHtml,
    estimateHighlightedSize(highlightedHtml, code),
  );
}

export function getSyntaxHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  }).catch((err) => {
    if (language === "text") {
      highlighterPromiseCache.delete(language);
      throw err;
    }
    failedSyntaxLanguages.add(language);
    return getSyntaxHighlighterPromise("text");
  });
  highlighterPromiseCache.set(language, promise);
  return promise;
}

export function highlightCodeToHtmlWithFallback(
  highlighter: DiffsHighlighter,
  code: string,
  language: string,
  themeName: DiffThemeName,
): string {
  if (failedSyntaxLanguages.has(language)) {
    return highlighter.codeToHtml(code, { lang: "text", theme: themeName });
  }
  try {
    return highlighter.codeToHtml(code, { lang: language, theme: themeName });
  } catch (error) {
    failedSyntaxLanguages.add(language);
    console.warn(
      `Code highlighting failed for language "${language}", falling back to plain text.`,
      error instanceof Error ? error.message : error,
    );
    return highlighter.codeToHtml(code, { lang: "text", theme: themeName });
  }
}

function escapeHtmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function appendPlainTextToHighlightedHtml(html: string, plainText: string): string {
  if (plainText.length === 0) return html;
  const insertAt = html.lastIndexOf("</code>");
  if (insertAt === -1) return html;
  return `${html.slice(0, insertAt)}${escapeHtmlText(plainText)}${html.slice(insertAt)}`;
}
