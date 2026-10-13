import "../index.css";

import { DEFAULT_SERVER_SETTINGS_VIEW, type ServerProviderUsageSnapshot } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { serverQueryKeys } from "../lib/serverReactQuery";
import { useStore } from "../store";
import { makeState, makeThread } from "../storeTestFixtures";
import BranchToolbar from "./BranchToolbar";

afterEach(() => cleanup());

it.each(["model", "session"] as const)(
  "shows the thread's %s account quota instead of the default account quota",
  async (source) => {
    const thread = makeThread({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        instanceId: source === "model" ? "claude_work" : "claudeAgent",
      },
      session:
        source === "session"
          ? {
              provider: "claudeAgent",
              providerInstanceId: "claude_work",
              status: "ready",
              orchestrationStatus: "ready",
              createdAt: "2026-10-12T12:00:00.000Z",
              updatedAt: "2026-10-12T12:00:00.000Z",
            }
          : null,
    });
    useStore.setState(makeState(thread));
    localStorage.setItem("synara:server-settings-migrated:v1", "1");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
    client.setQueryData(
      serverQueryKeys.allProviderUsage(),
      [
        { instanceId: "claudeAgent", usedPercent: 90 },
        { instanceId: "claude_work", usedPercent: 20 },
      ].map(
        ({ instanceId, usedPercent }): ServerProviderUsageSnapshot => ({
          provider: "claudeAgent",
          instanceId,
          updatedAt: "2026-10-12T12:00:00.000Z",
          limits: [{ window: "Weekly", usedPercent, windowDurationMins: 10080 }],
          usageLines: [],
          source: "test",
          status: "ok",
        }),
      ),
    );
    try {
      await render(
        <QueryClientProvider client={client}>
          <BranchToolbar
            threadId={thread.id}
            onEnvModeChange={() => {}}
            envLocked={false}
            threadDetailReady={true}
            showBranchSelector={false}
          />
        </QueryClientProvider>,
      );
      await page.getByRole("button", { name: "Local" }).click();
      await expect.element(page.getByText("80% left", { exact: true })).toBeVisible();
      expect(page.getByText("10% left", { exact: true }).query()).toBeNull();
    } finally {
      await cleanup();
      client.clear();
    }
  },
);
