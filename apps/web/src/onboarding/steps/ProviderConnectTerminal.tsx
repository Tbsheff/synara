// FILE: ProviderConnectTerminal.tsx
// Purpose: Inline terminal that runs a provider's sign-in command inside the welcome tour.
//          Uses a synthetic thread scope so nothing leaks into real thread terminal state,
//          and disposes every session on unmount.
// Layer: Web UI component

import type { ProviderKind } from "@synara/contracts";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";

import ThreadTerminalDrawer from "~/components/ThreadTerminalDrawer";
import { disposeAndCloseTerminalSession } from "~/components/terminal/terminalSession";
import { useTerminalSurfaceController } from "~/hooks/useTerminalSurfaceController";
import { readNativeApi } from "~/nativeApi";
import { runProjectCommandInTerminal } from "~/projectTerminalRunner";
import { useTerminalStateStore } from "~/terminalStateStore";
import { onboardingTerminalThreadId } from "../onboardingTerminalScope";

export function ProviderConnectTerminal(props: {
  provider: ProviderKind;
  signInCommand: string;
  cwd: string;
}) {
  const scopeId = onboardingTerminalThreadId(props.provider);
  const terminal = useTerminalSurfaceController(scopeId);
  const { terminalState, openTerminalThreadPage } = terminal;
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const terminalIdsRef = useRef(terminalState.terminalIds);
  terminalIdsRef.current = terminalState.terminalIds;

  useEffect(
    () => () => {
      const api = readNativeApi();
      for (const terminalId of terminalIdsRef.current) {
        disposeAndCloseTerminalSession({ api, threadId: scopeId, terminalId });
      }
      clearTerminalState(scopeId);
    },
    [clearTerminalState, scopeId],
  );

  useEffect(() => {
    if (terminalState.terminalOpen) {
      return;
    }
    openTerminalThreadPage(scopeId, { terminalOnly: true });
  }, [openTerminalThreadPage, scopeId, terminalState.terminalOpen]);

  const commandStartedRef = useRef(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [commandAttempt, setCommandAttempt] = useState(0);
  const activeTerminalId = terminalState.activeTerminalId || terminalState.terminalIds[0];
  useEffect(() => {
    if (commandStartedRef.current || !terminalState.terminalOpen || !activeTerminalId) {
      return;
    }
    const api = readNativeApi();
    if (!api || props.cwd.length === 0) {
      return;
    }
    commandStartedRef.current = true;
    void runProjectCommandInTerminal({
      api,
      threadId: scopeId,
      terminalId: activeTerminalId,
      project: { cwd: props.cwd },
      cwd: props.cwd,
      command: props.signInCommand,
    }).catch((error: unknown) => {
      setCommandError(
        error instanceof Error ? error.message : "Could not run the sign-in command.",
      );
    });
  }, [
    activeTerminalId,
    commandAttempt,
    props.cwd,
    props.signInCommand,
    scopeId,
    terminalState.terminalOpen,
  ]);

  return (
    <div className="h-70 overflow-hidden rounded-lg border border-border/70">
      {commandError ? (
        <div role="alert" className="flex items-center gap-2 p-2 text-ui-sm text-warning">
          <span>{commandError}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              commandStartedRef.current = false;
              setCommandError(null);
              setCommandAttempt((attempt) => attempt + 1);
            }}
          >
            Retry
          </Button>
        </div>
      ) : null}
      <ThreadTerminalDrawer
        key={scopeId}
        threadId={scopeId}
        cwd={props.cwd}
        runtimeEnv={{}}
        isVisible
        terminalLabelsById={terminalState.terminalLabelsById}
        terminalTitleOverridesById={terminalState.terminalTitleOverridesById}
        terminalCliKindsById={terminalState.terminalCliKindsById}
        activeTerminalId={terminalState.activeTerminalId}
        focusRequestId={terminal.focusRequestId}
        onTerminalSessionExited={terminal.handleTerminalSessionExited}
        onTerminalMetadataChange={terminal.setTerminalMetadata}
        onTerminalActivityChange={terminal.setTerminalActivity}
      />
    </div>
  );
}
