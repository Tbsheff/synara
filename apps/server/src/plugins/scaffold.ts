import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function pluginName(target: string): string {
  const name = path
    .basename(path.resolve(target))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-");
  if (!name || name === "." || name === "-") throw new Error("Plugin name is not valid.");
  return name;
}

function write(target: string, contents: string) {
  writeFileSync(target, contents, { flag: "wx" });
}

function writeLocalPluginSdk(sourceRoot: string): void {
  const sdkRoot = path.join(sourceRoot, ".synara-sdk");
  const sdkSourceRoot = path.join(sdkRoot, "src");
  mkdirSync(sdkSourceRoot, { recursive: true });
  write(
    path.join(sdkRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "@synara/plugin-sdk",
        version: "0.1.0",
        private: true,
        type: "module",
        exports: {
          ".": "./src/index.ts",
          "./app": "./src/app.ts",
        },
        peerDependencies: { react: "^19.0.0" },
      },
      null,
      2,
    )}\n`,
  );
  for (const [specifier, fileName] of [
    ["@synara/plugin-sdk", "index.ts"],
    ["@synara/plugin-sdk/app", "app.ts"],
  ] as const) {
    const entry = fileURLToPath(import.meta.resolve(specifier));
    write(path.join(sdkSourceRoot, fileName), readFileSync(entry, "utf8"));
  }
}

export function scaffoldPlugin(target: string): {
  readonly id: string;
  readonly sourceRoot: string;
} {
  const sourceRoot = path.resolve(target);
  if (existsSync(sourceRoot)) throw new Error(`Plugin path already exists: ${sourceRoot}`);
  const name = pluginName(sourceRoot);
  const id = `@local/synara-plugin-${name}`;
  mkdirSync(path.join(sourceRoot, "src"), { recursive: true });
  mkdirSync(path.join(sourceRoot, "skills", name), { recursive: true });
  writeLocalPluginSdk(sourceRoot);

  write(
    path.join(sourceRoot, "package.json"),
    `${JSON.stringify(
      {
        name: id,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: {
          typecheck: "tsc --noEmit",
        },
        synara: {
          displayName: name.replace(
            /(^|-)([a-z])/g,
            (_, prefix: string, letter: string) => `${prefix ? " " : ""}${letter.toUpperCase()}`,
          ),
          apiVersion: 2,
          server: "./src/server.ts",
          app: "./src/app.tsx",
          skills: ["./skills"],
        },
        dependencies: {
          "@synara/plugin-sdk": "file:./.synara-sdk",
          react: "^19.0.0",
        },
        devDependencies: {
          "@types/react": "^19.0.0",
          typescript: "^5.9.0",
        },
      },
      null,
      2,
    )}\n`,
  );
  write(
    path.join(sourceRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          jsx: "react-jsx",
          noEmit: true,
        },
        include: ["src", "skills"],
      },
      null,
      2,
    )}\n`,
  );
  write(
    path.join(sourceRoot, "src", "contract.ts"),
    'import { object, string } from "@synara/plugin-sdk";\n\nexport const pluginContract = {\n  read: { input: object({}), output: object({ text: string() }) },\n  save: { input: object({ text: string() }), output: object({ text: string() }) },\n} as const;\n',
  );
  write(
    path.join(sourceRoot, "src", "server.ts"),
    'import { definePlugin } from "@synara/plugin-sdk";\n\nimport { pluginContract } from "./contract";\n\nexport default definePlugin((synara) => {\n  const save = async ({ text }: ReturnType<typeof pluginContract.save.input.parse>) => {\n    await synara.storage.set("text", text);\n    return { text };\n  };\n\n  synara.rpc.register("read", pluginContract.read, async () => ({ text: String((await synara.storage.get("text")) ?? "") }));\n  synara.rpc.register("save", pluginContract.save, save);\n  synara.agents.registerTool({\n    id: "save-note",\n    title: "Save plugin note",\n    description: "Save text in this plugin.",\n    access: "write",\n    contract: pluginContract.save,\n    execute: save,\n  });\n});\n',
  );
  write(
    path.join(sourceRoot, "src", "app.tsx"),
    `import { definePluginApp, usePluginRpc, usePluginRuntime, type PluginNavPanelProps } from "@synara/plugin-sdk/app";\nimport { useEffect, useState } from "react";\n\nimport { pluginContract } from "./contract";\n\nfunction ${name.replace(/(^|-)([a-z])/g, (_, _prefix: string, letter: string) => letter.toUpperCase())}Panel({ context, plugin }: PluginNavPanelProps) {\n  const call = usePluginRpc(plugin);\n  const runtime = usePluginRuntime();\n  const [text, setText] = useState("");\n  const [status, setStatus] = useState("");\n  useEffect(() => { void call("read", pluginContract.read, {}).then((value) => setText(value.text)); }, [call]);\n  return <main className="chat-content-card flex min-h-0 flex-1 flex-col overflow-hidden bg-background">\n    <header className="flex items-center justify-between gap-4 border-b px-6 py-4">\n      <div><h1 className="text-base font-semibold">${name}</h1><p className="mt-1 text-sm text-muted-foreground">A local Synara plugin.</p></div>\n      <button type="button" className="rounded-md border px-3 py-2 text-sm font-medium" disabled={!context.projectId} onClick={() => context.projectId && void runtime.editPlugin({ plugin, projectId: context.projectId }).then(({ threadId }) => runtime.navigate(\`/\${threadId}\`))}>Edit in chat</button>\n    </header>\n    <div className="mx-auto grid w-full max-w-3xl gap-3 p-6">\n      <textarea className="min-h-40 rounded-md border bg-background p-3" value={text} onChange={(event) => setText(event.target.value)} />\n      <button type="button" className="justify-self-end rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground" onClick={() => void call("save", pluginContract.save, { text }).then(() => setStatus("Saved"))}>Save</button>\n      {status ? <p className="text-sm text-muted-foreground">{status}</p> : null}\n    </div>\n  </main>;\n}\n\nexport default definePluginApp((app) => app.slots.navPanel({ id: "main", title: "${name}", component: ${name.replace(/(^|-)([a-z])/g, (_, _prefix: string, letter: string) => letter.toUpperCase())}Panel }));\n`,
  );
  write(
    path.join(sourceRoot, "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: Use when work needs the ${name} Synara plugin.\n---\n\n# ${name}\n\nUse the plugin panel and its public RPC methods. Keep changes inside this plugin package.\n`,
  );

  return { id, sourceRoot };
}
