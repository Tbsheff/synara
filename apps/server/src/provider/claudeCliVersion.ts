import { compareSemverVersions } from "./providerMaintenance.ts";

// Auto permission mode required `--enable-auto-mode` (never passed by Synara) before 2.1.111.
export const MINIMUM_CLAUDE_AUTO_MODE_CLI_VERSION = "2.1.111";

export function isClaudeAutoModeCliVersionSupported(version: string | null): boolean {
  return (
    version !== null && compareSemverVersions(version, MINIMUM_CLAUDE_AUTO_MODE_CLI_VERSION) >= 0
  );
}

export const MINIMUM_CLAUDE_THINKING_DISPLAY_CLI_VERSION = "2.1.259";

export function isClaudeThinkingDisplayCliVersionSupported(version: string | null): boolean {
  return (
    version !== null &&
    compareSemverVersions(version, MINIMUM_CLAUDE_THINKING_DISPLAY_CLI_VERSION) >= 0
  );
}
