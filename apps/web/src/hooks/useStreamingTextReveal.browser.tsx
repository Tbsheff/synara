import { afterEach, describe, expect, it, vi } from "vitest";

import { StreamingTextRevealController } from "./useStreamingTextReveal";

const controllers: StreamingTextRevealController[] = [];

function fixture(text = "old ") {
  const root = document.createElement("div");
  root.textContent = text;
  document.body.append(root);
  const controller = new StreamingTextRevealController();
  controllers.push(controller);
  return { root, controller };
}

function clock() {
  let now = 1_000;
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextId, callback);
    return nextId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  return (at: number) => {
    now = at;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(now);
  };
}

function paintedRanges(): Range[] {
  return [...CSS.highlights.entries()]
    .filter(([name]) => name.startsWith("chat-stream-reveal"))
    .flatMap(([, highlight]) => [...highlight] as Range[]);
}

function rangeAllocations() {
  const NativeRange = Range;
  let count = 0;
  vi.stubGlobal(
    "Range",
    class extends NativeRange {
      constructor() {
        super();
        count += 1;
      }
    },
  );
  return () => count;
}

describe("streaming text fade", () => {
  afterEach(() => {
    for (const controller of controllers.splice(0)) controller.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("allocates one Range for an unchanged node/fragment across 60 Hz frames", () => {
    const advance = clock();
    const allocations = rangeAllocations();
    const add = vi.spyOn(Highlight.prototype, "add");
    const remove = vi.spyOn(Highlight.prototype, "delete");
    const { root, controller } = fixture();
    controller.observe(root, true);
    root.firstChild!.textContent += "new text";
    controller.observe(root, true);
    const range = paintedRanges()[0]!;
    const box = root.getBoundingClientRect().toJSON();
    const start = 1_000 + 8 * 2.5;
    for (let frame = 0; frame < 12; frame += 1) {
      advance(start + (frame * 1_000) / 60);
      expect(paintedRanges().map((painted) => painted.toString())).toEqual(["new text"]);
    }
    advance(start + 200);
    console.info("[text-fade] ranges", {
      allocations: allocations(),
      adds: add.mock.calls.length,
      deletes: remove.mock.calls.length,
    });
    expect(allocations()).toBe(1);
    expect(add).toHaveBeenCalledTimes(9);
    expect(remove).toHaveBeenCalledTimes(9);
    expect(paintedRanges()).toEqual([]);
    expect(range.toString()).toBe("new text");
    expect(root.getBoundingClientRect().toJSON()).toEqual(box);
  });

  it("releases ranges on replacement and disposal without fading the old prefix", () => {
    const advance = clock();
    const { root, controller } = fixture();
    controller.observe(root, true);
    root.firstChild!.textContent += "new";
    controller.observe(root, true);
    const oldRange = paintedRanges()[0]!;
    root.innerHTML = "<strong>old new</strong>";
    controller.observe(root, true);
    expect(paintedRanges()).not.toContain(oldRange);
    expect(paintedRanges().map((range) => range.toString())).toEqual(["new"]);
    advance(1_300);
    expect(paintedRanges()).toEqual([]);
    root.firstChild!.textContent += " more";
    controller.observe(root, true);
    expect(paintedRanges().map((range) => range.toString())).toEqual([" more"]);
    controller.dispose();
    expect(paintedRanges()).toEqual([]);
  });
});
