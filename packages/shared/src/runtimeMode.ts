import type { ProviderKind, RuntimeMode } from "@synara/contracts";

const AUTO_RUNTIME_MODE_PROVIDERS = new Set<ProviderKind>(["codex", "claudeAgent"]);
const RUNTIME_MODE_PRIVILEGE = {
  "approval-required": 0,
  "accept-edits": 1,
  auto: 2,
  "full-access": 3,
} as const satisfies Record<RuntimeMode, number>;

export function providerSupportsAutoRuntimeMode(provider: ProviderKind): boolean {
  return AUTO_RUNTIME_MODE_PROVIDERS.has(provider);
}

export function providerSupportsAcceptEditsRuntimeMode(provider: ProviderKind): boolean {
  return provider === "claudeAgent";
}

export function unsupportedAcceptEditsRuntimeModeMessage(provider: ProviderKind): string {
  return `Provider "${provider}" does not support Accept edits. Accept edits is available only for Claude Code.`;
}

export function unsupportedAutoRuntimeModeMessage(provider: ProviderKind): string {
  return `Provider "${provider}" does not support Auto runtime mode. Auto is available only for Codex and Claude Code.`;
}

export function runtimeModeSelectionIssue(input: {
  readonly runtimeMode: RuntimeMode;
  readonly modelSelection: {
    readonly provider: ProviderKind;
    readonly model: string;
    readonly supportsAutoMode?: boolean | undefined;
  };
}): string | null {
  if (input.runtimeMode === "accept-edits") {
    return providerSupportsAcceptEditsRuntimeMode(input.modelSelection.provider)
      ? null
      : unsupportedAcceptEditsRuntimeModeMessage(input.modelSelection.provider);
  }
  if (input.runtimeMode !== "auto") {
    return null;
  }
  if (!providerSupportsAutoRuntimeMode(input.modelSelection.provider)) {
    return unsupportedAutoRuntimeModeMessage(input.modelSelection.provider);
  }
  if (
    input.modelSelection.provider === "claudeAgent" &&
    input.modelSelection.supportsAutoMode !== true
  ) {
    // Fail closed on an unknown capability: the Claude adapter refuses to
    // start Auto sessions without a confirmed flag, so persisting Auto here
    // would only defer the failure to runtime.
    return input.modelSelection.supportsAutoMode === false
      ? `Claude model "${input.modelSelection.model}" does not support Auto mode.`
      : `Claude model "${input.modelSelection.model}" has not been verified to support Auto mode.`;
  }
  return null;
}

export function runtimeModeEscalatesPrivilege(
  callerRuntimeMode: RuntimeMode,
  targetRuntimeMode: RuntimeMode,
): boolean {
  return RUNTIME_MODE_PRIVILEGE[targetRuntimeMode] > RUNTIME_MODE_PRIVILEGE[callerRuntimeMode];
}

export function normalizeRuntimeModeForProvider(
  runtimeMode: RuntimeMode,
  provider: ProviderKind,
): RuntimeMode {
  return (runtimeMode === "auto" && !providerSupportsAutoRuntimeMode(provider)) ||
    (runtimeMode === "accept-edits" && !providerSupportsAcceptEditsRuntimeMode(provider))
    ? "approval-required"
    : runtimeMode;
}
