import { Schema } from "effect";

export const HTML_RENDER_MAX_BYTES = 512 * 1024;
export const HTML_RENDER_MAX_TITLE_LENGTH = 200;
export const HTML_RENDER_MIN_HEIGHT = 80;
export const HTML_RENDER_MAX_HEIGHT = 2000;
export const HTML_RENDER_DEFAULT_HEIGHT = 480;
export const HTML_RENDER_ACTIVITY_KIND = "synara.html.rendered";

export const HtmlRenderDocument = Schema.Struct({
  title: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(HTML_RENDER_MAX_TITLE_LENGTH),
  ),
  html: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(HTML_RENDER_MAX_BYTES)),
  height: Schema.Int.check(
    Schema.isBetween({ minimum: HTML_RENDER_MIN_HEIGHT, maximum: HTML_RENDER_MAX_HEIGHT }),
  ),
});
export type HtmlRenderDocument = typeof HtmlRenderDocument.Type;
