import "../index.css";

import { expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { SettingsSidebarNav } from "./SettingsSidebarNav";
import { rankSettingsSearchEntries, settingsSearchEntryTarget } from "../settingsSearchIndex";

it("gives each settings search result one tab stop and announces its selection", async () => {
  await render(<SettingsSidebarNav activeSection="general" onSelectSection={vi.fn()} />);
  await page.getByLabelText("Search settings", { exact: true }).fill("font");
  const results = rankSettingsSearchEntries("font", 12);
  const list = page.getByRole("listbox", { name: "Settings search results" });
  await expect.element(list).toBeVisible();
  const options = list.element().querySelectorAll<HTMLElement>('[role="option"]');
  expect(options).toHaveLength(results.length);
  expect(list.element().querySelectorAll("button")).toHaveLength(results.length);
  expect(Array.from(options).every((option) => option.tabIndex === 0)).toBe(true);
  await userEvent.tab();
  expect(document.activeElement).toBe(options[0]);
  expect(options[0]).toHaveAttribute("aria-selected", "true");
  await userEvent.tab();
  expect(document.activeElement).toBe(options[1]);
});

it("opens the exact arrow-selected setting and restores search focus", async () => {
  const onSelectSection = vi.fn();
  await render(<SettingsSidebarNav activeSection="general" onSelectSection={onSelectSection} />);
  const input = page.getByLabelText("Search settings", { exact: true });
  await input.fill("font");
  const results = rankSettingsSearchEntries("font", 12);
  await userEvent.keyboard("{ArrowDown}{ArrowUp}{ArrowDown}{Enter}");
  const selected = results[1]!;
  expect(onSelectSection).toHaveBeenCalledExactlyOnceWith(selected.section, {
    target: settingsSearchEntryTarget(selected),
  });
  await expect.element(input).toHaveValue("");
  expect(document.activeElement).toBe(input.element());
});

it("supports Home, End and Escape from results and handles changed or empty matches", async () => {
  const onSelectSection = vi.fn();
  await render(<SettingsSidebarNav activeSection="general" onSelectSection={onSelectSection} />);
  const input = page.getByLabelText("Search settings", { exact: true });
  await input.fill("font");
  await userEvent.keyboard("{ArrowDown}{End}");
  const options = page.getByRole("option").elements();
  expect(document.activeElement).toBe(options.at(-1));
  await userEvent.keyboard("{Home}");
  expect(document.activeElement).toBe(options[0]);
  await userEvent.keyboard("{Escape}");
  await expect.element(input).toHaveValue("");
  expect(document.activeElement).toBe(input.element());
  await input.fill("theme");
  await userEvent.keyboard("{Enter}");
  expect(onSelectSection).toHaveBeenCalledExactlyOnceWith("appearance", {
    target: "setting-theme",
  });
  await input.fill("zzzzunmatchedzzzz");
  await userEvent.keyboard("{ArrowDown}{ArrowUp}{Enter}");
  await expect.element(page.getByRole("status")).toHaveTextContent("No matching settings");
  expect(onSelectSection).toHaveBeenCalledTimes(1);
  await userEvent.keyboard("{Escape}");
  await expect.element(input).toHaveValue("");
});
