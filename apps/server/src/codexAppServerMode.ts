import { Effect, Option } from "effect";

import { ServerSettingsService } from "./serverSettings";

export function codexSharedProcessEnabled(mode: "shared" | "per-session"): boolean {
  return mode === "shared";
}

export const codexAppServerSharedMode: Effect.Effect<boolean> = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(ServerSettingsService);
  const mode = Option.isSome(service)
    ? yield* service.value.getSettings.pipe(
        Effect.map((settings) => settings.codexAppServerMode),
        Effect.catch(() => Effect.succeed("per-session" as const)),
      )
    : "per-session";
  return codexSharedProcessEnabled(mode);
});
