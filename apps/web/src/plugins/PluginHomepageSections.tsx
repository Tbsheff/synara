import type { SynaraPluginAppContext } from "@synara/plugin-sdk/app";

import { cn } from "~/lib/utils";

import { PluginPanelActionList, usePluginPanelActions } from "./PluginPanelActions";
import { PluginContributionErrorBoundary, usePluginContributions } from "./runtime";

export function PluginHomepageSections(props: {
  readonly className?: string;
  readonly context: SynaraPluginAppContext;
}) {
  const sections = usePluginContributions("homepageSections");
  const actions = usePluginPanelActions("new-thread");
  if (sections.length === 0 && actions.length === 0) return null;

  return (
    <div className={cn("flex w-full flex-col gap-3", props.className)}>
      {actions.length > 0 ? (
        <div className="flex justify-center">
          <PluginPanelActionList
            actions={actions}
            context={props.context}
            scope="new-thread"
          />
        </div>
      ) : null}
      {sections.map((section) => {
        const Section = section.component;
        return (
          <PluginContributionErrorBoundary
            key={`${section.plugin.id}:${section.id}:${section.plugin.generation}`}
            plugin={section.plugin}
            contributionId={section.id}
            fallback={null}
          >
            <section className="rounded-xl border bg-card p-4 text-left">
              <h3 className="text-sm font-medium">{section.title}</h3>
              {section.description ? (
                <p className="mt-1 text-xs text-muted-foreground">{section.description}</p>
              ) : null}
              <div className="mt-3">
                <Section context={props.context} plugin={section.plugin} />
              </div>
            </section>
          </PluginContributionErrorBoundary>
        );
      })}
    </div>
  );
}
