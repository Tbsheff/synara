import "../index.css";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { ServerBusyIndicator, ServerBusyNotice } from "./ServerBusyIndicator";
import { emitWsTransportState } from "../wsTransportEvents";
import { publishServerBusySnapshot } from "../serverBusyState";

it("explains waiting during an unresponsive server without a blocking dialog", async () => {
  const screen = await render(
    <ServerBusyNotice
      snapshot={{ reason: "unresponsive", pendingRequests: 2, slowRequests: 1, lastStallMs: null }}
    />,
  );
  await expect.element(screen.getByRole("status")).toBeVisible();
  await expect.element(screen.getByText("Synara server is busy")).toBeVisible();
  await expect.element(screen.getByText(/2 requests are still waiting/)).toBeVisible();
});

it("distinguishes a recent stall from a still-running request on a responsive server", async () => {
  const screen = await render(
    <ServerBusyNotice
      snapshot={{ reason: "recent-stall", pendingRequests: 0, slowRequests: 0, lastStallMs: 5200 }}
    />,
  );
  await expect.element(screen.getByText("Synara server recovered")).toBeVisible();
  await expect.element(screen.getByText(/5.2 s/)).toBeVisible();
  await screen.rerender(
    <ServerBusyNotice
      snapshot={{ reason: null, pendingRequests: 1, slowRequests: 1, lastStallMs: null }}
    />,
  );
  await expect.element(screen.getByText("Synara server is busy")).toBeVisible();
  await screen.rerender(
    <ServerBusyNotice
      snapshot={{ reason: null, pendingRequests: 0, slowRequests: 0, lastStallMs: null }}
    />,
  );
  await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
});

it("uses one reconnecting state when the socket actually closes", async () => {
  const screen = await render(
    <ServerBusyNotice
      reconnecting
      snapshot={{
        reason: null,
        pendingRequests: 2,
        slowRequests: 1,
        lastStallMs: null,
      }}
    />,
  );
  await expect.element(screen.getByRole("status")).toBeVisible();
  await expect.element(screen.getByText("Reconnecting to Synara server")).toBeVisible();
  await expect.element(screen.getByText(/resume automatically/)).toBeVisible();
  await expect.element(screen.getByText("Synara server is busy")).not.toBeInTheDocument();
});

it("follows actual transport recovery without showing reconnecting during initial startup", async () => {
  publishServerBusySnapshot({
    reason: null,
    pendingRequests: 1,
    slowRequests: 1,
    lastStallMs: null,
  });
  emitWsTransportState("connecting");
  const screen = await render(<ServerBusyIndicator />);
  await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
  emitWsTransportState("open");
  await expect.element(screen.getByText("Synara server is busy")).toBeVisible();
  emitWsTransportState("connecting");
  await expect
    .element(screen.getByText("Reconnecting to Synara server"), { timeout: 3_000 })
    .toBeVisible();
  await expect.element(screen.getByText(/You can keep working/)).not.toBeInTheDocument();
  publishServerBusySnapshot({
    reason: null,
    pendingRequests: 0,
    slowRequests: 0,
    lastStallMs: null,
  });
  emitWsTransportState("open");
  await expect.element(screen.getByRole("status"), { timeout: 3_000 }).not.toBeInTheDocument();
  emitWsTransportState("disposed");
});

function sampleReconnectBannerPerFrame() {
  const samples: Array<{ t: number; opacity: number | null }> = [];
  let running = true;
  const tick = () => {
    if (!running) return;
    const banner = [...document.querySelectorAll<HTMLElement>("[role='status']")].find((element) =>
      element.textContent?.includes("Reconnecting to Synara server"),
    );
    const shell = banner?.parentElement ?? null;
    samples.push({
      t: performance.now(),
      opacity: shell ? Number(getComputedStyle(shell).opacity) : null,
    });
    window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
  return {
    stop: () => {
      running = false;
      return samples;
    },
  };
}

async function waitMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

it("ignores a short connection blip and fades a real outage in after the composer delay", async () => {
  publishServerBusySnapshot({
    reason: null,
    pendingRequests: 0,
    slowRequests: 0,
    lastStallMs: null,
  });
  emitWsTransportState("open");
  const screen = await render(<ServerBusyIndicator />);
  try {
    const blip = sampleReconnectBannerPerFrame();
    emitWsTransportState("connecting");
    await waitMs(1_000);
    emitWsTransportState("open");
    await waitMs(700);
    const blipFrames = blip.stop().filter((sample) => sample.opacity !== null).length;

    const outage = sampleReconnectBannerPerFrame();
    const outageStartedAt = performance.now();
    emitWsTransportState("closed");
    await waitMs(1_700);
    emitWsTransportState("open");
    const recoveredAt = performance.now();
    await waitMs(1_000);
    const samples = outage.stop();
    const mounted = samples.filter((sample) => sample.opacity !== null);
    const firstMountedAt = mounted[0]?.t ?? Number.NaN;
    const lastMountedAt = mounted.at(-1)?.t ?? Number.NaN;
    const partialOpacityFrames = mounted.filter(
      (sample) => sample.opacity! > 0.02 && sample.opacity! < 0.98,
    ).length;
    console.log(
      `SMOOTH_METRIC ${JSON.stringify({
        name: "reconnect-banner",
        value: {
          blipFrames,
          showDelayMs: Math.round(firstMountedAt - outageStartedAt),
          visibleAfterRecoveryMs: Math.round(lastMountedAt - recoveredAt),
          shownForMs: Math.round(lastMountedAt - firstMountedAt),
          partialOpacityFrames,
        },
      })}`,
    );

    expect(blipFrames).toBe(0);
    expect(firstMountedAt - outageStartedAt).toBeGreaterThanOrEqual(1_450);
    expect(lastMountedAt - firstMountedAt).toBeGreaterThanOrEqual(600);
    expect(partialOpacityFrames).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("Reconnecting to Synara server");
  } finally {
    await screen.unmount();
    emitWsTransportState("disposed");
  }
});
