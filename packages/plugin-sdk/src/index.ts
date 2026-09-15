export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface PluginSchema<Value> {
  readonly parse: (input: unknown, path?: string) => Value;
  readonly jsonSchema: Readonly<Record<string, JsonValue>>;
  readonly isOptional?: boolean;
}

export function schema<Value>(
  parse: PluginSchema<Value>["parse"],
  jsonSchema: Readonly<Record<string, JsonValue>> = {},
): PluginSchema<Value> {
  return { parse, jsonSchema };
}

export function string(): PluginSchema<string> {
  return {
    jsonSchema: { type: "string" },
    parse(input, path = "value") {
      if (typeof input !== "string") throw new Error(`${path} must be a string.`);
      return input;
    },
  };
}

export function nonEmptyString(
  options: { readonly maxLength?: number } = {},
): PluginSchema<string> {
  return {
    jsonSchema: {
      type: "string",
      minLength: 1,
      ...(options.maxLength === undefined ? {} : { maxLength: options.maxLength }),
    },
    parse(input, path = "value") {
      if (typeof input !== "string" || input.trim().length === 0) {
        throw new Error(`${path} must be a non-empty string.`);
      }
      const value = input.trim();
      if (options.maxLength !== undefined && value.length > options.maxLength) {
        throw new Error(`${path} must be at most ${options.maxLength} characters.`);
      }
      return value;
    },
  };
}

export interface PluginOptionalSchema<Value> extends PluginSchema<Value | undefined> {
  readonly isOptional: true;
}

export function optional<Value>(schema: PluginSchema<Value>): PluginOptionalSchema<Value> {
  return {
    jsonSchema: schema.jsonSchema,
    isOptional: true,
    parse(input, path) {
      return input === undefined ? undefined : schema.parse(input, path);
    },
  };
}

export function literal<const Value extends JsonPrimitive>(value: Value): PluginSchema<Value> {
  return {
    jsonSchema: { const: value },
    parse(input, path = "value") {
      if (input !== value) throw new Error(`${path} must be ${JSON.stringify(value)}.`);
      return value;
    },
  };
}

export function array<Value>(schema: PluginSchema<Value>): PluginSchema<Value[]> {
  return {
    jsonSchema: { type: "array", items: schema.jsonSchema },
    parse(input, path = "value") {
      if (!Array.isArray(input)) throw new Error(`${path} must be an array.`);
      return input.map((entry, index) => schema.parse(entry, `${path}[${index}]`));
    },
  };
}

type PluginSchemaShape = Readonly<Record<string, PluginSchema<unknown>>>;

type PluginSchemaValue<Schema> = Schema extends PluginSchema<infer Value> ? Value : never;

type PluginObjectValue<Shape extends PluginSchemaShape> = {
  [Key in keyof Shape as Shape[Key] extends PluginOptionalSchema<unknown>
    ? never
    : Key]: PluginSchemaValue<Shape[Key]>;
} & {
  [Key in keyof Shape as Shape[Key] extends PluginOptionalSchema<unknown> ? Key : never]?: Exclude<
    PluginSchemaValue<Shape[Key]>,
    undefined
  >;
};

type Simplify<Value> = { [Key in keyof Value]: Value[Key] } & {};

export function object<Shape extends PluginSchemaShape>(
  shape: Shape,
): PluginSchema<Simplify<PluginObjectValue<Shape>>> {
  return {
    jsonSchema: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(shape).map(([key, schema]) => [key, schema.jsonSchema]),
      ),
      required: Object.entries(shape)
        .filter(([, schema]) => schema.isOptional !== true)
        .map(([key]) => key),
      additionalProperties: false,
    },
    parse(input, path = "value") {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error(`${path} must be an object.`);
      }
      const source = input as Record<string, unknown>;
      for (const key of Object.keys(source)) {
        if (!Object.hasOwn(shape, key)) {
          throw new Error(`${path}.${key} is not allowed.`);
        }
      }
      return Object.fromEntries(
        Object.entries(shape).flatMap(([key, schema]) => {
          const value = schema.parse(source[key], `${path}.${key}`);
          return value === undefined && schema.isOptional === true ? [] : [[key, value]];
        }),
      ) as Simplify<PluginObjectValue<Shape>>;
    },
  };
}

export interface PluginRpcContract<Input, Output> {
  readonly input: PluginSchema<Input>;
  readonly output: PluginSchema<Output>;
}

export interface PluginKvStorage {
  readonly get: (key: string) => Promise<JsonValue | undefined>;
  readonly set: (key: string, value: JsonValue) => Promise<void>;
  readonly delete: (key: string) => Promise<void>;
  readonly update: (
    key: string,
    updateValue: (
      current: JsonValue | undefined,
    ) => JsonValue | undefined | Promise<JsonValue | undefined>,
  ) => Promise<JsonValue | undefined>;
}

export interface PluginThreadStartInput {
  readonly projectId: string;
  readonly title: string;
  readonly prompt: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export interface PluginHostApi {
  readonly threads: {
    readonly start: (input: PluginThreadStartInput) => Promise<{ readonly threadId: string }>;
  };
}

export interface PluginCall {
  readonly pluginId: string;
  readonly generation: number;
  readonly host: PluginHostApi;
  readonly signal: AbortSignal;
}

export type PluginHandler<Input, Output> = (input: Input, call: PluginCall) => Promise<Output>;

export type PluginAgentToolAccess = "read" | "write";

export interface PluginAgentToolRegistration<Input, Output> {
  readonly id: string;
  readonly title?: string;
  readonly description: string;
  readonly contract: PluginRpcContract<Input, Output>;
  readonly access: PluginAgentToolAccess;
  readonly execute: PluginHandler<Input, Output>;
}

export type RegisteredPluginAgentTool = Omit<
  PluginAgentToolRegistration<unknown, unknown>,
  "contract" | "execute"
> & {
  readonly pluginId: string;
  readonly generation: number;
  readonly inputSchema: Readonly<Record<string, JsonValue>>;
};

export interface SynaraPluginApi {
  readonly storage: PluginKvStorage;
  readonly rpc: {
    readonly register: <Input, Output>(
      method: string,
      contract: PluginRpcContract<Input, Output>,
      handler: PluginHandler<Input, Output>,
    ) => void;
  };
  readonly agents: {
    readonly registerTool: <Input, Output>(
      registration: PluginAgentToolRegistration<Input, Output>,
    ) => void;
  };
}

export type SynaraPlugin = (api: SynaraPluginApi) => void;

export function definePlugin(plugin: SynaraPlugin): SynaraPlugin {
  return plugin;
}

export interface SynaraPluginManifest {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly apiVersion: 1 | 2;
  readonly app?: string;
  readonly appUrl?: string;
  readonly appCssUrl?: string;
  readonly editable?: boolean;
  readonly sourcePath?: string;
}

interface RegisteredMethod {
  readonly contract: PluginRpcContract<unknown, unknown>;
  readonly handler: PluginHandler<unknown, unknown>;
}

interface RegisteredAgentTool
  extends PluginAgentToolRegistration<unknown, unknown>, RegisteredPluginAgentTool {}

type PendingAgentTool = Omit<RegisteredAgentTool, "pluginId" | "generation">;

interface ActivePlugin {
  readonly manifest: SynaraPluginManifest;
  readonly generation: number;
  readonly host: PluginHostApi;
  readonly methods: ReadonlyMap<string, RegisteredMethod>;
  readonly agentTools: ReadonlyMap<string, RegisteredAgentTool>;
  readonly lifecycle: AbortController;
  accepting: boolean;
  inFlight: number;
  readonly drained: Set<() => void>;
}

export interface PluginRegistry {
  readonly activate: (manifest: SynaraPluginManifest, plugin: SynaraPlugin) => Promise<number>;
  readonly deactivate: (pluginId: string) => Promise<boolean>;
  readonly list: () => ReadonlyArray<SynaraPluginManifest & { readonly generation: number }>;
  readonly call: (input: {
    readonly pluginId: string;
    readonly generation: number;
    readonly method: string;
    readonly input: unknown;
  }) => Promise<JsonValue>;
  readonly listAgentTools: () => ReadonlyArray<RegisteredPluginAgentTool>;
  readonly callAgentTool: (input: {
    readonly pluginId: string;
    readonly generation: number;
    readonly toolId: string;
    readonly input: unknown;
    readonly host?: PluginHostApi;
    readonly signal?: AbortSignal;
  }) => Promise<JsonValue>;
}

const PLUGIN_CONTRIBUTION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function createPluginRegistry(input: {
  readonly host: PluginHostApi | ((pluginId: string) => PluginHostApi);
  readonly storage: PluginKvStorage | ((pluginId: string) => PluginKvStorage);
  readonly drainTimeoutMs?: number;
}): PluginRegistry {
  const active = new Map<string, ActivePlugin>();
  let nextGeneration = 0;

  const invoke = async (
    plugin: ActivePlugin,
    contract: PluginRpcContract<unknown, unknown>,
    handler: PluginHandler<unknown, unknown>,
    rawInput: unknown,
    outputName: string,
    invocation?: { readonly host?: PluginHostApi; readonly signal?: AbortSignal },
  ): Promise<JsonValue> => {
    const parsedInput = contract.input.parse(rawInput, "input");
    const host = invocation?.host ?? plugin.host;
    const signal = invocation?.signal
      ? AbortSignal.any([invocation.signal, plugin.lifecycle.signal])
      : plugin.lifecycle.signal;
    signal.throwIfAborted();
    plugin.inFlight += 1;
    try {
      const output = await handler(parsedInput, {
        pluginId: plugin.manifest.id,
        generation: plugin.generation,
        host,
        signal,
      });
      signal.throwIfAborted();
      const parsedOutput = contract.output.parse(output, "output");
      const serialized = JSON.stringify(parsedOutput);
      if (serialized === undefined) throw new Error(`${outputName} must be JSON serializable.`);
      return JSON.parse(serialized) as JsonValue;
    } finally {
      plugin.inFlight -= 1;
      if (plugin.inFlight === 0) {
        for (const resolve of plugin.drained) resolve();
        plugin.drained.clear();
      }
    }
  };

  const waitForDrain = async (plugin: ActivePlugin): Promise<void> => {
    if (plugin.inFlight === 0) return;
    const timeoutMs = input.drainTimeoutMs ?? 30_000;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        plugin.drained.delete(onDrained);
        resolve();
      }, timeoutMs);
      const onDrained = () => {
        clearTimeout(timeout);
        resolve();
      };
      plugin.drained.add(onDrained);
    });
  };

  return {
    async activate(manifest, plugin) {
      const methods = new Map<string, RegisteredMethod>();
      const agentTools = new Map<string, PendingAgentTool>();
      const lifecycle = new AbortController();
      const register: SynaraPluginApi["rpc"]["register"] = (method, contract, handler) => {
        if (methods.has(method)) throw new Error(`Duplicate plugin RPC method: ${method}`);
        methods.set(method, {
          contract: contract as PluginRpcContract<unknown, unknown>,
          handler: handler as PluginHandler<unknown, unknown>,
        });
      };
      const registerTool: SynaraPluginApi["agents"]["registerTool"] = (registration) => {
        if (manifest.apiVersion < 2) {
          throw new Error("Plugin agent tools require Synara API version 2.");
        }
        if (!PLUGIN_CONTRIBUTION_ID_PATTERN.test(registration.id)) {
          throw new Error(
            `Plugin agent tool id must match ${PLUGIN_CONTRIBUTION_ID_PATTERN}: ${registration.id}`,
          );
        }
        if (agentTools.has(registration.id)) {
          throw new Error(`Duplicate plugin agent tool: ${registration.id}`);
        }
        if (
          typeof registration.description !== "string" ||
          registration.description.trim() === ""
        ) {
          throw new Error(
            `Plugin agent tool description must be a non-empty string: ${registration.id}`,
          );
        }
        if (
          registration.title !== undefined &&
          (typeof registration.title !== "string" || registration.title.trim() === "")
        ) {
          throw new Error(`Plugin agent tool title must be a non-empty string: ${registration.id}`);
        }
        if (registration.access !== "read" && registration.access !== "write") {
          throw new Error(`Plugin agent tool access must be read or write: ${registration.id}`);
        }
        if (
          typeof registration.contract?.input?.parse !== "function" ||
          typeof registration.contract?.output?.parse !== "function" ||
          typeof registration.execute !== "function"
        ) {
          throw new Error(
            `Plugin agent tool contract and execute handler are required: ${registration.id}`,
          );
        }
        let inputSchema: Readonly<Record<string, JsonValue>>;
        try {
          const serializedSchema = JSON.stringify(registration.contract.input.jsonSchema);
          if (serializedSchema === undefined) throw new Error("Schema is not JSON serializable.");
          const parsedSchema = JSON.parse(serializedSchema) as unknown;
          if (
            typeof parsedSchema !== "object" ||
            parsedSchema === null ||
            Array.isArray(parsedSchema)
          ) {
            throw new Error("Schema root must be an object.");
          }
          inputSchema = parsedSchema as Readonly<Record<string, JsonValue>>;
        } catch (cause) {
          throw new Error(`Plugin agent tool input schema is invalid: ${registration.id}`, {
            cause,
          });
        }
        agentTools.set(registration.id, {
          id: registration.id,
          ...(registration.title === undefined ? {} : { title: registration.title }),
          description: registration.description,
          inputSchema,
          access: registration.access,
          contract: registration.contract as PluginRpcContract<unknown, unknown>,
          execute: registration.execute as PluginHandler<unknown, unknown>,
        });
      };
      const baseStorage =
        typeof input.storage === "function" ? input.storage(manifest.id) : input.storage;
      const baseHost = typeof input.host === "function" ? input.host(manifest.id) : input.host;
      const assertActive = () => lifecycle.signal.throwIfAborted();
      const storage: PluginKvStorage = {
        get: async (key) => {
          assertActive();
          const value = await baseStorage.get(key);
          assertActive();
          return value;
        },
        set: async (key, value) => {
          assertActive();
          await baseStorage.set(key, value);
        },
        delete: async (key) => {
          assertActive();
          await baseStorage.delete(key);
        },
        update: (key, updateValue) => {
          assertActive();
          return baseStorage.update(key, async (current) => {
            assertActive();
            const next = await updateValue(current);
            assertActive();
            return next;
          });
        },
      };
      const host: PluginHostApi = {
        threads: {
          start: async (threadInput) => {
            assertActive();
            return baseHost.threads.start(threadInput);
          },
        },
      };
      plugin({ storage, rpc: { register }, agents: { registerTool } });
      const generation = (nextGeneration += 1);
      const previous = active.get(manifest.id);
      if (previous) {
        previous.accepting = false;
        previous.lifecycle.abort(new Error(`Plugin generation retired: ${manifest.id}`));
        await waitForDrain(previous);
      }
      active.set(manifest.id, {
        manifest,
        generation,
        host,
        methods,
        agentTools: new Map(
          [...agentTools].map(([id, tool]) => [id, { ...tool, pluginId: manifest.id, generation }]),
        ),
        lifecycle,
        accepting: true,
        inFlight: 0,
        drained: new Set(),
      });
      return generation;
    },
    async deactivate(pluginId) {
      const plugin = active.get(pluginId);
      if (!plugin) return false;
      plugin.accepting = false;
      plugin.lifecycle.abort(new Error(`Plugin disabled: ${pluginId}`));
      await waitForDrain(plugin);
      return active.get(pluginId) === plugin && active.delete(pluginId);
    },
    list() {
      return [...active.values()].map(({ manifest, generation }) => ({ ...manifest, generation }));
    },
    listAgentTools() {
      return [...active.values()].flatMap((plugin) =>
        plugin.accepting
          ? [...plugin.agentTools.values()].map(
              ({ contract: _contract, execute: _execute, ...tool }) => tool,
            )
          : [],
      );
    },
    async call(callInput) {
      const plugin = active.get(callInput.pluginId);
      if (!plugin) throw new Error(`Plugin is not active: ${callInput.pluginId}`);
      if (!plugin.accepting || plugin.generation !== callInput.generation) {
        throw new Error(`Plugin generation is stale: ${callInput.pluginId}`);
      }
      const method = plugin.methods.get(callInput.method);
      if (!method) throw new Error(`Plugin RPC method is not registered: ${callInput.method}`);
      return invoke(plugin, method.contract, method.handler, callInput.input, "Plugin RPC output");
    },
    async callAgentTool(callInput) {
      const plugin = active.get(callInput.pluginId);
      if (!plugin) throw new Error(`Plugin is not active: ${callInput.pluginId}`);
      if (!plugin.accepting || plugin.generation !== callInput.generation) {
        throw new Error(`Plugin generation is stale: ${callInput.pluginId}`);
      }
      const tool = plugin.agentTools.get(callInput.toolId);
      if (!tool) throw new Error(`Plugin agent tool is not registered: ${callInput.toolId}`);
      return invoke(
        plugin,
        tool.contract,
        tool.execute,
        callInput.input,
        "Plugin agent tool output",
        {
          ...(callInput.host === undefined ? {} : { host: callInput.host }),
          ...(callInput.signal === undefined ? {} : { signal: callInput.signal }),
        },
      );
    },
  };
}
