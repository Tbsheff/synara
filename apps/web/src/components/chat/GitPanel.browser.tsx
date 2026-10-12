import "../../index.css";

import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { getRenderablePatch } from "~/lib/diffRendering";
import { GitFileRow } from "./GitPanel";

function parseSingleFile() {
  const renderable = getRenderablePatch(
    [
      "diff --git a/src/one.ts b/src/one.ts",
      "index 1111111..2222222 100644",
      "--- a/src/one.ts",
      "+++ b/src/one.ts",
      "@@ -1,1 +1,1 @@",
      "-const one = 1;",
      "+const one = 2;",
      "",
    ].join("\n"),
    "git-panel:browser",
  );
  if (renderable?.kind !== "files") throw new Error("expected parsed files");
  return renderable.files[0]!;
}

it("shows the stage action when the row receives keyboard focus", async () => {
  const screen = await render(
    <GitFileRow
      fileDiff={parseSingleFile()}
      theme="light"
      isSelected={false}
      actionLabel="Stage file"
      actionIcon="stage"
      actionDisabled={false}
      onSelect={() => undefined}
      onAction={() => undefined}
    />,
  );
  const action = screen.getByRole("button", { name: "Stage file" }).element() as HTMLElement;
  expect(getComputedStyle(action).opacity).toBe("0");
  const rowButton = screen.getByTitle("src/one.ts").element() as HTMLElement;
  rowButton.focus();
  await vi.waitFor(() => expect(getComputedStyle(action).opacity).toBe("1"));
});
