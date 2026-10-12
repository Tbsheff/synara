import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import { CursorAdapter } from "../Services/CursorAdapter.ts";
import { GrokAdapter } from "../Services/GrokAdapter.ts";
import { makeCursorAdapterLive } from "./CursorAdapter.ts";
import { makeGrokAdapterLive } from "./GrokAdapter.ts";

const baseLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "acp-rollback-capability-",
}).pipe(Layer.provideMerge(NodeServices.layer));

describe("ACP adapters without native history rewind", () => {
  it.effect("Cursor rebuilds context instead of claiming a native rollback", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      expect(adapter.capabilities.conversationRollback).toBe("restart-session");
    }).pipe(Effect.provide(makeCursorAdapterLive().pipe(Layer.provideMerge(baseLayer)))),
  );

  it.effect("Grok rebuilds context instead of claiming a native rollback", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokAdapter;
      expect(adapter.capabilities.conversationRollback).toBe("restart-session");
    }).pipe(Effect.provide(makeGrokAdapterLive().pipe(Layer.provideMerge(baseLayer)))),
  );
});
