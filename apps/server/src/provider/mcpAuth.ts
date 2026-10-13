import type { ProviderMcpAuthAction, ProviderMcpAuthState } from "@synara/contracts";
import { quoteExternalMcpShellArgument } from "../externalMcp/shell";
import { sanitizeUnmappedProviderDetail } from "./unmappedProviderEvents";

type AuthServer = ProviderMcpAuthState["servers"][number];
export class McpAuthState {
  private readonly servers = new Map<string, AuthServer>();
  private readonly startedAt = new Map<string, number>();
  version = 0;
  constructor(
    readonly sessionKey: string,
    private readonly action: ProviderMcpAuthAction,
  ) {}

  replace(statuses: ReadonlyArray<{ name: string; needsAuth: boolean }>): void {
    const names = new Set<string>();
    for (const { name, needsAuth } of statuses) {
      if (!name.trim()) continue;
      names.add(name);
      if (!needsAuth) {
        this.succeed(name);
        continue;
      }
      if (!this.servers.has(name)) {
        this.version++;
        this.servers.set(name, { name, status: "needs-auth", action: this.action });
      }
    }
    for (const name of this.servers.keys()) if (!names.has(name)) this.succeed(name);
  }
  needsAuth(name: string): void {
    if (name.trim() && !this.servers.has(name)) {
      this.version++;
      this.servers.set(name, { name, status: "needs-auth", action: this.action });
    }
  }
  begin(name: string): boolean {
    const server = this.servers.get(name);
    if (!server || server.status === "authenticating") return false;
    this.version++;
    this.servers.set(name, { name, status: "authenticating", action: server.action });
    this.startedAt.set(name, Date.now());
    return true;
  }
  fail(name: string, error: string): void {
    const server = this.servers.get(name);
    if (!server) return;
    this.version++;
    this.startedAt.delete(name);
    this.servers.set(name, {
      ...server,
      status: "error",
      error: sanitizeUnmappedProviderDetail(error.slice(0, 2000)) || "MCP sign-in failed.",
    });
  }
  succeed(name: string): void {
    if (this.servers.delete(name)) this.version++;
    this.startedAt.delete(name);
  }
  manual(name: string, action: Extract<ProviderMcpAuthAction, { type: "manual" }>): void {
    const server = this.servers.get(name);
    if (server) {
      this.version++;
      this.servers.set(name, { ...server, action, status: "needs-auth" });
    }
    this.startedAt.delete(name);
  }
  snapshot(): ProviderMcpAuthState {
    for (const [name, startedAt] of this.startedAt) {
      if (Date.now() - startedAt > 130_000) this.fail(name, "MCP sign-in timed out. Try again.");
    }
    return { sessionKey: this.sessionKey, servers: [...this.servers.values()] };
  }
}

export function mcpManualCommand(input: {
  provider: "codex" | "claudeAgent";
  binaryPath?: string | undefined;
  cwd?: string | undefined;
  name?: string;
  environment?: Readonly<NodeJS.ProcessEnv>;
  platform?: NodeJS.Platform;
}): string {
  const windows = (input.platform ?? process.platform) === "win32";
  const quote = windows
    ? (value: string) => `'${value.replaceAll("'", "''")}'`
    : quoteExternalMcpShellArgument;
  const directoryKeys =
    input.provider === "codex"
      ? ["CODEX_HOME"]
      : ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"];
  const environment = directoryKeys.flatMap((key) => {
    const value = input.environment?.[key];
    return value ? [windows ? `$env:${key}=${quote(value)};` : `${key}=${quote(value)}`] : [];
  });
  const args = input.provider === "codex" && input.name ? ` mcp login ${quote(input.name)}` : "";
  const executable = quote(input.binaryPath || (input.provider === "codex" ? "codex" : "claude"));
  const cd = input.cwd
    ? windows
      ? `Set-Location -LiteralPath ${quote(input.cwd)}; `
      : `cd ${quote(input.cwd)} && `
    : "";
  return `${cd}${environment.join(" ")}${environment.length ? " " : ""}${windows ? "& " : ""}${executable}${args}`;
}
