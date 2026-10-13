// FILE: workspaceExplorer.tsx
// Purpose: Shared workspace file-tree explorer + file-search building blocks used
//          by both the full editor view and the right-dock explorer pane.
// Layer: Chat workspace-browsing UI primitives
// Exports: WorkspaceFilesSidebar, WorkspaceSearchSidebar, WorkspaceExplorerSidebar,
//          ExplorerActivityBarButton, useExplorerEntryPrefetch, setFileReferenceDragData.

import type { ProjectEntry, ProjectFileSystemEntry } from "@synara/contracts";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import {
  type ComponentPropsWithoutRef,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  forwardRef,
  useEffect,
  useRef,
  useState,
  useLayoutEffect,
} from "react";

import {
  CHAT_FILE_REFERENCE_DRAG_TYPE,
  formatChatFileReference,
  type ChatFileReference,
} from "~/lib/chatReferences";
import { splitRepoRelativePath } from "~/lib/diffRendering";
import { showFileReferenceContextMenu } from "~/lib/fileReferenceContextMenu";
import {
  projectListDirectoriesQueryOptions,
  projectReadFileQueryOptions,
  projectSearchEntriesQueryOptions,
} from "~/lib/projectReactQuery";
import { getSyntaxHighlighterPromise, getSyntaxLanguageForPath } from "~/lib/syntaxHighlighting";
import { cn } from "~/lib/utils";
import { Skeleton } from "../ui/skeleton";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { SearchInput } from "../ui/search-input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  EXPLORER_ROW_PROPS,
  nextExplorerRowIndex,
  useExplorerListNavigation,
} from "./explorerListNavigation";
import { FileEntryIcon } from "./FileEntryIcon";
import { fileRowClassName, fileRowIndentStyle } from "./fileRowStyles";
import { PanelStateMessage } from "./PanelStateMessage";

const EXPLORER_HIDDEN_DIRECTORY_NAMES = new Set([
  ".cache",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".pnpm-store",
  ".svelte-kit",
  ".turbo",
  ".vite",
  ".yarn",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

// Mirrors the composer mention search: debounce keystrokes so they don't fan
// out into fuzzy-search RPCs, and cap results to keep the sidebar light.
const EXPLORER_SEARCH_QUERY_DEBOUNCE_MS = 120;
const EXPLORER_SEARCH_RESULTS_LIMIT = 80;
const EMPTY_WORKSPACE_SEARCH_FILE_MATCHES: ReadonlyArray<ProjectEntry> = [];

// Default sidebar shell: a full-height column in the editor's wide row layout
// that collapses to a stacked block on narrow viewports. Surfaces with a fixed
// horizontal layout (e.g. the right dock) override this via `containerClassName`.
const EXPLORER_SIDEBAR_CONTAINER_CLASS =
  "flex min-h-[11rem] w-full shrink-0 flex-col border-b border-border/65 app-content-surface lg:h-full lg:w-56 lg:border-b-0 lg:border-r";

// Marks the drag payload so the chat composer can accept it as a reference.
export function setFileReferenceDragData(dataTransfer: DataTransfer, path: string): void {
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(CHAT_FILE_REFERENCE_DRAG_TYPE, formatChatFileReference({ path }));
  dataTransfer.setData("text/plain", path);
}

function shouldShowExplorerEntry(entry: ProjectFileSystemEntry): boolean {
  if (entry.kind !== "directory") {
    return true;
  }
  if (entry.name.startsWith(".synara")) {
    return false;
  }
  return !EXPLORER_HIDDEN_DIRECTORY_NAMES.has(entry.name);
}

/**
 * Warms caches for an explorer entry before it is clicked: directory listings
 * for folders, file contents plus the matching syntax highlighter for files.
 */
export function useExplorerEntryPrefetch(cwd: string | null) {
  const queryClient = useQueryClient();
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (pending.current !== null) clearTimeout(pending.current);
    pending.current = null;
  };
  useEffect(() => cancel, [cwd]);
  return (
    entry: Pick<ProjectFileSystemEntry, "path" | "kind">,
    intent: "hover" | "cancel" | "focus" = "focus",
  ) => {
    cancel();
    if (intent === "cancel") return;
    const prefetch = () => {
      pending.current = null;
      if (!cwd) {
        return;
      }
      if (entry.kind === "directory") {
        void queryClient.prefetchQuery(
          projectListDirectoriesQueryOptions({
            cwd,
            relativePath: entry.path,
            includeFiles: true,
            includeChildHints: false,
          }),
        );
        return;
      }
      void queryClient.prefetchQuery(
        projectReadFileQueryOptions({ cwd, relativePath: entry.path }),
      );
      void getSyntaxHighlighterPromise(getSyntaxLanguageForPath(entry.path)).catch(() => undefined);
    };
    if (intent === "hover") pending.current = setTimeout(prefetch, 180);
    else prefetch();
  };
}

type ExplorerEntryPrefetch = ReturnType<typeof useExplorerEntryPrefetch>;

// Forwards its ref and spreads incoming props so directory rows can act as the
// Collapsible trigger (Base UI injects onClick/aria/data + ref onto this element).
const ExplorerRow = forwardRef<
  HTMLButtonElement,
  {
    entry: ProjectFileSystemEntry;
    depth: number;
    selected: boolean;
    expanded: boolean;
    onSelectFile: (path: string) => void;
    onPrefetchEntry: ExplorerEntryPrefetch;
    onEntryContextMenu: (entry: ProjectFileSystemEntry, position: { x: number; y: number }) => void;
  } & ComponentPropsWithoutRef<"button">
>(function ExplorerRow(
  {
    entry,
    depth,
    selected,
    expanded,
    onSelectFile,
    onPrefetchEntry,
    onEntryContextMenu,
    className,
    onClick,
    ...rest
  },
  ref,
) {
  const isDirectory = entry.kind === "directory";
  // Directory rows are the Collapsible trigger: chain Base UI's injected onClick
  // (which toggles open/close) and skip file selection. File rows open the preview.
  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (isDirectory) {
      return;
    }
    onSelectFile(entry.path);
  };
  const handlePrefetch = () => {
    onPrefetchEntry(entry);
  };
  const handleContextMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    onEntryContextMenu(entry, { x: event.clientX, y: event.clientY });
  };
  const handleDragStart = (event: ReactDragEvent<HTMLButtonElement>) => {
    setFileReferenceDragData(event.dataTransfer, entry.path);
  };

  return (
    <button
      {...rest}
      {...EXPLORER_ROW_PROPS}
      data-explorer-path={entry.path}
      ref={ref}
      type="button"
      className={fileRowClassName(selected, cn("h-7 pr-2", className))}
      style={fileRowIndentStyle(depth)}
      title={entry.path}
      draggable
      onDragStart={handleDragStart}
      onClick={handleClick}
      onPointerEnter={() => onPrefetchEntry(entry, "hover")}
      onPointerLeave={() => onPrefetchEntry(entry, "cancel")}
      onBlur={() => onPrefetchEntry(entry, "cancel")}
      onFocus={handlePrefetch}
      onContextMenu={handleContextMenu}
    >
      {isDirectory ? (
        <DisclosureChevron open={expanded} className="opacity-75" />
      ) : (
        <FileEntryIcon
          pathValue={entry.path}
          kind={entry.kind}
          className="size-3.5 shrink-0 opacity-75"
        />
      )}
      <span className="min-w-0 truncate">{entry.name}</span>
    </button>
  );
});

const EXPLORER_SKELETON_ROW_WIDTHS = ["w-9/12", "w-6/12", "w-7/12"];

function ExplorerLoadingRows(props: { depth: number }) {
  return (
    <div
      className="space-y-1.5 py-1.5 pr-2"
      style={fileRowIndentStyle(props.depth)}
      role="status"
      aria-label="Loading directory..."
    >
      {EXPLORER_SKELETON_ROW_WIDTHS.map((width) => (
        <div key={width} className="flex h-5 items-center gap-1.5">
          <Skeleton className="size-3.5 shrink-0 rounded-sm" />
          <Skeleton className={cn("h-3 rounded-full", width)} />
        </div>
      ))}
    </div>
  );
}

function WorkspaceDirectory(props: {
  cwd: string;
  relativePath: string | null;
  depth: number;
  selectedFilePath: string | null;
  expandedDirectories: ReadonlySet<string>;
  onSelectFile: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  onPrefetchEntry: ExplorerEntryPrefetch;
  onEntryContextMenu: (entry: ProjectFileSystemEntry, position: { x: number; y: number }) => void;
}) {
  const query = useQuery(
    projectListDirectoriesQueryOptions({
      cwd: props.cwd,
      relativePath: props.relativePath,
      includeFiles: true,
      includeChildHints: false,
    }),
  );

  if (query.isLoading && !query.data) {
    return <ExplorerLoadingRows depth={props.depth} />;
  }

  if (query.error) {
    return (
      <p className="px-3 py-2 text-ui-sm text-destructive/80">
        {query.error instanceof Error ? query.error.message : "Could not load directory."}
      </p>
    );
  }

  return (
    <>
      {(query.data?.entries ?? []).filter(shouldShowExplorerEntry).map((entry) => {
        if (entry.kind !== "directory") {
          return (
            <ExplorerRow
              key={entry.path}
              entry={entry}
              depth={props.depth}
              selected={entry.path === props.selectedFilePath}
              expanded={false}
              onSelectFile={props.onSelectFile}
              onPrefetchEntry={props.onPrefetchEntry}
              onEntryContextMenu={props.onEntryContextMenu}
            />
          );
        }
        const expanded = props.expandedDirectories.has(entry.path);
        return (
          <Collapsible
            key={entry.path}
            open={expanded}
            onOpenChange={() => props.onToggleDirectory(entry.path)}
          >
            <CollapsibleTrigger
              render={
                <ExplorerRow
                  entry={entry}
                  depth={props.depth}
                  selected={false}
                  expanded={expanded}
                  onSelectFile={props.onSelectFile}
                  onPrefetchEntry={props.onPrefetchEntry}
                  onEntryContextMenu={props.onEntryContextMenu}
                />
              }
            />
            {/* Keep children mounted only while open (plus the closing transition Base UI
                manages) so the height animation plays and lazy listings stay cached. */}
            <CollapsiblePanel>
              <WorkspaceDirectory
                cwd={props.cwd}
                relativePath={entry.path}
                depth={props.depth + 1}
                selectedFilePath={props.selectedFilePath}
                expandedDirectories={props.expandedDirectories}
                onSelectFile={props.onSelectFile}
                onToggleDirectory={props.onToggleDirectory}
                onPrefetchEntry={props.onPrefetchEntry}
                onEntryContextMenu={props.onEntryContextMenu}
              />
            </CollapsiblePanel>
          </Collapsible>
        );
      })}
    </>
  );
}

// Opening the file-reference context menu from a tree row (full entry) or a
// search-result row (path only). Both wrap the same menu, so they live here
// instead of being re-declared in every sidebar that renders these rows.
function useTreeEntryContextMenu(
  onReferenceInChat: ((reference: ChatFileReference) => void) | undefined,
) {
  return (entry: ProjectFileSystemEntry, position: { x: number; y: number }) => {
    void showFileReferenceContextMenu({ path: entry.path, position, onReferenceInChat });
  };
}

function useResultEntryContextMenu(
  onReferenceInChat: ((reference: ChatFileReference) => void) | undefined,
) {
  return (path: string, position: { x: number; y: number }) => {
    void showFileReferenceContextMenu({ path, position, onReferenceInChat });
  };
}

// Scrollable file-tree body, shared by the standalone files sidebar and the
// combined explorer sidebar (which shows it whenever the search box is empty).
type WorkspaceFilesTreeProps = {
  workspaceRoot: string | null;
  selectedFilePath: string | null;
  expandedDirectories: ReadonlySet<string>;
  onSelectFile: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  onPrefetchEntry: ExplorerEntryPrefetch;
  onEntryContextMenu: (entry: ProjectFileSystemEntry, position: { x: number; y: number }) => void;
};

function WorkspaceFilesTree(props: WorkspaceFilesTreeProps & { workspaceRoot: string }) {
  const paths = [
    null,
    ...Array.from(props.expandedDirectories).filter((path) => {
      const parts = path.split("/");
      if (
        parts.some(
          (name) => name.startsWith(".synara") || EXPLORER_HIDDEN_DIRECTORY_NAMES.has(name),
        )
      )
        return false;
      return parts
        .slice(0, -1)
        .every((_, index) => props.expandedDirectories.has(parts.slice(0, index + 1).join("/")));
    }),
  ];
  const queries = useQueries({
    queries: paths.map((relativePath) =>
      projectListDirectoriesQueryOptions({
        cwd: props.workspaceRoot,
        relativePath,
        includeFiles: true,
        includeChildHints: false,
      }),
    ),
  });
  const byPath = new Map(paths.map((path, index) => [path, queries[index]!]));
  type Row = { key: string; depth: number } & (
    | { entry: ProjectFileSystemEntry; message?: never }
    | { entry?: never; message: string }
  );
  const rows: Row[] = [];
  const appendDirectory = (path: string | null, depth: number) => {
    const query = byPath.get(path);
    if (!query || query.isLoading || query.isPlaceholderData) {
      rows.push({ key: `loading:${path}`, depth, message: "Loading directory..." });
      return;
    }
    if (query.error) {
      rows.push({ key: `error:${path}`, depth, message: query.error.message });
      return;
    }
    for (const entry of (query.data?.entries ?? []).filter(shouldShowExplorerEntry)) {
      rows.push({ key: entry.path, depth, entry });
      if (entry.kind === "directory" && props.expandedDirectories.has(entry.path))
        appendDirectory(entry.path, depth + 1);
    }
  };
  appendDirectory(null, 0);
  const virtual = rows.length > 200;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const wasVirtual = useRef(virtual);
  if (wasVirtual.current !== virtual) {
    pendingFocus.current = focusedPath;
    wasVirtual.current = virtual;
  }
  const focusedIndex = rows.findIndex((row) => row.key === focusedPath);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => rows[index]!.key,
    estimateSize: () => 28,
    overscan: 8,
    enabled: virtual,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      if (focusedIndex >= 0 && !indexes.includes(focusedIndex)) indexes.push(focusedIndex);
      return indexes.sort((a, b) => a - b);
    },
  });
  const virtualRows = virtualizer.getVirtualItems();
  const selectedIndex = rows.findIndex((row) => row.key === props.selectedFilePath);
  useLayoutEffect(() => {
    const path = pendingFocus.current;
    if (!path) return;
    const row = Array.from(
      scrollRef.current?.querySelectorAll<HTMLButtonElement>("[data-explorer-path]") ?? [],
    ).find((row) => row.dataset.explorerPath === path);
    if (row) {
      pendingFocus.current = null;
      row.focus({ preventScroll: true });
    }
  });
  useEffect(() => {
    if (virtual && selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
  }, [selectedIndex, virtual, virtualizer]);

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-auto px-1 py-1"
      onFocusCapture={(event) => {
        const path = (event.target as HTMLElement).dataset.explorerPath;
        if (path) setFocusedPath(path);
      }}
      onKeyDown={(event) => {
        if (!virtual || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey)
          return;
        const key = event.key;
        if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
        const entryIndexes = rows.flatMap((row, index) => (row.entry ? [index] : []));
        const current = entryIndexes.indexOf(focusedIndex);
        const next = entryIndexes[nextExplorerRowIndex(key, current, entryIndexes.length)];
        if (next === undefined) return;
        event.preventDefault();
        pendingFocus.current = rows[next]!.key;
        setFocusedPath(rows[next]!.key);
        virtualizer.scrollToIndex(next, { align: "auto" });
      }}
    >
      {virtual ? (
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualRows.map((item) => {
            const row = rows[item.index]!;
            return (
              <div
                key={row.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {row.entry ? (
                  <ExplorerRow
                    entry={row.entry}
                    depth={row.depth}
                    selected={row.entry.path === props.selectedFilePath}
                    expanded={props.expandedDirectories.has(row.entry.path)}
                    aria-expanded={
                      row.entry.kind === "directory"
                        ? props.expandedDirectories.has(row.entry.path)
                        : undefined
                    }
                    onClick={
                      row.entry.kind === "directory"
                        ? () => props.onToggleDirectory(row.entry.path)
                        : undefined
                    }
                    onSelectFile={props.onSelectFile}
                    onPrefetchEntry={props.onPrefetchEntry}
                    onEntryContextMenu={props.onEntryContextMenu}
                  />
                ) : (
                  <p className="h-7 truncate px-3 text-ui-sm text-muted-foreground" role="status">
                    {row.message}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <WorkspaceDirectory
          cwd={props.workspaceRoot}
          relativePath={null}
          depth={0}
          selectedFilePath={props.selectedFilePath}
          expandedDirectories={props.expandedDirectories}
          onSelectFile={props.onSelectFile}
          onToggleDirectory={props.onToggleDirectory}
          onPrefetchEntry={props.onPrefetchEntry}
          onEntryContextMenu={props.onEntryContextMenu}
        />
      )}
    </div>
  );
}

function WorkspaceFilesTreeBody(props: WorkspaceFilesTreeProps) {
  return (
    <>
      {props.workspaceRoot ? (
        <WorkspaceFilesTree
          key={props.workspaceRoot}
          {...props}
          workspaceRoot={props.workspaceRoot}
        />
      ) : (
        <PanelStateMessage density="compact" fill="flex">
          <p>No workspace.</p>
        </PanelStateMessage>
      )}
    </>
  );
}

export function WorkspaceFilesSidebar(props: {
  workspaceRoot: string | null;
  selectedFilePath: string | null;
  expandedDirectories: ReadonlySet<string>;
  containerClassName?: string;
  onSelectFile: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  onReferenceInChat: ((reference: ChatFileReference) => void) | undefined;
}) {
  const prefetchEntry = useExplorerEntryPrefetch(props.workspaceRoot);
  const handleEntryContextMenu = useTreeEntryContextMenu(props.onReferenceInChat);
  const handleListKeyDown = useExplorerListNavigation();
  return (
    <aside
      className={props.containerClassName ?? EXPLORER_SIDEBAR_CONTAINER_CLASS}
      onKeyDown={handleListKeyDown}
    >
      <WorkspaceFilesTreeBody
        workspaceRoot={props.workspaceRoot}
        selectedFilePath={props.selectedFilePath}
        expandedDirectories={props.expandedDirectories}
        onSelectFile={props.onSelectFile}
        onToggleDirectory={props.onToggleDirectory}
        onPrefetchEntry={prefetchEntry}
        onEntryContextMenu={handleEntryContextMenu}
      />
    </aside>
  );
}

function WorkspaceSearchResultRow(props: {
  entry: ProjectEntry;
  selected: boolean;
  onSelectFile: (path: string) => void;
  onPrefetchEntry: ExplorerEntryPrefetch;
  onEntryContextMenu: (path: string, position: { x: number; y: number }) => void;
}) {
  const { entry, onEntryContextMenu, onPrefetchEntry, onSelectFile } = props;
  const { dir, name } = splitRepoRelativePath(entry.path);
  const handlePrefetch = () => {
    onPrefetchEntry(entry);
  };

  return (
    <button
      {...EXPLORER_ROW_PROPS}
      type="button"
      className={fileRowClassName(props.selected, "h-8 px-2")}
      title={entry.path}
      draggable
      onDragStart={(event) => {
        setFileReferenceDragData(event.dataTransfer, entry.path);
      }}
      onClick={() => onSelectFile(entry.path)}
      onPointerEnter={() => onPrefetchEntry(entry, "hover")}
      onPointerLeave={() => onPrefetchEntry(entry, "cancel")}
      onBlur={() => onPrefetchEntry(entry, "cancel")}
      onFocus={handlePrefetch}
      onContextMenu={(event) => {
        event.preventDefault();
        onEntryContextMenu(entry.path, { x: event.clientX, y: event.clientY });
      }}
    >
      <FileEntryIcon pathValue={entry.path} kind="file" className="size-3.5 shrink-0 opacity-75" />
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
        <span className="shrink-0 truncate font-medium">{name}</span>
        {dir ? (
          <span className="min-w-0 truncate text-ui-sm text-muted-foreground/55">{dir}</span>
        ) : null}
      </div>
    </button>
  );
}

interface WorkspaceFileSearchState {
  // Trimmed live input — drives the "is the box empty?" decision (tree vs results).
  inputQuery: string;
  fileMatches: ReadonlyArray<ProjectEntry>;
  searchResultsPending: boolean;
  searchResultsCurrent: boolean;
  isFetching: boolean;
  error: Error | null;
  truncated: boolean;
}

// Fuzzy file-name search shared by the standalone search sidebar and the
// combined explorer sidebar: debounce keystrokes, then expose the matches plus
// the freshness flags both surfaces need to gate selection on stale results.
function useWorkspaceFileSearch(
  workspaceRoot: string | null,
  query: string,
): WorkspaceFileSearchState {
  const [debouncedQuery] = useDebouncedValue(query, {
    wait: EXPLORER_SEARCH_QUERY_DEBOUNCE_MS,
  });
  const inputQuery = query.trim();
  const trimmedQuery = debouncedQuery.trim();
  const entriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: workspaceRoot,
      query: trimmedQuery,
      kind: "file",
      limit: EXPLORER_SEARCH_RESULTS_LIMIT,
    }),
  );
  // Results are tied to the debounced query. While the user is ahead of that
  // query, keep old results non-selectable so Enter cannot open a stale match.
  const searchResultsPending = inputQuery !== trimmedQuery || entriesQuery.isPlaceholderData;
  const searchResultsCurrent = !searchResultsPending;
  const fileMatches = searchResultsCurrent
    ? (entriesQuery.data?.entries ?? EMPTY_WORKSPACE_SEARCH_FILE_MATCHES)
    : EMPTY_WORKSPACE_SEARCH_FILE_MATCHES;
  return {
    inputQuery,
    fileMatches,
    searchResultsPending,
    searchResultsCurrent,
    isFetching: entriesQuery.isFetching,
    error: searchResultsCurrent ? entriesQuery.error : null,
    truncated: entriesQuery.data?.truncated ?? false,
  };
}

// Search-box header: a fixed, full-width input that selects the top match on
// Enter and clears (returning to the tree, in the combined sidebar) on Escape.
function WorkspaceSearchInputHeader(props: {
  query: string;
  search: WorkspaceFileSearchState;
  autoFocus?: boolean;
  onQueryChange: (query: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const { onQueryChange, onSelectFile, query, search } = props;
  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (!search.searchResultsCurrent) {
        return;
      }
      const topMatch = search.fileMatches[0];
      if (topMatch) {
        onSelectFile(topMatch.path);
      }
      return;
    }
    if (event.key === "Escape" && query.length > 0) {
      event.stopPropagation();
      onQueryChange("");
    }
  };

  return (
    <div className="shrink-0 border-b border-border/65 p-2">
      <SearchInput
        value={query}
        autoFocus={props.autoFocus}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        placeholder="Search files..."
        aria-label="Search files"
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleInputKeyDown}
      />
    </div>
  );
}

// Scrollable search-results body (matches list + truncation hint). Callers only
// mount it once the query is non-empty, so the empty-query state lives outside.
function WorkspaceSearchResultsBody(props: {
  workspaceRoot: string | null;
  search: WorkspaceFileSearchState;
  selectedFilePath: string | null;
  onSelectFile: (path: string) => void;
  onPrefetchEntry: ExplorerEntryPrefetch;
  onEntryContextMenu: (path: string, position: { x: number; y: number }) => void;
}) {
  const { fileMatches } = props.search;
  return (
    <>
      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto px-1 py-1",
          fileMatches.length === 0 && "flex flex-col",
        )}
      >
        {!props.workspaceRoot ? (
          <PanelStateMessage density="compact" fill="flex">
            <p>No workspace.</p>
          </PanelStateMessage>
        ) : props.search.searchResultsCurrent && props.search.error ? (
          <PanelStateMessage density="compact" fill="flex">
            <p className="text-destructive/85">
              {props.search.error instanceof Error
                ? props.search.error.message
                : "Could not search files."}
            </p>
          </PanelStateMessage>
        ) : fileMatches.length === 0 ? (
          props.search.searchResultsPending || props.search.isFetching ? (
            <ExplorerLoadingRows depth={0} />
          ) : (
            <PanelStateMessage density="compact" fill="flex">
              <p>No matching files.</p>
            </PanelStateMessage>
          )
        ) : (
          fileMatches.map((entry) => (
            <WorkspaceSearchResultRow
              key={entry.path}
              entry={entry}
              selected={entry.path === props.selectedFilePath}
              onSelectFile={props.onSelectFile}
              onPrefetchEntry={props.onPrefetchEntry}
              onEntryContextMenu={props.onEntryContextMenu}
            />
          ))
        )}
      </div>
      {fileMatches.length > 0 && props.search.truncated ? (
        <p className="shrink-0 border-t border-border/45 px-3 py-1.5 text-ui-xs text-muted-foreground/70">
          Showing the top matches. Refine the search to narrow them down.
        </p>
      ) : null}
    </>
  );
}

export function WorkspaceSearchSidebar(props: {
  workspaceRoot: string | null;
  query: string;
  onQueryChange: (query: string) => void;
  selectedFilePath: string | null;
  containerClassName?: string;
  onSelectFile: (path: string) => void;
  onReferenceInChat: ((reference: ChatFileReference) => void) | undefined;
}) {
  const prefetchEntry = useExplorerEntryPrefetch(props.workspaceRoot);
  const handleEntryContextMenu = useResultEntryContextMenu(props.onReferenceInChat);
  const handleListKeyDown = useExplorerListNavigation();
  const search = useWorkspaceFileSearch(props.workspaceRoot, props.query);

  return (
    <aside
      className={props.containerClassName ?? EXPLORER_SIDEBAR_CONTAINER_CLASS}
      onKeyDown={handleListKeyDown}
    >
      <WorkspaceSearchInputHeader
        query={props.query}
        search={search}
        autoFocus
        onQueryChange={props.onQueryChange}
        onSelectFile={props.onSelectFile}
      />
      {search.inputQuery.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col px-1 py-1">
          <PanelStateMessage density="compact" fill="flex">
            <p>Search files by name or path.</p>
          </PanelStateMessage>
        </div>
      ) : (
        <WorkspaceSearchResultsBody
          workspaceRoot={props.workspaceRoot}
          search={search}
          selectedFilePath={props.selectedFilePath}
          onSelectFile={props.onSelectFile}
          onPrefetchEntry={prefetchEntry}
          onEntryContextMenu={handleEntryContextMenu}
        />
      )}
    </aside>
  );
}

// Combined explorer: one panel with a fixed search box on top that shows the
// full file tree while empty and switches to fuzzy file-name results as soon as
// the user types — no separate Files/Search activity rail needed.
export function WorkspaceExplorerSidebar(props: {
  workspaceRoot: string | null;
  selectedFilePath: string | null;
  expandedDirectories: ReadonlySet<string>;
  query: string;
  onQueryChange: (query: string) => void;
  containerClassName?: string;
  onSelectFile: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  onReferenceInChat: ((reference: ChatFileReference) => void) | undefined;
}) {
  const prefetchEntry = useExplorerEntryPrefetch(props.workspaceRoot);
  const handleTreeEntryContextMenu = useTreeEntryContextMenu(props.onReferenceInChat);
  const handleResultEntryContextMenu = useResultEntryContextMenu(props.onReferenceInChat);
  const handleListKeyDown = useExplorerListNavigation();
  const search = useWorkspaceFileSearch(props.workspaceRoot, props.query);

  return (
    <aside
      className={props.containerClassName ?? EXPLORER_SIDEBAR_CONTAINER_CLASS}
      onKeyDown={handleListKeyDown}
    >
      <WorkspaceSearchInputHeader
        query={props.query}
        search={search}
        onQueryChange={props.onQueryChange}
        onSelectFile={props.onSelectFile}
      />
      {search.inputQuery.length === 0 ? (
        <WorkspaceFilesTreeBody
          workspaceRoot={props.workspaceRoot}
          selectedFilePath={props.selectedFilePath}
          expandedDirectories={props.expandedDirectories}
          onSelectFile={props.onSelectFile}
          onToggleDirectory={props.onToggleDirectory}
          onPrefetchEntry={prefetchEntry}
          onEntryContextMenu={handleTreeEntryContextMenu}
        />
      ) : (
        <WorkspaceSearchResultsBody
          workspaceRoot={props.workspaceRoot}
          search={search}
          selectedFilePath={props.selectedFilePath}
          onSelectFile={props.onSelectFile}
          onPrefetchEntry={prefetchEntry}
          onEntryContextMenu={handleResultEntryContextMenu}
        />
      )}
    </aside>
  );
}

export function ExplorerActivityBarButton(props: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const button = (
    <button
      type="button"
      className={cn(
        "relative flex h-12 w-full cursor-pointer items-center justify-center text-muted-foreground/72 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground",
        props.active && "bg-[var(--color-background-button-secondary)] text-foreground",
      )}
      aria-label={props.label}
      aria-pressed={props.active}
      title={props.label}
      onClick={props.onClick}
    >
      <span
        className={cn(
          "absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-r-full bg-transparent",
          props.active && "bg-foreground/85",
        )}
        aria-hidden="true"
      />
      {props.children}
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup side="right">{props.label}</TooltipPopup>
    </Tooltip>
  );
}
