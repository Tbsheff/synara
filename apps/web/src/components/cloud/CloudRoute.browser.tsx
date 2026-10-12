import { isBetaFeatureEnabled, PROVIDER_CLOUD_BETA_FEATURE } from "@synara/shared/betaFeatures";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  type AnyRoute,
} from "@tanstack/react-router";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({ getCapabilities: vi.fn() }));

vi.mock("~/betaFeatures", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/betaFeatures")>()),
  CLOUD_ON: isBetaFeatureEnabled(PROVIDER_CLOUD_BETA_FEATURE, "production"),
}));
vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/nativeApi")>()),
  ensureNativeApi: () => ({ cloud: { getCapabilities: harness.getCapabilities } }),
}));

import { Route as cloudRoute } from "~/routes/_chat.cloud";
import CloudView from "./CloudView";

it("redirects a Stable Cloud deep link home and renders nothing", async () => {
  const mounted = vi.fn();
  const root = createRootRoute();
  const home = createRoute({ getParentRoute: () => root, path: "/", component: () => <p>Home</p> });
  const cloud = createRoute({
    getParentRoute: () => root,
    path: "/cloud",
    beforeLoad: (cloudRoute as AnyRoute).options.beforeLoad,
    component: () => {
      mounted();
      return <p>Cloud mounted</p>;
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([home, cloud]),
    history: createMemoryHistory({ initialEntries: ["/cloud"] }),
  });
  const view = await render(<RouterProvider router={router} />);
  try {
    await expect.poll(() => router.state.location.pathname).toBe("/");
    expect(mounted).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
  }

  const direct = await render(
    <QueryClientProvider client={new QueryClient()}>
      <div data-testid="cloud-host">
        <CloudView />
      </div>
    </QueryClientProvider>,
  );
  try {
    expect(direct.container.querySelector("[data-testid=cloud-host]")?.childElementCount).toBe(0);
    expect(harness.getCapabilities).not.toHaveBeenCalled();
  } finally {
    await direct.unmount();
  }
});
