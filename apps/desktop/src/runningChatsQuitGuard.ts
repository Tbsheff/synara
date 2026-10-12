// FILE: runningChatsQuitGuard.ts
// Purpose: Coordinates the renderer Stay/Quit handshake before a user-initiated desktop quit.
// Layer: Desktop quit policy
// Depends on: Quit confirmation IPC payloads from the renderer.

import type {
  DesktopQuitConfirmationChat,
  DesktopQuitConfirmationPresentation,
  DesktopQuitConfirmationRequest,
  DesktopQuitConfirmationResponse,
} from "@synara/contracts";

const DEFAULT_READY_TIMEOUT_MS = 3000;

export function shouldPromptForRunningChatsBeforeQuit(reason: string): boolean {
  return reason === "window-close" || reason === "before-quit";
}

export function quitConfirmationPresentationForPlatform(): DesktopQuitConfirmationPresentation {
  return "in-app";
}

export function parseQuitConfirmationRequest(
  payload: unknown,
): DesktopQuitConfirmationRequest | null {
  if (payload == null || typeof payload !== "object") {
    return null;
  }
  const requestId = (payload as { readonly requestId?: unknown }).requestId;
  if (typeof requestId !== "string" || requestId.trim().length === 0) {
    return null;
  }
  const presentationRaw = (payload as { readonly presentation?: unknown }).presentation;
  return {
    requestId,
    presentation: presentationRaw === "native" ? "native" : "in-app",
  };
}

function parseQuitConfirmationChats(value: unknown): DesktopQuitConfirmationChat[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const chats: DesktopQuitConfirmationChat[] = [];
  for (const item of value) {
    if (item == null || typeof item !== "object") {
      continue;
    }
    const id = (item as { readonly id?: unknown }).id;
    const title = (item as { readonly title?: unknown }).title;
    if (typeof id !== "string" || id.trim().length === 0) {
      continue;
    }
    chats.push({
      id,
      title: typeof title === "string" ? title : "",
    });
  }
  return chats;
}

export function parseQuitConfirmationResponse(
  payload: unknown,
): DesktopQuitConfirmationResponse | null {
  if (payload == null || typeof payload !== "object") {
    return null;
  }
  const record = payload as {
    readonly requestId?: unknown;
    readonly phase?: unknown;
    readonly runningCount?: unknown;
    readonly chats?: unknown;
    readonly allow?: unknown;
  };
  if (typeof record.requestId !== "string" || record.requestId.trim().length === 0) {
    return null;
  }
  if (record.phase === "ready") {
    if (typeof record.runningCount !== "number" || !Number.isFinite(record.runningCount)) {
      return null;
    }
    return {
      requestId: record.requestId,
      phase: "ready",
      runningCount: record.runningCount,
      chats: parseQuitConfirmationChats(record.chats),
    };
  }
  if (record.phase === "decision" && typeof record.allow === "boolean") {
    return {
      requestId: record.requestId,
      phase: "decision",
      allow: record.allow,
    };
  }
  return null;
}

export interface RunningChatsQuitGuard {
  readonly hasAllowedQuit: () => boolean;
  readonly hasPendingAsk: () => boolean;
  readonly cancelPending: () => void;
  /**
   * Resolve the pending ask as allowed WITHOUT latching `allowed` — a dead
   * renderer proved the ask can never be answered, not that the user said
   * yes, so a later quit must still get to ask.
   */
  readonly allowPending: () => void;
  readonly receiveResponse: (payload: unknown) => void;
  readonly askRenderer: (input: {
    readonly send: (request: DesktopQuitConfirmationRequest) => void;
    readonly isRendererAvailable: () => boolean;
    readonly readyTimeoutMs?: number;
    readonly presentation?: DesktopQuitConfirmationPresentation;
    readonly presentNativeConfirmation?: (
      chats: ReadonlyArray<DesktopQuitConfirmationChat>,
    ) => boolean | Promise<boolean>;
    readonly confirmWithoutRenderer?: () => Promise<boolean>;
  }) => Promise<boolean>;
}

interface PendingQuitConfirmation {
  readonly requestId: string;
  readonly presentation: DesktopQuitConfirmationPresentation;
  readonly presentNativeConfirmation:
    | ((chats: ReadonlyArray<DesktopQuitConfirmationChat>) => boolean | Promise<boolean>)
    | undefined;
  readonly confirmWithoutRenderer: (() => Promise<boolean>) | undefined;
  waitingForDecision: boolean;
  confirmingWithoutRenderer: boolean;
  readyTimer: ReturnType<typeof setTimeout> | null;
  readonly resolve: (allow: boolean) => void;
}

export function makeRunningChatsQuitGuard(
  createRequestId: () => string = () => crypto.randomUUID(),
): RunningChatsQuitGuard {
  let allowed = false;
  let inFlight: Promise<boolean> | null = null;
  let pending: PendingQuitConfirmation | null = null;

  const finish = (allow: boolean): void => {
    const current = pending;
    pending = null;
    if (current?.readyTimer) {
      clearTimeout(current.readyTimer);
    }
    if (allow) {
      allowed = true;
    }
    current?.resolve(allow);
  };

  const settleFromNativeDialog = (
    current: PendingQuitConfirmation,
    ask: () => boolean | Promise<boolean>,
  ): void => {
    const requestId = current.requestId;
    void Promise.resolve()
      .then(ask)
      .then(
        (allow) => {
          if (pending?.requestId === requestId) {
            finish(allow);
          }
        },
        () => {
          if (pending?.requestId === requestId) {
            finish(false);
          }
        },
      );
  };

  const confirmPendingWithoutRenderer = (current: PendingQuitConfirmation): void => {
    if (current.readyTimer) {
      clearTimeout(current.readyTimer);
      current.readyTimer = null;
    }
    current.waitingForDecision = true;
    current.confirmingWithoutRenderer = true;
    const confirm = current.confirmWithoutRenderer;
    if (!confirm) {
      finish(false);
      return;
    }
    settleFromNativeDialog(current, confirm);
  };

  const presentNativeSheet = (
    current: PendingQuitConfirmation,
    chats: ReadonlyArray<DesktopQuitConfirmationChat>,
  ): void => {
    const presenter = current.presentNativeConfirmation;
    if (!presenter) {
      confirmPendingWithoutRenderer(current);
      return;
    }
    settleFromNativeDialog(current, () => presenter(chats));
  };

  return {
    hasAllowedQuit: () => allowed,
    hasPendingAsk: () => pending !== null,
    cancelPending(): void {
      finish(false);
    },
    allowPending(): void {
      const current = pending;
      pending = null;
      if (current?.readyTimer) {
        clearTimeout(current.readyTimer);
      }
      current?.resolve(true);
    },
    receiveResponse(payload: unknown): void {
      const response = parseQuitConfirmationResponse(payload);
      if (!response || pending == null || response.requestId !== pending.requestId) {
        return;
      }
      if (response.phase === "decision") {
        finish(response.allow);
        return;
      }
      if (pending.confirmingWithoutRenderer) {
        return;
      }
      if (pending.readyTimer) {
        clearTimeout(pending.readyTimer);
        pending.readyTimer = null;
      }
      if (response.runningCount <= 0 && pending.presentation === "native") {
        finish(true);
        return;
      }
      pending.waitingForDecision = true;
      if (pending.presentation === "native") {
        presentNativeSheet(pending, response.chats);
      }
    },
    askRenderer(input): Promise<boolean> {
      if (allowed) {
        return Promise.resolve(true);
      }
      if (inFlight) {
        return inFlight;
      }
      if (!input.isRendererAvailable()) {
        const confirm = input.confirmWithoutRenderer;
        if (!confirm) {
          return Promise.resolve(false);
        }
        return Promise.resolve()
          .then(confirm)
          .then(
            (allow) => {
              if (allow) {
                allowed = true;
              }
              return allow;
            },
            () => false,
          );
      }

      inFlight = new Promise<boolean>((resolve) => {
        const requestId = createRequestId();
        const presentation = input.presentation ?? "in-app";
        pending = {
          requestId,
          presentation,
          presentNativeConfirmation: input.presentNativeConfirmation,
          confirmWithoutRenderer: input.confirmWithoutRenderer,
          waitingForDecision: false,
          confirmingWithoutRenderer: false,
          readyTimer: setTimeout(() => {
            if (pending?.requestId === requestId && !pending.waitingForDecision) {
              confirmPendingWithoutRenderer(pending);
            }
          }, input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS),
          resolve: (allow) => {
            inFlight = null;
            resolve(allow);
          },
        };
        try {
          input.send({ requestId, presentation });
        } catch {
          if (pending?.requestId === requestId) {
            confirmPendingWithoutRenderer(pending);
          }
        }
      });
      return inFlight;
    },
  };
}
