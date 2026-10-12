import type {
  CloudApplyToWorktreeInput,
  CloudGetDiffInput,
  CloudProvider,
  CloudSendFollowUpInput,
  CloudSubmitRpcInput,
  CloudTaskRefInput,
} from "@synara/contracts";
import {
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";

import {
  CLOUD_TASK_LIST_REFRESH_MS,
  CLOUD_TASK_PAGE_SIZE,
  CLOUD_TASK_STATUS_POLL_MS,
  isCloudTaskTerminal,
} from "~/components/cloud/cloud.logic";
import { ensureNativeApi } from "~/nativeApi";

export const cloudQueryKeys = {
  all: ["cloud"] as const,
  capabilities: (provider: CloudProvider) => ["cloud", "capabilities", provider] as const,
  environments: (provider: CloudProvider) => ["cloud", "environments", provider] as const,
  tasks: (provider: CloudProvider) => ["cloud", "tasks", provider] as const,
  task: (input: CloudTaskRefInput | null) =>
    ["cloud", "task", input?.provider ?? null, input?.taskId ?? null] as const,
  submissions: () => ["cloud", "submissions"] as const,
  diff: (input: CloudGetDiffInput | null) =>
    [
      "cloud",
      "diff",
      input?.provider ?? null,
      input?.taskId ?? null,
      input?.attempt ?? null,
    ] as const,
};

export const cloudMutationKeys = {
  submit: ["cloud", "mutation", "submit"] as const,
  applyToWorktree: ["cloud", "mutation", "apply-to-worktree"] as const,
  sendFollowUp: ["cloud", "mutation", "send-follow-up"] as const,
};

export function cloudCapabilitiesQueryOptions(provider: CloudProvider, enabled: boolean) {
  return queryOptions({
    queryKey: cloudQueryKeys.capabilities(provider),
    queryFn: () => ensureNativeApi().cloud.getCapabilities({ provider }),
    enabled,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function cloudEnvironmentsQueryOptions(provider: CloudProvider, enabled: boolean) {
  return queryOptions({
    queryKey: cloudQueryKeys.environments(provider),
    queryFn: () => ensureNativeApi().cloud.listEnvironments({ provider }),
    enabled,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function cloudSubmissionsQueryOptions(enabled: boolean) {
  return queryOptions({
    queryKey: cloudQueryKeys.submissions(),
    queryFn: () => ensureNativeApi().cloud.listSubmissions({}),
    enabled,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function cloudTasksInfiniteQueryOptions(provider: CloudProvider, enabled: boolean) {
  return infiniteQueryOptions({
    queryKey: cloudQueryKeys.tasks(provider),
    queryFn: ({ pageParam }) =>
      ensureNativeApi().cloud.listTasks({
        provider,
        limit: CLOUD_TASK_PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.cursor,
    enabled,
    staleTime: 30_000,
    refetchInterval: (query) =>
      (query.state.data?.pages.length ?? 0) > 1 ? false : CLOUD_TASK_LIST_REFRESH_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function cloudTaskQueryOptions(input: CloudTaskRefInput | null, enabled: boolean) {
  return queryOptions({
    queryKey: cloudQueryKeys.task(input),
    queryFn: () => {
      if (!input) throw new Error("Cloud task is unavailable.");
      return ensureNativeApi().cloud.getTask(input);
    },
    enabled: enabled && input !== null,
    staleTime: 10_000,
    refetchInterval: (query) =>
      isCloudTaskTerminal(query.state.data?.status) ? false : CLOUD_TASK_STATUS_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function cloudDiffQueryOptions(input: CloudGetDiffInput | null, enabled: boolean) {
  return queryOptions({
    queryKey: cloudQueryKeys.diff(input),
    queryFn: () => {
      if (!input) throw new Error("Cloud diff is unavailable.");
      return ensureNativeApi().cloud.getDiff(input);
    },
    enabled: enabled && input !== null,
    staleTime: 5 * 60_000,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function cloudSubmitMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: cloudMutationKeys.submit,
    mutationFn: (input: CloudSubmitRpcInput) => ensureNativeApi().cloud.submit(input),
    onSettled: async (_result, _error, input) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: cloudQueryKeys.submissions() }),
        queryClient.invalidateQueries({ queryKey: cloudQueryKeys.tasks(input.provider) }),
      ]);
    },
  });
}

export function cloudApplyToWorktreeMutationOptions() {
  return mutationOptions({
    mutationKey: cloudMutationKeys.applyToWorktree,
    mutationFn: (input: CloudApplyToWorktreeInput) =>
      ensureNativeApi().cloud.applyToWorktree(input),
  });
}

export function cloudSendFollowUpMutationOptions() {
  return mutationOptions({
    mutationKey: cloudMutationKeys.sendFollowUp,
    mutationFn: (input: CloudSendFollowUpInput) => ensureNativeApi().cloud.sendFollowUp(input),
  });
}
