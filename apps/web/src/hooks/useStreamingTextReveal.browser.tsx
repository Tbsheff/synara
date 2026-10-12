import { useRef } from "react";
import { render } from "vitest-browser-react";

import { afterEach, describe, expect, it, vi } from "vitest";

import arrivals from "./__fixtures__/streamingTextReveal.arrivals.json";

import {
  StreamingTextRevealController,
  useStreamingTextReveal,
  visibleTextNodes,
  emptyRevealSchedule,
  nextRevealSchedule,
} from "./useStreamingTextReveal";

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
    .flatMap(([, highlight]) => Array.from(highlight) as Range[]);
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

function scanCounts() {
  const createWalker = document.createTreeWalker.bind(document);
  const join = Array.prototype.join;
  const charCodeAt = String.prototype.charCodeAt;
  const counts = { walks: 0, nodes: 0, copiedChars: 0, comparedChars: 0 };
  vi.spyOn(document, "createTreeWalker").mockImplementation((...args) => {
    counts.walks += 1;
    const walker = createWalker(...args);
    const next = walker.nextNode.bind(walker);
    vi.spyOn(walker, "nextNode").mockImplementation(() => {
      const node = next();
      if (node) counts.nodes += 1;
      return node;
    });
    return walker;
  });
  vi.spyOn(Array.prototype, "join").mockImplementation(function (this: string[], separator) {
    if (separator === "" && this.every((value: unknown) => typeof value === "string")) {
      counts.copiedChars += this.reduce((sum: number, value: string) => sum + value.length, 0);
    }
    return join.call(this, separator);
  });
  vi.spyOn(String.prototype, "charCodeAt").mockImplementation(function (this: string, index) {
    counts.comparedChars += 1;
    return charCodeAt.call(this, index);
  });
  return counts;
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
    expect(Reflect.get(controller, "nodeTexts")).toHaveLength(0);
    expect(Reflect.get(controller, "mutations")).toHaveLength(0);
    expect(Reflect.get(controller, "tailBlock")).toBeNull();
    expect(Reflect.get(controller, "observer")).toBeNull();
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

  it("scans only changed tail nodes while keeping stable block offsets", () => {
    const advance = clock();
    const { root, controller } = fixture("");
    root.innerHTML = `${"<p>stable block</p>".repeat(100)}<p>tail</p>`;
    controller.observe(root, true);
    const counts = scanCounts();
    for (let step = 0; step < 20; step += 1) {
      advance(1_000 + step * 40);
      root.lastChild!.firstChild!.textContent += " new";
      controller.observe(root, true);
      expect(
        paintedRanges().every((range) => range.startContainer === root.lastChild!.firstChild),
      ).toBe(true);
    }
    console.info("[text-fade] tail scans", counts);
    expect(counts.walks).toBe(0);
    expect(counts.nodes).toBe(0);
    expect(counts.copiedChars).toBe(0);
    expect(counts.comparedChars).toBeLessThan(2_000);
  });

  it("measures saved 1,019-update arrival lengths with 400-character prose blocks", () => {
    const advance = clock();
    const { root, controller } = fixture("");
    controller.observe(root, true);
    const counts = scanCounts();
    let length = 0;
    for (const arrival of arrivals) {
      advance(1_000 + arrival.at - arrivals[0]!.at);
      while (length < arrival.length) {
        if (length % 400 === 0) {
          const paragraph = document.createElement("p");
          paragraph.append(document.createTextNode(""));
          root.append(paragraph);
        }
        const count = Math.min(arrival.length - length, 400 - (length % 400));
        (root.lastChild!.firstChild as Text).appendData("x".repeat(count));
        length += count;
      }
      controller.observe(root, true);
    }
    console.info("[text-fade] saved arrivals", { updates: arrivals.length, length, ...counts });
    expect(arrivals).toHaveLength(1_019);
    expect(length).toBe(8_001);
    expect(counts.walks).toBeLessThan(50);
    expect(counts.nodes).toBeLessThan(100);
    expect(counts.copiedChars).toBeLessThan(30_000);
    expect(counts.comparedChars).toBeLessThan(500_000);
  });

  it("uses a full scan for stable edits, formatting, replacement, and hidden math changes", () => {
    const advance = clock();
    const { root, controller } = fixture("");
    root.innerHTML = "<p>old </p><p>tail</p>";
    controller.observe(root, true);
    const counts = scanCounts();
    root.firstChild!.firstChild!.textContent = "edit ";
    controller.observe(root, true);
    expect(counts.walks).toBe(1);
    advance(1_300);
    root.lastChild!.textContent = "tail new";
    controller.observe(root, true);
    expect(counts.walks).toBe(2);
    const replacedRange = paintedRanges().find(
      (range) => range.startContainer === root.lastChild!.firstChild,
    );
    expect(replacedRange).toBeDefined();
    root.lastChild!.textContent = "tail new";
    controller.observe(root, true);
    expect(counts.walks).toBe(3);
    expect(paintedRanges()).not.toContain(replacedRange);
    root.innerHTML = "<p>edit </p><p><span class='katex-mathml'>hidden</span>tail new</p>";
    controller.observe(root, true);
    expect(counts.walks).toBe(4);
    root.querySelector("span")!.removeAttribute("class");
    controller.observe(root, true);
    expect(counts.walks).toBe(5);
    expect(Reflect.get(controller, "nodeStarts")).toEqual([0, 5, 11]);
    expect(
      paintedRanges()
        .map((range) => range.toString())
        .join(""),
    ).not.toContain("edit");
  });

  it("keeps incremental schedules equal to full text comparisons through tail edits", () => {
    const advance = clock();
    const { root, controller } = fixture("");
    root.innerHTML = "<p>stable </p><p><b>one</b><i> two</i></p>";
    controller.observe(root, true);
    let previous = visibleTextNodes(root)
      .map((node) => node.data)
      .join("");
    let schedule = emptyRevealSchedule();
    for (let step = 0; step < 40; step += 1) {
      const now = 1_000 + step * 40;
      advance(now);
      schedule = {
        arrivals: schedule.arrivals,
        lastStartAt: schedule.lastStartAt,
        fragments: schedule.fragments.filter((fragment) => now - fragment.startedAt < 200),
      };
      const tail = root.lastChild!;
      if (step % 7 === 0) {
        const next = document.createElement("p");
        next.textContent = " next";
        root.append(next);
      } else if (step % 5 === 0) {
        tail.textContent = `${tail.textContent!.slice(0, -2)}!`;
      } else if (step % 3 === 0) {
        tail.insertBefore(document.createTextNode(" first"), tail.firstChild);
      } else {
        (visibleTextNodes(tail).at(-1) as Text).appendData(" +");
      }
      const next = visibleTextNodes(root)
        .map((node) => node.data)
        .join("");
      schedule = nextRevealSchedule(schedule, previous, next, now);
      controller.observe(root, true);
      expect(Reflect.get(controller, "schedule")).toEqual(schedule);
      const nodes = visibleTextNodes(root);
      let start = 0;
      expect(Reflect.get(controller, "nodes")).toEqual(nodes);
      expect(Reflect.get(controller, "nodeStarts")).toEqual(
        nodes.map((node) => {
          const offset = start;
          start += node.data.length;
          return offset;
        }),
      );
      previous = next;
    }
  });

  it("keeps offsets after an empty tail when formatting lands during settlement", () => {
    const advance = clock();
    const { root, controller } = fixture("");
    root.innerHTML = "<p>old </p><span></span>";
    controller.observe(root, true);
    root.firstChild!.firstChild!.textContent += "new";
    controller.observe(root, true);
    controller.observe(root, false);
    const finalBlock = document.createElement("p");
    finalBlock.textContent = "tail";
    root.append(finalBlock);
    advance(1_100);
    expect(Reflect.get(controller, "nodeStarts")).toEqual([0, 7]);
    expect(paintedRanges().map((range) => range.toString())).toEqual(["new"]);
    advance(1_300);
    expect(Reflect.get(controller, "observer")).toBeNull();
    expect(paintedRanges()).toEqual([]);
  });

  it("remaps asynchronous formatting changes on the next animation frame", async () => {
    const advance = clock();
    const { root, controller } = fixture();
    controller.observe(root, true);
    root.firstChild!.textContent += "new";
    controller.observe(root, true);
    const detached = root.firstChild!;
    root.innerHTML = "<p><strong>old </strong><em>new</em></p>";
    await Promise.resolve();
    advance(1_100);
    expect(paintedRanges().map((range) => range.toString())).toEqual(["new"]);
    expect(Reflect.get(controller, "nodes")).not.toContain(detached);
    advance(1_300);
    expect(paintedRanges()).toEqual([]);
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
