import { AsyncLocalStorage } from "node:async_hooks";

import type { PluginAgentToolAccess } from "@synara/plugin-sdk";

export interface PluginAgentToolAuthority {
  readonly signal: AbortSignal;
  readonly assertWriteAuthorized: () => Promise<void>;
  readonly assertThreadStartAuthorized: () => Promise<void>;
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

export function bindPluginInvocationAuthority<Value>(
  run: () => Promise<Value>,
): () => Promise<Value> {
  const authority = invocationAuthority.getStore();
  return authority ? () => invocationAuthority.run(authority, run) : run;
}

export function hasPluginInvocationAuthority(): boolean {
  return invocationAuthority.getStore() !== undefined;
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

export async function assertPluginThreadStartAuthority(): Promise<void> {
  const authority = invocationAuthority.getStore();
  if (!authority) return;
  authority.signal.throwIfAborted();
  await authority.assertThreadStartAuthorized();
  authority.signal.throwIfAborted();
}
