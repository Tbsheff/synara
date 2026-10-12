import {
  getSharedHighlighter,
  parseDiffFromFile,
  renderDiffWithHighlighter,
  resolveLanguages,
  resolveThemes,
} from "@pierre/diffs";
import type { WorkerRequest, WorkerResponse } from "@pierre/diffs/worker";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import { expect, it } from "vitest";

import baseline from "./fixtures/github-highlighting.json";

const diff = parseDiffFromFile(
  { name: "example.ts", contents: "const value = 1;\n" },
  { name: "example.ts", contents: "const value = 2;\n" },
);

function request(worker: Worker, message: WorkerRequest): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.removeEventListener("message", onMessage);
      reject(new Error(`Worker did not answer ${message.type}`));
    }, 10_000);
    function onMessage(event: MessageEvent<WorkerResponse>) {
      if (event.data.id !== message.id) return;
      clearTimeout(timeout);
      worker.removeEventListener("message", onMessage);
      resolve(event.data);
    }
    worker.addEventListener("message", onMessage);
    worker.postMessage(message, []);
  });
}

it("keeps the original light and dark code and diff colors on the main thread and worker", async () => {
  const highlighter = await getSharedHighlighter({
    themes: ["github-light", "github-dark"],
    langs: ["typescript", "python", "tsx", "json", "markdown", "bash"],
    preferredHighlighter: "shiki-js",
  });
  const worker = new DiffWorker();
  try {
    for (const theme of ["github-light", "github-dark"] as const) {
      const renderOptions = {
        theme,
        useTokenTransformer: false,
        tokenizeMaxLineLength: 1_000,
        lineDiffType: "word-alt",
        maxLineDiffLength: 1_000,
      } as const;
      expect(highlighter.codeToHtml('const value = "synara";', { lang: "typescript", theme })).toBe(
        baseline[theme].html,
      );
      expect(renderDiffWithHighlighter(diff, highlighter, renderOptions)).toEqual(
        baseline[theme].diff,
      );
      const initialized = await request(worker, {
        type: "initialize",
        id: `initialize-${theme}`,
        preferredHighlighter: "shiki-js",
        resolvedThemes: await resolveThemes([theme]),
        resolvedLanguages: await resolveLanguages(["typescript"]),
        renderOptions,
      });
      expect(initialized.type).toBe("success");
      const rendered = await request(worker, { type: "diff", id: `diff-${theme}`, diff });
      expect(rendered.type).toBe("success");
      if (rendered.type !== "success" || rendered.requestType !== "diff") {
        throw new Error("Worker did not render the diff");
      }
      expect(rendered.result).toEqual(baseline[theme].diff);
    }
    const unsupported = await request(worker, {
      type: "initialize",
      id: "unsupported-wasm",
      preferredHighlighter: "shiki-wasm",
      resolvedThemes: [],
      renderOptions: {
        theme: "github-light",
        useTokenTransformer: false,
        tokenizeMaxLineLength: 1_000,
        lineDiffType: "word-alt",
        maxLineDiffLength: 1_000,
      },
    });
    expect(unsupported).toMatchObject({
      type: "error",
      error: expect.stringContaining("JavaScript engine"),
    });
  } finally {
    worker.terminate();
  }
});

it("rejects WASM and unshipped themes on the main thread", async () => {
  await expect(
    getSharedHighlighter({
      themes: ["github-light"],
      langs: ["text"],
      preferredHighlighter: "shiki-wasm",
    }),
  ).rejects.toThrow("JavaScript engine");
  await expect(
    getSharedHighlighter({
      themes: ["nord"],
      langs: ["text"],
      preferredHighlighter: "shiki-js",
    }),
  ).rejects.toThrow("No valid theme loader");
});
