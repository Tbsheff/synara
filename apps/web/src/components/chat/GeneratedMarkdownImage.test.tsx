import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { GeneratedMarkdownImage } from "./GeneratedMarkdownImage";

it("renders a plain frame without an image viewer", () => {
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <GeneratedMarkdownImage src="./image.png" alt="File preview" cwd="/repo" />
    </QueryClientProvider>,
  );
  expect(markup).not.toContain('aria-label="Expand generated image"');
  expect(markup).not.toContain("--expand");
  expect(markup).toContain('aria-label="Download generated image"');
});
