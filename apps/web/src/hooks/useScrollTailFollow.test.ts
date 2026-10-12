import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { reactHookHarness } from "../test/reactHookHarness";
import { useScrollTailFollow } from "./useScrollTailFollow";

vi.mock("react", async () => (await import("../test/reactHookHarness")).reactHookHarnessMock);

class ScrollBox {
  scrollTop = 0;
  scrollHeight = 1_070;
  clientHeight = 200;
}

function mountBox(enabled = true) {
  const box = new ScrollBox();
  const render = (enabled: boolean, content: string) => {
    reactHookHarness.beginRender();
    return useScrollTailFollow<HTMLElement>({ enabled, content });
  };
  const controls = render(enabled, "");
  controls.ref.current = box as HTMLElement;
  render(enabled, "live lines");
  return { box, render, controls };
}

beforeEach(() => reactHookHarness.reset());
afterEach(() => reactHookHarness.unmount());

describe("useScrollTailFollow completion", () => {
  it("follows the final content update when streaming turns off at the bottom", () => {
    const { box, render } = mountBox();
    expect(box.scrollTop).toBe(870);
    box.scrollHeight = 1_240;
    render(false, "final lines");
    expect(box.scrollTop).toBe(1_040);
  });

  it("keeps a detached reader's scroll position through completion", () => {
    const { box, controls, render } = mountBox();
    box.scrollTop = 400;
    controls.onScroll();
    box.scrollHeight = 1_240;
    render(false, "final lines");
    expect(box.scrollTop).toBe(400);
  });

  it.each([false, true])(
    "keeps the reader position when final content arrives after streaming stops (detached: %s)",
    (detached) => {
      const { box, controls, render } = mountBox();
      if (detached) {
        box.scrollTop = 400;
        controls.onScroll();
      }
      render(false, "live lines");
      box.scrollHeight = 1_240;
      render(false, "final lines");
      expect(box.scrollTop).toBe(detached ? 400 : 1_040);
      box.scrollHeight = 1_400;
      render(false, "later settled change");
      expect(box.scrollTop).toBe(detached ? 400 : 1_040);
    },
  );

  it("does not tail output that mounted after completion", () => {
    const { box, render } = mountBox(false);
    render(false, "final lines");
    expect(box.scrollTop).toBe(0);
  });
});
