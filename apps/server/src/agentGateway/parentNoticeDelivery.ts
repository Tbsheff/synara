import { ThreadId, type ChildThreadNotice } from "@synara/contracts";
import { CHILD_NOTICE_EXCERPT_LIMIT } from "@synara/shared/threadNotice";
import { Effect, Option, Queue, Stream } from "effect";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { CompletionRepository } from "./completionRepository.ts";

export interface ParentNoticeDependencies {
  readonly repository: CompletionRepository;
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly orchestrationEngine: OrchestrationEngineShape;
}

export const collectParentNotices = (dependencies: ParentNoticeDependencies) =>
  Effect.gen(function* () {
    const { repository, snapshotQuery } = dependencies;
    for (const candidate of yield* repository.parentNotices.candidates()) {
      if (!(yield* repository.isOutputSettled(candidate.childThreadId))) continue;
      const completed =
        candidate.state === "completed" && candidate.turnId !== null
          ? yield* repository.hasCompletedRun(candidate.childThreadId, candidate.turnId)
          : false;
      if (candidate.state === "completed" && !completed && !candidate.attention) continue;
      const initialFailure =
        candidate.turnId === null && candidate.messageId
          ? yield* repository.initialFailure(candidate.childThreadId, candidate.messageId)
          : null;
      if (candidate.turnId === null && !initialFailure && !candidate.attention) continue;
      const child = Option.getOrUndefined(
        yield* snapshotQuery.getThreadDetailById(ThreadId.makeUnsafe(candidate.childThreadId)),
      );
      if (!child) continue;
      const status: ChildThreadNotice["status"] = initialFailure
        ? initialFailure.status === "error"
          ? "error"
          : "interrupted"
        : completed || candidate.state === "error" || candidate.state === "interrupted"
          ? (candidate.state as "completed" | "error" | "interrupted")
          : "needs-attention";
      const lastAssistant =
        candidate.turnId === null
          ? undefined
          : child.messages.findLast(
              (message) => message.role === "assistant" && message.turnId === candidate.turnId,
            );
      const error =
        status === "error" && child.latestTurn?.turnId === candidate.turnId
          ? child.session?.lastError
          : null;
      yield* repository.parentNotices.save(
        candidate,
        {
          childThreadId: ThreadId.makeUnsafe(candidate.childThreadId),
          title: child.title,
          turnId: candidate.turnId,
          status,
          excerpt: (
            lastAssistant?.text ||
            initialFailure?.error ||
            error ||
            "No assistant message."
          ).slice(0, CHILD_NOTICE_EXCERPT_LIMIT),
        },
        initialFailure?.completedAt ?? candidate.completedAt ?? child.updatedAt,
      );
    }
  });

export const flushParentNotices = (dependencies: ParentNoticeDependencies) =>
  dependencies.repository.parentNotices.withLock(
    Effect.gen(function* () {
      const { repository, snapshotQuery, orchestrationEngine } = dependencies;
      const notices = repository.parentNotices;
      yield* notices.batchPending();
      for (const command of yield* notices.batches()) {
        const parent = Option.getOrUndefined(
          yield* snapshotQuery.getThreadShellById(command.threadId),
        );
        const available = parent !== undefined && parent.archivedAt == null;
        if (available && (yield* notices.hasUnacknowledged(command.commandId)))
          yield* orchestrationEngine.dispatch(command);
        yield* notices.settleBatch(command.commandId, available);
      }
    }),
  );

export const startParentNoticeDelivery = (dependencies: ParentNoticeDependencies) =>
  Effect.gen(function* () {
    const events = yield* dependencies.orchestrationEngine.subscribeDomainEvents;
    const wakeups = yield* Queue.sliding<void>(1);
    yield* Effect.addFinalizer(() => Queue.shutdown(wakeups));
    yield* Effect.forkScoped(
      Stream.runForEach(events, (event) =>
        event.type === "thread.session-set" ||
        event.type === "thread.turn-diff-completed" ||
        event.type === "thread.message-sent" ||
        event.type === "thread.activity-appended" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.deleted"
          ? Queue.offer(wakeups, undefined).pipe(Effect.asVoid)
          : Effect.void,
      ),
    );
    const reconcile = Effect.sleep(200).pipe(
      Effect.andThen(collectParentNotices(dependencies)),
      Effect.andThen(flushParentNotices(dependencies)),
      Effect.catch((error) => Effect.logWarning("parent notice delivery will retry", { error })),
    );
    yield* Queue.offer(wakeups, undefined);
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.raceFirst(Queue.take(wakeups), Effect.sleep(5000)).pipe(Effect.andThen(reconcile)),
      ),
    );
  });
