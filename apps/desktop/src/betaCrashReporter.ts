import type { CrashReporterStartOptions } from "electron";

export interface BetaCrashReporterInput {
  readonly productName: string;
  readonly installId: string;
  readonly appVersion: string;
}

export function betaCrashReporterOptions(input: BetaCrashReporterInput): CrashReporterStartOptions {
  return {
    productName: input.productName,
    companyName: "Synara",
    uploadToServer: false,
    compress: true,
    globalExtra: {
      installId: input.installId,
      flavor: "beta",
      appVersion: input.appVersion,
    },
  };
}
