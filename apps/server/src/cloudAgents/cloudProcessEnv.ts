import type { CloudProvider } from "@synara/contracts";

import { CLAUDE_DIRECT_CREDENTIAL_ENV_KEYS } from "../provider/claudeProcessEnv.ts";
import { buildProviderChildEnvironment } from "../providerChildEnvironment.ts";

const CODEX_CLOUD_REMOVED_ENV_KEYS = ["CODEX_STARTING_DIFF"] as const;
const CLAUDE_CLOUD_REMOVED_ENV_KEYS = CLAUDE_DIRECT_CREDENTIAL_ENV_KEYS;

export function buildCloudCliEnvironment(
  provider: CloudProvider,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = buildProviderChildEnvironment({
    provider,
    baseEnv,
    overrides: { NO_COLOR: "1" },
  });
  const removedKeys =
    provider === "codex" ? CODEX_CLOUD_REMOVED_ENV_KEYS : CLAUDE_CLOUD_REMOVED_ENV_KEYS;
  for (const key of removedKeys) {
    delete env[key];
  }
  return env;
}
