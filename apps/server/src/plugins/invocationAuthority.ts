import { AsyncLocalStorage } from "node:async_hooks";

import type { PluginAgentToolAccess } from "@synara/plugin-sdk";

export interface PluginAgentToolAuthority {
  readonly signal: AbortSignal;
  readonly assertWriteAuthorized: () => Promise<void>;
}

interface PluginInvocationAuthority extends PluginAgentToolAuthority {
  readonly access: PluginAgentToolAccess;
}

const invocationAuthority = new AsyncLocalStorage<PluginInvocationAuthority>();

export function runWithPluginInvocationAuthority<Value>(
  authority: PluginInvocationAuthority,
  run: () => Promise<Value>,
): Promise<Value> {
  return invocationAuthority.run(authority, run);
}

export async function assertPluginWriteAuthority(): Promise<void> {
  const authority = invocationAuthority.getStore();
  if (!authority) return;
  if (authority.access !== "write") {
    throw new Error("A read-only plugin tool cannot use a write host API.");
  }
  authority.signal.throwIfAborted();
  await authority.assertWriteAuthorized();
  authority.signal.throwIfAborted();
}
