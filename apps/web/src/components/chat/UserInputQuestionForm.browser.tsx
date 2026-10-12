import "../../index.css";
import { ApprovalRequestId, MessageId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { AsyncUserInputCard } from "./AsyncUserInputCard";
import { UserInputQuestionForm } from "./UserInputQuestionForm";

const prompt = {
  requestId: ApprovalRequestId.makeUnsafe("blocking-question"),
  createdAt: "2026-09-15T00:00:00Z",
  questions: [
    {
      id: "question",
      header: "Choose",
      question: "Which option?",
      multiSelect: false,
      options: [
        { label: "First", description: "First" },
        { label: "Second", description: "Second" },
      ],
    },
  ],
};

const twoQuestionPrompt = {
  ...prompt,
  questions: [
    prompt.questions[0]!,
    { ...prompt.questions[0]!, id: "followUp", question: "Which follow-up?" },
  ],
};

const waitPastAutoAdvance = () => new Promise((resolve) => setTimeout(resolve, 300));

const props = () => ({
  pendingUserInputs: [prompt],
  answers: {},
  questionIndex: 0,
  submissionVersion: 0,
  isResponding: false,
  onToggleOption: vi.fn((_questionId: string, label: string) => ({
    selectedOptionLabels: [label],
  })),
  onAdvance: vi.fn(),
  onPrevious: vi.fn(),
  onCancel: vi.fn(),
});

describe("shared question form with blocking prompts", () => {
  it("offers Cancel with choices and stops pending auto-advance", async () => {
    const callbacks = props();
    const screen = await render(<ComposerPendingUserInputPanel {...callbacks} />);
    await screen.getByRole("button", { name: /Second/ }).click();
    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(callbacks.onAdvance).not.toHaveBeenCalled();
  });

  it("keeps Cancel available when a question has no choices", async () => {
    const callbacks = props();
    const noChoicePrompt = {
      ...prompt,
      questions: [{ ...prompt.questions[0]!, options: [] }],
    };
    const screen = await render(
      <ComposerPendingUserInputPanel {...callbacks} pendingUserInputs={[noChoicePrompt]} />,
    );
    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
  });

  it("preserves global digit shortcuts and advances with the newly selected answer", async () => {
    const callbacks = props();
    await render(
      <ComposerPendingUserInputPanel {...callbacks} pendingUserInputs={[twoQuestionPrompt]} />,
    );
    await userEvent.keyboard("2");
    expect(callbacks.onToggleOption).toHaveBeenCalledExactlyOnceWith("question", "Second");
    await expect
      .poll(() => callbacks.onAdvance.mock.calls)
      .toEqual([[{ question: { selectedOptionLabels: ["Second"] } }]]);
  });

  it("cancels delayed choice advancement when a response starts", async () => {
    const callbacks = props();
    const screen = await render(<ComposerPendingUserInputPanel {...callbacks} />);
    await screen.getByRole("button", { name: /Second/ }).click();
    await screen.rerender(
      <ComposerPendingUserInputPanel {...callbacks} isResponding submissionVersion={1} />,
    );
    await expect.element(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(callbacks.onAdvance).not.toHaveBeenCalled();
  });

  it("does not consume shortcuts from an open async form", async () => {
    const callbacks = props();
    const screen = await render(
      <>
        <AsyncUserInputCard
          messageId={MessageId.makeUnsafe("async")}
          input={{ questions: [{ title: "Async question?", options: ["Only choice"] }] }}
          onRespond={vi.fn()}
        />
        <ComposerPendingUserInputPanel {...callbacks} />
      </>,
    );
    await screen.getByRole("button", { name: "1 question", exact: true }).click();
    await screen.getByRole("button", { name: /Only choice/ }).click();
    await userEvent.keyboard("2");
    expect(callbacks.onToggleOption).not.toHaveBeenCalled();
  });
});

describe("auto-advance", () => {
  it("waits for an explicit submit after choosing the only question's answer", async () => {
    const callbacks = props();
    const screen = await render(<ComposerPendingUserInputPanel {...callbacks} />);
    await screen.getByRole("button", { name: /Second/ }).click();
    expect(callbacks.onToggleOption).toHaveBeenCalledExactlyOnceWith("question", "Second");
    await waitPastAutoAdvance();
    expect(callbacks.onAdvance).not.toHaveBeenCalled();
  });

  it("advances between questions but waits for submit on the last question", async () => {
    const callbacks = props();
    const screen = await render(
      <ComposerPendingUserInputPanel {...callbacks} pendingUserInputs={[twoQuestionPrompt]} />,
    );
    await screen.getByRole("button", { name: /Second/ }).click();
    await expect
      .poll(() => callbacks.onAdvance.mock.calls)
      .toEqual([[{ question: { selectedOptionLabels: ["Second"] } }]]);
    await screen.rerender(
      <ComposerPendingUserInputPanel
        {...callbacks}
        pendingUserInputs={[twoQuestionPrompt]}
        questionIndex={1}
      />,
    );
    await screen.getByRole("button", { name: /First/ }).click();
    expect(callbacks.onToggleOption).toHaveBeenLastCalledWith("followUp", "First");
    await waitPastAutoAdvance();
    expect(callbacks.onAdvance).toHaveBeenCalledOnce();
  });

  it("cancels a pending advance when the answer changes before it fires", async () => {
    const callbacks = props();
    const screen = await render(
      <ComposerPendingUserInputPanel {...callbacks} pendingUserInputs={[twoQuestionPrompt]} />,
    );
    await screen.getByRole("button", { name: /Second/ }).click();
    await screen.rerender(
      <ComposerPendingUserInputPanel
        {...callbacks}
        pendingUserInputs={[twoQuestionPrompt]}
        answers={{ question: { customAnswer: "Typed instead", answerMode: "custom" } }}
      />,
    );
    await waitPastAutoAdvance();
    expect(callbacks.onAdvance).not.toHaveBeenCalled();
  });

  it("cancels a pending advance when a text input receives focus", async () => {
    const callbacks = props();
    const screen = await render(
      <>
        <UserInputQuestionForm {...callbacks} questions={twoQuestionPrompt.questions} />
        <textarea aria-label="Composer" />
      </>,
    );
    await screen.getByRole("button", { name: /Second/ }).click();
    (screen.getByRole("textbox", { name: "Composer" }).element() as HTMLTextAreaElement).focus();
    await waitPastAutoAdvance();
    expect(callbacks.onAdvance).not.toHaveBeenCalled();
  });
});

describe("option previews", () => {
  it("shows the selected option's preview as plain text", async () => {
    const callbacks = props();
    const previewPrompt = {
      ...prompt,
      questions: [
        {
          ...prompt.questions[0]!,
          options: [
            { label: "First", description: "First", preview: "<b>first</b>" },
            { label: "Second", description: "Second", preview: "second layout" },
          ],
        },
      ],
    };
    const screen = await render(
      <ComposerPendingUserInputPanel
        {...callbacks}
        pendingUserInputs={[previewPrompt]}
        answers={{ question: { selectedOptionLabels: ["Second"] } }}
      />,
    );
    const preview = screen.getByTestId("user-input-option-preview");
    await expect.element(preview).toHaveTextContent("second layout");
    await screen.rerender(
      <ComposerPendingUserInputPanel {...callbacks} pendingUserInputs={[previewPrompt]} />,
    );
    await expect.element(preview).toHaveTextContent("<b>first</b>");
    expect(preview.element().querySelector("b")).toBeNull();
  });
});
