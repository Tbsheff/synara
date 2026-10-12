// Preserve state and current callbacks while streaming markdown updates.
import { render } from "vitest-browser-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ChatMarkdown from "./ChatMarkdown";

const fenced = "```javascript\nconst answer = 42;\n```\n\nExplanation.";

describe("ChatMarkdown streaming identity", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["python", "def parse_settings(source: str) -> dict[str, str]", ":\n    return {}"],
    ["typescript", "interface Map {\n  [key: string]", ": string;\n}"],
    ["yaml", "[docs]", ": https://example.com\n[^note]: literal"],
    ["json", '{"[key]', ':": "value", "[^note]": "literal"}'],
  ])(
    "keeps both PRE nodes when %s code gains a bracket-colon pattern",
    async (language, code, tail) => {
      const matchMedia = window.matchMedia.bind(window);
      vi.spyOn(window, "matchMedia").mockImplementation((query) => {
        const result = matchMedia(query);
        return query === "(prefers-reduced-motion: reduce)"
          ? { ...result, matches: true, addEventListener: () => {}, removeEventListener: () => {} }
          : result;
      });
      let text = `# Answer\n\n\`\`\`sh\necho settled\n\`\`\`\n\nMore text.\n\n\`\`\`${language}\n${code}`;
      const screen = await render(<ChatMarkdown text={text} cwd={undefined} isStreaming />);
      try {
        await expect
          .poll(() => document.querySelectorAll(".chat-markdown pre.shiki").length)
          .toBe(2);
        const before = [...document.querySelectorAll(".chat-markdown pre")];
        for (const chunk of [tail, "\n```\n\nDone."]) {
          text += chunk;
          await screen.rerender(<ChatMarkdown text={text} cwd={undefined} isStreaming />);
          await expect
            .poll(() => document.querySelector(".chat-markdown")?.textContent)
            .toContain(chunk === tail ? (code + tail).split("\n").at(-1)! : "Done.");
          const after = [...document.querySelectorAll(".chat-markdown pre")];
          expect(after).toHaveLength(2);
          expect(after[0]).toBe(before[0]);
          expect(after[1]).toBe(before[1]);
        }
        await screen.rerender(<ChatMarkdown text={text} cwd={undefined} isStreaming={false} />);
        const completed = [...document.querySelectorAll(".chat-markdown pre")];
        expect(completed).toHaveLength(2);
        expect(completed[0]).toBe(before[0]);
        expect(completed[1]).toBe(before[1]);
      } finally {
        await screen.unmount();
      }
    },
  );

  it("keeps the code block and soft wrap while prose streams after it", async () => {
    const screen = await render(<ChatMarkdown text={fenced} cwd={undefined} isStreaming />);
    await screen.getByRole("button", { name: "Enable soft wrap" }).click();
    const block = document.querySelector(".chat-markdown-codeblock");
    expect(block?.getAttribute("data-wrap")).toBe("true");

    await screen.rerender(
      <ChatMarkdown text={fenced + " More detail."} cwd={undefined} isStreaming />,
    );
    expect(document.querySelector(".chat-markdown-codeblock")).toBe(block);
    expect(block?.getAttribute("data-wrap")).toBe("true");
    await screen.unmount();
  });

  it("shows the complete growing code when the stream finishes", async () => {
    const screen = await render(
      <ChatMarkdown text={"```text\npartial"} cwd={undefined} isStreaming />,
    );
    const finalCode = "partial\ncomplete final line";
    await screen.rerender(
      <ChatMarkdown
        text={`\`\`\`text\n${finalCode}\n\`\`\``}
        cwd={undefined}
        isStreaming={false}
      />,
    );
    await expect
      .poll(() => document.querySelector(".chat-markdown-codeblock pre")?.textContent)
      .toContain(finalCode);
    await screen.unmount();
  });

  it("uses the latest checkbox callback without changing markdown text", async () => {
    const previous = vi.fn();
    const current = vi.fn();
    const screen = await render(
      <ChatMarkdown text="- [ ] Task" cwd={undefined} onTaskToggle={previous} />,
    );
    await screen.rerender(
      <ChatMarkdown text="- [ ] Task" cwd={undefined} onTaskToggle={current} />,
    );
    await screen.getByRole("checkbox").click();
    expect(previous).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledWith({ sourceLine: 1, checked: true });
    await screen.unmount();
  });
});
