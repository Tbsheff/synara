// FILE: pendingUserInput.ts
// Purpose: Normalize draft answers and progress for pending user input prompts.
// Layer: Web chat state utility
// Exports: Draft answer helpers and progress derivation used by ChatView/composer panels.

import type { ProviderUserInputAnswers, UserInputQuestion } from "@synara/contracts";

export type PendingUserInputAnswerMode = "options" | "custom";

export interface PendingUserInputDraftAnswer {
  selectedOptionLabels?: string[];
  customAnswer?: string;
  answerMode?: PendingUserInputAnswerMode;
}

export interface PendingUserInputProgress {
  questionIndex: number;
  activeQuestion: UserInputQuestion | null;
  activeDraft: PendingUserInputDraftAnswer | undefined;
  selectedOptionLabels: string[];
  customAnswer: string;
  resolvedAnswer: string | string[] | null;
  usingCustomAnswer: boolean;
  answeredQuestionCount: number;
  isLastQuestion: boolean;
  isComplete: boolean;
  canAdvance: boolean;
}

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Normalize option selections so UI and submit logic can share one canonical list.
function normalizeSelectedOptionLabels(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return Array.from(new Set(normalized));
}

function draftAnswerMode(
  draft: PendingUserInputDraftAnswer | undefined,
): PendingUserInputAnswerMode {
  return draft?.answerMode ?? (normalizeDraftAnswer(draft?.customAnswer) ? "custom" : "options");
}

function activeCustomAnswer(draft: PendingUserInputDraftAnswer | undefined): string | null {
  return draftAnswerMode(draft) === "custom" ? normalizeDraftAnswer(draft?.customAnswer) : null;
}

export function allowsPendingUserInputCustomAnswer(
  question: UserInputQuestion | null | undefined,
): boolean {
  return question?.isOther !== false || question.options.length === 0;
}

export function resolvePendingUserInputAnswer(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): string | string[] | null {
  const customAnswer = allowsPendingUserInputCustomAnswer(question)
    ? activeCustomAnswer(draft)
    : null;
  if (customAnswer) {
    return customAnswer;
  }

  const selectedOptionLabels = normalizeSelectedOptionLabels(draft?.selectedOptionLabels).filter(
    (label) =>
      allowsPendingUserInputCustomAnswer(question) ||
      question.options.some((option) => option.label === label),
  );
  if (question.multiSelect) {
    return selectedOptionLabels.length > 0 ? selectedOptionLabels : null;
  }

  return selectedOptionLabels[0] ?? null;
}

export function setPendingUserInputCustomAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer {
  if (draft && customAnswer.length === 0 && draftAnswerMode(draft) === "options") {
    return draft;
  }
  const selectedOptionLabels = normalizeSelectedOptionLabels(draft?.selectedOptionLabels);

  return {
    customAnswer,
    ...(selectedOptionLabels.length > 0 ? { selectedOptionLabels } : {}),
    answerMode: customAnswer.length > 0 ? "custom" : "options",
  };
}

// Toggle selections in-place so multi-select prompts can keep the same draft state shape.
export function togglePendingUserInputOptionSelection(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionLabel: string,
): PendingUserInputDraftAnswer {
  const selectedOptionLabels = normalizeSelectedOptionLabels(draft?.selectedOptionLabels);
  const nextSelectedOptionLabels = question.multiSelect
    ? selectedOptionLabels.includes(optionLabel)
      ? selectedOptionLabels.filter((label) => label !== optionLabel)
      : [...selectedOptionLabels, optionLabel]
    : [optionLabel];
  const customAnswer = draft?.customAnswer ?? "";
  const answerMode =
    nextSelectedOptionLabels.length === 0 && customAnswer.length > 0 ? "custom" : "options";

  return {
    ...(customAnswer.length > 0 ? { customAnswer } : {}),
    ...(nextSelectedOptionLabels.length > 0
      ? { selectedOptionLabels: nextSelectedOptionLabels }
      : {}),
    answerMode,
  };
}

export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, string | string[]> | null {
  const answers: Record<string, string | string[]> = {};

  for (const question of questions) {
    const answer = resolvePendingUserInputAnswer(question, draftAnswers[question.id]);
    if (!answer) {
      return null;
    }
    answers[question.id] = answer;
  }

  return answers;
}

export function hasCompletePendingUserInputAnswers(answers: ProviderUserInputAnswers): boolean {
  const entries = Object.entries(answers);
  if (entries.length === 0) {
    return false;
  }

  return entries.every(([, answer]) => {
    if (typeof answer === "string") {
      return answer.trim().length > 0;
    }

    if (Array.isArray(answer)) {
      return answer.some((entry) => typeof entry === "string" && entry.trim().length > 0);
    }

    return false;
  });
}

export function omitNullPendingUserInputAnswers(
  answers: ProviderUserInputAnswers,
): ProviderUserInputAnswers {
  return Object.fromEntries(
    Object.entries(answers).filter(([, answer]) => answer !== null && answer !== undefined),
  );
}

function countAnsweredPendingUserInputQuestions(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  return questions.reduce((count, question) => {
    return resolvePendingUserInputAnswer(question, draftAnswers[question.id]) ? count + 1 : count;
  }, 0);
}

export function derivePendingUserInputProgress(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
  questionIndex: number,
): PendingUserInputProgress {
  const normalizedQuestionIndex =
    questions.length === 0 ? 0 : Math.max(0, Math.min(questionIndex, questions.length - 1));
  const activeQuestion = questions[normalizedQuestionIndex] ?? null;
  const activeDraft = activeQuestion ? draftAnswers[activeQuestion.id] : undefined;
  const resolvedAnswer = activeQuestion
    ? resolvePendingUserInputAnswer(activeQuestion, activeDraft)
    : null;
  const customAnswer =
    allowsPendingUserInputCustomAnswer(activeQuestion) && draftAnswerMode(activeDraft) === "custom"
      ? (activeDraft?.customAnswer ?? "")
      : "";
  const usingCustomAnswer =
    allowsPendingUserInputCustomAnswer(activeQuestion) && activeCustomAnswer(activeDraft) !== null;
  const answeredQuestionCount = countAnsweredPendingUserInputQuestions(questions, draftAnswers);
  const isLastQuestion =
    questions.length === 0 ? true : normalizedQuestionIndex >= questions.length - 1;

  return {
    questionIndex: normalizedQuestionIndex,
    activeQuestion,
    activeDraft,
    selectedOptionLabels: usingCustomAnswer
      ? []
      : normalizeSelectedOptionLabels(activeDraft?.selectedOptionLabels),
    customAnswer,
    resolvedAnswer,
    usingCustomAnswer,
    answeredQuestionCount,
    isLastQuestion,
    isComplete: buildPendingUserInputAnswers(questions, draftAnswers) !== null,
    canAdvance: Boolean(resolvedAnswer),
  };
}
