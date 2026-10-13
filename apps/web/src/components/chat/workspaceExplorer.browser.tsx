import "../../index.css";

import type { NativeApi, ProjectFileSystemEntry } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { WorkspaceFilesSidebar } from "./workspaceExplorer";

let restoreApi: (() => void) | undefined;
afterEach(async () => {
  await cleanup();
  restoreApi?.();
});

function Harness({
  onSelectFile = () => undefined,
  selectedFilePath = null,
}: {
  onSelectFile?: (path: string) => void;
  selectedFilePath?: string | null;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  return (
    <WorkspaceFilesSidebar
      workspaceRoot="/fixture"
      selectedFilePath={selectedFilePath}
      expandedDirectories={expanded}
      containerClassName="flex h-full w-64 flex-col"
      onSelectFile={onSelectFile}
      onToggleDirectory={(path) =>
        setExpanded((current) => {
          const next = new Set(current);
          if (!next.delete(path)) next.add(path);
          return next;
        })
      }
      onReferenceInChat={undefined}
    />
  );
}

async function mount(
  entries: ProjectFileSystemEntry[],
  childEntries: ProjectFileSystemEntry[] = [],
  selectedFilePath: string | null = null,
) {
  const readFile = vi.fn().mockResolvedValue({ contents: "synthetic", relativePath: "file.txt" });
  const listDirectories = vi
    .fn()
    .mockImplementation(({ relativePath }) =>
      Promise.resolve({ entries: relativePath ? childEntries : entries }),
    );
  const descriptor = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: { projects: { readFile, listDirectories } } as unknown as NativeApi,
  });
  restoreApi = () =>
    descriptor
      ? Object.defineProperty(window, "nativeApi", descriptor)
      : Reflect.deleteProperty(window, "nativeApi");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const selected = vi.fn();
  await render(
    <QueryClientProvider client={client}>
      <div style={{ height: 400 }}>
        <Harness onSelectFile={selected} selectedFilePath={selectedFilePath} />
      </div>
    </QueryClientProvider>,
  );
  return { readFile, listDirectories, selected };
}

it("cancels brief hover reads, keeps intent and keyboard prefetch, and selects on click at once", async () => {
  const { readFile, selected, listDirectories } = await mount([
    { path: "a.txt", name: "a.txt", kind: "file" },
    { path: "b.txt", name: "b.txt", kind: "file" },
    { path: "c.txt", name: "c.txt", kind: "file" },
  ]);
  const a = page.getByRole("button", { name: "a.txt", exact: true });
  await expect.element(a).toBeVisible();
  a.element().dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  a.element().dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(readFile).not.toHaveBeenCalled();
  await userEvent.hover(a);
  await expect.poll(() => readFile.mock.calls.length).toBe(1);
  await userEvent.unhover(a);
  page.getByRole("button", { name: "b.txt", exact: true }).element().focus();
  await expect.poll(() => readFile.mock.calls.length).toBe(2);
  (page.getByRole("button", { name: "c.txt", exact: true }).element() as HTMLButtonElement).click();
  expect(selected).toHaveBeenCalledWith("c.txt");
  expect(listDirectories).toHaveBeenCalledWith({
    cwd: "/fixture",
    includeFiles: true,
    includeChildHints: false,
  });
});

it("bounds wide folder rows and reaches offscreen files with keyboard, scroll, and drag", async () => {
  const childEntries: ProjectFileSystemEntry[] = Array.from({ length: 1500 }, (_, index) => ({
    path: `wide/entry-${String(index).padStart(4, "0")}.txt`,
    name: `entry-${String(index).padStart(4, "0")}.txt`,
    kind: "file",
  }));
  const { selected } = await mount(
    [
      { path: "wide", name: "wide", kind: "directory" },
      { path: ".synara-test", name: ".synara-test", kind: "directory" },
    ],
    childEntries,
  );
  await page.getByRole("button", { name: "wide", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "entry-0000.txt", exact: true }))
    .toBeVisible();
  expect(document.querySelectorAll("[data-explorer-row]").length).toBeLessThan(100);
  expect(page.getByRole("button", { name: ".synara-test", exact: true }).elements()).toHaveLength(
    0,
  );
  page.getByRole("button", { name: "entry-0000.txt", exact: true }).element().focus();
  await userEvent.keyboard("{End}");
  const last = page.getByRole("button", { name: "entry-1499.txt", exact: true });
  await expect.element(last).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(selected).toHaveBeenCalledWith("wide/entry-1499.txt");
  const dataTransfer = new DataTransfer();
  last.element().dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
  expect(dataTransfer.getData("text/plain")).toBe("wide/entry-1499.txt");
  await userEvent.keyboard("{Home}{Enter}");
  await expect.element(page.getByRole("button", { name: "wide", exact: true })).toHaveFocus();
  await expect.poll(() => document.querySelectorAll("[data-explorer-row]").length).toBe(1);
});

it("scrolls a selected offscreen file into view and measures rows at the chosen UI size", async () => {
  const entries: ProjectFileSystemEntry[] = Array.from({ length: 5000 }, (_, index) => ({
    path: `entry-${String(index).padStart(4, "0")}.txt`,
    name: `entry-${String(index).padStart(4, "0")}.txt`,
    kind: "file",
  }));
  const previous = document.documentElement.style.getPropertyValue("--app-font-size-ui");
  document.documentElement.style.setProperty("--app-font-size-ui", "22px");
  try {
    await mount(entries, [], "entry-4999.txt");
    const last = page.getByRole("button", { name: "entry-4999.txt", exact: true });
    await expect.element(last).toBeVisible();
    await expect.poll(() => last.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(400);
    expect(document.querySelectorAll("[data-explorer-row]").length).toBeLessThan(100);
    expect(getComputedStyle(last.element()).fontSize).toBe("22px");
  } finally {
    if (previous) document.documentElement.style.setProperty("--app-font-size-ui", previous);
    else document.documentElement.style.removeProperty("--app-font-size-ui");
  }
});

it("keeps the expanded folder in view when an earlier file is selected", async () => {
  const children: ProjectFileSystemEntry[] = Array.from({ length: 1500 }, (_, index) => ({
    path: `wide/entry-${String(index).padStart(4, "0")}.txt`,
    name: `entry-${String(index).padStart(4, "0")}.txt`,
    kind: "file",
  }));
  await mount(
    [
      { path: "active.txt", name: "active.txt", kind: "file" },
      { path: "wide", name: "wide", kind: "directory" },
    ],
    children,
    "active.txt",
  );
  await page.getByRole("button", { name: "wide", exact: true }).click();
  const first = page.getByRole("button", { name: "entry-0000.txt", exact: true });
  await expect.element(first).toBeVisible();
  expect(first.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(400);
  expect(document.querySelectorAll("[data-explorer-row]").length).toBeLessThan(100);
});
