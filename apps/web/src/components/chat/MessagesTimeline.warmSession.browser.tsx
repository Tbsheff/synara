import "../../index.css";
import { MessageId } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { resolveWorkingLabel } from "../ChatView.logic";
import { MessagesTimeline } from "./MessagesTimeline";
import type { WorktreeSetupSnapshot } from "../../types";

function FollowUp({
  connecting,
  busy,
  setup,
}: {
  connecting: boolean;
  busy: boolean;
  setup?: WorktreeSetupSnapshot;
}) {
  return (
    <div style={{ height: 420 }}>
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        workingLabel={resolveWorkingLabel({
          isSendBusy: busy,
          turnTakenOver: !busy,
          isConnecting: connecting,
          providerName: "Codex",
        })}
        worktreeSetup={setup ?? null}
        timelineEntries={[
          {
            id: "follow-up",
            kind: "message",
            createdAt: "2026-10-12T20:00:00.000Z",
            message: {
              id: MessageId.makeUnsafe("follow-up-message"),
              role: "user",
              text: "Follow up",
              createdAt: "2026-10-12T20:00:00.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-10-12T20:00:01.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />
    </div>
  );
}

describe("provider start presentation", () => {
  it("a warm follow-up never renders a start label through dispatch and takeover", async () => {
    const labels: string[] = [];
    const observer = new MutationObserver(() => {
      labels.push(document.body.textContent ?? "");
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    const screen = await render(<FollowUp connecting={false} busy />);
    try {
      await expect
        .poll(() => document.querySelector("[data-working-label-current]")?.textContent)
        .toBe("Working");
      const row = document.querySelector("[data-working-label-current]")?.parentElement;
      const height = row?.getBoundingClientRect().height;
      expect(height).toBeGreaterThan(0);
      await screen.rerender(<FollowUp connecting={false} busy={false} />);
      await expect
        .poll(() => document.querySelector("[data-working-label-current]")?.textContent)
        .toBe("Thinking");
      expect(row?.getBoundingClientRect().height).toBe(height);
      expect(labels.length).toBeGreaterThan(0);
      expect(labels.every((text) => !text.includes("Starting"))).toBe(true);
      expect(document.body.textContent).not.toContain("Starting");
    } finally {
      observer.disconnect();
      await screen.unmount();
    }
  });
  it("a cold start uses the same work line after workspace setup", async () => {
    const setup: WorktreeSetupSnapshot = {
      steps: [
        { id: "prepare-thread", label: "Linking thread workspace", status: "done" },
        { id: "start-session", label: "Starting session", status: "active" },
      ],
    };
    const screen = await render(<FollowUp connecting busy={false} setup={setup} />);
    try {
      await expect
        .poll(() => document.querySelector("[data-working-label-current]")?.textContent)
        .toBe("Working");
      expect(document.body.textContent).not.toContain("Starting");
      expect(document.body.textContent).not.toContain("Preparing worktree");
    } finally {
      await screen.unmount();
    }
  });
});
