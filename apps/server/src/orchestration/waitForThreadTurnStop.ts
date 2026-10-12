import type { OrchestrationThreadShell, TurnId } from "@synara/contracts";
import { Effect, Option } from "effect";

export function waitForThreadTurnStop<E, R>(
  readShell: () => Effect.Effect<Option.Option<OrchestrationThreadShell>, E, R>,
  turnId?: TurnId | null,
) {
  const wait = Effect.gen(function* () {
    while (true) {
      const shell = yield* readShell();
      if (Option.isNone(shell)) return;
      const latest = shell.value.latestTurn;
      if (
        turnId &&
        latest?.turnId &&
        latest.turnId !== turnId &&
        shell.value.session?.activeTurnId !== turnId
      )
        return;
      if (
        latest?.state !== "running" &&
        shell.value.session?.status !== "running" &&
        shell.value.session?.status !== "starting"
      )
        return;
      yield* Effect.sleep("50 millis");
    }
  });
  return wait.pipe(Effect.timeoutOption("5 seconds"));
}
