import { describe, expect, it, vi } from "vitest";

import { PROVIDER_DESCRIPTORS } from "@synara/shared/providerMetadata";
import { isBetaFeatureEnabled } from "@synara/shared/betaFeatures";

vi.mock(import("@synara/shared/betaFeatures"), async (importOriginal) => ({
  ...(await importOriginal()),
  desktopFlavorFromProtocol: () => "production",
}));

import {
  CLOUD_ON,
  GROUPS_ON,
  INLINE_HTML_RENDER_ON,
  visibleProviderDescriptors,
} from "./betaFeatures";

describe("visibleProviderDescriptors", () => {
  it("respects a disabled provider feature", () => {
    const visible = visibleProviderDescriptors((feature) => feature !== "omp");
    expect(visible.some((d) => d.kind === "omp")).toBe(false);
    expect(visible.map((d) => d.kind)).toEqual(
      PROVIDER_DESCRIPTORS.filter((d) => d.kind !== "omp").map((d) => d.kind),
    );
  });

  it("offers Oh My Pi and the other providers in Stable", () => {
    const visible = visibleProviderDescriptors((feature) =>
      isBetaFeatureEnabled(feature, "production"),
    );
    expect(visible).toEqual(PROVIDER_DESCRIPTORS);
  });
});

it("offers Hubs and inline HTML on Stable while cloud agents stay off", () => {
  expect(GROUPS_ON).toBe(true);
  expect(INLINE_HTML_RENDER_ON).toBe(true);
  expect(CLOUD_ON).toBe(false);
});
