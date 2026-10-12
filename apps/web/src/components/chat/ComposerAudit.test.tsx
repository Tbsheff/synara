import { ApprovalRequestId } from "@synara/contracts";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeQueuedChatTurn } from "../../composerDraftStoreTestFixtures";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerQueuedHeader, queuedComposerTurnAttachmentSummary } from "./ComposerQueuedHeader";
import { ComposerVoiceRecorderBar } from "./ComposerVoiceRecorderBar";
import { UserInputQuestionForm } from "./UserInputQuestionForm";

const hooks = vi.hoisted(() => ({ state: false }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: () => undefined,
  useEffectEvent: <T,>(fn: T) => fn,
  useRef: <T,>(current: T) => ({ current }),
  useId: () => "preview-region",
  useState: (initial: unknown) => [
    typeof initial === "boolean" ? hooks.state : initial,
    (next: unknown) => {
      hooks.state = typeof next === "function" ? next(hooks.state) : next;
    },
  ],
}));

type Props = { children?: ReactNode; [key: string]: unknown };
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}

describe("composer audit interaction contracts", () => {
  beforeEach(() => {
    hooks.state = false;
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not submit the final answer until the user submits", async () => {
    const onAdvance = vi.fn();
    const tree = UserInputQuestionForm({
      questions: [
        {
          id: "q",
          header: "Scope",
          question: "Choose",
          options: [{ label: "CLI", description: "CLI" }],
        },
      ],
      submissionVersion: 0,
      isResponding: false,
      answers: {},
      questionIndex: 0,
      onToggleOption: () => ({ selectedOptionLabels: ["CLI"] }),
      onAdvance,
      onPrevious: vi.fn(),
    });
    const choice = elements(tree).find((el) => el.props.label === "CLI")!;
    (choice.props.onSelect as () => void)();
    await vi.advanceTimersByTimeAsync(250);
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it("offers the exact persistent scope and passes it with the decision", () => {
    const rule = { type: "network-host" as const, host: "example.com", action: "allow" as const };
    const onRespond = vi.fn(async () => undefined);
    const tree = ComposerPendingApprovalPanel({
      approval: {
        requestId: ApprovalRequestId.makeUnsafe("request"),
        requestKind: "command",
        createdAt: "2026-01-01T00:00:00Z",
        approvalRuleOptions: [rule],
      },
      pendingCount: 1,
      isResponding: false,
      onRespond,
    });
    const choice = elements(tree).find((el) => el.props.label === "Always allow example.com");
    expect(choice).toBeDefined();
    (choice!.props.onSelect as () => void)();
    expect(onRespond).toHaveBeenCalledWith("request", "accept", undefined, "command", rule);
  });

  it("announces pending approval in a polite region and offers a focus target", () => {
    const tree = ComposerPendingApprovalPanel({
      approval: {
        requestId: ApprovalRequestId.makeUnsafe("request"),
        requestKind: "command",
        createdAt: "2026-01-01T00:00:00Z",
        detail: "Bash: echo hello",
      },
      pendingCount: 1,
      isResponding: false,
      onRespond: vi.fn(async () => undefined),
    });
    expect(
      elements(tree).some((el) => el.props.role === "status" && el.props["aria-live"] === "polite"),
    ).toBe(true);
    expect(elements(tree).some((el) => el.props.role === "group" && el.props.tabIndex === -1)).toBe(
      true,
    );
  });

  it("keeps Cancel enabled during transcription", () => {
    const onDiscard = vi.fn();
    const tree = ComposerVoiceRecorderBar({
      durationLabel: "0:03",
      isRecording: false,
      isTranscribing: true,
      waveformLevels: [],
      onDiscard,
      onStop: vi.fn(),
    });
    const cancel = elements(tree).find((el) => el.props["aria-label"] === "Cancel transcription");
    expect(cancel).toBeDefined();
    expect(cancel?.props.disabled).not.toBe(true);
    (cancel?.props.onClick as () => void)();
    expect(onDiscard).toHaveBeenCalledOnce();
  });

  it("reads a queued prompt without removing or editing it", () => {
    const queuedTurn = {
      ...makeQueuedChatTurn("preview"),
      prompt: "first line\nfull instructions",
      previewText: "first line",
    };
    const onRemove = vi.fn();
    const onEdit = vi.fn();
    const tree = ComposerQueuedHeader({
      queuedTurns: [queuedTurn],
      onRemove,
      onEdit,
      onSteer: vi.fn(),
    });
    const row = elements(tree).find(
      (el) => el.props.queuedTurn === queuedTurn && el.props.showDivider === false,
    );
    expect(row).toBeDefined();
    const renderRow = () => (row!.type as (props: Props) => ReactNode)(row!.props);
    const collapsed = elements(renderRow());
    const toggle = collapsed.find((el) => el.props.label === "Show full queued follow-up");
    expect(toggle?.props["aria-expanded"]).toBe(false);
    (toggle?.props.onClick as () => void)();
    const expanded = elements(renderRow());
    expect(
      expanded.some(
        (el) =>
          el.props.label === "Hide full queued follow-up" && el.props["aria-expanded"] === true,
      ),
    ).toBe(true);
    expect(expanded.some((el) => el.props.children === queuedTurn.prompt)).toBe(true);
    expect(onRemove).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
  });
});

it("shows queued file references in the attachment count after reload", () => {
  const base = makeQueuedChatTurn("stored-file");
  if (base.kind !== "chat") throw new Error("Expected a chat queue fixture");
  const queued = {
    ...base,
    terminalContexts: [],
    files: [],
    persistedFiles: [
      {
        id: "file-stored",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
        blobKey: "queued-file",
      },
    ],
  };
  expect(queuedComposerTurnAttachmentSummary(queued)).toBe("1 file");
});
