import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { ProviderPermissionsPanel, ProviderPermissionRows } from "./ProviderPermissionsPanel";

describe("provider permission view", () => {
  it("shows the reported source and marks administrator values read-only", () => {
    const html = renderToStaticMarkup(
      <ProviderPermissionRows
        result={{
          supported: true,
          configPath: "/account/config.toml",
          requirementsRead: true,
          rows: [
            {
              key: "sandbox_mode",
              label: "Filesystem mode",
              value: "read-only",
              source: "Administrator policy",
              managed: true,
            },
          ],
        }}
      />,
    );
    expect(html).toContain("Filesystem mode");
    expect(html).toContain("Administrator policy");
    expect(html).toContain("Managed, read-only");
    expect(html).not.toContain("input");
  });
  it("shows unknown managed requirements rather than claiming no limits", () => {
    const html = renderToStaticMarkup(
      <ProviderPermissionRows
        result={{ supported: true, configPath: null, requirementsRead: false, rows: [] }}
      />,
    );
    expect(html).toContain("Administrator requirements could not be read");
  });
});

const harness = vi.hoisted(() => ({
  request: vi.fn(async () => ({
    supported: true,
    configPath: null,
    requirementsRead: true,
    rows: [],
  })),
  open: vi.fn(async () => {}),
  queryFn: undefined as (() => Promise<unknown>) | undefined,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (value: unknown) => [value, vi.fn()],
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: (options: { queryKey: readonly unknown[]; queryFn: () => Promise<unknown> }) => {
    if (options.queryKey.includes("providerPermissions")) {
      harness.queryFn = options.queryFn;
      return {
        data: {
          supported: true,
          configPath: "/selected/config.toml",
          requirementsRead: true,
          rows: [],
        },
        isFetching: false,
        refetch: vi.fn(),
      };
    }
    return { data: { availableEditors: [] } };
  },
}));
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    provider: { getPermissions: harness.request },
    shell: { openInEditor: harness.open },
  }),
}));
vi.mock("~/editorPreferences", () => ({ resolveAndPersistPreferredEditor: () => "code" }));
afterEach(() => {
  vi.clearAllMocks();
});

type Props = { children?: ReactNode; onClick?: () => void };
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}

it("settles account saves before it reads the selected account's policy", async () => {
  let release!: () => void;
  const saving = new Promise<void>((resolve) => {
    release = resolve;
  });
  const input = { provider: "codex" as const, instanceId: "work" };
  ProviderPermissionsPanel({ input, beforeLoad: () => saving });
  const request = harness.queryFn!();
  expect(harness.request).not.toHaveBeenCalled();
  release();
  await request;
  expect(harness.request).toHaveBeenCalledWith(input);
});

it("opens the selected account's reported config through the existing editor API", async () => {
  const tree = ProviderPermissionsPanel({
    input: { provider: "codex", instanceId: "work" },
    beforeLoad: async () => {},
  });
  const open = elements(tree).find((node) => node.props.children === "Open provider config");
  expect(open).toBeDefined();
  open!.props.onClick!();
  await Promise.resolve();
  expect(harness.open).toHaveBeenCalledWith("/selected/config.toml", "code");
});
