import "../../index.css";
import "@xterm/xterm/css/xterm.css";

import { cdp } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { terminalRuntimeRegistry } from "./terminalRuntimeRegistry";
import { TERMINAL_RUNTIME_RETENTION_LIMITS } from "./terminalRuntimeRetention";

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({
    terminal: {
      open: async () => ({ status: "running", scrollback: "" }),
      resize: async () => undefined,
      ackOutput: async () => undefined,
      onEvent: () => () => undefined,
    },
  }),
}));

const callbacks = {
  onSessionExited: () => undefined,
  onTerminalMetadataChange: () => undefined,
  onTerminalActivityChange: () => undefined,
};

const CURSOR_BLINK_STARTUP_SETTLE_MS = 700;
const runtimeKey = "webgl-disposal::terminal";

afterEach(() => {
  terminalRuntimeRegistry.disposeThread("webgl-disposal");
  vi.useRealTimers();
  document.querySelector("[data-webgl-disposal]")?.remove();
});

async function fillFocusedTerminal() {
  const host = document.createElement("div");
  host.dataset.webglDisposal = "";
  host.style.cssText = "width:960px;height:520px;position:relative";
  document.body.append(host);
  const { terminal } = terminalRuntimeRegistry.attach(
    {
      runtimeKey,
      threadId: "webgl-disposal",
      terminalId: "terminal",
      terminalLabel: "Terminal",
      cwd: "/tmp",
      callbacks,
    },
    { autoFocus: true, isVisible: true },
    host,
  );
  const xtermCore = (
    terminal as unknown as {
      _core: {
        _bufferService: { buffer: object };
        _renderService: {
          _renderer: { value: { _cursorBlinkStateManager?: { value?: object } } };
        };
      };
    }
  )._core;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (xtermCore._renderService._renderer.value._cursorBlinkStateManager?.value) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(
    xtermCore._renderService._renderer.value._cursorBlinkStateManager?.value !== undefined,
  ).toBe(true);
  terminal.focus();
  await new Promise<void>((resolve) => {
    terminal.write(
      Array.from({ length: 5_000 }, (_, index) => `${index} ${"x".repeat(110)}\r\n`).join(""),
      resolve,
    );
  });
  await new Promise((resolve) => setTimeout(resolve, CURSOR_BLINK_STARTUP_SETTLE_MS));
  expect(terminal.buffer.normal.length).toBeGreaterThan(4_000);
  return new WeakRef(xtermCore._bufferService.buffer);
}

it("frees the focused WebGL terminal buffer after detached cache expiry", async () => {
  const buffer = await fillFocusedTerminal();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  terminalRuntimeRegistry.detach(runtimeKey);
  await vi.advanceTimersByTimeAsync(TERMINAL_RUNTIME_RETENTION_LIMITS.maxIdleMs + 1);
  vi.useRealTimers();
  expect(document.querySelector(".xterm")).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const session = cdp() as { send(method: "HeapProfiler.collectGarbage"): Promise<unknown> };
  await session.send("HeapProfiler.collectGarbage");
  await session.send("HeapProfiler.collectGarbage");
  expect(buffer.deref() === undefined).toBe(true);
});
