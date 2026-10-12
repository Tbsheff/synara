import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThreadId, TurnId } from "@synara/contracts";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { WorkspaceFileOpenerContext } from "../../lib/workspaceFileOpener";
import type { WorkLogEntry } from "../../workLog";
import { TimelineWorkEntryRow } from "./TimelineWorkEntryRow";

const TURN_ID = TurnId.makeUnsafe("turn-rows");

function entry(overrides: Partial<WorkLogEntry>): WorkLogEntry {
  return {
    id: "work-row",
    createdAt: "2026-10-10T10:00:00.000Z",
    label: "Tool call",
    tone: "tool",
    activityKind: "tool.completed",
    toolStatus: "completed",
    ...overrides,
  };
}

const queryClient = new QueryClient();

function Providers(props: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{props.children}</QueryClientProvider>;
}

type RowExtras = {
  onOpenTurnDiff?: (turnId: TurnId, filePath?: string) => void;
  onOpenAgentActivity?: (activityId: string) => void;
  onImageExpand?: () => void;
  onOpenThread?: (id: ThreadId) => void;
};

function rowElement(workEntry: WorkLogEntry, extra: RowExtras = {}) {
  return (
    <Providers>
      <div style={{ width: 720 }}>
        <TimelineWorkEntryRow
          workEntry={workEntry}
          chatMetaFontSizePx={12}
          density="compact"
          markdownCwd="/repo"
          onImageExpand={extra.onImageExpand ?? (() => undefined)}
          timestampFormat="24-hour"
          turnId={TURN_ID}
          {...(extra.onOpenTurnDiff ? { onOpenTurnDiff: extra.onOpenTurnDiff } : {})}
          {...(extra.onOpenThread ? { onOpenThread: extra.onOpenThread } : {})}
          {...(extra.onOpenAgentActivity ? { onOpenAgentActivity: extra.onOpenAgentActivity } : {})}
        />
      </div>
    </Providers>
  );
}

async function renderRow(workEntry: WorkLogEntry, extra: RowExtras = {}) {
  return render(rowElement(workEntry, extra));
}

function trigger(index = 0): HTMLButtonElement {
  const triggers = document.querySelectorAll<HTMLButtonElement>(
    '[data-tool-detail-trigger="true"]',
  );
  const found = triggers[index];
  if (!found) throw new Error(`missing trigger ${index}`);
  return found;
}

async function expand(index = 0) {
  const button = trigger(index);
  button.click();
  await expect.poll(() => button.getAttribute("aria-expanded")).toBe("true");
}

const bodyText = () => document.body.textContent ?? "";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("TimelineWorkEntryRow typed rows", () => {
  it("shows the live tail while a command runs, then the final output and footer", async () => {
    const running = entry({
      itemType: "command_execution",
      activityKind: "tool.updated",
      toolStatus: "running",
      command: "bun install",
      commandExecution: { command: "bun install", cwd: "/repo" },
      liveOutput: {
        tail: "[output truncated]\nresolving packages",
        truncated: true,
        totalChars: 42_000,
        updatedAt: "2026-10-10T10:00:01.000Z",
      },
    });
    const screen = await renderRow(running);
    expect(bodyText()).toContain("Running bun install");
    await expand();
    await expect
      .poll(() => document.querySelector("[data-command-live-output='true']")?.textContent ?? "")
      .toContain("resolving packages");
    expect(bodyText()).toContain("/repo");
    expect(bodyText()).toContain("Showing the end of 42,000 characters");
    expect(document.querySelector("[data-command-footer='true']")).toBeNull();

    await screen.rerender(
      rowElement(
        entry({
          itemType: "command_execution",
          command: "bun install",
          commandExecution: {
            command: "bun install",
            cwd: "/repo",
            output: "done in 3s",
            exitCode: 1,
            durationMs: 3_200,
          },
        }),
      ),
    );
    await expect
      .poll(() => document.querySelector("[data-command-output='true']")?.textContent ?? "")
      .toContain("done in 3s");
    expect(document.querySelector("[data-command-live-output='true']")).toBeNull();
    expect(document.querySelector("[data-command-footer='true']")?.textContent).toBe("Exit code 1");
    expect(bodyText()).toContain("Ran bun install · Failed in 3s");
  });

  it("splits Claude stdout and stderr", async () => {
    await renderRow(
      entry({
        itemType: "command_execution",
        commandExecution: { command: "make", stdout: "built", stderr: "warn: x", exitCode: 0 },
      }),
    );
    await expand();
    await expect
      .poll(() => document.querySelector("[data-command-stderr='true']")?.textContent ?? "")
      .toContain("warn: x");
    expect(document.querySelector("[data-command-stdout='true']")?.textContent).toContain("built");
    expect(document.querySelector("[data-command-footer='true']")?.textContent).toBe("Success");
  });

  it("expands a per-file diff and keeps the open-turn-diff path", async () => {
    const onOpenTurnDiff = vi.fn();
    await renderRow(
      entry({
        itemType: "file_change",
        changedFiles: ["src/app.ts", "src/new.ts"],
        fileChanges: {
          changes: [
            {
              path: "src/app.ts",
              kind: "update",
              unifiedDiff:
                "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n export {};\n",
              additions: 1,
              deletions: 1,
            },
            { path: "src/new.ts", kind: "add", additions: 4 },
          ],
        },
      }),
      { onOpenTurnDiff },
    );
    const rows = document.querySelectorAll('[data-file-change-row="true"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Edited");
    expect(rows[1]?.textContent).toContain("Created");

    await expand(0);
    await expect
      .poll(() => document.querySelector("[data-file-change-diff='true']") !== null)
      .toBe(true);
    await expect
      .poll(() => document.querySelector("[data-file-change-diff='true'] diffs-container") !== null)
      .toBe(true);
    document.querySelector<HTMLButtonElement>("[data-open-turn-diff='true']")?.click();
    expect(onOpenTurnDiff).toHaveBeenCalledWith(TURN_ID, "src/app.ts");

    (rows[1] as HTMLButtonElement).click();
    expect(onOpenTurnDiff).toHaveBeenLastCalledWith(TURN_ID, "src/new.ts");
  });

  it("shows tool arguments, result text, errors and images", async () => {
    await renderRow(
      entry({
        itemType: "mcp_tool_call",
        toolName: "mcp__linear__get_issue",
        toolCall: {
          toolName: "mcp__linear__get_issue",
          arguments: { id: "ENG-1" },
          resultText: "Issue ENG-1 ![x](/Users/me/secret.png)",
          error: "partial failure",
          structuredContent: { state: "open" },
          images: [
            { source: "file", path: "att_123.png", mediaType: "image/png" },
            { source: "omitted", reason: "Image larger than 5 MB" },
          ],
          otherBlocks: [{ blockType: "document", mediaType: "application/pdf", title: "spec.pdf" }],
        },
      }),
    );
    expect(bodyText()).toContain("Get issue ENG-1");
    await expand();
    await expect
      .poll(() => document.querySelector("[data-tool-result='true']")?.textContent ?? "")
      .toContain("![x](/Users/me/secret.png)");
    expect(document.querySelector("[data-tool-result='true'] img")).toBeNull();
    expect(document.querySelector("[data-tool-error='true']")?.textContent).toBe("partial failure");
    expect(bodyText()).toContain('"state": "open"');
    expect(bodyText()).toContain("PDF document: spec.pdf");
    const image = document.querySelector<HTMLImageElement>("[data-tool-image='attachment'] img");
    expect(image?.getAttribute("src")).toContain("/attachments/att_123.png");
    expect(document.querySelector("[data-tool-image-omitted='true']")?.textContent).toContain(
      "Image larger than 5 MB",
    );
  });

  it("renders bare hunks through the shared diff renderer", async () => {
    await renderRow(
      entry({
        itemType: "file_change",
        fileChanges: {
          changes: [
            {
              path: "src/bare.ts",
              kind: "update",
              unifiedDiff: "@@ -1,1 +1,1 @@\n-const b = 1;\n+const b = 2;",
            },
          ],
        },
      }),
    );
    await expand(0);
    await expect
      .poll(() => document.querySelector("[data-file-change-diff='true'] diffs-container") !== null)
      .toBe(true);
  });

  it("keeps captured Read results beside the file opener", async () => {
    const openFile = vi.fn(() => true);
    const opener = { openFile };
    await render(
      <Providers>
        <WorkspaceFileOpenerContext.Provider value={opener}>
          <TimelineWorkEntryRow
            workEntry={entry({
              itemType: "dynamic_tool_call",
              toolName: "Read",
              toolCall: {
                toolName: "Read",
                arguments: { file_path: "/repo/src/app.ts" },
                resultText: "1 const a = 1;",
              },
            })}
            chatMetaFontSizePx={12}
            density="compact"
            markdownCwd="/repo"
            onImageExpand={() => undefined}
            timestampFormat="24-hour"
          />
        </WorkspaceFileOpenerContext.Provider>
      </Providers>,
    );
    expect(bodyText()).toContain("Read app.ts");
    await expand();
    await expect.poll(() => bodyText()).toContain("1 const a = 1;");
    const button = [...document.querySelectorAll("button")].find((element) =>
      element.textContent?.includes("Open file"),
    );
    expect(button).toBeDefined();
    button?.click();
    expect(openFile).toHaveBeenCalledWith("/repo/src/app.ts");
  });

  it("lists web search results", async () => {
    await renderRow(
      entry({
        itemType: "web_search",
        webSearch: {
          query: "vitest browser mode",
          results: [
            { url: "https://vitest.dev/guide/browser", title: "Browser Mode" },
            { url: "javascript:alert(1)", title: "Unsafe" },
          ],
        },
      }),
    );
    expect(bodyText()).toContain("Searched the web for vitest browser mode");
    await expand();
    await expect.poll(() => bodyText()).toContain("Browser Mode");
    const links = document.querySelectorAll("[data-web-search-result-link='true']");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("https://vitest.dev/guide/browser");
    expect(links[0]?.hasAttribute("target")).toBe(false);
    expect(bodyText()).toContain("Unsafe");
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it("renders a notice body as text on expand", async () => {
    await renderRow(
      entry({
        tone: "info",
        notice: {
          noticeKind: "hook-blocked",
          severity: "error",
          title: "Hook blocked the tool call",
          status: "blocked",
          body: "<b>policy</b> denied rm -rf",
        },
      }),
    );
    expect(bodyText()).toContain("Hook blocked the tool call");
    await expand();
    await expect
      .poll(() => document.querySelector("[data-transcript-notice-body='true']")?.textContent ?? "")
      .toBe("<b>policy</b> denied rm -rf");
    expect(document.querySelector("[data-transcript-notice-body='true'] b")).toBeNull();
  });

  it("expands an agent launch row to its prompt, model and status", async () => {
    const onOpenAgentActivity = vi.fn();
    await renderRow(
      entry({
        id: "agent-launch",
        itemType: "collab_agent_tool_call",
        label: "Run background sleep",
        toolTitle: "Run background sleep",
        toolStatus: "running",
        activityKind: "tool.updated",
        subagentAction: {
          tool: "spawnAgent",
          status: "in_progress",
          summaryText: "Spawned 1 agent",
          model: "claude-sonnet-5-5",
          prompt: "Sleep 75 seconds, then print BGRESULT",
        },
      }),
      { onOpenAgentActivity },
    );
    await expand();
    await expect
      .poll(() => document.querySelector("[data-subagent-prompt]")?.textContent)
      .toBe("Sleep 75 seconds, then print BGRESULT");
    expect(bodyText()).toContain("claude-sonnet-5-5");
    expect(bodyText()).toContain("Running");
    document.querySelector<HTMLButtonElement>("[data-open-agent-activity]")?.click();
    expect(onOpenAgentActivity).toHaveBeenCalledWith("agent-launch");
  });

  it("shows Claude command output once with the exit code only in the footer", async () => {
    await renderRow(
      entry({
        itemType: "command_execution",
        command: "ls /nonexistent",
        commandExecution: {
          command: "ls /nonexistent",
          output: "Exit code 1\nls: /nonexistent: No such file or directory",
          exitCode: 1,
        },
      }),
    );
    await expand();
    await expect.poll(() => bodyText()).toContain("No such file or directory");
    expect(bodyText().split("Exit code 1").length - 1).toBe(1);
  });
});

it("copies a command and each output stream without shell labels", async () => {
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await renderRow(
    entry({
      itemType: "command_execution",
      commandExecution: {
        command: "make",
        stdout: "built",
        stderr: "error: x",
        exitCode: 1,
      },
    }),
  );
  await expand();
  for (const [label, value] of [
    ["command", "make"],
    ["stdout", "built"],
    ["stderr", "error: x"],
  ]) {
    const button = document.querySelector<HTMLButtonElement>(`[aria-label="Copy ${label}"]`);
    expect(button).not.toBeNull();
    button!.click();
    await expect.poll(() => writeText.mock.calls.at(-1)?.[0]).toBe(value);
  }
  writeText.mockRestore();
});

it("opens the resolved thread from settled subagent history", async () => {
  const onOpenThread = vi.fn();
  await renderRow(
    entry({
      itemType: "collab_agent_tool_call",
      subagents: [
        {
          threadId: "provider-id",
          resolvedThreadId: "child-id",
          statusLabel: "Completed",
          prompt: "Check build",
          isActive: false,
        },
      ],
    }),
    { onOpenThread },
  );
  await expand();
  document.querySelector<HTMLButtonElement>("[data-subagent-history] button")!.click();
  expect(onOpenThread).toHaveBeenCalledWith(ThreadId.makeUnsafe("child-id"));
});
