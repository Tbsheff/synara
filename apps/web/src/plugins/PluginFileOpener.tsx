import type { PluginFileOpenerProps, SynaraPluginAppContext } from "@synara/plugin-sdk/app";
import { isLocalAbsolutePath } from "@synara/shared/path";
import { isScratchWorkspacePath } from "@synara/shared/threadWorkspace";
import type { ReactNode } from "react";

import type { ActivePluginContribution } from "./frontendRuntime";
import { PluginContributionErrorBoundary, usePluginContributions } from "./runtime";
import { PluginOriginalRenderer, PluginOriginalRendererProvider } from "./PluginSourceCodeRenderer";

export type PluginFileSource = PluginFileOpenerProps["source"];

export function normalizePluginFileExtension(path: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

export function resolvePluginFileSource(path: string): PluginFileSource {
  if (isScratchWorkspacePath(path)) return "thread-storage";
  return isLocalAbsolutePath(path) ? "host" : "workspace";
}

export function selectPluginFileOpener(
  openers: readonly ActivePluginContribution<"fileOpeners">[],
  path: string,
): ActivePluginContribution<"fileOpeners"> | null {
  const extension = normalizePluginFileExtension(path);
  if (extension === null) return null;
  return openers.find((opener) => opener.extensions.includes(extension)) ?? null;
}

export function PluginFileOpener(props: {
  readonly context: SynaraPluginAppContext;
  readonly path: string;
  readonly source: PluginFileSource;
  readonly original: ReactNode;
  readonly enabled: boolean;
}) {
  const openers = usePluginContributions("fileOpeners");
  const registration = props.enabled ? selectPluginFileOpener(openers, props.path) : null;
  if (!registration) return props.original;

  const Opener = registration.component;
  const openerProps: PluginFileOpenerProps = {
    context: props.context,
    plugin: registration.plugin,
    path: props.path,
    source: props.source,
    Original: PluginOriginalRenderer,
  };

  return (
    <PluginOriginalRendererProvider original={props.original}>
      <PluginContributionErrorBoundary
        key={`${registration.plugin.id}:${registration.id}:${registration.plugin.generation}:${props.path}`}
        plugin={registration.plugin}
        contributionId={registration.id}
        fallback={props.original}
      >
        <Opener {...openerProps} />
      </PluginContributionErrorBoundary>
    </PluginOriginalRendererProvider>
  );
}
