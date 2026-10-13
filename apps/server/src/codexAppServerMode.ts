import {
  CODEX_SHARED_PROCESS_BETA_FEATURE,
  desktopFlavorFromBundleId,
  isBetaFeatureEnabled,
} from "@synara/shared/betaFeatures";
import { SYNARA_DESKTOP_BUNDLE_ID_ENV } from "@synara/shared/desktopIdentity";
import { Effect, Option } from "effect";

import { ServerSettingsService } from "./serverSettings";

export function codexSharedProcessEnabled(
  mode: "shared" | "per-session",
  bundleId?: string,
): boolean {
  return (
    mode === "shared" &&
    isBetaFeatureEnabled(CODEX_SHARED_PROCESS_BETA_FEATURE, desktopFlavorFromBundleId(bundleId))
  );
}

export const codexAppServerSharedMode: Effect.Effect<boolean> = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(ServerSettingsService);
  const mode = Option.isSome(service)
    ? yield* service.value.getSettings.pipe(
        Effect.map((settings) => settings.codexAppServerMode),
        Effect.catch(() => Effect.succeed("per-session" as const)),
      )
    : "per-session";
  return codexSharedProcessEnabled(mode, process.env[SYNARA_DESKTOP_BUNDLE_ID_ENV]);
});
