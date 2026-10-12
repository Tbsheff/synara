import type { OrchestrationThreadActivity, ProviderKind, ThreadId } from "@synara/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

import { providerDiscoveryQueryKeys } from "~/lib/providerDiscoveryReactQuery";
import { useStore } from "../store";

const TRANSCRIPT_NOTICE_ACTIVITY_KIND = "transcript.notice";
const SKILLS_CHANGED_NOTICE_KIND = "skills-changed";

function payloadRecord(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return activity.payload &&
    typeof activity.payload === "object" &&
    !Array.isArray(activity.payload)
    ? (activity.payload as Record<string, unknown>)
    : null;
}

export function skillsChangedNoticeFingerprints(
  activityById: Readonly<Record<string, OrchestrationThreadActivity>> | undefined,
): ReadonlySet<string> {
  const fingerprints = new Set<string>();
  if (!activityById) return fingerprints;
  for (const activity of Object.values(activityById)) {
    if (activity.kind !== TRANSCRIPT_NOTICE_ACTIVITY_KIND) continue;
    const payload = payloadRecord(activity);
    if (payload?.noticeKind !== SKILLS_CHANGED_NOTICE_KIND) continue;
    const detail = typeof payload.detail === "string" ? payload.detail : "";
    fingerprints.add(JSON.stringify([activity.id, activity.createdAt, detail]));
  }
  return fingerprints;
}

export function hasNewSkillsChangedNotice(
  seen: ReadonlySet<string>,
  current: ReadonlySet<string>,
): boolean {
  for (const fingerprint of current) {
    if (!seen.has(fingerprint)) return true;
  }
  return false;
}

export function composerDiscoveryQueryKeysForProvider(provider: ProviderKind) {
  return [
    [...providerDiscoveryQueryKeys.all, "commands", provider],
    [...providerDiscoveryQueryKeys.all, "skills", provider],
  ] as const;
}

export function useRefreshComposerDiscoveryOnSkillsChanged(input: {
  threadId: ThreadId;
  provider: ProviderKind;
}): void {
  const { threadId, provider } = input;
  const queryClient = useQueryClient();
  const activityById = useStore((state) => state.activityByThreadId?.[threadId]);
  const detailSynced = useStore((state) => state.threadDetailSyncById?.[threadId] === "synced");
  const fingerprints = useMemo(() => skillsChangedNoticeFingerprints(activityById), [activityById]);
  const seenRef = useRef<{
    threadId: ThreadId;
    detailSynced: boolean;
    fingerprints: ReadonlySet<string>;
  } | null>(null);

  useEffect(() => {
    const seen = seenRef.current;
    const isSameSyncedThread = seen?.threadId === threadId && seen.detailSynced && detailSynced;
    seenRef.current = {
      threadId,
      detailSynced,
      fingerprints: isSameSyncedThread
        ? new Set([...seen.fingerprints, ...fingerprints])
        : fingerprints,
    };
    if (!isSameSyncedThread || !hasNewSkillsChangedNotice(seen.fingerprints, fingerprints)) {
      return;
    }
    for (const queryKey of composerDiscoveryQueryKeysForProvider(provider)) {
      void queryClient.invalidateQueries({ queryKey });
    }
  }, [detailSynced, fingerprints, provider, queryClient, threadId]);
}
