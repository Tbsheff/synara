import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowserLocalServersHome } from "./BrowserPanel";

describe("local server scan state", () => {
  it("shows a failed scan with Retry instead of empty", () => {
    const html = renderToStaticMarkup(
      <BrowserLocalServersHome
        activeTabId={null}
        loading={false}
        error="Scan failed"
        onNavigate={() => {}}
        onRefresh={() => {}}
        servers={[]}
      />,
    );
    expect(html).toContain("Scan failed");
    expect(html).toContain("Retry");
    expect(html).not.toContain("No local servers");
  });
});

it("keeps cached local servers on a failed refresh", () => {
  const html = renderToStaticMarkup(
    <BrowserLocalServersHome
      activeTabId={null}
      loading={false}
      error="Scan failed"
      onNavigate={() => {}}
      onRefresh={() => {}}
      servers={[
        {
          id: "cached",
          pid: 1,
          command: "node",
          displayName: "Cached server",
          args: "",
          ports: [3000],
          addresses: [],
          isStoppable: false,
        },
      ]}
    />,
  );
  expect(html).toContain("Cached server");
  expect(html).toContain("Scan failed");
  expect(html).not.toContain("No local servers");
});
it("keeps scanning distinct from a confirmed empty result", () => {
  const props = { activeTabId: null, onNavigate: () => {}, onRefresh: () => {}, servers: [] };
  expect(renderToStaticMarkup(<BrowserLocalServersHome {...props} loading />)).toContain(
    "Scanning local servers",
  );
  expect(renderToStaticMarkup(<BrowserLocalServersHome {...props} loading={false} />)).toContain(
    "No local servers",
  );
});

it("does not show empty for a paused initial local server read", () => {
  const html = renderToStaticMarkup(
    <BrowserLocalServersHome
      activeTabId={null}
      loading={false}
      pending
      onNavigate={() => {}}
      onRefresh={() => {}}
      servers={[]}
    />,
  );
  expect(html).toContain("Scanning local servers");
  expect(html).not.toContain("No local servers");
});
