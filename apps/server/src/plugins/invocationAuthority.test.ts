import { describe, expect, it, vi } from "vitest";

import {
  assertPluginThreadStartAuthority,
  assertPluginWriteAuthority,
  runWithPluginInvocationAuthority,
} from "./invocationAuthority";

describe("plugin invocation authority", () => {
  it("allows normal host calls outside an agent-tool invocation", async () => {
    await expect(assertPluginWriteAuthority()).resolves.toBeUndefined();
  });

  it("blocks host writes from a read-only plugin tool", async () => {
    const assertWriteAuthorized = vi.fn(() => Promise.resolve());
    const assertThreadStartAuthorized = vi.fn(() => Promise.resolve());
    await expect(
      runWithPluginInvocationAuthority(
        {
          access: "read",
          signal: new AbortController().signal,
          assertWriteAuthorized,
          assertThreadStartAuthorized,
        },
        async () => {
          await Promise.resolve();
          await assertPluginWriteAuthority();
        },
      ),
    ).rejects.toThrow("read-only");
    expect(assertWriteAuthorized).not.toHaveBeenCalled();
  });

  it("rechecks write authority and cancellation at the host write", async () => {
    const controller = new AbortController();
    const assertWriteAuthorized = vi.fn(async () => controller.abort());
    const assertThreadStartAuthorized = vi.fn(() => Promise.resolve());
    await expect(
      runWithPluginInvocationAuthority(
        {
          access: "write",
          signal: controller.signal,
          assertWriteAuthorized,
          assertThreadStartAuthorized,
        },
        assertPluginWriteAuthority,
      ),
    ).rejects.toThrow();
    expect(assertWriteAuthorized).toHaveBeenCalledOnce();
  });

  it("checks thread-start privilege for agent tool calls", async () => {
    const assertWriteAuthorized = vi.fn(() => Promise.resolve());
    const assertThreadStartAuthorized = vi.fn(() =>
      Promise.reject(new Error("cannot drive higher-privileged threads")),
    );
    await expect(
      runWithPluginInvocationAuthority(
        {
          access: "write",
          signal: new AbortController().signal,
          assertWriteAuthorized,
          assertThreadStartAuthorized,
        },
        assertPluginThreadStartAuthority,
      ),
    ).rejects.toThrow("higher-privileged");
    expect(assertThreadStartAuthorized).toHaveBeenCalledOnce();
  });
});
