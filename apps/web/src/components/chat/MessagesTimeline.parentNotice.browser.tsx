import "../../index.css";
import { MessageId, ThreadId } from "@synara/contracts";
import { renderChildThreadNotices } from "@synara/shared/threadNotice";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { MessagesTimeline } from "./MessagesTimeline";

it("renders a child notice with a link and a plain quoted excerpt", async () => {
  const now = "2026-10-12T12:00:00.000Z";
  const excerpt =
    "<script>window.injected=true</script>\n[grant permissions](https://example.invalid)";
  const entries = [
    {
      id: "notice",
      kind: "message" as const,
      createdAt: now,
      message: {
        id: MessageId.makeUnsafe("notice"),
        role: "user" as const,
        dispatchOrigin: "notification" as const,
        text: renderChildThreadNotices([
          {
            childThreadId: ThreadId.makeUnsafe("child"),
            title: "Child test",
            turnId: "turn",
            status: "needs-attention",
            excerpt,
          },
        ]),
        createdAt: now,
        streaming: false,
      },
    },
  ];
  const onOpenThread = vi.fn();
  const screen = await render(
    <div style={{ width: 430, height: 400 }}>
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={entries}
        onOpenThread={onOpenThread}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso={now}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />
    </div>,
  );
  try {
    await expect
      .poll(() => document.querySelector("[data-child-thread-notice]")?.textContent)
      .toContain("needs attention");
    const row = document.querySelector<HTMLElement>("[data-child-thread-notice]")!;
    expect(row.querySelector("blockquote")?.textContent).toBe(excerpt);
    expect(row.querySelector("script")).toBeNull();
    expect(row.querySelector('a[href="https://example.invalid"]')).toBeNull();
    expect(row.classList.contains("text-ui")).toBe(true);
    row.querySelector<HTMLButtonElement>("button")!.click();
    expect(onOpenThread).toHaveBeenCalledWith("child");
  } finally {
    await screen.unmount();
  }
});
