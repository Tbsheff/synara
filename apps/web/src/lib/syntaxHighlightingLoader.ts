export const MAX_SYNTAX_HIGHLIGHT_INPUT_CHARS = 250_000;

export type SyntaxHighlightingModule = typeof import("./syntaxHighlighting");

let syntaxHighlightingModulePromise: Promise<SyntaxHighlightingModule> | null = null;

export function loadSyntaxHighlighting(): Promise<SyntaxHighlightingModule> {
  syntaxHighlightingModulePromise ??= import("./syntaxHighlighting");
  return syntaxHighlightingModulePromise;
}
