import type { ServerProviderStatus } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  provider: "codex" as "codex" | "claudeAgent",
  statuses: [] as ServerProviderStatus[],
}));

vi.mock("react", async (importOriginal) => {
  const original = await importOriginal<typeof import("react")>();
  return {
    ...original,
    useState: (initial: unknown) =>
      original.useState(initial === harness.provider ? "work" : initial),
  };
});
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({}),
  useQuery: (options: { queryKey?: readonly unknown[] }) => ({
    data:
      options.queryKey?.[1] === "allProviderUsage"
        ? []
        : options.queryKey?.[1] === "providerPermissions"
          ? undefined
          : { providers: harness.statuses },
    isPending: false,
    isFetching: false,
  }),
}));
vi.mock("~/lib/serverReactQuery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/serverReactQuery")>()),
  hasReconciledServerProviderStatuses: () => true,
}));
vi.mock("~/hooks/useProviderStatusesForLocalConfig", () => ({
  useProviderStatusesForLocalConfig: () => harness.statuses,
}));
vi.mock("~/hooks/useProviderStatusRefresh", () => ({
  useRefreshProviderStatusesNow: () => vi.fn(),
}));
vi.mock("~/store", () => ({ useStore: () => ({}) }));

import { AppSettingsSchema } from "~/appSettings";
import { ProvidersSettingsPanel } from "./ProvidersSettingsPanel";

it.each([
  ["codex", "unauthenticated", "Not authenticated"],
  ["claudeAgent", "authenticated", "Signed in locally"],
] as const)(
  "keeps the selected %s account's identity above wrapping auth and removal actions",
  (provider, authStatus, headline) => {
    harness.provider = provider;
    harness.statuses = [
      {
        provider,
        driver: provider,
        instanceId: "work",
        available: true,
        status: "ready",
        authStatus,
        checkedAt: "2026-10-12T12:00:00Z",
      },
    ];
    const defaults = AppSettingsSchema.makeUnsafe({});
    const markup = renderToStaticMarkup(
      <ProvidersSettingsPanel
        defaults={defaults}
        settings={{
          ...defaults,
          providerInstances: { work: { driver: provider, displayName: "Work", config: {} } },
        }}
        providerTarget={provider}
        updateSettings={vi.fn()}
        updateSettingsAndWait={vi.fn(async () => {})}
        active
        resetEpoch={0}
      />,
    );
    const editor = markup.split('aria-label="Work account">')[1];
    expect(editor).toBeDefined();
    const headerClass = editor!.match(/^<div class="([^"]+)"/u)?.[1];
    expect(headerClass?.split(" ")).toContain("flex-col");
    const [identity, actions] = editor!.split('aria-label="Work account actions">');
    expect(identity).toContain(headline);
    expect(identity).toContain("Work</span>");
    expect(identity).not.toContain("<button");
    expect(identity).toContain("flex-wrap");
    expect(actions?.split("</div>")[0]).toContain('aria-label="Sign in to Work"');
    expect(actions?.split("</div>")[0]).toContain('aria-label="Sign out of Work"');
    expect(actions?.split("</div>")[0]).toContain("Remove entry");
  },
);
