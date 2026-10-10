import type { PluginSourceCodeRendererProps, SynaraPluginAppContext } from "@synara/plugin-sdk/app";
import { createContext, useContext, type ReactNode } from "react";

import type { ActivePluginContribution } from "./frontendRuntime";
import { PluginContributionErrorBoundary, usePluginContributions } from "./runtime";

const PluginOriginalRendererContext = createContext<ReactNode>(null);

export function PluginOriginalRenderer() {
  return useContext(PluginOriginalRendererContext);
}

export function PluginOriginalRendererProvider(props: {
  readonly children: ReactNode;
  readonly original: ReactNode;
}) {
  return (
    <PluginOriginalRendererContext.Provider value={props.original}>
      {props.children}
    </PluginOriginalRendererContext.Provider>
  );
}

export function selectPluginSourceCodeRenderer(
  renderers: readonly ActivePluginContribution<"sourceCodeRenderers">[],
): ActivePluginContribution<"sourceCodeRenderers"> | null {
  return renderers[0] ?? null;
}

export function PluginSourceCodeRenderer(props: {
  readonly context: SynaraPluginAppContext;
  readonly content: string;
  readonly path: string;
  readonly original: ReactNode;
  readonly enabled: boolean;
}) {
  const renderers = usePluginContributions("sourceCodeRenderers");
  const registration = props.enabled ? selectPluginSourceCodeRenderer(renderers) : null;
  if (!registration) return props.original;

  const Renderer = registration.component;
  const rendererProps: PluginSourceCodeRendererProps = {
    context: props.context,
    plugin: registration.plugin,
    content: props.content,
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
