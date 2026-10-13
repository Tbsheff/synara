import { describe, expect, it } from "vitest";
import { McpAuthState, mcpManualCommand } from "./mcpAuth";

describe("session-owned MCP auth", () => {
  it("only tracks servers that need auth and clears them on a verified ready status", () => {
    const state = new McpAuthState("attempt-1", { type: "oauth" });
    state.replace([
      { name: "linear", needsAuth: true },
      { name: "docs", needsAuth: false },
    ]);
    expect(state.snapshot().servers).toEqual([
      { name: "linear", status: "needs-auth", action: { type: "oauth" } },
    ]);
    state.replace([{ name: "linear", needsAuth: false }]);
    expect(state.snapshot().servers).toEqual([]);
  });

  it("admits a login once and preserves failure until a verified status or retry", () => {
    const state = new McpAuthState("attempt-1", { type: "oauth" });
    state.replace([{ name: "linear", needsAuth: true }]);
    expect(state.begin("linear")).toBe(true);
    expect(state.begin("linear")).toBe(false);
    state.replace([{ name: "linear", needsAuth: true }]);
    expect(state.snapshot().servers[0]?.status).toBe("authenticating");
    state.fail("linear", "Consent denied");
    state.replace([{ name: "linear", needsAuth: true }]);
    expect(state.snapshot().servers[0]?.error).toBe("Consent denied");
    expect(state.begin("linear")).toBe(true);
    expect(state.snapshot().servers[0]?.error).toBeUndefined();
    expect(state.begin("invented-server")).toBe(false);
  });

  it("does not expose credential fields or secrets in provider errors", () => {
    const state = new McpAuthState("attempt-1", { type: "oauth" });
    state.replace([{ name: "linear", needsAuth: true }]);
    state.fail(
      "linear",
      "OAuth failed: access_token=PRIVATE_ACCESS_SENTINEL refresh_token=PRIVATE_REFRESH_SENTINEL",
    );
    const json = JSON.stringify(state.snapshot());
    expect(json).not.toContain("PRIVATE_ACCESS_SENTINEL");
    expect(json).not.toContain("PRIVATE_REFRESH_SENTINEL");
    expect(json).toContain("OAuth failed");
  });

  it("builds a manual command for the selected account without copying secret environment", () => {
    const command = mcpManualCommand({
      provider: "claudeAgent",
      binaryPath: "/cli/claude",
      cwd: "/project/a b",
      environment: {
        HOME: "/account",
        CLAUDE_CONFIG_DIR: "/account/config",
        ANTHROPIC_AUTH_TOKEN: "PRIVATE_SENTINEL",
      },
      platform: "linux",
    });
    expect(command).toContain("'/project/a b'");
    expect(command).toContain("CLAUDE_CONFIG_DIR='/account/config'");
    expect(command).toContain("'/cli/claude'");
    expect(command).not.toContain("PRIVATE_SENTINEL");
    expect(command).not.toContain("ANTHROPIC_AUTH_TOKEN");
  });

  it("quotes PowerShell paths and server names as data", () => {
    const command = mcpManualCommand({
      provider: "codex",
      cwd: "C:\\repo's",
      name: "linear'; whoami",
      environment: { CODEX_HOME: "C:\\account" },
      platform: "win32",
    });
    expect(command).toContain("Set-Location -LiteralPath 'C:\\repo''s'");
    expect(command).toContain("$env:CODEX_HOME='C:\\account'");
    expect(command).toContain("& 'codex' mcp login 'linear''; whoami'");
  });
});
