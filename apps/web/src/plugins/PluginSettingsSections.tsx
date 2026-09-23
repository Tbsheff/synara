import type { SynaraPluginAppContext } from "@synara/plugin-sdk/app";

import { SettingsCard, SettingsEmptyState } from "~/components/settings/SettingsPanelPrimitives";
import {
  SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME,
  SETTINGS_PANEL_SECTION_CLASS_NAME,
  SETTINGS_SECTION_LABEL_CLASS_NAME,
} from "~/settingsPanelStyles";

import type { ActivePluginContribution } from "./frontendRuntime";
import { PluginContributionErrorBoundary, usePluginContributions } from "./runtime";
import { SynaraPluginCatalog } from "./SynaraPluginCatalog";

type ActivePluginSettingsSection = ActivePluginContribution<"settingsSections">;

export function PluginSettingsSectionList({
  context,
  contributions,
}: {
  readonly context: SynaraPluginAppContext;
  readonly contributions: ReadonlyArray<ActivePluginSettingsSection>;
}) {
  if (contributions.length === 0) {
    return <SettingsEmptyState>No extension settings are available.</SettingsEmptyState>;
  }

  return (
    <div className="space-y-6">
      {contributions.map((contribution) => {
        const Component = contribution.component;
        const key = `${contribution.plugin.id}:${contribution.id}:${contribution.plugin.generation}`;
        return (
          <section key={key} className={SETTINGS_PANEL_SECTION_CLASS_NAME}>
            {contribution.title ? (
              <h2 className={SETTINGS_SECTION_LABEL_CLASS_NAME}>{contribution.title}</h2>
            ) : null}
            {contribution.description ? (
              <p className={`${SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME} px-2`}>
                {contribution.description}
              </p>
            ) : null}
            <SettingsCard divided={false} className="p-4">
              <PluginContributionErrorBoundary
                plugin={contribution.plugin}
                contributionId={contribution.id}
                fallback={
                  <SettingsEmptyState layout="status" tone="destructive">
                    {contribution.plugin.displayName} settings could not load.
                  </SettingsEmptyState>
                }
              >
                <Component context={context} plugin={contribution.plugin} />
              </PluginContributionErrorBoundary>
            </SettingsCard>
          </section>
        );
      })}
    </div>
  );
}

export function PluginSettingsSections({ context }: { readonly context: SynaraPluginAppContext }) {
  const contributions = usePluginContributions("settingsSections");
  return (
    <div className="space-y-6">
      <SynaraPluginCatalog context={context} />
      <PluginSettingsSectionList context={context} contributions={contributions} />
    </div>
  );
}
