import { describe, expect, it } from "vitest";

import type { ProcessRunResult } from "../processRunner.ts";
import { IosSimulatorBackend } from "./IosSimulatorBackend.ts";
import type { HelperClient } from "./helperClient.ts";

const DEVICE_A = "AAAA-1111";
const DEVICE_B = "BBBB-2222";

function ok(stdout = ""): ProcessRunResult {
  return { stdout, stderr: "", code: 0, signal: null, timedOut: false };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const GEOMETRY: Record<string, number> = { [DEVICE_A]: 400, [DEVICE_B]: 800 };

class BindingHelper {
  running = true;
  readonly attachGates = new Map<string, Promise<void>>();
  readonly attachStarted = new Map<string, () => void>();
  readonly holdsAfterAttach = new Map<string, Promise<void>>();
  readonly requests: Array<{
    readonly method: string;
    readonly attached: string | null;
    readonly params: Record<string, unknown>;
  }> = [];
  private attachment: string | null = null;

  get attachedDevice() {
    if (this.attachment === null) return null;
    const width = GEOMETRY[this.attachment]!;
    return {
      udid: this.attachment,
      pointWidth: width,
      pointHeight: width,
      pixelWidth: width,
      pixelHeight: width,
      scale: 1,
      inputAvailable: true,
      accessibilityAvailable: true,
    };
  }

  start(): void {}

  async attach(udid: string) {
    this.attachStarted.get(udid)?.();
    const gate = this.attachGates.get(udid);
    if (gate) await gate;
    this.attachment = udid;
    const hold = this.holdsAfterAttach.get(udid);
    if (hold) await hold;
    return this.attachedDevice!;
  }

  async request(method: string, params: Record<string, unknown> = {}) {
    this.requests.push({ method, attached: this.attachment, params });
    if (method === "describe-ui") {
      return {
        tree: {
          role: "Application",
          label: this.attachment,
          frame: { x: 0, y: 0, width: 10, height: 10 },
          children: [],
        },
      };
    }
    return { ok: true };
  }

  normalize(x: number, y: number) {
    const width = GEOMETRY[this.attachment ?? ""] ?? 1;
    return { x: x / width, y: y / width };
  }

  async startStream() {}
  async stopStream() {}
  async dispose() {}
}

function makeBackend() {
  const helper = new BindingHelper();
  const backend = new IosSimulatorBackend({
    platform: "darwin",
    helperCacheRoot: "/tmp/synara-device-binding-test-cache",
    makeHelperClient: () => helper as unknown as HelperClient,
    run: async (command) =>
      command === "xcodebuild" ? ok("Xcode 26.2\nBuild version 17C52") : ok(),
  });
  Object.defineProperty(backend, "compileHelperIfNeeded", {
    value: async () => "/tmp/synara-device-binding-test-cache/synara-device-helper",
  });
  return { backend, helper };
}

function blockAttach(helper: BindingHelper, udid: string) {
  const gate = deferred();
  const started = deferred();
  helper.attachGates.set(udid, gate.promise);
  helper.attachStarted.set(udid, started.resolve);
  return { release: gate.resolve, started: started.promise };
}

describe("helper binding", () => {
  it("sends each concurrent tap to the device it named, with that device's geometry", async () => {
    const { backend, helper } = makeBackend();
    const attachA = blockAttach(helper, DEVICE_A);

    const tapA = backend.tap(DEVICE_A, 200, 200);
    await attachA.started;
    const tapB = backend.tap(DEVICE_B, 400, 400);
    await new Promise((resolve) => setTimeout(resolve, 10));
    attachA.release();
    await Promise.all([tapA, tapB]);

    expect(helper.requests).toEqual([
      { method: "tap", attached: DEVICE_A, params: { x: 0.5, y: 0.5 } },
      { method: "tap", attached: DEVICE_B, params: { x: 0.5, y: 0.5 } },
    ]);
  });

  it("reads the accessibility tree of the device it named while another call attaches", async () => {
    const { backend, helper } = makeBackend();
    const attachA = deferred();
    const attachStartedA = deferred();
    helper.holdsAfterAttach.set(DEVICE_A, attachA.promise);
    helper.attachStarted.set(DEVICE_A, attachStartedA.resolve);

    const readA = backend.describeUi(DEVICE_A);
    await attachStartedA.promise;
    const tapB = backend.tap(DEVICE_B, 1, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    attachA.resolve();
    const [tree] = await Promise.all([readA, tapB]);

    expect(tree.root.label).toBe(DEVICE_A);
  });

  it("sends no input when the call is aborted during helper setup", async () => {
    const { backend, helper } = makeBackend();
    const attachA = blockAttach(helper, DEVICE_A);
    const controller = new AbortController();

    const tap = backend.tap(DEVICE_A, 10, 10, { signal: controller.signal });
    await attachA.started;
    controller.abort();
    attachA.release();

    await expect(tap).rejects.toThrow();
    expect(helper.requests).toEqual([]);
  });

  it("sends no further chord keys once the call is aborted", async () => {
    const { backend, helper } = makeBackend();
    const controller = new AbortController();
    const request = helper.request.bind(helper);
    helper.request = async (method, params) => {
      const result = await request(method, params);
      controller.abort();
      return result;
    };

    await expect(
      backend.keyEvent(
        DEVICE_A,
        { keyCode: 4, modifiers: ["shift"], direction: "down" },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(helper.requests).toHaveLength(1);
  });
});
