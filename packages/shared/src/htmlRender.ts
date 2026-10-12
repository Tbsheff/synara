import {
  HTML_RENDER_MAX_BYTES,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MIN_HEIGHT,
  HtmlRenderDocument,
} from "@synara/contracts";
import { Option, Schema } from "effect";

export const HTML_RENDER_TOOL_NAME = "synara_html_render";
export const HTML_RENDER_SANDBOX = "allow-scripts allow-forms";

export const HTML_RENDER_LAYOUT_GUIDE =
  "Use one self-contained HTML document with inline styles, scripts, and data images. Network requests, remote CDNs, frames, and form submissions are blocked. The frame uses the reply column width (about 728px on desktop and 360px on phones). Use fluid width, no outer horizontal padding, no outer card or banner title. Give distinct panels 16px padding and var(--radius) corners. Give charts fixed heights. Let content set its height; do not use 100vh or height:100% on html or body. The requested height reserves a fixed box; taller pages scroll inside it.";

export const HTML_RENDER_THEME_GUIDE =
  "Synara sets CSS variables on :root and updates them with the app theme: --background, --foreground, --muted, --muted-foreground, --card, --card-foreground, --popover, --popover-foreground, --secondary, --secondary-foreground, --border, --input, --ring, --primary, --primary-foreground, --accent, --accent-foreground, --destructive, --destructive-foreground, --warning, --warning-foreground, --success, --success-foreground, --info, --info-foreground, --chart-1 through --chart-5, --radius, --font-sans, --font-mono, --font-size. Use these tokens for both light and dark mode. Leave the page background transparent so it blends into the reply.";

export interface HtmlRenderTheme {
  readonly appearance: "light" | "dark";
  readonly variables: Readonly<Record<string, string>>;
}

const decodeDocument = Schema.decodeUnknownOption(HtmlRenderDocument);

export function readHtmlRenderDocument(value: unknown): HtmlRenderDocument | undefined {
  const decoded = decodeDocument(value);
  if (Option.isNone(decoded)) return undefined;
  const document = decoded.value;
  return document.title.trim() &&
    document.html.trim() &&
    new TextEncoder().encode(document.html).byteLength <= HTML_RENDER_MAX_BYTES
    ? document
    : undefined;
}

export function clampHtmlRenderHeight(height: number): number {
  return Math.min(
    HTML_RENDER_MAX_HEIGHT,
    Math.max(
      HTML_RENDER_MIN_HEIGHT,
      Number.isFinite(height) ? Math.round(height) : HTML_RENDER_MIN_HEIGHT,
    ),
  );
}

export function htmlRenderFrameHeight(reservedHeight: number, contentHeight?: number): number {
  return Math.min(
    clampHtmlRenderHeight(reservedHeight),
    clampHtmlRenderHeight(contentHeight ?? reservedHeight),
  );
}

export function readHtmlRenderContentHeight(
  event: { readonly source: unknown; readonly data: unknown },
  frameWindow: unknown,
): number | undefined {
  if (frameWindow == null || event.source !== frameWindow) return undefined;
  const data = event.data;
  if (
    typeof data !== "object" ||
    data === null ||
    !("jsonrpc" in data) ||
    !("method" in data) ||
    !("params" in data)
  )
    return undefined;
  if (data.jsonrpc !== "2.0" || data.method !== "ui/notifications/size-changed") return undefined;
  const params = data.params;
  if (typeof params !== "object" || params === null || !("height" in params)) return undefined;
  return typeof params.height === "number" && Number.isFinite(params.height) && params.height > 0
    ? clampHtmlRenderHeight(params.height)
    : undefined;
}

export function htmlRenderThemeMessage(theme: HtmlRenderTheme) {
  return {
    jsonrpc: "2.0",
    method: "ui/notifications/host-context-changed",
    params: { theme: theme.appearance, styles: { variables: theme.variables } },
  } as const;
}

const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

const BOOTSTRAP = `(function(){
function theme(t){if(!t||!t.variables)return;var r=document.documentElement;r.style.colorScheme=t.appearance==='light'?'light':'dark';for(var k in t.variables){if(/^--[a-z0-9-]+$/.test(k))r.style.setProperty(k,String(t.variables[k]));}}
window.addEventListener('message',function(e){var d=e.data;if(e.source===parent&&d&&d.jsonrpc==='2.0'&&d.method==='ui/notifications/host-context-changed'&&d.params&&d.params.styles)theme({appearance:d.params.theme,variables:d.params.styles.variables});});
var last=0,pending=false;function report(){pending=false;var b=document.body;if(!b)return;var h=Math.ceil(Math.max(b.scrollHeight,b.getBoundingClientRect().height));if(h===last||h<=0)return;last=h;parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{height:h}},'*');}
function queue(){if(!pending){pending=true;requestAnimationFrame(report);}}
document.addEventListener('DOMContentLoaded',function(){if(window.ResizeObserver){var observer=new ResizeObserver(queue);observer.observe(document.body);}queue();});window.addEventListener('load',queue);
})();`;

export function buildHtmlRenderSrcdoc(html: string, theme: HtmlRenderTheme): string {
  const variables = Object.entries(theme.variables)
    .filter(([key]) => /^--[a-z0-9-]+$/.test(key))
    .map(([key, value]) => `${key}:${value.replace(/[;{}<>]/g, "")};`)
    .join("");
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{color-scheme:${theme.appearance};${variables}}html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:var(--font-size);line-height:1.5}body{margin:0;display:flow-root}code,pre{font-family:var(--font-mono)}</style><script>${BOOTSTRAP}</script></head><body>${html}</body></html>`;
}
