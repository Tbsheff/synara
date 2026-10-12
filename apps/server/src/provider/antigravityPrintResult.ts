function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const RESULT_STATUSES = new Set([
  "SUCCESS",
  "ERROR",
  "CANCELED",
  "INTERRUPTED",
  "INVALID",
  "WAITING",
  "RUNNING",
]);
const STREAM_EVENTS = new Set(["init", "step_update", "result", "error"]);

export const ANTIGRAVITY_PRINT_RECORD_MAX_CHARS = 8 * 1024 * 1024;
export const ANTIGRAVITY_PRINT_RESULT_MAX_CHARS = 4 * 1024 * 1024;

type Step = {
  state?: unknown;
  type?: unknown;
  text: string;
};

export type AntigravityPrintResultParserOptions = {
  readonly maxRecordChars?: number;
  readonly maxResultChars?: number;
};

/** Consume complete records as they arrive; an interrupted final line must not erase prior output. */
export function createAntigravityPrintResultParser(
  options: AntigravityPrintResultParserOptions = {},
) {
  const maxRecordChars = options.maxRecordChars ?? ANTIGRAVITY_PRINT_RECORD_MAX_CHARS;
  const maxResultChars = options.maxResultChars ?? ANTIGRAVITY_PRINT_RESULT_MAX_CHARS;
  let pending = "";
  let discardingRecord = false;
  let fallback = "";
  let structured = false;
  let streamed = false;
  let streamError: string | undefined;
  let malformedRecord = false;
  let result: Record<string, unknown> | undefined;
  const steps = new Map<number, Step>();
  let lastResponseIndex = -1;
  let retainedTextChars = 0;
  let oversizedRecords = 0;
  let droppedRecordChars = 0;
  let droppedResponseChars = 0;
  let droppedFallbackChars = 0;

  const retainText = (current: string, delta: string): string => {
    const accepted = Math.max(0, Math.min(delta.length, maxResultChars - retainedTextChars));
    droppedResponseChars += delta.length - accepted;
    retainedTextChars += accepted;
    return accepted > 0 ? `${current}${delta.slice(0, accepted)}` : current;
  };

  const releaseText = (index: number) => {
    const step = steps.get(index);
    if (!step?.text) return;
    retainedTextChars -= step.text.length;
    step.text = "";
  };

  const consume = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let value: Record<string, unknown> | undefined;
    try {
      value = record(JSON.parse(trimmed));
    } catch {
      // A truncated protocol header is not a legacy answer. Ordinary markdown
      // and JSON answers still use the plain-text fallback.
      if (/^\{\s*"(?:event|status)"\s*:/.test(trimmed)) structured = true;
      if (structured) malformedRecord = true;
      return;
    }
    if (!value) return;
    if (typeof value.event !== "string" || !STREAM_EVENTS.has(value.event)) {
      if (typeof value.status === "string" && RESULT_STATUSES.has(value.status)) {
        structured = true;
        result = value;
      }
      return;
    }
    structured = true;
    streamed = true;
    if (value.event === "result") {
      const envelope = record(value.result);
      if (envelope && typeof envelope.status === "string") result = envelope;
      else malformedRecord = true;
    } else if (value.event === "error") {
      streamError =
        typeof value.message === "string" && value.message.trim()
          ? value.message
          : "Antigravity stream failed.";
    } else if (value.event === "step_update") {
      const update = record(value.step_update);
      const index = update?.step_index;
      if (!update || typeof index !== "number" || !Number.isInteger(index) || index < 0) {
        malformedRecord = true;
        return;
      }
      const previous = steps.get(index);
      const type = update.step_type ?? previous?.type;
      const delta = typeof update.text_delta === "string" ? update.text_delta : "";
      if (type === "agent_response" && index > lastResponseIndex) {
        if (lastResponseIndex >= 0) releaseText(lastResponseIndex);
        lastResponseIndex = index;
      }
      const keepsText = type === undefined || index === lastResponseIndex;
      if (!keepsText) releaseText(index);
      steps.set(index, {
        state: update.state ?? previous?.state,
        type,
        text: keepsText ? retainText(previous?.text ?? "", delta) : "",
      });
    }
  };

  return {
    write(chunk: string) {
      if (!structured) {
        const accepted = Math.max(0, Math.min(chunk.length, maxResultChars - fallback.length));
        droppedFallbackChars += chunk.length - accepted;
        if (accepted > 0) fallback += chunk.slice(0, accepted);
      }
      let start = 0;
      while (start < chunk.length) {
        const end = chunk.indexOf("\n", start);
        const piece = end === -1 ? chunk.slice(start) : chunk.slice(start, end);
        if (discardingRecord) {
          droppedRecordChars += piece.length;
        } else if (pending.length + piece.length > maxRecordChars) {
          droppedRecordChars += pending.length + piece.length;
          oversizedRecords += 1;
          malformedRecord = true;
          discardingRecord = true;
          pending = "";
        } else {
          pending += piece;
        }
        if (end === -1) break;
        if (!discardingRecord) consume(pending);
        pending = "";
        discardingRecord = false;
        start = end + 1;
      }
      if (structured && (fallback || droppedFallbackChars)) {
        fallback = "";
        droppedFallbackChars = 0;
      }
    },
    plainTextFallback(): string {
      return structured ? "" : fallback;
    },
    truncation() {
      return { oversizedRecords, droppedRecordChars, droppedResponseChars, droppedFallbackChars };
    },
    finish() {
      if (!discardingRecord) consume(pending);
      pending = "";
      discardingRecord = false;
      if (!structured) return undefined;
      const state =
        result?.status === "CANCELED" || result?.status === "INTERRUPTED"
          ? "interrupted"
          : streamError || (result && result.status !== "SUCCESS")
            ? "failed"
            : result?.status === "SUCCESS"
              ? "completed"
              : undefined;
      let lastResponseIndex = -1;
      let lastResponse: Step | undefined;
      for (const [index, step] of steps) {
        if (step.type === "agent_response" && index > lastResponseIndex) {
          lastResponseIndex = index;
          lastResponse = step;
        }
      }
      const completedResponse =
        streamed &&
        !malformedRecord &&
        (state === undefined || state === "completed") &&
        lastResponse?.state === "DONE" &&
        lastResponse.text.trim().length > 0 &&
        [...steps.entries()].every(
          ([index, step]) =>
            step.state === "DONE" && (step.type !== "error" || index < lastResponseIndex),
        );
      let response =
        typeof result?.response === "string" && result.response.trim()
          ? result.response
          : (lastResponse?.text ?? "");
      if (response.length > maxResultChars) {
        droppedResponseChars += response.length - maxResultChars;
        response = response.slice(0, maxResultChars);
      }
      return {
        state,
        completedResponse,
        response,
        error:
          typeof result?.error === "string"
            ? result.error
            : (streamError ??
              (state === "failed"
                ? `Antigravity ended with status ${result?.status}.`
                : undefined)),
        failed: state === "failed",
      };
    },
  };
}

export function parseAntigravityPrintResult(stdout: string) {
  const parser = createAntigravityPrintResultParser();
  parser.write(stdout);
  return parser.finish();
}
