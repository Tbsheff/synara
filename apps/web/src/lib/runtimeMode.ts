import type {
  ProviderKind,
  ProviderModelDescriptor,
  RuntimeMode,
  ServerProviderStatus,
} from "@synara/contracts";
import {
  normalizeRuntimeModeForProvider,
  providerSupportsAutoRuntimeMode,
  providerSupportsAcceptEditsRuntimeMode,
} from "@synara/shared/runtimeMode";

export {
  normalizeRuntimeModeForProvider,
  providerSupportsAutoRuntimeMode,
  providerSupportsAcceptEditsRuntimeMode,
};

export function providerModelSupportsAutoRuntimeMode(
  provider: ProviderKind,
  runtimeModel?: ProviderModelDescriptor,
  providerStatus?: ServerProviderStatus | null,
): boolean {
  if (!providerSupportsAutoRuntimeMode(provider)) {
    return false;
  }
  return (
    providerStatus?.supportsAutoRuntimeMode === true &&
    (provider !== "claudeAgent" || runtimeModel?.supportsAutoMode === true)
  );
}

export const RUNTIME_MODE_PRESENTATION: Record<
  RuntimeMode,
  { readonly label: string; readonly description: string }
> = {
  "approval-required": {
    label: "Ask for approval",
    description: "Always ask to edit external files and use the internet",
  },
  "accept-edits": {
    label: "Accept edits",
    description: "Auto-approve file edits and routine file commands; ask for other commands",
  },
  auto: {
    label: "Approve for me",
    description: "Only ask for actions detected as potentially unsafe",
  },
  "full-access": {
    label: "Full access",
    description: "Unrestricted access to the internet and any file on your computer",
  },
};

export function providerSupportsPlanMode(provider: ProviderKind): boolean {
  return provider !== "pi" && provider !== "antigravity";
}

export const providerSupportsApprovalRequiredMode = providerSupportsPlanMode;
