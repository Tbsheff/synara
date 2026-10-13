import { Fragment, useMemo, type ReactNode } from "react";
import type { ThreadId } from "@synara/contracts";
import { usePresentedWithFade } from "../hooks/usePresentedWithFade";
import { sidebarThreadNeedsReveal, type SidebarProjectEntry } from "./Sidebar.logic";
import { DisclosureRegion } from "./ui/DisclosureRegion";

type Props = {
  entries: readonly SidebarProjectEntry[];
  expandedParentThreadIds: ReadonlySet<string>;
  activeThreadId: ThreadId | null;
  renderRow: (entry: SidebarProjectEntry) => ReactNode;
};

function splitBranches(entries: readonly SidebarProjectEntry[]): SidebarProjectEntry[][] {
  const branches: SidebarProjectEntry[][] = [];
  const depth = entries[0]?.depth;
  for (const entry of entries) {
    if (entry.depth === depth) branches.push([entry]);
    else branches.at(-1)?.push(entry);
  }
  return branches;
}

function Branch({ entries, expandedParentThreadIds, activeThreadId, renderRow }: Props) {
  const parent = entries[0]!;
  const children = useMemo(() => splitBranches(entries.slice(1)), [entries]);
  const open = expandedParentThreadIds.has(parent.thread.id);
  const forcedIds = useMemo(
    () =>
      new Set(
        children
          .filter(
            (branch) =>
              branch[0]?.thread.parentThreadId ||
              branch.some(
                (entry) =>
                  entry.thread.id === activeThreadId || sidebarThreadNeedsReveal(entry.thread),
              ),
          )
          .map((branch) => branch[0]!.thread.id),
      ),
    [activeThreadId, children],
  );
  const optionalChildren = useMemo(
    () => children.filter((branch) => !forcedIds.has(branch[0]!.thread.id)),
    [children, forcedIds],
  );
  const presented = usePresentedWithFade(
    parent.childStateSummary && open ? optionalChildren : null,
    { minVisibleMs: 0 },
  );
  const renderBranch = (branch: SidebarProjectEntry[]) => (
    <Branch
      key={branch[0]!.thread.id}
      entries={branch}
      expandedParentThreadIds={expandedParentThreadIds}
      activeThreadId={activeThreadId}
      renderRow={renderRow}
    />
  );
  return (
    <Fragment>
      {renderRow(parent)}
      {parent.childStateSummary ? (
        <Fragment>
          {presented ? (
            <DisclosureRegion open={presented.open}>
              {presented.value
                .filter((branch) => !forcedIds.has(branch[0]!.thread.id))
                .map(renderBranch)}
            </DisclosureRegion>
          ) : null}
          {children.filter((branch) => forcedIds.has(branch[0]!.thread.id)).map(renderBranch)}
        </Fragment>
      ) : (
        children.map(renderBranch)
      )}
    </Fragment>
  );
}

export function SidebarThreadTree(props: Props) {
  return (
    <Fragment>
      {splitBranches(props.entries).map((entries) =>
        entries.length === 1 && !entries[0]!.childStateSummary ? (
          <Fragment key={entries[0]!.thread.id}>{props.renderRow(entries[0]!)}</Fragment>
        ) : (
          <Branch key={entries[0]!.thread.id} {...props} entries={entries} />
        ),
      )}
    </Fragment>
  );
}
