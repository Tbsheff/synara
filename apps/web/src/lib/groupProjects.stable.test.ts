import { type ProjectId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock(import("@synara/shared/betaFeatures"), async (importOriginal) => ({
  ...(await importOriginal()),
  desktopFlavorFromProtocol: () => "production",
}));

import type { Project } from "../types";
import { isGroupContainerProject } from "./groupProjects";

describe("isGroupContainerProject on Stable", () => {
  it("recognizes a saved Hub folder", () => {
    const project = {
      id: "project-group" as ProjectId,
      kind: "group",
      cwd: "/Users/tester/Documents/Synara/Groups/release",
    } as unknown as Project;
    expect(
      isGroupContainerProject(project, {
        homeDir: "/Users/tester",
        groupsWorkspaceRoot: "/Users/tester/Documents/Synara/Groups",
      }),
    ).toBe(true);
  });
});
