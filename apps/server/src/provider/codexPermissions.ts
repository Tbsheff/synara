import path from "node:path";
import type { ProviderPermissionsResult } from "@synara/contracts";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const POLICY_VALUES = new Set([
  "never",
  "on-request",
  "on-failure",
  "untrusted",
  "onRequest",
  "onFailure",
  "unlessTrusted",
  "read-only",
  "workspace-write",
  "danger-full-access",
  "external-sandbox",
  "readOnly",
  "workspaceWrite",
  "dangerFullAccess",
  "externalSandbox",
]);

function policy(value: unknown): string {
  if (typeof value === "string" && POLICY_VALUES.has(value)) return value;
  const granular = record(record(value).granular);
  const enabled = [
    "sandbox_approval",
    "rules",
    "mcp_elicitations",
    "request_permissions",
    "skill_approval",
  ].filter((key) => granular[key] === true);
  return enabled.length ? `Granular: ${enabled.join(", ")}` : "Not reported";
}

export function parseCodexPermissionsSnapshot(
  configResponse: unknown,
  requirementsResponse: unknown,
): ProviderPermissionsResult {
  const response = record(configResponse);
  const config = record(response.config);
  const origins = record(response.origins);
  const sourceNames: Record<string, string> = {
    packagedDefaults: "Provider default",
    user: "User configuration",
    project: "Project configuration",
    sessionFlags: "Session flags",
    system: "System configuration",
    mdm: "Administrator policy",
    enterpriseManaged: "Administrator policy",
    legacyManagedConfigTomlFromFile: "Administrator policy",
    legacyManagedConfigTomlFromMdm: "Administrator policy",
  };
  const rows: ProviderPermissionsResult["rows"][number][] = [];
  const add = (key: string, label: string, value: string, originKey = key) => {
    const sourceType = record(record(origins[originKey]).name).type;
    const source =
      typeof sourceType === "string" && Object.hasOwn(sourceNames, sourceType)
        ? (sourceNames[sourceType] ?? "Provider configuration")
        : "Provider default";
    rows.push({
      key,
      label,
      value,
      source,
      managed: source === "Administrator policy" || source === "System configuration",
    });
  };
  add("approval_policy", "Approval policy", policy(config.approval_policy));
  add("sandbox_mode", "Filesystem mode", policy(config.sandbox_mode));
  const workspace = record(config.sandbox_workspace_write);
  add(
    "network_access",
    "Workspace network access",
    typeof workspace.network_access === "boolean"
      ? workspace.network_access
        ? "Enabled"
        : "Disabled"
      : "Not reported",
    "sandbox_workspace_write.network_access",
  );
  if (Array.isArray(workspace.writable_roots)) {
    const roots = workspace.writable_roots.filter(
      (value): value is string =>
        typeof value === "string" && value.length > 0 && value.length <= 1_024,
    );
    add(
      "writable_roots",
      "Extra writable roots",
      String(roots.length),
      "sandbox_workspace_write.writable_roots",
    );
    for (const [index, root] of roots.slice(0, 32).entries())
      add(
        `writable_root.${index}`,
        "Writable root",
        root,
        "sandbox_workspace_write.writable_roots",
      );
  }
  const requirements = record(record(requirementsResponse).requirements);
  for (const [key, label] of [
    ["allowedApprovalPolicies", "Allowed approval policies"],
    ["allowedSandboxModes", "Allowed filesystem modes"],
  ] as const) {
    const values = requirements[key];
    if (Array.isArray(values)) {
      const allowed = values.filter(
        (value): value is string => typeof value === "string" && POLICY_VALUES.has(value),
      );
      rows.push({
        key,
        label,
        value:
          values.length === 0
            ? "None"
            : allowed.length === values.length
              ? allowed.join(", ")
              : "Includes an unsupported policy",
        source: "Administrator requirements",
        managed: true,
      });
    }
  }
  const network = record(requirements.network);
  for (const [key, label] of [
    ["enabled", "Managed network proxy"],
    ["managedAllowedDomainsOnly", "Managed domains only"],
    ["allowLocalBinding", "Local network listeners"],
  ] as const) {
    if (typeof network[key] === "boolean")
      rows.push({
        key: `network.${key}`,
        label,
        value: network[key] ? "Enabled" : "Disabled",
        source: "Administrator requirements",
        managed: true,
      });
  }
  const domains = { ...record(network.domains) };
  for (const [list, action] of [
    [network.allowedDomains, "allow"],
    [network.deniedDomains, "deny"],
  ] as const) {
    if (Array.isArray(list))
      for (const domain of list)
        if (typeof domain === "string" && !Object.hasOwn(domains, domain)) domains[domain] = action;
  }
  const domainEntries = Object.entries(domains).filter(
    ([domain, action]) =>
      domain.length <= 253 &&
      /^[a-zA-Z0-9.*:-]+$/.test(domain) &&
      (action === "allow" || action === "deny"),
  );
  for (const [domain, action] of domainEntries.slice(0, 64))
    rows.push({
      key: `network.domain.${domain}`,
      label: domain,
      value: action === "allow" ? "Allowed" : "Denied",
      source: "Administrator network requirements",
      managed: true,
    });
  if (domainEntries.length > 64)
    rows.push({
      key: "network.moreDomains",
      label: "More managed domains",
      value: String(domainEntries.length - 64),
      source: "Administrator network requirements",
      managed: true,
    });
  const userLayer = Array.isArray(response.layers)
    ? response.layers.find((layer) => record(record(layer).name).type === "user")
    : undefined;
  const file = record(record(userLayer).name).file;
  const configPath =
    typeof file === "string" &&
    (path.isAbsolute(file) || path.win32.isAbsolute(file)) &&
    /[\\/]config\.toml$/.test(file)
      ? file
      : null;
  return {
    supported: true,
    configPath,
    requirementsRead:
      Object.hasOwn(record(requirementsResponse), "requirements") &&
      (record(requirementsResponse).requirements === null ||
        (typeof record(requirementsResponse).requirements === "object" &&
          !Array.isArray(record(requirementsResponse).requirements))),
    rows,
  };
}
