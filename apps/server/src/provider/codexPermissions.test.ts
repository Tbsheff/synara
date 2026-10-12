import { describe, expect, it } from "vitest";
import { parseCodexPermissionsSnapshot } from "./codexPermissions";

describe("Codex permission snapshot", () => {
  it("shows loaded policy sources and managed limits without copying secret config", () => {
    const snapshot = parseCodexPermissionsSnapshot(
      {
        config: {
          approval_policy: "on-request",
          sandbox_mode: "workspace-write",
          sandbox_workspace_write: { network_access: false, writable_roots: ["/work"] },
          developer_instructions: "private prompt",
          api_key: "private key",
        },
        origins: {
          approval_policy: { name: { type: "sessionFlags" } },
          sandbox_mode: { name: { type: "user", file: "/account/config.toml" } },
        },
        layers: [
          {
            name: { type: "user", file: "/account/config.toml" },
            config: { api_key: "private key" },
          },
        ],
      },
      {
        requirements: {
          allowedApprovalPolicies: ["onRequest"],
          allowedSandboxModes: ["workspaceWrite"],
          network: { enabled: true, managedAllowedDomainsOnly: true },
        },
      },
    );
    expect(snapshot.rows).toContainEqual({
      key: "approval_policy",
      label: "Approval policy",
      value: "on-request",
      source: "Session flags",
      managed: false,
    });
    expect(snapshot.rows).toContainEqual({
      key: "network_access",
      label: "Workspace network access",
      value: "Disabled",
      source: "Provider default",
      managed: false,
    });
    expect(snapshot.rows).toContainEqual({
      key: "allowedSandboxModes",
      label: "Allowed filesystem modes",
      value: "workspaceWrite",
      source: "Administrator requirements",
      managed: true,
    });
    expect(snapshot.configPath).toBe("/account/config.toml");
    expect(JSON.stringify(snapshot)).not.toContain("private");
  });
  it("marks unreadable requirements as unknown and does not treat missing policy as full access", () => {
    const snapshot = parseCodexPermissionsSnapshot({ config: {}, origins: {} }, undefined);
    expect(snapshot.requirementsRead).toBe(false);
    expect(snapshot.rows.find((row) => row.key === "sandbox_mode")?.value).toBe("Not reported");
  });
});

it("does not mutate native policy data or publish an unlisted policy source", () => {
  const config = {
    config: { sandbox_mode: "read-only" },
    origins: { sandbox_mode: { name: { type: "__proto__" } } },
  };
  const requirements = {
    requirements: { network: { domains: {}, allowedDomains: ["example.com"] } },
  };
  const result = parseCodexPermissionsSnapshot(config, requirements);
  expect(requirements.requirements.network.domains).toEqual({});
  expect(result.rows.find((row) => row.key === "sandbox_mode")?.source).toBe("Provider default");
  expect(result.rows.find((row) => row.key === "network.domain.example.com")?.value).toBe(
    "Allowed",
  );
  expect(parseCodexPermissionsSnapshot(config, {}).requirementsRead).toBe(false);
});
