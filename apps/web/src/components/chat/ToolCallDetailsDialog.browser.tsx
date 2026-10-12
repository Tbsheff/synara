import "../../index.css";

import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { buildTypedCommandView } from "../../lib/toolCallDetails";
import { TypedCommandDetails } from "./ToolCallDetailsDialog";

function lines(count: number) {
  return Array.from({ length: count }, (_, index) => `MEASURE_LINE_${index + 1}`).join("\n");
}

function outputBox() {
  const box = document.querySelector<HTMLPreElement>(
    "[data-command-live-output], [data-command-output], [data-command-stdout] > pre, [data-command-stderr] > pre",
  );
  if (!box) throw new Error("Command output box missing");
  return box;
}

async function nextFrame() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

describe("command output completion", () => {
  it.each(["output", "stdout", "stderr"] as const)(
    "keeps the box and reader position when live output clears before final %s arrives",
    async (stream) => {
      for (const detached of [false, true]) {
        const screen = await render(
          <TypedCommandDetails
            running
            view={buildTypedCommandView({
              command: { command: "run" },
              status: "running",
              liveOutput: { tail: lines(40), totalChars: lines(40).length, truncated: false },
            })}
          />,
        );
        try {
          await screen.rerender(
            <TypedCommandDetails
              running
              view={buildTypedCommandView({
                command: { command: "run" },
                status: "running",
                liveOutput: { tail: lines(60), totalChars: lines(60).length, truncated: false },
              })}
            />,
          );
          const box = outputBox();
          if (detached) box.scrollTop -= 120;
          box.dispatchEvent(new Event("scroll"));
          await nextFrame();
          const readerScrollTop = box.scrollTop;
          await screen.rerender(
            <TypedCommandDetails
              running
              view={buildTypedCommandView({ command: { command: "run" }, status: "running" })}
            />,
          );
          await nextFrame();
          expect(box.isConnected).toBe(true);
          expect(box.textContent).toBe(lines(60));
          expect(box.scrollTop).toBe(readerScrollTop);
          await screen.rerender(
            <TypedCommandDetails
              running={false}
              view={buildTypedCommandView({
                command: { command: "run", [stream]: lines(61), exitCode: 0 },
                status: "completed",
              })}
            />,
          );
          await nextFrame();
          expect(outputBox()).toBe(box);
          expect(box.textContent).toContain("MEASURE_LINE_61");
          if (detached) {
            expect(box.scrollTop).toBe(readerScrollTop);
          } else {
            expect(box.scrollHeight - box.clientHeight - box.scrollTop).toBeLessThanOrEqual(1);
          }
        } finally {
          await screen.unmount();
        }
      }
    },
  );

  it.each(["output", "stdout", "stderr"] as const)(
    "keeps the same box and its reader position when final %s arrives",
    async (stream) => {
      for (const detached of [false, true]) {
        const screen = await render(
          <TypedCommandDetails
            running
            view={buildTypedCommandView({
              command: { command: "run" },
              status: "running",
              liveOutput: { tail: lines(60), totalChars: lines(60).length, truncated: false },
            })}
          />,
        );
        try {
          const box = outputBox();
          expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
          expect(box.scrollHeight - box.clientHeight - box.scrollTop).toBeLessThanOrEqual(1);
          if (detached) box.scrollTop -= 120;
          box.dispatchEvent(new Event("scroll"));
          await nextFrame();
          const readerScrollTop = box.scrollTop;
          await screen.rerender(
            <TypedCommandDetails
              running={false}
              view={buildTypedCommandView({
                command: { command: "run", [stream]: lines(61), exitCode: 0 },
                status: "completed",
              })}
            />,
          );
          await nextFrame();
          expect(outputBox()).toBe(box);
          expect(box.textContent).toContain("MEASURE_LINE_61");
          if (detached) {
            expect(box.scrollTop).toBe(readerScrollTop);
          } else {
            expect(box.scrollHeight - box.clientHeight - box.scrollTop).toBeLessThanOrEqual(1);
            const text = box.firstChild!;
            const range = document.createRange();
            range.setStart(text, box.textContent!.lastIndexOf("MEASURE_LINE_61"));
            range.setEnd(text, box.textContent!.length);
            const lineRect = range.getBoundingClientRect();
            const boxRect = box.getBoundingClientRect();
            expect(lineRect.top).toBeGreaterThanOrEqual(boxRect.top);
            expect(lineRect.bottom).toBeLessThanOrEqual(boxRect.bottom);
          }
        } finally {
          await screen.unmount();
        }
      }
    },
  );
});
