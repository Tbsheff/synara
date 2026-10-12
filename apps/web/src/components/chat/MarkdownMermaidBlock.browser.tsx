import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { MarkdownMermaidBlock } from "./MarkdownMermaidBlock";

afterEach(() => {
  document.body.innerHTML = "";
});

it("renders a diagram and lets the reader switch back to source", async () => {
  const screen = await render(
    <MarkdownMermaidBlock source="graph TD; A-->B" theme="light">
      <pre>graph TD; A--&gt;B</pre>
    </MarkdownMermaidBlock>,
  );
  await expect
    .poll(() => document.querySelector('[aria-label="Mermaid diagram"] svg'))
    .not.toBeNull();
  await screen.getByRole("button", { name: "Show diagram source" }).click();
  expect(document.querySelector("pre")?.textContent).toBe("graph TD; A-->B");
  await screen.getByRole("button", { name: "Show diagram", exact: true }).click();
  expect(document.querySelector('[aria-label="Mermaid diagram"] svg')).not.toBeNull();
});

it("keeps malformed diagram source readable", async () => {
  await render(
    <MarkdownMermaidBlock source="this is not a diagram" theme="dark">
      <pre>this is not a diagram</pre>
    </MarkdownMermaidBlock>,
  );
  await expect.poll(() => document.body.textContent).toContain("Could not render this diagram");
  expect(document.querySelector("pre")?.textContent).toBe("this is not a diagram");
});
