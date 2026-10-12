import { PROVIDER_CLOUD_BETA_FEATURE } from "@synara/shared/betaFeatures";
import { Effect, type Layer, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as betaGate from "../betaFeatureGate";
import { CloudAgentsGateway } from "./CloudAgentsGateway";
import { makeCloudAgentsServerLayer } from "./cloudAgentsServerLayer";

describe("makeCloudAgentsServerLayer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds nothing on Stable, so no scratch directory, probe, or sweep runs", async () => {
    const gate = vi.spyOn(betaGate, "isServerBetaFeatureEnabled").mockReturnValue(false);
    const layer = makeCloudAgentsServerLayer() as unknown as Layer.Layer<never>;
    const gateway = await Effect.runPromise(
      Effect.serviceOption(CloudAgentsGateway).pipe(Effect.provide(layer)),
    );
    expect(gate).toHaveBeenCalledWith(PROVIDER_CLOUD_BETA_FEATURE);
    expect(Option.isNone(gateway)).toBe(true);
  });
});
