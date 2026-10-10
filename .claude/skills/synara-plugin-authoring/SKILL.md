---
name: synara-plugin-authoring
description: Create or change Synara app plugins, inspect their source, and manage local plugin activation with the Synara CLI.
---

# Author Synara plugins

Use the installed host contract as the source of truth. Start with:

```bash
synara plugin list --json
synara plugin source <plugin-id> --json
```

In a Synara source checkout where the installed binary is older, run the current CLI entry instead. Put global flags such as `--home-dir` before `plugin`:

```bash
bun apps/server/src/index.ts --home-dir <synara-home> plugin list --json
bun apps/server/src/index.ts --home-dir <synara-home> plugin source <plugin-id> --json
```

Create and install a local plugin package with:

```bash
synara plugin new ./my-plugin
synara plugin install ./my-plugin
```

The package manifest must contain a `synara` block. The scaffold supplies the supported shape:

```json
{
  "name": "@local/synara-plugin-example",
  "version": "0.1.0",
  "type": "module",
  "synara": {
    "displayName": "Example",
    "apiVersion": 2,
    "server": "./src/server.ts",
    "app": "./src/app.tsx",
    "skills": ["./skills"]
  }
}
```

Edit only when `sourceRoot` points to a local directory. Keep server behavior behind `@synara/plugin-sdk`, app behavior behind `@synara/plugin-sdk/app`, and shared transport shapes in the plugin contract. Do not import Synara's stores, database tables, routes, or internal services from a plugin.

Parse plugin input at the RPC boundary. Use plugin-owned storage for plugin state and `storage.update` for read-modify-write work. Start work through the public host API so normal Synara authority, persistence, and orchestration still apply.

Register a chat tool with `synara.agents.registerTool`. Give it a stable lowercase ID, the same checked contract used by RPC, and an `access` value of `read` or `write`. The SDK derives the advertised JSON input schema from the contract. Reuse one handler when the app and chat perform the same action. Synara checks the plugin contract again at invocation. Write tools also require the calling chat's exact active turn and `thread:write` authority.

After an edit, run the plugin's focused tests. Build and ask the active host to load the changed server and app entries:

```bash
synara plugin reload <plugin-id>
```

For a live edit loop, use:

```bash
synara plugin dev ./my-plugin
```

The watcher rebuilds and reloads the plugin after source or skill changes. A failed activation keeps the last active generation. Use `synara plugin disable|enable <plugin-id>` only when the user asks to change activation. Use `synara plugin uninstall <plugin-id>` to remove the install record and copied skills; uninstall never deletes the editable source package.

An app panel can call `runtime.editPlugin({ plugin, projectId })`. Synara starts a normal full-access chat with this skill and the installed source root. Inspect the manifest and current files before changing them. Keep all host access behind the public SDK, test the change, then build and reload it.

Current limits: Synara installs trusted local directories. It does not fetch remote packages, publish a marketplace package, or sandbox plugin code.
