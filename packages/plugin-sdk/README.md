# Synara plugin SDK

This package defines the public boundary for trusted Synara app plugins. A plugin can register validated server RPC methods and chat tools, store namespaced JSON data, add host-owned UI panels, and start threads through Synara's normal orchestration path.

The built-in example is `@synara/plugin-review-queue`. Synara can also build and load trusted plugin packages from local directories. A package can ship a server entry, a web app entry, and one or more skills. Synara keeps React and the plugin SDK shared, so a plugin app does not load its own React copy.

The Review Queue also proves the authoring loop: its **Edit in chat** action starts a normal Synara thread in the active Synara project, loads the `synara-plugin-authoring` skill, and points the agent at `plugins/review-queue`. The chat edits source files with its usual workspace tools; the plugin SDK does not grant a second file-write path.

Use the CLI for the full local loop:

```bash
synara plugin new ./notes
synara plugin build ./notes
synara plugin install ./notes
synara plugin list
synara plugin source @local/synara-plugin-notes
synara plugin dev ./notes
synara plugin reload @local/synara-plugin-notes
synara plugin disable @local/synara-plugin-notes
synara plugin enable @local/synara-plugin-notes
synara plugin uninstall @local/synara-plugin-notes
```

`new` creates a server entry, an app panel, a shared contract, and a skill. `install` builds the package and stores its real source path. `dev` watches source and skill files. `reload` prepares a new generation and keeps the old one active if the new server entry fails. `uninstall` removes the install record and copied skills but does not delete source files. These commands use the same `--home-dir` control file as the running host.

An external package declares its entries in `package.json`:

```json
{
  "name": "@local/synara-plugin-notes",
  "version": "0.1.0",
  "type": "module",
  "synara": {
    "displayName": "Notes",
    "apiVersion": 2,
    "server": "./src/server.ts",
    "app": "./src/app.tsx",
    "skills": ["./skills"]
  }
}
```

Manifest paths must stay inside the package. Plugin IDs use the full package name. Skills are copied into Synara's skill directory while the plugin is active.

## Server entry

```ts
import { definePlugin, object, string } from "@synara/plugin-sdk";

const echo = {
  input: object({ value: string() }),
  output: object({ value: string() }),
};

export default definePlugin((synara) => {
  const runEcho = async ({ value }: { readonly value: string }) => ({ value });
  synara.rpc.register("echo", echo, runEcho);
  synara.agents.registerTool({
    id: "echo",
    title: "Echo value",
    description: "Echo a value through this plugin.",
    access: "read",
    contract: echo,
    execute: runEcho,
  });
});
```

RPC and chat-tool inputs and outputs are checked at run time. A read tool uses the caller's `thread:read` authority. A write tool uses `thread:write` and rechecks the exact calling turn before each host write. The MCP endpoint uses the current handler for a known tool name, but an active provider session can need a restart to discover a new or renamed tool. Storage is scoped to the package ID. Use `storage.update` for read-modify-write work so calls from the same process cannot overwrite each other.

## App entry

```tsx
import { definePluginApp } from "@synara/plugin-sdk/app";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "example",
    title: "Example",
    component: ExamplePanel,
  });
});
```

Panels get public plugin context and RPC hooks. They must not import Synara stores, routes, database types, or server services.

Call `usePluginRuntime().editPlugin({ plugin, projectId })` to start an edit chat for the installed source package. The host starts a normal full-access thread, loads the `synara-plugin-authoring` skill, and includes the exact source root in the first message. The agent edits with its usual workspace tools; the SDK does not add another file-write path.

Plugins run as trusted code in the server process and web app. This API is an ownership boundary, not a security sandbox. Remote install, marketplace publishing, event hooks, provider adapters, and untrusted plugin isolation are not in this version.
