import { providerSupportsPlanMode } from "~/lib/runtimeMode";
// FILE: KanbanTaskExtrasMenu.tsx
// Purpose: Compact plus-menu for kanban task mode/environment toggles.
// Layer: Kanban UI component
// Exports: KanbanTaskExtrasMenu

import type { ProviderInteractionMode, ProviderKind } from "@synara/contracts";

import {
  ComposerPickerMenuPopup,
  ComposerPickerMenuSubPopup,
} from "~/components/chat/ComposerPickerMenuPopup";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { CentralIcon } from "~/lib/central-icons";
import { BugIcon, ListTodoIcon, MessageCircleIcon, PlusIcon, WorktreeIcon } from "~/lib/icons";
import type { DraftThreadEnvMode } from "../../composerDraftStore";

interface KanbanTaskExtrasMenuProps {
  readonly provider: ProviderKind;
  readonly interactionMode: ProviderInteractionMode;
  readonly onInteractionModeChange: (mode: ProviderInteractionMode) => void;
  readonly envMode: DraftThreadEnvMode;
  readonly environmentDisabled?: boolean;
  readonly onEnvModeChange: (mode: DraftThreadEnvMode) => void;
}

/**
 * The composer `+` analog: a single chrome icon button hosting the task's quick
 * toggles (Plan mode and Local/Worktree environment), mirroring how the
 * composer's ComposerExtrasMenu collapses mode switches behind one `+`.
 */
export function KanbanTaskExtrasMenu({
  provider,
  interactionMode,
  onInteractionModeChange,
  envMode,
  onEnvModeChange,
  environmentDisabled = false,
}: KanbanTaskExtrasMenuProps) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-sm"
            variant="chrome"
            className="shrink-0 rounded-md"
            aria-label="Task options"
          />
        }
      >
        <PlusIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start">
        <MenuSub>
          <MenuSubTrigger>Mode</MenuSubTrigger>
          <ComposerPickerMenuSubPopup>
            <MenuRadioGroup
              value={interactionMode}
              onValueChange={(value) => {
                if (value === "plan" && !providerSupportsPlanMode(provider)) return;
                if (value === "default" || value === "plan" || value === "debug") {
                  onInteractionModeChange(value);
                }
              }}
            >
              <MenuRadioItem value="default">
                <span className="inline-flex items-center gap-2">
                  <MessageCircleIcon className="size-4 shrink-0" />
                  Default
                </span>
              </MenuRadioItem>
              {providerSupportsPlanMode(provider) ? (
                <MenuRadioItem value="plan">
                  <span className="inline-flex items-center gap-2">
                    <ListTodoIcon className="size-4 shrink-0" />
                    Plan
                  </span>
                </MenuRadioItem>
              ) : null}
              <MenuRadioItem value="debug">
                <span className="inline-flex items-center gap-2">
                  <BugIcon className="size-4 shrink-0" />
                  Debug
                </span>
              </MenuRadioItem>
            </MenuRadioGroup>
          </ComposerPickerMenuSubPopup>
        </MenuSub>
        <MenuSeparator />
        <MenuRadioGroup
          value={envMode}
          onValueChange={(value) => {
            if (!environmentDisabled && (value === "local" || value === "worktree")) {
              onEnvModeChange(value);
            }
          }}
        >
          <MenuRadioItem value="local" disabled={environmentDisabled}>
            <span className="inline-flex items-center gap-2">
              <CentralIcon name="macbook-air" className="size-4 shrink-0" />
              Local
            </span>
          </MenuRadioItem>
          <MenuRadioItem value="worktree" disabled={environmentDisabled}>
            <span className="inline-flex items-center gap-2">
              <WorktreeIcon className="size-4 shrink-0" aria-hidden />
              Worktree
            </span>
          </MenuRadioItem>
        </MenuRadioGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
