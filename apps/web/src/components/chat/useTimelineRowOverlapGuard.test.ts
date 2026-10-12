import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { reactHookHarness } from "../../test/reactHookHarness";
import { useTimelineRowOverlapGuard } from "./useTimelineRowOverlapGuard";

vi.mock("react", async () => (await import("../../test/reactHookHarness")).reactHookHarnessMock);

class LayoutNode {
  parentElement: LayoutNode | null = null;
  firstElementChild: LayoutNode | null = null;
  children: LayoutNode[] = [];
  style = { position: "", top: "", height: "", opacity: "" };
  isConnected = true;
  clientHeight = 200;
  scrollHeight = 1_000;
  height = 40;
  getBoundingClientRect() {
    return { height: this.height };
  }
  private offset = 700;
  writes: number[] = [];
  get scrollTop() {
    return this.offset;
  }
  set scrollTop(value: number) {
    this.offset = value;
    this.writes.push(value);
  }
}

const resizeCallbacks: Array<(entries: readonly ResizeObserverEntry[]) => void> = [];
const mutationCallbacks: Array<() => void> = [];
const frameCallbacks = new Map<number, FrameRequestCallback>();
let nextFrameId = 0;

beforeEach(() => {
  reactHookHarness.reset();
  resizeCallbacks.length = 0;
  mutationCallbacks.length = 0;
  frameCallbacks.clear();
  nextFrameId = 0;
  vi.stubGlobal("HTMLElement", LayoutNode);
  vi.stubGlobal("document", { timeline: { currentTime: 100 } });
  vi.stubGlobal("window", {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
      frameCallbacks.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => frameCallbacks.delete(id),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: (entries: readonly ResizeObserverEntry[]) => void) {
        resizeCallbacks.push(callback);
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: () => void) {
        mutationCallbacks.push(callback);
      }
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
});

afterEach(() => {
  reactHookHarness.unmount();
  vi.unstubAllGlobals();
});

it.each([0, 32])("follows the final layout after position and %ipx size commits", (growth) => {
  const scroller = new LayoutNode();
  const content = new LayoutNode();
  scroller.firstElementChild = content;
  const listRef = { current: { getScrollableNode: () => scroller as unknown as HTMLElement } };
  reactHookHarness.beginRender();
  const observe = useTimelineRowOverlapGuard({ listRef, enabled: true });
  const container = new LayoutNode();
  container.style.position = "absolute";
  container.style.top = "100px";
  container.parentElement = content;
  const row = new LayoutNode();
  row.parentElement = container;
  observe(row as unknown as HTMLElement);
  mutationCallbacks[0]!();
  expect(scroller.writes, "position commits must wait for settled layout").toEqual([]);
  scroller.scrollHeight += growth;
  resizeCallbacks.at(-1)!([
    { target: row, contentRect: { height: row.height } } as unknown as ResizeObserverEntry,
  ]);
  expect(scroller.writes).toEqual([800 + growth]);
  for (const callback of frameCallbacks.values()) callback(116);
  expect(scroller.writes).toEqual([800 + growth]);
});
