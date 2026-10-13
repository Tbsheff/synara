import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  ProjectId,
  TodoId,
  type Todo,
  type TodoUpdateInput,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { resetComposerDraftStore } from "../../composerDraftStoreTestFixtures";
import { serverQueryKeys } from "../../lib/serverReactQuery";
import { useProjectEnvironmentStore } from "../../projectEnvironmentStore";
import { useStore } from "../../store";
import { makeProject } from "../../storeTestFixtures";
import { TaskHandOff } from "./TaskHandOff";

const transport = vi.hoisted(() => ({ dispatch: vi.fn(), navigate: vi.fn(), pickFolder: vi.fn() }));
vi.mock("../../nativeApi", () => {
  const api = {
    orchestration: { dispatchCommand: transport.dispatch },
    dialogs: { pickFolder: transport.pickFolder },
    todo: { list: async () => ({ todos: [] }) },
  };
  return {
    ensureNativeApi: () => api,
    readNativeApi: () => api,
    readNativeApiServerCapability: () => false,
    onNativeApiServerCapabilitiesChange: () => () => {},
  };
});
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => transport.navigate,
}));

const project = makeProject();
const secondProject = makeProject({
  id: ProjectId.makeUnsafe("local-project"),
  name: "Local repo",
});
const now = "2026-10-12T12:00:00.000Z";
const todo: Todo = {
  id: TodoId.makeUnsafe("environment-task"),
  title: "Fix the build",
  notes: "",
  priority: "none",
  projectId: project.id,
  dueDate: null,
  threadId: null,
  delegationBaseTurnId: null,
  linkedAt: null,
  completedAt: null,
  createdAt: now,
  updatedAt: now,
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("synara:server-settings-migrated:v1", "1");
  resetComposerDraftStore();
  useStore.setState({ projects: [project, secondProject], threadsHydrated: true });
  useProjectEnvironmentStore.setState({ envModeByProjectId: { [project.id]: "worktree" } });
  transport.dispatch.mockReset().mockResolvedValue(undefined);
  transport.navigate.mockReset().mockResolvedValue(undefined);
  transport.pickFolder.mockReset().mockResolvedValue("/tmp/picked-folder");
});
afterEach(() => cleanup());

it.each([
  { scenario: "saved worktree", expected: "worktree" },
  { scenario: "saved local", expected: "local" },
  { scenario: "app default", expected: "worktree" },
  { scenario: "choose local", expected: "local" },
  { scenario: "choose worktree", expected: "worktree" },
  { scenario: "change project", expected: "local" },
  { scenario: "picked folder", expected: "local" },
] as const)("uses $expected for $scenario in the Tasks form", async ({ scenario, expected }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(serverQueryKeys.settings(), {
    ...DEFAULT_SERVER_SETTINGS_VIEW,
    defaultThreadEnvMode: "worktree",
  });
  if (scenario === "app default") {
    useProjectEnvironmentStore.setState({ envModeByProjectId: {} });
  }
  if (scenario === "saved local" || scenario === "choose worktree") {
    useProjectEnvironmentStore.getState().setProjectEnvMode(project.id, "local");
  }
  useProjectEnvironmentStore.getState().setProjectEnvMode(secondProject.id, "local");
  client.setQueryData(serverQueryKeys.config(), {
    cwd: project.cwd,
    providers: [
      {
        provider: "codex",
        driver: "codex",
        instanceId: "codex",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: now,
      },
    ],
  });
  const environments: string[] = [];
  const onLinkChat = vi.fn(async (input: TodoUpdateInput) => {
    if (input.threadId) {
      environments.push(useComposerDraftStore.getState().getDraftThread(input.threadId)!.envMode);
    }
  });
  try {
    await render(
      <QueryClientProvider client={client}>
        <TaskHandOff
          todo={todo}
          readTodo={() => todo}
          onLinkChat={onLinkChat}
          startRef={{ current: null }}
        />
      </QueryClientProvider>,
    );
    if (scenario === "choose local") {
      await page.getByRole("button", { name: "Worktree", exact: true }).click();
      await page.getByRole("menuitem", { name: "Local project", exact: true }).click();
      expect(useProjectEnvironmentStore.getState().envModeByProjectId[project.id]).toBe("local");
    }
    if (scenario === "choose worktree") {
      await page.getByRole("button", { name: "Local", exact: true }).click();
      await page.getByRole("menuitem", { name: "New worktree", exact: true }).click();
      expect(useProjectEnvironmentStore.getState().envModeByProjectId[project.id]).toBe("worktree");
    }
    if (scenario === "change project") {
      await page.getByRole("button", { name: "Project", exact: true }).click();
      await page.getByRole("menuitemradio", { name: "Local repo", exact: true }).click();
    }
    if (scenario === "picked folder") {
      await page.getByRole("button", { name: "Folder…", exact: true }).click();
    }
    await expect
      .element(
        page.getByRole("button", {
          name: expected === "worktree" ? "Worktree" : "Local",
          exact: true,
        }),
      )
      .toBeVisible();
    if (scenario === "picked folder") {
      await page.getByRole("button", { name: "Local", exact: true }).click();
      expect(page.getByRole("menuitem", { name: "New worktree", exact: true }).query()).toBeNull();
      return;
    }
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await vi.waitFor(() => expect(onLinkChat).toHaveBeenCalledTimes(1));
    expect(environments).toEqual([expected]);
    if (expected === "worktree") {
      await vi.waitFor(() => expect(transport.navigate).toHaveBeenCalledTimes(1));
      expect(transport.dispatch).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() =>
        expect(transport.dispatch).toHaveBeenCalledWith(
          expect.objectContaining({ type: "thread.turn.start" }),
        ),
      );
      expect(transport.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "thread.create", envMode: "local" }),
      );
    }
  } finally {
    await cleanup();
    client.clear();
  }
});
