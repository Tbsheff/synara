import { realpathSync } from "node:fs";

import { Effect, Layer, PubSub, Ref, Stream } from "effect";
import type {
  GitStatusLocalResult,
  GitStatusRemoteResult,
  GitStatusResult,
  GitStatusStreamEvent,
} from "@synara/contracts";
import { mergeGitStatusParts } from "@synara/shared/git";
import { makeKeyedSingleFlightCache } from "@synara/shared/KeyedSingleFlightCache";

import type { GitManagerServiceError } from "../Errors";
import { GitCore, type GitStatusDetails } from "../Services/GitCore";
import { GitManager } from "../Services/GitManager";
import {
  GitStatusBroadcaster,
  type GitStatusBroadcasterShape,
} from "../Services/GitStatusBroadcaster";
import {
  canReuseCachedRemoteStatus,
  type CachedGitStatus,
  GIT_STATUS_CACHE_MAX_ENTRIES,
  LOCAL_STATUS_SINGLE_FLIGHT_TTL_MS,
  makeCachedStatusValue,
  setCachedGitStatus,
  splitLocalStatus,
  splitLocalStatusDetails,
  splitRemoteStatus,
  splitRemoteStatusDetails,
} from "../gitStatusCache";

interface GitStatusChange {
  readonly cwd: string;
  readonly event: GitStatusStreamEvent;
}

function normalizeCwd(cwd: string): string {
  try {
    return realpathSync.native(cwd);
  } catch {
    return cwd;
  }
}

export const GitStatusBroadcasterLive = Layer.effect(
  GitStatusBroadcaster,
  Effect.gen(function* () {
    const gitCore = yield* GitCore;
    const gitManager = yield* GitManager;
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<GitStatusChange>(),
      (pubsub) => PubSub.shutdown(pubsub),
    );
    const cacheRef = yield* Ref.make(new Map<string, CachedGitStatus>());
    const statusReads = yield* makeKeyedSingleFlightCache<GitStatusResult, GitManagerServiceError>({
      maxEntries: GIT_STATUS_CACHE_MAX_ENTRIES,
      ttlMs: LOCAL_STATUS_SINGLE_FLIGHT_TTL_MS,
    });

    const getCachedStatus = (cwd: string) =>
      Ref.get(cacheRef).pipe(Effect.map((cache) => cache.get(cwd) ?? null));

    const updateCachedLocalStatus = (
      cwd: string,
      local: GitStatusLocalResult,
      options?: { readonly publish?: boolean },
    ) =>
      Effect.gen(function* () {
        const nextLocal = makeCachedStatusValue(local);
        const shouldPublish = yield* Ref.modify(cacheRef, (cache) => {
          const previous = cache.get(cwd) ?? { local: null, remote: null };
          const nextCache = setCachedGitStatus(cache, cwd, { ...previous, local: nextLocal });
          return [previous.local?.fingerprint !== nextLocal.fingerprint, nextCache] as const;
        });

        if (options?.publish && shouldPublish) {
          yield* PubSub.publish(changesPubSub, {
            cwd,
            event: { _tag: "localUpdated", local },
          });
        }

        return local;
      });

    const updateCachedRemoteStatus = (
      cwd: string,
      remote: GitStatusRemoteResult | null,
      options?: { readonly publish?: boolean },
    ) =>
      Effect.gen(function* () {
        const nextRemote = makeCachedStatusValue(remote);
        const shouldPublish = yield* Ref.modify(cacheRef, (cache) => {
          const previous = cache.get(cwd) ?? { local: null, remote: null };
          const nextCache = setCachedGitStatus(cache, cwd, { ...previous, remote: nextRemote });
          return [previous.remote?.fingerprint !== nextRemote.fingerprint, nextCache] as const;
        });

        if (options?.publish && shouldPublish) {
          yield* PubSub.publish(changesPubSub, {
            cwd,
            event: { _tag: "remoteUpdated", remote },
          });
        }

        return remote;
      });

    const loadStatus = (
      cwd: string,
      options?: { readonly publish?: boolean; readonly details?: GitStatusDetails },
    ) =>
      Effect.gen(function* () {
        const status = yield* gitManager.status(
          { cwd },
          options?.details ? { details: options.details } : undefined,
        );
        const local = yield* updateCachedLocalStatus(cwd, splitLocalStatus(status), options);
        const remote = yield* updateCachedRemoteStatus(cwd, splitRemoteStatus(status), options);
        return mergeGitStatusParts(local, remote) as GitStatusResult;
      });

    const readStatus = (cwd: string) =>
      Effect.gen(function* () {
        const details = yield* gitCore.statusDetails(cwd);
        const cached = yield* getCachedStatus(cwd);
        if (cached?.remote && canReuseCachedRemoteStatus({ cached, details })) {
          const local = yield* updateCachedLocalStatus(cwd, splitLocalStatusDetails(details));
          const remote = splitRemoteStatusDetails(details, cached.remote.value);
          return mergeGitStatusParts(local, remote) as GitStatusResult;
        }
        return yield* loadStatus(cwd, { details });
      });

    const getStatus: GitStatusBroadcasterShape["getStatus"] = (input) => {
      const normalizedCwd = normalizeCwd(input.cwd);
      return statusReads.get(normalizedCwd, readStatus(normalizedCwd));
    };

    const refreshStatus: GitStatusBroadcasterShape["refreshStatus"] = (cwd) => {
      const normalizedCwd = normalizeCwd(cwd);
      return statusReads
        .invalidate(normalizedCwd)
        .pipe(
          Effect.andThen(
            statusReads.get(normalizedCwd, loadStatus(normalizedCwd, { publish: true })),
          ),
        );
    };

    const refreshLocalStatus: GitStatusBroadcasterShape["refreshLocalStatus"] = (cwd) =>
      refreshStatus(cwd).pipe(Effect.map(splitLocalStatus));

    const streamStatus: GitStatusBroadcasterShape["streamStatus"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const normalizedCwd = normalizeCwd(input.cwd);
          const subscription = yield* PubSub.subscribe(changesPubSub);
          const status = yield* getStatus({ cwd: normalizedCwd });
          const snapshot: GitStatusStreamEvent = {
            _tag: "snapshot",
            local: splitLocalStatus(status),
            remote: splitRemoteStatus(status),
          };

          return Stream.concat(
            Stream.make(snapshot),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((change) => change.cwd === normalizedCwd),
              Stream.map((change) => change.event),
            ),
          );
        }),
      );

    return {
      getStatus,
      refreshLocalStatus,
      refreshStatus,
      streamStatus,
    } satisfies GitStatusBroadcasterShape;
  }),
);
