import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(`${import.meta.dirname}/${path}`, "utf8");

describe("keyboard access boundaries", () => {
  it("keeps plain Tab free to reach model picker controls", () => {
    expect(source("chat/ComposerModelPicker.tsx")).toContain(
      'event.key !== "Tab" || !event.ctrlKey',
    );
  });
  it("offers the sortable keyboard sensor", () => {
    expect(source("SidebarCustomizeList.tsx")).toContain("useSensor(KeyboardSensor");
    expect(source("SidebarCustomizeList.tsx")).toContain(
      "coordinateGetter: sortableKeyboardCoordinates",
    );
  });
  it("shows Git file actions when their row has keyboard focus", () => {
    expect(source("chat/GitPanel.tsx")).toContain("group-focus-within:opacity-100");
  });
  it("uses a shared modal for image focus containment and restoration", () => {
    expect(source("chat/ExpandedImageOverlay.tsx")).toMatch(/<Dialog\s/);
    expect(source("chat/ExpandedImageOverlay.tsx")).toContain("<DialogPopup");
  });
});
