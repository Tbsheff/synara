import { expect, it, vi } from "vitest";
import { renderMermaidDiagram } from "./MarkdownMermaidBlock";

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: mermaid }));

it("renders diagrams with locked strict settings and recovers after invalid source", async () => {
  mermaid.render.mockRejectedValueOnce(new Error("invalid diagram"));
  mermaid.render.mockResolvedValueOnce({ svg: '<svg aria-label="diagram"></svg>' });
  const failed = renderMermaidDiagram("invalid", "failed", "dark");
  const next = renderMermaidDiagram("graph TD; A-->B", "next", "light");
  await expect(failed).rejects.toThrow("invalid diagram");
  await expect(next).resolves.toContain("<svg");
  expect(mermaid.initialize).toHaveBeenLastCalledWith(
    expect.objectContaining({
      securityLevel: "strict",
      startOnLoad: false,
      suppressErrorRendering: true,
      maxTextSize: 50_000,
      maxEdges: 500,
      secure: expect.arrayContaining(["securityLevel", "maxTextSize", "maxEdges", "themeCSS"]),
    }),
  );
  expect(mermaid.render.mock.calls.map(([id]) => id)).toEqual(["failed", "next"]);
});
