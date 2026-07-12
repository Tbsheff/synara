import { describe, expect, it } from "vitest";

import {
  appendCappedBufferedText,
  setCappedBufferedToolOutput,
} from "./ProviderRuntimeIngestion.ts";

describe("ProviderRuntimeIngestion buffered text helpers", () => {
  it("caps appended buffered text with a truncation marker", () => {
    const result = appendCappedBufferedText("abcdef", "ghijklmnopqrstuvwxyz", 20);

    expect(result).toBe("abcde... [truncated]");
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it("keeps normal buffered text unchanged", () => {
    expect(appendCappedBufferedText("hello ", "world", 64)).toBe("hello world");
  });

  it("evicts the oldest buffered item when capacity is reached", () => {
    const buffers = new Map([
      ["oldest", { text: "first", truncated: false }],
      ["retained", { text: "second", truncated: false }],
    ]);

    setCappedBufferedToolOutput(buffers, "newest", { text: "third", truncated: false }, 2);

    expect([...buffers.keys()]).toEqual(["retained", "newest"]);
  });
});
