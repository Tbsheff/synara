import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { InboxAttentionReadNotice } from "./InboxView";
it.each(["PR reviews", "Automation runs", "Tasks"])(
  "shows the failed %s cause and Retry",
  (label) => {
    const html = renderToStaticMarkup(
      <InboxAttentionReadNotice
        read={{ label, isError: true, error: new Error("Connection lost"), refetch: () => {} }}
      />,
    );
    expect(html).toContain("Connection lost");
    expect(html).toContain(label);
    expect(html).toContain("Retry");
  },
);

it("keeps a useful fallback when a failed read has no message", () => {
  const html = renderToStaticMarkup(
    <InboxAttentionReadNotice
      read={{ label: "Tasks", isError: true, error: {}, refetch: () => {} }}
    />,
  );
  expect(html).toContain("Tasks could not load. Other results may be incomplete.");
  expect(html).toContain("Retry");
});
