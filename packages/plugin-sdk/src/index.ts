export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface PluginSchema<Value> {
  readonly parse: (input: unknown, path?: string) => Value;
}

export function schema<Value>(parse: PluginSchema<Value>["parse"]): PluginSchema<Value> {
  return { parse };
}

export function string(): PluginSchema<string> {
  return {
    parse(input, path = "value") {
      if (typeof input !== "string") throw new Error(`${path} must be a string.`);
      return input;
    },
  };
}

export function nonEmptyString(options: { readonly maxLength?: number } = {}): PluginSchema<string> {
  return {
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

export function optional<Value>(schema: PluginSchema<Value>): PluginSchema<Value | undefined> {
  return {
    parse(input, path) {
      return input === undefined ? undefined : schema.parse(input, path);
    },
  };
}

export function literal<const Value extends JsonPrimitive>(value: Value): PluginSchema<Value> {
  return {
    parse(input, path = "value") {
      if (input !== value) throw new Error(`${path} must be ${JSON.stringify(value)}.`);
      return value;
    },
  };
}

export function array<Value>(schema: PluginSchema<Value>): PluginSchema<Value[]> {
  return {
    parse(input, path = "value") {
      if (!Array.isArray(input)) throw new Error(`${path} must be an array.`);
      return input.map((entry, index) => schema.parse(entry, `${path}[${index}]`));
    },
  };
}

export function object<Shape extends Readonly<Record<string, PluginSchema<unknown>>>>(
  shape: Shape,
): PluginSchema<{ [Key in keyof Shape]: Shape[Key] extends PluginSchema<infer Value> ? Value : never }> {
  return {
    parse(input, path = "value") {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error(`${path} must be an object.`);
      }
      const source = input as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(shape).map(([key, schema]) => [key, schema.parse(source[key], `${path}.${key}`)]),
      ) as { [Key in keyof Shape]: Shape[Key] extends PluginSchema<infer Value> ? Value : never };
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
}

type RpcHandler<Input, Output> = (input: Input, call: PluginCall) => Promise<Output>;

export interface SynaraPluginApi {
  readonly storage: PluginKvStorage;
  readonly rpc: {
    readonly register: <Input, Output>(
      method: string,
      contract: PluginRpcContract<Input, Output>,
      handler: RpcHandler<Input, Output>,
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
  readonly apiVersion: 1;
  readonly app?: string;
  readonly appUrl?: string;
  readonly appCssUrl?: string;
  readonly editable?: boolean;
  readonly sourcePath?: string;
}

interface RegisteredMethod {
  readonly contract: PluginRpcContract<unknown, unknown>;
  readonly handler: RpcHandler<unknown, unknown>;
}

interface ActivePlugin {
  readonly manifest: SynaraPluginManifest;
  readonly generation: number;
  readonly methods: ReadonlyMap<string, RegisteredMethod>;
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
}

export function createPluginRegistry(input: {
  readonly host: PluginHostApi | ((pluginId: string) => PluginHostApi);
  readonly storage: PluginKvStorage | ((pluginId: string) => PluginKvStorage);
}): PluginRegistry {
  const active = new Map<string, ActivePlugin>();
  let nextGeneration = 0;

  return {
    async activate(manifest, plugin) {
      const methods = new Map<string, RegisteredMethod>();
      const register: SynaraPluginApi["rpc"]["register"] = (method, contract, handler) => {
        if (methods.has(method)) throw new Error(`Duplicate plugin RPC method: ${method}`);
        methods.set(method, {
          contract: contract as PluginRpcContract<unknown, unknown>,
          handler: handler as RpcHandler<unknown, unknown>,
        });
      };
      const storage = typeof input.storage === "function" ? input.storage(manifest.id) : input.storage;
      plugin({ storage, rpc: { register } });
      const generation = (nextGeneration += 1);
      const previous = active.get(manifest.id);
      if (previous) {
        previous.accepting = false;
        if (previous.inFlight > 0) {
          await new Promise<void>((resolve) => previous.drained.add(resolve));
        }
      }
      active.set(manifest.id, {
        manifest,
        generation,
        methods,
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
      if (plugin.inFlight > 0) {
        await new Promise<void>((resolve) => plugin.drained.add(resolve));
      }
      return active.get(pluginId) === plugin && active.delete(pluginId);
    },
    list() {
      return [...active.values()].map(({ manifest, generation }) => ({ ...manifest, generation }));
    },
    async call(callInput) {
      const plugin = active.get(callInput.pluginId);
      if (!plugin) throw new Error(`Plugin is not active: ${callInput.pluginId}`);
      if (!plugin.accepting || plugin.generation !== callInput.generation) {
        throw new Error(`Plugin generation is stale: ${callInput.pluginId}`);
      }
      const method = plugin.methods.get(callInput.method);
      if (!method) throw new Error(`Plugin RPC method is not registered: ${callInput.method}`);
      const parsedInput = method.contract.input.parse(callInput.input, "input");
      const host = typeof input.host === "function" ? input.host(callInput.pluginId) : input.host;
      plugin.inFlight += 1;
      try {
        const output = await method.handler(parsedInput, {
          pluginId: callInput.pluginId,
          generation: callInput.generation,
          host,
        });
        const parsedOutput = method.contract.output.parse(output, "output");
        const serialized = JSON.stringify(parsedOutput);
        if (serialized === undefined) throw new Error("Plugin RPC output must be JSON serializable.");
        return JSON.parse(serialized) as JsonValue;
      } finally {
        plugin.inFlight -= 1;
        if (plugin.inFlight === 0) {
          for (const resolve of plugin.drained) resolve();
          plugin.drained.clear();
        }
      }
    },
  };
}
