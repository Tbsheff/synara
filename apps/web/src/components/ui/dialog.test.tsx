import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Dialog, DialogBackdrop } from "./dialog";

it("gives the shared dialog backdrop a reduced motion rule", () => {
  const markup = renderToStaticMarkup(
    <Dialog defaultOpen>
      <DialogBackdrop />
    </Dialog>,
  );
  expect(markup).toContain("motion-reduce:transition-none");
});
