import { describe, expect, it } from "vitest";

import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  hasCompletePendingUserInputAnswers,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "./pendingUserInput";

describe("resolvePendingUserInputAnswer", () => {
  it("prefers a custom answer over a selected option", () => {
    expect(
      resolvePendingUserInputAnswer(
        {
          id: "compat",
          header: "Compat",
          question: "How strict should compatibility be?",
          options: [],
        },
        {
          selectedOptionLabels: ["Keep current envelope"],
          customAnswer: "Keep the existing envelope for one release",
        },
      ),
    ).toBe("Keep the existing envelope for one release");
  });

  it("answers with the custom text while keeping the preset selection as a draft", () => {
    const question = {
      id: "tags",
      header: "Tags",
      question: "What should happen to tags?",
      options: [{ label: "Preserve existing tags", description: "Keep them" }],
    };
    const draft = setPendingUserInputCustomAnswer(
      { selectedOptionLabels: ["Preserve existing tags"] },
      "doesn't matter",
    );
    expect(resolvePendingUserInputAnswer(question, draft)).toBe("doesn't matter");
    expect(draft.selectedOptionLabels).toEqual(["Preserve existing tags"]);
  });

  it("returns all selected options for multi-select questions", () => {
    expect(
      resolvePendingUserInputAnswer(
        {
          id: "targets",
          header: "Targets",
          question: "Which outputs should we ship?",
          multiSelect: true,
          options: [],
        },
        {
          selectedOptionLabels: ["CLI", "Desktop"],
        },
      ),
    ).toEqual(["CLI", "Desktop"]);
  });
});

describe("togglePendingUserInputOptionSelection", () => {
  it("toggles options for multi-select questions", () => {
    const question = {
      id: "targets",
      header: "Targets",
      question: "Which outputs should we ship?",
      multiSelect: true,
      options: [],
    } as const;

    expect(
      togglePendingUserInputOptionSelection(question, { selectedOptionLabels: ["CLI"] }, "Desktop"),
    ).toEqual({
      answerMode: "options",
      selectedOptionLabels: ["CLI", "Desktop"],
    });

    expect(
      togglePendingUserInputOptionSelection(
        question,
        { selectedOptionLabels: ["CLI", "Desktop"] },
        "CLI",
      ),
    ).toEqual({
      answerMode: "options",
      selectedOptionLabels: ["Desktop"],
    });
  });
});

describe("switching between options and custom text", () => {
  const multiSelectQuestion = {
    id: "targets",
    header: "Targets",
    question: "Which outputs should we ship?",
    multiSelect: true,
    options: [
      { label: "CLI", description: "Command line" },
      { label: "Desktop", description: "Desktop app" },
    ],
  };
  const singleSelectQuestion = { ...multiSelectQuestion, id: "target", multiSelect: false };

  it("restores the prior selections when the custom text is cleared", () => {
    let draft = togglePendingUserInputOptionSelection(multiSelectQuestion, undefined, "CLI");
    draft = togglePendingUserInputOptionSelection(multiSelectQuestion, draft, "Desktop");
    draft = setPendingUserInputCustomAnswer(draft, "Web only");
    expect(resolvePendingUserInputAnswer(multiSelectQuestion, draft)).toBe("Web only");
    draft = setPendingUserInputCustomAnswer(draft, "");
    expect(resolvePendingUserInputAnswer(multiSelectQuestion, draft)).toEqual(["CLI", "Desktop"]);
  });

  it("restores the typed text when the options are cleared", () => {
    let draft = setPendingUserInputCustomAnswer(undefined, "Web only");
    draft = togglePendingUserInputOptionSelection(multiSelectQuestion, draft, "CLI");
    expect(resolvePendingUserInputAnswer(multiSelectQuestion, draft)).toEqual(["CLI"]);
    draft = togglePendingUserInputOptionSelection(multiSelectQuestion, draft, "CLI");
    expect(resolvePendingUserInputAnswer(multiSelectQuestion, draft)).toBe("Web only");
    expect(
      derivePendingUserInputProgress([multiSelectQuestion], { targets: draft }, 0).customAnswer,
    ).toBe("Web only");
  });

  it("keeps the typed text when the cleared composer echoes an empty value", () => {
    let draft = setPendingUserInputCustomAnswer(undefined, "Web only");
    draft = togglePendingUserInputOptionSelection(multiSelectQuestion, draft, "CLI");
    const echoed = setPendingUserInputCustomAnswer(draft, "");
    expect(echoed).toBe(draft);
    draft = togglePendingUserInputOptionSelection(multiSelectQuestion, echoed, "CLI");
    expect(resolvePendingUserInputAnswer(multiSelectQuestion, draft)).toBe("Web only");
  });

  it("answers and shows only the active mode when both values are kept", () => {
    let draft = setPendingUserInputCustomAnswer(undefined, "Web only");
    draft = togglePendingUserInputOptionSelection(singleSelectQuestion, draft, "Desktop");
    expect(draft.customAnswer).toBe("Web only");
    expect(buildPendingUserInputAnswers([singleSelectQuestion], { target: draft })).toEqual({
      target: "Desktop",
    });
    const progress = derivePendingUserInputProgress([singleSelectQuestion], { target: draft }, 0);
    expect(progress.customAnswer).toBe("");
    expect(progress.usingCustomAnswer).toBe(false);
    expect(progress.selectedOptionLabels).toEqual(["Desktop"]);
  });
});

describe("buildPendingUserInputAnswers", () => {
  it("returns a canonical answer map for complete prompts", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          {
            id: "scope",
            header: "Scope",
            question: "What should the plan target first?",
            options: [
              {
                label: "Orchestration-first",
                description: "Focus on orchestration first",
              },
            ],
          },
          {
            id: "compat",
            header: "Compat",
            question: "How strict should compatibility be?",
            options: [
              {
                label: "Keep current envelope",
                description: "Preserve current wire format",
              },
            ],
          },
        ],
        {
          scope: {
            selectedOptionLabels: ["Orchestration-first"],
          },
          compat: {
            customAnswer: "Keep the current envelope for one release window",
          },
        },
      ),
    ).toEqual({
      scope: "Orchestration-first",
      compat: "Keep the current envelope for one release window",
    });
  });

  it("returns null when any question is unanswered", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          {
            id: "scope",
            header: "Scope",
            question: "What should the plan target first?",
            options: [
              {
                label: "Orchestration-first",
                description: "Focus on orchestration first",
              },
            ],
          },
        ],
        {},
      ),
    ).toBeNull();
  });
});

describe("hasCompletePendingUserInputAnswers", () => {
  it("accepts non-empty string and array answers", () => {
    expect(
      hasCompletePendingUserInputAnswers({
        language: "TypeScript",
        features: ["Auth", "Testing"],
      }),
    ).toBe(true);
  });

  it("rejects null and empty answers before dispatch", () => {
    expect(
      hasCompletePendingUserInputAnswers({
        language: null,
        features: [],
      }),
    ).toBe(false);
  });
});

describe("pending user input question progress", () => {
  const questions = [
    {
      id: "scope",
      header: "Scope",
      question: "What should the plan target first?",
      options: [
        {
          label: "Orchestration-first",
          description: "Focus on orchestration first",
        },
      ],
    },
    {
      id: "compat",
      header: "Compat",
      question: "How strict should compatibility be?",
      options: [
        {
          label: "Keep current envelope",
          description: "Preserve current wire format",
        },
      ],
    },
  ] as const;

  it("derives the active question and advancement state", () => {
    expect(
      derivePendingUserInputProgress(
        questions,
        {
          scope: {
            selectedOptionLabels: ["Orchestration-first"],
          },
        },
        0,
      ),
    ).toMatchObject({
      questionIndex: 0,
      activeQuestion: questions[0],
      selectedOptionLabels: ["Orchestration-first"],
      customAnswer: "",
      resolvedAnswer: "Orchestration-first",
      answeredQuestionCount: 1,
      isLastQuestion: false,
      isComplete: false,
      canAdvance: true,
    });
  });
});

describe("options-only questions", () => {
  it("rejects custom text and unlisted choices when the provider disables Other", () => {
    const question = {
      id: "q",
      header: "Target",
      question: "Choose",
      isOther: false,
      options: [{ label: "CLI", description: "CLI" }],
    };
    expect(
      resolvePendingUserInputAnswer(question, { customAnswer: "injected", answerMode: "custom" }),
    ).toBeNull();
    expect(
      resolvePendingUserInputAnswer(question, {
        selectedOptionLabels: ["unlisted"],
        answerMode: "options",
      }),
    ).toBeNull();
    expect(
      resolvePendingUserInputAnswer(question, {
        selectedOptionLabels: ["CLI"],
        customAnswer: "kept draft",
        answerMode: "custom",
      }),
    ).toBe("CLI");
    expect(
      derivePendingUserInputProgress([question], { q: { customAnswer: "injected" } }, 0)
        .customAnswer,
    ).toBe("");
  });
});

it("accepts free text when isOther is false but no options exist", () => {
  const question = {
    id: "free-text",
    header: "Answer",
    question: "What should change?",
    options: [],
    isOther: false,
  };
  const draft = { customAnswer: "Keep the existing API", answerMode: "custom" as const };
  expect(resolvePendingUserInputAnswer(question, draft)).toBe("Keep the existing API");
  expect(derivePendingUserInputProgress([question], { [question.id]: draft }, 0)).toMatchObject({
    customAnswer: "Keep the existing API",
    usingCustomAnswer: true,
    canAdvance: true,
    isComplete: true,
  });
});
