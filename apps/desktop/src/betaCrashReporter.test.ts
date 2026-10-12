import { describe, expect, it } from "vitest";

import { betaCrashReporterOptions } from "./betaCrashReporter";

describe("betaCrashReporterOptions", () => {
  const options = betaCrashReporterOptions({
    productName: "Synara Beta",
    installId: "00000000-0000-4000-8000-000000000000",
    appVersion: "0.9.3-beta.1",
  });

  it("keeps raw minidumps on this machine", () => {
    expect(options.uploadToServer).toBe(false);
    expect(options.submitURL).toBeUndefined();
  });

  it("tags local dumps with the Beta install metadata", () => {
    expect(options.globalExtra).toEqual({
      installId: "00000000-0000-4000-8000-000000000000",
      flavor: "beta",
      appVersion: "0.9.3-beta.1",
    });
  });
});
