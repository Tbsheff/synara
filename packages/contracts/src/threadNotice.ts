import { Schema } from "effect";
import { ThreadId } from "./baseSchemas";

export const ChildThreadNotice = Schema.Struct({
  childThreadId: ThreadId,
  title: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  status: Schema.Literals(["completed", "error", "interrupted", "needs-attention"]),
  excerpt: Schema.String,
});
export type ChildThreadNotice = typeof ChildThreadNotice.Type;
export const ChildThreadNoticeBatch = Schema.Array(ChildThreadNotice);
