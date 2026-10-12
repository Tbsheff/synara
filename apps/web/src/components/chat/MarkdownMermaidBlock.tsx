import { useEffect, useId, useState, type ReactNode } from "react";
import { Button } from "../ui/button";

type DiagramTheme = "light" | "dark";
let renderQueue = Promise.resolve();

export function renderMermaidDiagram(
  source: string,
  id: string,
  theme: DiagramTheme,
): Promise<string> {
  const result = renderQueue.then(async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      maxTextSize: 50_000,
      maxEdges: 500,
      theme: theme === "dark" ? "dark" : "default",
      flowchart: { htmlLabels: false },
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "maxEdges",
        "suppressErrorRendering",
        "theme",
        "themeCSS",
        "flowchart",
      ],
    });
    return (await mermaid.render(id, source)).svg;
  });
  renderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function MarkdownMermaidBlock(props: {
  source: string;
  theme: DiagramTheme;
  children: ReactNode;
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [showSource, setShowSource] = useState(false);
  const [result, setResult] = useState<{
    source: string;
    theme: DiagramTheme;
    svg: string | null;
    failed: boolean;
  } | null>(null);
  useEffect(() => {
    let active = true;
    void renderMermaidDiagram(props.source, `mermaid-${id}`, props.theme).then(
      (svg) => {
        if (active) setResult({ source: props.source, theme: props.theme, svg, failed: false });
      },
      () => {
        if (active)
          setResult({ source: props.source, theme: props.theme, svg: null, failed: true });
      },
    );
    return () => {
      active = false;
    };
  }, [id, props.source, props.theme]);
  const current = result?.source === props.source && result.theme === props.theme ? result : null;
  return (
    <div data-mermaid-block="true">
      <div className="px-3 py-1 text-ui-xs">
        <Button
          size="xs"
          variant="ghost"
          aria-pressed={showSource}
          onClick={() => setShowSource((value) => !value)}
        >
          {showSource ? "Show diagram" : "Show diagram source"}
        </Button>
        {current?.failed ? (
          <p className="text-ui-sm text-muted-foreground">
            Could not render this diagram. The source is below.
          </p>
        ) : null}
      </div>
      {showSource || !current?.svg ? (
        props.children
      ) : (
        <div
          className="overflow-auto p-3 [&_svg]:max-w-full"
          role="img"
          aria-label="Mermaid diagram"
          dangerouslySetInnerHTML={{ __html: current.svg }}
        />
      )}
    </div>
  );
}
