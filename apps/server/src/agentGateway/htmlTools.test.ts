import { HTML_RENDER_MAX_BYTES } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeAgentGatewayHtmlTools } from "./htmlTools";
import { GatewayToolError, type ToolContext } from "./toolRuntime";

vi.mock("../betaFeatureGate.ts", async () => {
  const { isBetaFeatureEnabled } = await import("@synara/shared/betaFeatures");
  return {
    isServerBetaFeatureEnabled: (feature: string) => isBetaFeatureEnabled(feature, "production"),
  };
});

const context: ToolContext = {
  principal: {
    kind: "provider-session",
    sessionKey: "test",
    threadId: "caller",
    provider: "codex",
    turnId: "turn",
  },
  callerThreadId: "caller",
  callerThreadLabel: null,
  callerSessionKey: "test",
  callerProvider: "codex",
  callerCapabilities: new Set(["thread:write"]),
  callerTurnId: "turn",
  assertCallerTurnActive: () => Effect.void,
  jsonRpcRequestId: 1,
};

describe("synara_html_render", () => {
  it("publishes the tool on the Stable server", () => {
    expect(makeAgentGatewayHtmlTools({ append: () => Effect.void })[0]?.definition.name).toBe(
      "synara_html_render",
    );
  });
  it("withholds a disabled tool and refuses a cached handler after the gate closes", async () => {
    const append = vi.fn(() => Effect.void);
    expect(makeAgentGatewayHtmlTools({ append, isEnabled: () => false })).toEqual([]);
    let enabled = true;
    const tool = makeAgentGatewayHtmlTools({ append, isEnabled: () => enabled })[0]!;
    enabled = false;
    const result = await Effect.runPromise(tool.handler({ title: "Page", html: "Hello" }, context));
    expect(result.isError).toBe(true);
    expect(append).not.toHaveBeenCalled();
  });

  it.each(["codex", "claudeAgent"] as const)(
    "publishes only to the %s caller after checking its active turn",
    async (provider) => {
      const append = vi.fn(() => Effect.void);
      const assertActive = vi.fn(() => Effect.void);
      const tool = makeAgentGatewayHtmlTools({ append, isEnabled: () => true })[0]!;
      expect(tool.definition.name).toBe("synara_html_render");
      expect(tool.requiresActiveTurn).toBe(true);
      expect(tool.requiredCapability).toBe("thread:write");
      const caller = { ...context, callerProvider: provider, assertCallerTurnActive: assertActive };
      const result = await Effect.runPromise(
        tool.handler({ title: "Page", html: "<p>Hello</p>", threadId: "other" }, caller),
      );
      expect(result.isError).not.toBe(true);
      expect(assertActive).toHaveBeenCalledOnce();
      expect(append).toHaveBeenCalledWith(
        { title: "Page", html: "<p>Hello</p>", height: 480 },
        caller,
      );
    },
  );

  it("refuses writes after the caller turn ends", async () => {
    const append = vi.fn(() => Effect.void);
    const tool = makeAgentGatewayHtmlTools({ append, isEnabled: () => true })[0]!;
    const result = await Effect.runPromise(
      tool.handler(
        { title: "Page", html: "Hello" },
        {
          ...context,
          assertCallerTurnActive: () =>
            Effect.fail(new GatewayToolError("turn_ended", "Turn ended")),
        },
      ),
    );
    expect(result.isError).toBe(true);
    expect(append).not.toHaveBeenCalled();
  });

  it.each([
    { title: "", html: "x" },
    { title: "x".repeat(201), html: "x" },
    { title: "Page", html: "x".repeat(HTML_RENDER_MAX_BYTES + 1) },
    { title: "Page", html: "é".repeat(HTML_RENDER_MAX_BYTES) },
    { title: "Page", html: "x", height: 2001 },
    { title: "Page", html: "x", height: 79 },
  ])("rejects invalid input before storing HTML", async (args) => {
    const append = vi.fn(() => Effect.void);
    const tool = makeAgentGatewayHtmlTools({ append, isEnabled: () => true })[0]!;
    const result = await Effect.runPromise(tool.handler(args, context));
    expect(result.isError).toBe(true);
    expect(append).not.toHaveBeenCalled();
  });

  it("reports a store failure to the caller", async () => {
    const tool = makeAgentGatewayHtmlTools({
      append: () => Effect.fail(new Error("Store failed")),
      isEnabled: () => true,
    })[0]!;
    const result = await Effect.runPromise(tool.handler({ title: "Page", html: "Hello" }, context));
    expect(result.isError).toBe(true);
  });
});
