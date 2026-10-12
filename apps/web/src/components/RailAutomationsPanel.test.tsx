import type { ReactNode } from "react";
import type { AutomationDefinition } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
const { state } = vi.hoisted(() => ({
  state: {
    data: { definitions: [] as AutomationDefinition[], runs: [] },
    isLoading: false,
    isPending: false,
    isError: true,
    error: new Error("List failed"),
    refetch: vi.fn(),
    createMutation: { isPending: false },
    runsByAutomationId: new Map(),
  },
}));
vi.mock("~/routes/-automations.shared", () => ({
  useAutomations: () => state,
  automationListRowIcon: () => ({ name: "clock" }),
}));
vi.mock("~/routes/-automations.list", () => ({
  useAutomationListClock: () => 0,
  AutomationListRow: ({ title }: { title: string }) => <span>{title}</span>,
  automationRowSubtitle: () => "",
  hasUnreadResult: () => false,
  AutomationCreateDialog: () => null,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useParams: () => null }));
vi.mock("~/store", () => ({ useStore: () => [] }));
vi.mock("./SidebarPanelTitle", () => ({ SidebarPanelTitle: () => null }));
vi.mock("./SidebarPrimaryAction", () => ({ SidebarPrimaryAction: () => null }));
vi.mock("./ui/sidebar", () => ({
  SidebarGroup: ({ children }: { children: ReactNode }) => children,
  SidebarMenu: ({ children }: { children: ReactNode }) => children,
}));
import { RailAutomationsPanel } from "./RailAutomationsPanel";
it("shows failed automation reads with Retry instead of empty", () => {
  const html = renderToStaticMarkup(
    <RailAutomationsPanel createOpen={false} onCreateOpenChange={() => {}} />,
  );
  expect(html).toContain("List failed");
  expect(html).toContain("Retry");
  expect(html).not.toContain("No automations yet");
});

it("keeps cached automation rows on failed refresh", () => {
  state.data.definitions = [
    { id: "automation", name: "Cached automation", enabled: true } as AutomationDefinition,
  ];
  const html = renderToStaticMarkup(
    <RailAutomationsPanel createOpen={false} onCreateOpenChange={() => {}} />,
  );
  expect(html).toContain("Cached automation");
  expect(html).toContain("List failed");
});

it("does not show empty for a paused initial automation read", () => {
  state.data.definitions = [];
  state.isError = false;
  state.isPending = true;
  const html = renderToStaticMarkup(
    <RailAutomationsPanel createOpen={false} onCreateOpenChange={() => {}} />,
  );
  expect(html).toContain("Loading automations...");
  expect(html).not.toContain("No automations yet");
});
