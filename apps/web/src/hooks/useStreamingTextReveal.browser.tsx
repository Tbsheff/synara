import { useRef } from "react";
import { render } from "vitest-browser-react";

import { afterEach, describe, expect, it, vi } from "vitest";

import { StreamingTextRevealController, useStreamingTextReveal } from "./useStreamingTextReveal";

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

function RevealHarness({ text }: { readonly text: string }) {
  const root = useRef<HTMLDivElement | null>(null);
  useStreamingTextReveal(root, true, text);
  return <div ref={root}>{text}</div>;
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

  it("releases 10,000 indexed code nodes only after the final fade finishes", () => {
    const advance = clock();
    const { root, controller } = fixture("");
    root.innerHTML = `<pre><code>${"<span>x</span>".repeat(10_000)}</code></pre>`;
    controller.observe(root, true);
    root.querySelector("span:last-child")!.firstChild!.textContent += "new";
    controller.observe(root, true);
    controller.observe(root, false);
    expect(Reflect.get(controller, "nodes")).toHaveLength(10_000);
    advance(1_100);
    expect(paintedRanges().map((range) => range.toString())).toEqual(["new"]);
    advance(1_300);
    console.info("[text-fade] settled index", {
      nodes: Reflect.get(controller, "nodes").length,
      offsets: Reflect.get(controller, "nodeStarts").length,
      root: Reflect.get(controller, "root") === null ? null : "retained",
    });
    expect(Reflect.get(controller, "nodes")).toEqual([]);
    expect(Reflect.get(controller, "nodeStarts")).toEqual([]);
    expect(Reflect.get(controller, "root")).toBeNull();
    expect(paintedRanges()).toEqual([]);
    controller.observe(root, true);
    expect(paintedRanges()).toEqual([]);
    root.querySelector("span:last-child")!.firstChild!.textContent += " again";
    controller.observe(root, true);
    expect(paintedRanges().map((range) => range.toString())).toEqual([" again"]);
  });

  it("releases the root and detached nodes on disposal during a fade", () => {
    clock();
    const { root, controller } = fixture();
    controller.observe(root, true);
    root.firstChild!.textContent += "new";
    controller.observe(root, true);
    root.replaceChildren();
    controller.dispose();
    expect(Reflect.get(controller, "nodes")).toEqual([]);
    expect(Reflect.get(controller, "nodeStarts")).toEqual([]);
    expect(Reflect.get(controller, "root")).toBeNull();
    expect(Reflect.get(controller, "text")).toBeNull();
    expect(paintedRanges()).toEqual([]);
  });

  it("remaps the last fade after final code highlighting replaces its nodes", () => {
    const advance = clock();
    const { root, controller } = fixture();
    controller.observe(root, true);
    root.firstChild!.textContent += "new";
    controller.observe(root, true);
    const detached = root.firstChild!;
    root.innerHTML = "<pre><code><span>old </span><span>new</span></code></pre>";
    controller.observe(root, false);
    expect(paintedRanges().map((range) => range.toString())).toEqual(["new"]);
    expect(Reflect.get(controller, "nodes")).not.toContain(detached);
    advance(1_300);
    expect(Reflect.get(controller, "nodes")).toHaveLength(0);
    expect(Reflect.get(controller, "root")).toBeNull();
  });

  it("creates no fade under reduced motion", async () => {
    const nativeMatchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, "matchMedia").mockImplementation((query) =>
      query === "(prefers-reduced-motion: reduce)"
        ? ({
            matches: true,
            media: query,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
          } as unknown as MediaQueryList)
        : nativeMatchMedia(query),
    );
    const allocations = rangeAllocations();
    const screen = await render(<RevealHarness text="old " />);
    await screen.rerender(<RevealHarness text="old new" />);
    expect(paintedRanges()).toEqual([]);
    expect(allocations()).toBe(0);
    await screen.unmount();
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
