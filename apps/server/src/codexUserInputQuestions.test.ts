import { describe, expect, it } from "vitest";
import { parseCodexUserInputQuestions } from "./codexAppServerManager";

describe("Codex user input custom-answer policy", () => {
  it("keeps an explicit options-only flag", () => {
    expect(
      parseCodexUserInputQuestions({
        questions: [
          {
            id: "q",
            header: "Target",
            question: "Choose",
            isOther: false,
            options: [{ label: "CLI", description: "CLI" }],
          },
        ],
      })?.[0],
    ).toMatchObject({ isOther: false });
  });
  it("keeps the custom-answer flag when enabled", () => {
    expect(
      parseCodexUserInputQuestions({
        questions: [{ id: "q", header: "Target", question: "Choose", isOther: true, options: [] }],
      })?.[0],
    ).toMatchObject({ isOther: true });
  });
});
