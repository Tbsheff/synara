import { describe, expect, it } from "vitest";
import {
  createAntigravityPrintResultParser,
  parseAntigravityPrintResult,
} from "./antigravityPrintResult";

const encode = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");
const response = {
  event: "step_update",
  step_update: {
    step_index: 1,
    step_type: "agent_response",
    state: "DONE",
    text_delta: "Finished",
  },
};

describe("Antigravity print result", () => {
  it("honors the terminal ERROR after a response recovered within the first turn", () => {
    const result = parseAntigravityPrintResult(
      encode([
        { event: "step_update", step_update: { step_index: 0, step_type: "error", state: "DONE" } },
        response,
        {
          event: "result",
          result: {
            status: "ERROR",
            num_turns: 1,
            error: "The stream was interrupted. Please continue the task you were working on.",
          },
        },
      ]),
    );
    expect(result).toMatchObject({
      state: "failed",
      completedResponse: false,
      response: "Finished",
    });
  });
  it("does not allow stop-hook recovery after a later error step", () => {
    expect(
      parseAntigravityPrintResult(
        encode([
          response,
          {
            event: "step_update",
            step_update: { step_index: 2, step_type: "error", state: "DONE" },
          },
        ]),
      ),
    ).toMatchObject({ completedResponse: false });
  });
  it("parses records split across chunks and retains text before an incomplete final line", () => {
    const parser = createAntigravityPrintResultParser();
    const source =
      encode([
        {
          event: "step_update",
          step_update: {
            step_index: 1,
            step_type: "agent_response",
            state: "ACTIVE",
            text_delta: "Hel",
          },
        },
        { event: "step_update", step_update: { step_index: 1, state: "DONE", text_delta: "lo" } },
      ]) + '\n{"event":';
    for (let index = 0; index < source.length; index += 7)
      parser.write(source.slice(index, index + 7));
    expect(parser.finish()).toMatchObject({
      response: "Hello",
      state: undefined,
      completedResponse: false,
    });
  });

  it("accepts DONE housekeeping after a completed response, but not pending tools", () => {
    const updates = [
      response,
      {
        event: "step_update",
        step_update: { step_index: 2, step_type: "checkpoint", state: "DONE" },
      },
    ];
    expect(parseAntigravityPrintResult(encode(updates))).toMatchObject({ completedResponse: true });
    expect(
      parseAntigravityPrintResult(
        encode([
          ...updates,
          {
            event: "step_update",
            step_update: { step_index: 3, step_type: "tool", state: "ACTIVE" },
          },
        ]),
      ),
    ).toMatchObject({ completedResponse: false });
  });

  it("does not infer historical errors from the conversation turn count", () => {
    const result = {
      event: "result",
      result: { status: "ERROR", num_turns: 13, error: "quota exceeded" },
    };
    expect(parseAntigravityPrintResult(encode([response, result]))).toMatchObject({
      completedResponse: false,
      state: "failed",
      response: "Finished",
      error: "quota exceeded",
    });
  });

  it("retains text from a textless DONE update without overriding timeout errors", () => {
    const updates = [
      {
        event: "step_update",
        step_update: {
          step_index: 1,
          step_type: "agent_response",
          state: "ACTIVE",
          text_delta: "Finished",
        },
      },
      { event: "step_update", step_update: { step_index: 1, state: "DONE" } },
      { event: "result", result: { status: "ERROR", error: "timeout waiting for response" } },
    ];
    expect(parseAntigravityPrintResult(encode(updates))).toMatchObject({
      completedResponse: false,
      state: "failed",
      response: "Finished",
    });
  });

  it("does not turn a malformed first protocol line into legacy text", () => {
    expect(parseAntigravityPrintResult('{"event":')).toMatchObject({
      response: "",
      completedResponse: false,
    });
  });

  it("retains a valid result after a malformed record without allowing stop-hook recovery", () => {
    const source =
      encode([response]) +
      '\n{"event":invalid}\n' +
      encode([{ event: "result", result: { status: "SUCCESS", response: "Finished" } }]);
    expect(parseAntigravityPrintResult(source)).toMatchObject({
      response: "Finished",
      state: "completed",
      completedResponse: false,
    });
  });

  it("reads single-result JSON while leaving ordinary JSON answers as legacy text", () => {
    expect(parseAntigravityPrintResult('{"status":"SUCCESS","response":"Finished"}')).toMatchObject(
      { response: "Finished", state: "completed" },
    );
    expect(parseAntigravityPrintResult('{"answer":42}')).toBeUndefined();
  });

  it("does not discard explicit stream errors with an empty message", () => {
    expect(
      parseAntigravityPrintResult(encode([response, { event: "error", message: "" }])),
    ).toMatchObject({ completedResponse: false, state: "failed" });
  });

  it("bounds unterminated records, response text, and the plain-text fallback", () => {
    const limits = { maxRecordChars: 1024, maxResultChars: 512 };
    const plain = createAntigravityPrintResultParser(limits);
    for (let index = 0; index < 100; index += 1) plain.write("y".repeat(1000));
    expect(plain.finish()).toBeUndefined();
    expect(plain.plainTextFallback()).toHaveLength(512);
    expect(plain.truncation()).toMatchObject({ droppedFallbackChars: 100_000 - 512 });

    const structured = createAntigravityPrintResultParser(limits);
    structured.write(`${encode([response])}\n`);
    for (let index = 0; index < 100; index += 1) structured.write("z".repeat(1000));
    structured.write("\n");
    structured.write(
      `${encode([
        {
          event: "step_update",
          step_update: {
            step_index: 2,
            step_type: "agent_response",
            state: "DONE",
            text_delta: "r".repeat(900),
          },
        },
        { event: "result", result: { status: "SUCCESS" } },
      ])}\n`,
    );
    const result = structured.finish();
    expect(result).toMatchObject({ state: "completed", completedResponse: false });
    expect(result?.response).toHaveLength(512);
    expect(structured.plainTextFallback()).toBe("");
    expect(structured.truncation()).toMatchObject({
      oversizedRecords: 1,
      droppedRecordChars: 100_000,
      droppedResponseChars: 900 - 512,
    });

    const enveloped = createAntigravityPrintResultParser(limits);
    enveloped.write(
      `${encode([{ event: "result", result: { status: "SUCCESS", response: "e".repeat(800) } }])}\n`,
    );
    expect(enveloped.finish()?.response).toHaveLength(512);
    expect(enveloped.truncation()).toMatchObject({ droppedResponseChars: 800 - 512 });
  });
});
