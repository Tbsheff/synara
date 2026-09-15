import { definePluginApp, type SynaraPluginAppApi } from "@synara/plugin-sdk/app";
import { describe, expect, it } from "vitest";

import { collectPluginAppRegistrations } from "./registrations";

const Component = () => null;
const run = () => undefined;

describe("collectPluginAppRegistrations", () => {
  it("collects every frontend extension surface", () => {
    const app = definePluginApp((api) => {
      api.slots.homepageSection({ id: "home", title: "Home", component: Component });
      api.slots.settingsSection({ id: "settings", component: Component });
      api.slots.experimental_appOverlay({ id: "overlay", component: Component });
      api.slots.navPanel({ id: "nav", title: "Nav", component: Component });
      api.slots.threadPanelAction({ id: "thread-panel", title: "Panel", component: Component, run });
      api.slots.experimental_newThreadPanelAction({
        id: "new-panel",
        title: "New panel",
        component: Component,
        run,
      });
      api.slots.pendingInteraction({ id: "interaction", component: Component });
      api.slots.sidebarFooterAction({ id: "footer-action", title: "Footer", icon: "star", run });
      api.slots.experimental_sidebarNavigation({
        id: "navigation",
        title: "Navigation",
        component: Component,
      });
      api.slots.experimental_threadList({ id: "threads", title: "Threads", component: Component });
      api.slots.experimental_threadHeaderAction({
        id: "header",
        title: "Header",
        component: Component,
      });
      api.slots.experimental_browserToolbarAction({
        id: "browser",
        title: "Browser",
        component: Component,
      });
      api.slots.fileOpener({
        id: "files",
        title: "Files",
        extensions: [".MD", "TsX"],
        component: Component,
      });
      api.slots.experimental_sourceCodeRenderer({
        id: "source",
        title: "Source",
        component: Component,
      });
      api.slots.experimental_diffRenderer({ id: "diff", title: "Diff", component: Component });
      api.slots.messageDirective({ id: "review-card", component: Component });
      api.slots.messageAction({ id: "message", title: "Message", icon: "copy", run });
      api.slots.commandPaletteAction({ id: "legacy-command", title: "Legacy", run });
      api.slots.experimental_providerIcon({
        providerKind: "agent",
        providerId: "codex",
        icon: Component,
      });
      api.slots.experimental_timelineRenderer({ kind: "tool", component: Component });
      api.slots.experimental_environmentProviderInputs({
        environmentProviderId: "worktree",
        component: Component,
      });
      api.slots.experimental_machineProviderInputs({
        machineProviderId: "local",
        component: Component,
      });
      api.composer.customize({
        id: "composer",
        actions: [{ id: "action", title: "Action", run }],
        banners: [{ id: "banner", component: Component }],
        plusMenu: [{ id: "menu", title: "Menu", run }],
        richText: {
          effects: [{ id: "mention", match: () => [], className: "mention" }],
          onDraftChange: run,
        },
      });
      api.contentScripts.register({ id: "script", mount: run });
      api.commands.register({ id: "command", title: "Command", run, isAvailable: () => true });
      api.experimental_sidebarFooter.register({
        kind: "action",
        id: "footer-item",
        title: "Footer item",
        icon: "bolt",
        run,
      });
      api.experimental_sidebarFooter.register({
        kind: "disclosure",
        id: "footer-disclosure",
        title: "Footer disclosure",
        icon: "info",
        component: Component,
      });
      api.experimental_icons.register({ name: "acme-logo", component: Component });
    });

    const registrations = collectPluginAppRegistrations("acme.plugin", app, "/plugin.js");

    expect(Object.values(registrations).filter(Array.isArray)).toHaveLength(26);
    expect(registrations.pluginId).toBe("acme.plugin");
    expect(registrations.appUrl).toBe("/plugin.js");
    expect(registrations.navPanels.map(({ id }) => id)).toEqual(["nav"]);
    expect(registrations.fileOpeners[0]?.extensions).toEqual(["md", "tsx"]);
    expect(registrations.commands.map(({ id }) => id)).toEqual(["legacy-command", "command"]);
    expect(registrations.sidebarFooterItems.map(({ kind }) => kind)).toEqual([
      "action",
      "disclosure",
    ]);
  });

  it("accepts a legacy setup function", () => {
    const legacy = (api: SynaraPluginAppApi) => {
      api.slots.navPanel({ id: "legacy", title: "Legacy", component: Component });
    };

    expect(collectPluginAppRegistrations("acme.legacy", legacy).navPanels[0]?.id).toBe("legacy");
  });

  it("validates ids, directives, and normalized extensions", () => {
    expect(() =>
      collectPluginAppRegistrations(
        "acme.bad-id",
        definePluginApp((api) => {
          api.slots.navPanel({ id: "has space", title: "Bad", component: Component });
        }),
      ),
    ).toThrow("letters, digits");
    expect(() =>
      collectPluginAppRegistrations(
        "acme.bad-directive",
        definePluginApp((api) => {
          api.slots.messageDirective({ id: "ReviewCard", component: Component });
        }),
      ),
    ).toThrow("lowercase kebab-case");
    expect(() =>
      collectPluginAppRegistrations(
        "acme.bad-extension",
        definePluginApp((api) => {
          api.slots.fileOpener({
            id: "file",
            title: "File",
            extensions: ["../md"],
            component: Component,
          });
        }),
      ),
    ).toThrow("extension");
  });

  it("rejects duplicates within a kind but allows ids across kinds", () => {
    expect(() =>
      collectPluginAppRegistrations(
        "acme.duplicate",
        definePluginApp((api) => {
          api.slots.navPanel({ id: "same", title: "First", component: Component });
          api.slots.navPanel({ id: "same", title: "Second", component: Component });
        }),
      ),
    ).toThrow("Duplicate slots.navPanel id");

    expect(() =>
      collectPluginAppRegistrations(
        "acme.command",
        definePluginApp((api) => {
          api.commands.register({ id: "same", title: "First", run });
          api.slots.commandPaletteAction({ id: "same", title: "Second", run });
        }),
      ),
    ).toThrow("Duplicate commands id");

    expect(() =>
      collectPluginAppRegistrations(
        "acme.cross-kind",
        definePluginApp((api) => {
          api.slots.navPanel({ id: "same", title: "Nav", component: Component });
          api.slots.homepageSection({ id: "same", title: "Home", component: Component });
        }),
      ),
    ).not.toThrow();
  });

  it("does not leak partial registrations after setup fails", () => {
    const failure = definePluginApp((api) => {
      api.slots.navPanel({ id: "partial", title: "Partial", component: Component });
      throw new Error("setup failed");
    });

    expect(() => collectPluginAppRegistrations("acme.atomic", failure)).toThrow("setup failed");
    expect(
      collectPluginAppRegistrations(
        "acme.atomic",
        definePluginApp((api) => {
          api.slots.navPanel({ id: "complete", title: "Complete", component: Component });
        }),
      ).navPanels.map(({ id }) => id),
    ).toEqual(["complete"]);
  });
});
