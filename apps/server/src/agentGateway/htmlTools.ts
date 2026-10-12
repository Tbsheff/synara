import {
  HTML_RENDER_DEFAULT_HEIGHT,
  HTML_RENDER_MAX_BYTES,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MIN_HEIGHT,
  type HtmlRenderDocument,
} from "@synara/contracts";
import { INLINE_HTML_RENDER_BETA_FEATURE } from "@synara/shared/betaFeatures";
import {
  HTML_RENDER_LAYOUT_GUIDE,
  HTML_RENDER_THEME_GUIDE,
  HTML_RENDER_TOOL_NAME,
  readHtmlRenderDocument,
} from "@synara/shared/htmlRender";
import { Effect } from "effect";

import { isServerBetaFeatureEnabled } from "../betaFeatureGate.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { errorText, ToolInputError } from "./toolInput.ts";
import { WRITE_TOOL_ANNOTATIONS, type ToolContext, type ToolEntry } from "./toolRuntime.ts";

export function makeAgentGatewayHtmlTools(dependencies: {
  readonly append: (
    document: HtmlRenderDocument,
    context: ToolContext,
  ) => Effect.Effect<void, unknown>;
  readonly isEnabled?: () => boolean;
}): ReadonlyArray<ToolEntry> {
  const isEnabled =
    dependencies.isEnabled ?? (() => isServerBetaFeatureEnabled(INLINE_HTML_RENDER_BETA_FEATURE));
  if (!isEnabled()) return [];
  return [
    {
      requiredCapability: "thread:write",
      requiresActiveTurn: true,
      definition: {
        name: HTML_RENDER_TOOL_NAME,
        description: `Show a finished HTML page (mockup, chart, table, or diagram) inline in your own thread, above your final reply. Call it before writing that reply. Add only what the page does not say. Maximum HTML size: 512 KB in UTF-8. ${HTML_RENDER_LAYOUT_GUIDE} ${HTML_RENDER_THEME_GUIDE}`,
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1, maxLength: HTML_RENDER_MAX_TITLE_LENGTH },
            html: { type: "string", minLength: 1, maxLength: HTML_RENDER_MAX_BYTES },
            height: {
              type: "integer",
              minimum: HTML_RENDER_MIN_HEIGHT,
              maximum: HTML_RENDER_MAX_HEIGHT,
              default: HTML_RENDER_DEFAULT_HEIGHT,
              description:
                "Reserved frame height in CSS pixels. Defaults to 480; long content scrolls inside.",
            },
          },
          required: ["title", "html"],
          additionalProperties: false,
        },
        annotations: { title: "Render HTML", ...WRITE_TOOL_ANNOTATIONS, destructiveHint: false },
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          if (!isEnabled()) return mcpToolResultError("Inline HTML is available in Synara Beta.");
          const document = readHtmlRenderDocument({
            ...args,
            height: args.height ?? HTML_RENDER_DEFAULT_HEIGHT,
          });
          if (!document)
            return yield* Effect.fail(
              new ToolInputError(
                "Expected a title (1–200 characters), HTML (1–512 KB in UTF-8), and an optional integer height (80–2000).",
              ),
            );
          yield* context.assertCallerTurnActive();
          yield* dependencies.append(document, context);
          return mcpToolResultJson({
            title: document.title,
            height: document.height,
            message: "Page shown in this thread.",
          });
        }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
    },
  ];
}
