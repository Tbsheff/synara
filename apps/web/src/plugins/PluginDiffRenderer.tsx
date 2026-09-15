import type { PluginDiffRendererProps, SynaraPluginAppContext } from "@synara/plugin-sdk/app";
import type { ReactNode } from "react";

import type { ActivePluginContribution } from "./frontendRuntime";
import { PluginContributionErrorBoundary, usePluginContributions } from "./runtime";
import {
  PluginOriginalRenderer,
  PluginOriginalRendererProvider,
} from "./PluginSourceCodeRenderer";

export function selectPluginDiffRenderer(
  renderers: readonly ActivePluginContribution<"diffRenderers">[],
): ActivePluginContribution<"diffRenderers"> | null {
  return renderers[0] ?? null;
}

export function shouldUsePluginDiffRenderer(input: {
  readonly patch: string | null;
  readonly isGitRef: boolean;
}): boolean {
  return input.patch !== null && !input.isGitRef;
}

export function PluginDiffRenderer(props: {
  readonly context: SynaraPluginAppContext;
  readonly patch: string | null;
  readonly path: string;
  readonly isGitRef: boolean;
  readonly original: ReactNode;
}) {
  const renderers = usePluginContributions("diffRenderers");
  const registration = shouldUsePluginDiffRenderer(props)
    ? selectPluginDiffRenderer(renderers)
    : null;
  if (!registration || props.patch === null) return props.original;

  const Renderer = registration.component;
  const rendererProps: PluginDiffRendererProps = {
    context: props.context,
    plugin: registration.plugin,
    patch: props.patch,
    path: props.path,
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
        <Renderer {...rendererProps} />
      </PluginContributionErrorBoundary>
    </PluginOriginalRendererProvider>
  );
}
