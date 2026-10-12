import { describe, expect, it, vi } from "vitest";

import { createAppTeamIdLookup, teamIdFromCodesignDetails } from "./appTeamId";

const signedDetails = {
  exitCode: 0,
  stdout: "",
  stderr: "Executable=/Applications/Synara.app\nTeamIdentifier=ABCDE12345\n",
};

describe("teamIdFromCodesignDetails", () => {
  it("reads the team id of a signed bundle", () => {
    expect(teamIdFromCodesignDetails(signedDetails)).toBe("ABCDE12345");
  });

  it("treats an ad-hoc or unsigned bundle as having no team", () => {
    expect(
      teamIdFromCodesignDetails({ exitCode: 0, stdout: "", stderr: "TeamIdentifier=not set\n" }),
    ).toBeNull();
    expect(
      teamIdFromCodesignDetails({
        exitCode: 1,
        stdout: "",
        stderr: "/Applications/Synara.app: code object is not signed at all\n",
      }),
    ).toBeNull();
  });

  it("fails closed when the output has no team id or the lookup errors", () => {
    expect(teamIdFromCodesignDetails({ exitCode: 0, stdout: "", stderr: "" })).toBe("unavailable");
    expect(teamIdFromCodesignDetails({ exitCode: 3, stdout: "", stderr: "denied" })).toBe(
      "unavailable",
    );
  });
});

describe("createAppTeamIdLookup", () => {
  it("does not run codesign until asked and skips it for unsigned launches", async () => {
    const readDetails = vi.fn(async () => signedDetails);
    const unsigned = createAppTeamIdLookup({ signedBundle: false, readDetails, deadlineMs: 50 });
    expect(readDetails).not.toHaveBeenCalled();
    await expect(unsigned.resolve()).resolves.toBeNull();
    expect(readDetails).not.toHaveBeenCalled();
  });

  it("shares one lookup between prefetch and install", async () => {
    const readDetails = vi.fn(async () => signedDetails);
    const lookup = createAppTeamIdLookup({ signedBundle: true, readDetails, deadlineMs: 1_000 });
    lookup.prefetch();
    await expect(lookup.resolve()).resolves.toBe("ABCDE12345");
    await expect(lookup.resolve()).resolves.toBe("ABCDE12345");
    expect(readDetails).toHaveBeenCalledOnce();
  });

  it("fails closed when codesign hangs past the deadline, then retries", async () => {
    const readDetails = vi
      .fn<() => Promise<typeof signedDetails>>()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(signedDetails);
    const lookup = createAppTeamIdLookup({ signedBundle: true, readDetails, deadlineMs: 20 });
    await expect(lookup.resolve()).resolves.toBe("unavailable");
    await expect(lookup.resolve()).resolves.toBe("ABCDE12345");
    expect(readDetails).toHaveBeenCalledTimes(2);
  });

  it("fails closed when codesign cannot start", async () => {
    const lookup = createAppTeamIdLookup({
      signedBundle: true,
      readDetails: async () => {
        throw new Error("spawn ENOENT");
      },
      deadlineMs: 1_000,
    });
    await expect(lookup.resolve()).resolves.toBe("unavailable");
  });
});
