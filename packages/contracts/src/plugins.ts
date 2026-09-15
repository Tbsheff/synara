import { Schema } from "effect";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";

export const SynaraPluginDescriptor = Schema.Struct({
  id: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  apiVersion: Schema.Literals([1, 2]),
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  app: Schema.optionalKey(TrimmedNonEmptyString),
  appUrl: Schema.optionalKey(TrimmedNonEmptyString),
  appCssUrl: Schema.optionalKey(TrimmedNonEmptyString),
  editable: Schema.optionalKey(Schema.Boolean),
});
export type SynaraPluginDescriptor = typeof SynaraPluginDescriptor.Type;

export const PluginListResult = Schema.Array(SynaraPluginDescriptor);
export type PluginListResult = typeof PluginListResult.Type;

export const PluginCallInput = Schema.Struct({
  pluginId: TrimmedNonEmptyString,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  method: TrimmedNonEmptyString,
  input: Schema.Json,
});
export type PluginCallInput = typeof PluginCallInput.Type;

export const PluginCallResult = Schema.Struct({ output: Schema.Json });
export type PluginCallResult = typeof PluginCallResult.Type;

export const PluginEditInput = Schema.Struct({
  pluginId: TrimmedNonEmptyString,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  projectId: TrimmedNonEmptyString,
  operationId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type PluginEditInput = typeof PluginEditInput.Type;

export const PluginEditResult = Schema.Struct({ threadId: TrimmedNonEmptyString });
export type PluginEditResult = typeof PluginEditResult.Type;
