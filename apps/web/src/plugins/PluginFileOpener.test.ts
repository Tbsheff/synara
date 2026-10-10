import type { SynaraPluginDescriptor } from "@synara/contracts";
import type { PluginFileOpenerProps } from "@synara/plugin-sdk/app";
import { describe, expect, it } from "vitest";

import type { ActivePluginContribution } from "./frontendRuntime";
import {
  normalizePluginFileExtension,
  resolvePluginFileSource,
  selectPluginFileOpener,
} from "./PluginFileOpener";

const Component = (_props: PluginFileOpenerProps) => null;
const plugin: SynaraPluginDescriptor = {
  id: "acme.files",
  displayName: "Acme Files",
  version: "1.0.0",
  apiVersion: 2,
  generation: 1,
  app: "acme-files",
};

function opener(
  id: string,
  extensions: readonly string[],
): ActivePluginContribution<"fileOpeners"> {
  return { id, title: id, extensions, component: Component, plugin };
}

describe("PluginFileOpener selection", () => {
  it("normalizes the final path extension", () => {
    expect(normalizePluginFileExtension("src/components/Card.TSX")).toBe("tsx");
    expect(normalizePluginFileExtension("src.with.dot\\README.MD")).toBe("md");
    expect(normalizePluginFileExtension("src/no-extension")).toBeNull();
  });

  it("chooses the first active registration that matches the extension", () => {
    const first = opener("first", ["md", "mdx"]);
    const second = opener("second", ["md"]);

    expect(selectPluginFileOpener([first, second], "README.MD")).toBe(first);
    expect(selectPluginFileOpener([first, second], "README.txt")).toBeNull();
  });

  it("classifies workspace, host, and thread-storage paths", () => {
    expect(resolvePluginFileSource("src/index.ts")).toBe("workspace");
    expect(resolvePluginFileSource("/tmp/report.txt")).toBe("host");
    expect(resolvePluginFileSource("/tmp/synara-codex-workspaces/thread/report.txt")).toBe(
      "thread-storage",
    );
  });
});
