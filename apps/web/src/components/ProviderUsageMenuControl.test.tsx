import { DEFAULT_SERVER_SETTINGS_VIEW, type ServerProviderUsageSnapshot } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { serverQueryKeys } from "../lib/serverReactQuery";
import { ProviderUsageMenuControl } from "./ProviderUsageMenuControl";

it("shows the header quota for the selected account", () => {
  const client = new QueryClient();
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
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ProviderUsageMenuControl provider="claudeAgent" instanceId="claude_work" />
      </QueryClientProvider>,
    );
    expect(html).toContain("80%");
    expect(html).not.toContain("10%");
  } finally {
    client.clear();
  }
});
