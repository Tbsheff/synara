import "../../index.css";
import { ThreadId, type ProviderMcpAuthState } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ComposerMcpAuth } from "./ComposerMcpAuth";

const api = vi.hoisted(() => ({
  getMcpAuth: vi.fn(),
  authenticateMcp: vi.fn(),
  openExternal: vi.fn(),
}));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({ provider: api, shell: { openExternal: api.openExternal } }),
}));
const threadId = ThreadId.makeUnsafe("auth-thread");
const initial: ProviderMcpAuthState = {
  sessionKey: "attempt-1",
  servers: [{ name: "linear", status: "needs-auth", action: { type: "oauth" } }],
};
async function mount(provider: "codex" | "claudeAgent" = "codex") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={client}>
      <ComposerMcpAuth threadId={threadId} provider={provider} enabled />
    </QueryClientProvider>,
  );
  return { screen, client };
}
afterEach(() => vi.resetAllMocks());

describe("MCP sign-in near the composer", () => {
  it("opens native auth, re-checks status, and clears the indicator after success", async () => {
    api.getMcpAuth.mockResolvedValue(initial);
    api.authenticateMcp.mockResolvedValue({
      state: initial,
      authorizationUrl: "https://login.example/authorize",
    });
    api.openExternal.mockResolvedValue(undefined);
    const { screen, client } = await mount();
    try {
      await page.getByRole("button", { name: "1 MCP server needs sign-in" }).click();
      await page.getByRole("button", { name: "Authenticate linear" }).click();
      expect(api.authenticateMcp).toHaveBeenCalledExactlyOnceWith({
        threadId,
        sessionKey: "attempt-1",
        serverName: "linear",
      });
      expect(api.openExternal).toHaveBeenCalledExactlyOnceWith("https://login.example/authorize");
      api.getMcpAuth.mockResolvedValue({ sessionKey: "attempt-1", servers: [] });
      await page.getByRole("button", { name: "Re-check" }).click();
      await expect
        .element(page.getByRole("button", { name: "1 MCP server needs sign-in" }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
      client.clear();
    }
  });

  it("keeps errors in the list and lets the user retry", async () => {
    api.getMcpAuth.mockResolvedValue(initial);
    api.authenticateMcp.mockRejectedValue(new Error("Consent denied"));
    const { screen, client } = await mount();
    try {
      await page.getByRole("button", { name: "1 MCP server needs sign-in" }).click();
      await page.getByRole("button", { name: "Authenticate linear" }).click();
      await expect.element(page.getByRole("alert")).toHaveTextContent("Consent denied");
      await expect.element(page.getByRole("button", { name: "Authenticate linear" })).toBeEnabled();
      expect(api.openExternal).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      client.clear();
    }
  });

  it("does not open a stale session's OAuth result", async () => {
    api.getMcpAuth.mockResolvedValue(initial);
    let finish!: (value: { state: ProviderMcpAuthState; authorizationUrl: string }) => void;
    api.authenticateMcp.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { screen, client } = await mount();
    try {
      await page.getByRole("button", { name: "1 MCP server needs sign-in" }).click();
      await page.getByRole("button", { name: "Authenticate linear" }).click();
      client.setQueryData(["provider", "mcp-auth", threadId, "codex"], {
        sessionKey: "attempt-2",
        servers: initial.servers,
      });
      finish({ state: initial, authorizationUrl: "https://login.example/old" });
      await expect
        .poll(
          () =>
            client.getQueryData<ProviderMcpAuthState>(["provider", "mcp-auth", threadId, "codex"])
              ?.sessionKey,
        )
        .toBe("attempt-2");
      expect(api.openExternal).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      client.clear();
    }
  });
  it("shows all servers and keeps a native login pending until verified", async () => {
    const multiple: ProviderMcpAuthState = {
      ...initial,
      servers: [
        ...initial.servers,
        { name: "github", status: "needs-auth", action: { type: "oauth" } },
      ],
    };
    api.getMcpAuth.mockResolvedValue(multiple);
    api.authenticateMcp.mockResolvedValue({
      state: {
        ...multiple,
        servers: multiple.servers.map((server) =>
          server.name === "linear" ? { ...server, status: "authenticating" } : server,
        ),
      },
      authorizationUrl: "https://login.example/authorize",
    });
    api.openExternal.mockResolvedValue(undefined);
    const { screen, client } = await mount();
    try {
      await page.getByRole("button", { name: "2 MCP servers need sign-in" }).click();
      await page.getByRole("button", { name: "Authenticate linear" }).click();
      await expect
        .element(page.getByRole("button", { name: "Authenticate github" }))
        .toBeDisabled();
      await expect
        .element(page.getByText("Complete sign-in in your browser.", { exact: false }))
        .toBeVisible();
      await page.getByRole("button", { name: "Open sign-in" }).click();
      expect(api.openExternal).toHaveBeenCalledTimes(2);
      await page.getByRole("dialog").screenshot({ path: "node_modules/.cache/mcp-sign-in.png" });
    } finally {
      await screen.unmount();
      client.clear();
    }
  });

  it("shows Claude's exact manual command and Re-check without launching a browser", async () => {
    const command =
      "cd '/tmp/MCP check' && CLAUDE_CONFIG_DIR='/tmp/provider home' '/opt/Claude CLI'";
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    api.getMcpAuth.mockResolvedValue({
      sessionKey: "claude-attempt",
      servers: [
        {
          name: "linear",
          status: "needs-auth",
          action: {
            type: "manual",
            command,
            instructions: "Enter /mcp, select linear, then Authenticate.",
          },
        },
      ],
    });
    const { screen, client } = await mount("claudeAgent");
    try {
      await page.getByRole("button", { name: "1 MCP server needs sign-in" }).click();
      await expect.element(page.getByText(command, { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Copy command for linear" }).click();
      expect(writeText).toHaveBeenCalledExactlyOnceWith(command);
      await expect
        .element(page.getByText("Enter /mcp, select linear, then Authenticate."))
        .toBeVisible();
      expect(api.authenticateMcp).not.toHaveBeenCalled();
      expect(api.openExternal).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Re-check" }).click();
      expect(api.getMcpAuth).toHaveBeenCalledWith({ threadId, refresh: true });
    } finally {
      await screen.unmount();
      client.clear();
      writeText.mockRestore();
    }
  });
});
