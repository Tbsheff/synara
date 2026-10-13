// FILE: SettingsSidebarNav.tsx
// Purpose: Settings section sidebar navigation with central icons and reference-style pill rows.
//          Doubles as a settings search surface: typing swaps the section list for ranked
//          row matches (same behavior as the editor file search), each jumping to its section.
// Layer: UI component
// Exports: SettingsSidebarNav

import { type KeyboardEvent as ReactKeyboardEvent, useId, useRef, useState } from "react";

import { CentralIcon } from "~/lib/central-icons";
import { cn } from "~/lib/utils";
import { Badge } from "./ui/badge";
import { SearchInput } from "./ui/search-input";
import { SidebarLeadingIcon } from "./SidebarLeadingIcon";
import {
  EXPLORER_ROW_PROPS,
  nextExplorerRowIndex,
  useExplorerListNavigation,
} from "./chat/explorerListNavigation";
import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_NAV_ITEMS,
  type SettingsSectionId,
} from "../settingsNavigation";
import {
  rankSettingsSearchEntries,
  settingsSearchEntryTarget,
  settingsSectionLabel,
  type SettingsSearchContext,
  type SettingsSearchEntry,
} from "../settingsSearchIndex";
import {
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
  SIDEBAR_THREAD_ROW_BASE_CLASS_NAME,
} from "../sidebarRowStyles";
import {
  SETTINGS_SIDEBAR_ICON_CLASS_NAME,
  SETTINGS_SIDEBAR_ITEM_CLASS_NAME,
  SETTINGS_SIDEBAR_ITEM_LABEL_CLASS_NAME,
  SETTINGS_SIDEBAR_LIST_GAP_CLASS_NAME,
  SETTINGS_SIDEBAR_ROW_FILL_ACTIVE_CLASS_NAME,
  SETTINGS_SIDEBAR_ROW_FILL_HOVER_CLASS_NAME,
  SETTINGS_SIDEBAR_SECTION_CLASS_NAME,
  SETTINGS_SIDEBAR_SECTION_LABEL_CLASS_NAME,
} from "../settingsSidebarNavStyles";

// Cap the result list so a broad query stays a quick scan rather than a wall of rows.
const SETTINGS_SEARCH_RESULTS_LIMIT = 12;

const SETTINGS_SECTION_ICON_BY_ID = new Map<SettingsSectionId, string>(
  SETTINGS_NAV_ITEMS.map((item) => [item.id, item.icon]),
);

function SettingsSearchResultRow(props: {
  entry: SettingsSearchEntry;
  selected: boolean;
  id: string;
  onFocus: () => void;
  onSelect: (entry: SettingsSearchEntry) => void;
}) {
  const { entry, onSelect } = props;
  const icon = SETTINGS_SECTION_ICON_BY_ID.get(entry.section) ?? "settings-gear-4";
  // Mirrors the project header + nested thread layout: the section reuses the nav row
  // (muted icon + label) and the matched setting sits below as an indented thread-style row.
  return (
    <li role="presentation">
      <button
        {...EXPLORER_ROW_PROPS}
        type="button"
        id={props.id}
        role="option"
        aria-selected={props.selected}
        onFocus={props.onFocus}
        className={cn(
          "w-full min-w-0 rounded-md text-left outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          props.selected
            ? SETTINGS_SIDEBAR_ROW_FILL_ACTIVE_CLASS_NAME
            : SIDEBAR_ROW_HOVER_CLASS_NAME,
        )}
        onClick={() => onSelect(entry)}
      >
        <span className={SETTINGS_SIDEBAR_ITEM_CLASS_NAME}>
          <SidebarLeadingIcon size="sm" tone="text-inherit">
            <CentralIcon name={icon} className={SETTINGS_SIDEBAR_ICON_CLASS_NAME} />
          </SidebarLeadingIcon>
          <span className={SETTINGS_SIDEBAR_ITEM_LABEL_CLASS_NAME}>
            {settingsSectionLabel(entry.section)}
          </span>
        </span>
        <span
          className={cn(
            SIDEBAR_THREAD_ROW_BASE_CLASS_NAME,
            SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
            "flex items-center",
          )}
        >
          <span className="min-w-0 truncate">{entry.title}</span>
        </span>
      </button>
    </li>
  );
}

export function SettingsSidebarNav(props: {
  activeSection: SettingsSectionId;
  onSelectSection: (section: SettingsSectionId, options?: { target?: string }) => void;
  /**
   * Which conditionally-rendered rows exist on this machine, so the search
   * cannot offer a row the panel does not draw. Passed in rather than read here:
   * this component is a pure nav, and the one fact it needs is owned by a
   * surface that already has it.
   */
  searchContext?: SettingsSearchContext | undefined;
}) {
  const { onSelectSection } = props;
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsId = useId();
  const handleListKeyDown = useExplorerListNavigation();
  const trimmedQuery = query.trim();
  const isSearching = trimmedQuery.length > 0;
  const results = rankSettingsSearchEntries(
    trimmedQuery,
    SETTINGS_SEARCH_RESULTS_LIMIT,
    props.searchContext,
  );
  const selectedEntry = results.find((entry) => entry.id === selectedId) ?? results[0];
  const resultId = (entry: SettingsSearchEntry) => `${resultsId}-${entry.id}`;

  const handleSelectResult = (entry: SettingsSearchEntry) => {
    const target = settingsSearchEntryTarget(entry);
    onSelectSection(entry.section, target ? { target } : undefined);
    setQuery("");
    setSelectedId(null);
    searchRef.current?.focus();
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!selectedEntry) return;
      const index = results.indexOf(selectedEntry);
      const next = results[nextExplorerRowIndex(event.key, index, results.length)];
      if (next) {
        event.preventDefault();
        const row = document.getElementById(resultId(next));
        row?.focus();
        row?.scrollIntoView({ block: "nearest" });
      }
      return;
    }
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (selectedEntry) {
        handleSelectResult(selectedEntry);
      }
      return;
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && query.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
      setSelectedId(null);
      searchRef.current?.focus();
      return;
    }
    if (isSearching) handleListKeyDown(event);
  };

  return (
    <div className="px-1.5 py-1.5" onKeyDown={handleKeyDown}>
      <div className="mb-3 px-1">
        <SearchInput
          ref={searchRef}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={isSearching && results.length > 0}
          aria-controls={isSearching && results.length > 0 ? resultsId : undefined}
          aria-activedescendant={selectedEntry ? resultId(selectedEntry) : undefined}
          shape="capsule"
          value={query}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          placeholder="Search settings..."
          aria-label="Search settings"
          onFocus={() => setSelectedId(null)}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedId(null);
          }}
          onKeyDown={handleSearchKeyDown}
        />
      </div>

      {isSearching ? (
        results.length === 0 ? (
          <p role="status" className={SETTINGS_SIDEBAR_SECTION_LABEL_CLASS_NAME}>
            No matching settings.
          </p>
        ) : (
          <ul
            id={resultsId}
            role="listbox"
            aria-label="Settings search results"
            className={cn("flex flex-col", SETTINGS_SIDEBAR_LIST_GAP_CLASS_NAME)}
          >
            {results.map((entry) => (
              <SettingsSearchResultRow
                key={entry.id}
                entry={entry}
                id={resultId(entry)}
                selected={selectedEntry?.id === entry.id}
                onFocus={() => setSelectedId(entry.id)}
                onSelect={handleSelectResult}
              />
            ))}
          </ul>
        )
      ) : (
        <nav aria-label="Settings sections" className="flex flex-col">
          {SETTINGS_NAV_GROUPS.map((group) => {
            const items = SETTINGS_NAV_ITEMS.filter((item) => item.group === group.id);
            if (items.length === 0) {
              return null;
            }

            return (
              <section
                key={group.id}
                aria-labelledby={`settings-nav-${group.id}`}
                className={SETTINGS_SIDEBAR_SECTION_CLASS_NAME}
              >
                <h2
                  id={`settings-nav-${group.id}`}
                  className={SETTINGS_SIDEBAR_SECTION_LABEL_CLASS_NAME}
                >
                  {group.label}
                </h2>
                <ul className={cn("flex flex-col", SETTINGS_SIDEBAR_LIST_GAP_CLASS_NAME)}>
                  {items.map((item) => {
                    const isActive = item.id === props.activeSection;
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          aria-current={isActive ? "page" : undefined}
                          className={cn(
                            SETTINGS_SIDEBAR_ITEM_CLASS_NAME,
                            isActive
                              ? SETTINGS_SIDEBAR_ROW_FILL_ACTIVE_CLASS_NAME
                              : SETTINGS_SIDEBAR_ROW_FILL_HOVER_CLASS_NAME,
                          )}
                          onClick={() => props.onSelectSection(item.id)}
                        >
                          <SidebarLeadingIcon size="sm" tone="text-inherit">
                            <CentralIcon
                              name={item.icon}
                              className={SETTINGS_SIDEBAR_ICON_CLASS_NAME}
                            />
                          </SidebarLeadingIcon>
                          <span className={SETTINGS_SIDEBAR_ITEM_LABEL_CLASS_NAME}>
                            {item.label}
                          </span>
                          {item.badge ? (
                            <Badge
                              variant="outline"
                              size="sm"
                              className="ml-auto rounded-full px-1.5 font-normal text-muted-foreground"
                            >
                              {item.badge}
                            </Badge>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </nav>
      )}
    </div>
  );
}
