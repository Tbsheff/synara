import type { CloudProvider, CloudSubmission, ProjectId } from "@synara/contracts";
import {
  useInfiniteQuery,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { CLOUD_ON } from "~/betaFeatures";
import { useLatestProjectStore } from "~/latestProjectStore";
import {
  cloudCapabilitiesQueryOptions,
  cloudMutationKeys,
  cloudQueryKeys,
  cloudSubmissionsQueryOptions,
  cloudTasksInfiniteQueryOptions,
} from "~/lib/cloudReactQuery";
import { CloudIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { SETTINGS_PAGE_BACKGROUND_CLASS_NAME } from "~/settingsPanelStyles";
import { useStore } from "~/store";
import { RouteInsetSurface } from "../RouteInsetSurface";
import { RouteSurfaceHeader } from "../RouteSurface";
import { SegmentedPicker } from "../SegmentedPicker";
import { SidebarShowMoreRow } from "../SidebarListSection";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { ClaudeCloudFollowUp } from "./ClaudeCloudFollowUp";
import {
  CLOUD_PROVIDER_LABELS,
  cloudCapabilityNotice,
  cloudErrorMessage,
  mergeCloudEntries,
} from "./cloud.logic";
import { CloudSubmitDialog } from "./CloudSubmitDialog";
import { CloudTaskDetail } from "./CloudTaskDetail";
import { CloudTaskRow } from "./CloudTaskRow";

const PROVIDER_OPTIONS = (["codex", "claude"] as const).map((value) => ({
  value,
  label: CLOUD_PROVIDER_LABELS[value],
}));

function useCloudProjects() {
  const projects = useStore((state) => state.projects);
  const latestProjectId = useLatestProjectStore((state) => state.latestProjectId);
  const userProjects = useMemo(
    () => projects.filter((project) => project.kind === "project"),
    [projects],
  );
  const initialProjectId: ProjectId | null =
    userProjects.find((project) => project.id === latestProjectId)?.id ??
    userProjects[0]?.id ??
    null;
  return { projects: userProjects, initialProjectId };
}

function CloudListSkeleton() {
  return (
    <div className="flex flex-col gap-2 px-3 py-2" aria-label="Loading cloud tasks">
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} className="h-12 w-full rounded-lg" />
      ))}
    </div>
  );
}

function CloudDetailEmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
      <CloudIcon aria-hidden className="mb-2 size-6 text-muted-foreground/60" />
      <p className="m-0 text-ui-lg text-foreground">Select a cloud task</p>
      <p className="m-0 text-ui-sm text-muted-foreground">Choose one from the list to see it</p>
    </div>
  );
}

export default function CloudView() {
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<CloudProvider>("codex");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);
  const { projects, initialProjectId } = useCloudProjects();
  const submitInFlight = useIsMutating({ mutationKey: cloudMutationKeys.submit }) > 0;

  const capabilitiesQuery = useQuery(cloudCapabilitiesQueryOptions(provider, CLOUD_ON));
  const capabilities = capabilitiesQuery.data ?? null;
  const notice = capabilities ? cloudCapabilityNotice(capabilities) : null;
  const usable = capabilities?.available === true;
  const isCodex = provider === "codex";

  const refreshCapabilities = useMutation({
    mutationFn: () => ensureNativeApi().cloud.getCapabilities({ provider, refresh: true }),
    onSuccess: (next) => {
      queryClient.setQueryData(cloudQueryKeys.capabilities(next.provider), next);
    },
  });

  const submissionsQuery = useQuery(cloudSubmissionsQueryOptions(CLOUD_ON && isCodex && usable));
  const tasksQuery = useInfiniteQuery(
    cloudTasksInfiniteQueryOptions(
      provider,
      CLOUD_ON && isCodex && usable && capabilities?.canList === true,
    ),
  );
  const tasks = useMemo(
    () => tasksQuery.data?.pages.flatMap((page) => page.tasks) ?? [],
    [tasksQuery.data],
  );
  const submissions = submissionsQuery.data?.submissions;
  const entries = useMemo(
    () => mergeCloudEntries({ provider, submissions: submissions ?? [], tasks }),
    [provider, submissions, tasks],
  );
  const hasUncertainSubmission = (submissions ?? []).some(
    (submission) => submission.provider === provider && submission.state === "uncertain",
  );
  const selectedEntry = entries.find((entry) => entry.key === selectedKey) ?? null;
  const listError = tasksQuery.error ?? submissionsQuery.error;
  const listPending =
    (tasksQuery.isPending && tasksQuery.fetchStatus !== "idle") ||
    (submissionsQuery.isPending && submissionsQuery.fetchStatus !== "idle");

  if (!CLOUD_ON) return null;

  const selectSubmitted = (submission: CloudSubmission) => {
    setSelectedKey(
      submission.taskId ? `task:${submission.taskId}` : `submission:${submission.requestId}`,
    );
  };

  return (
    <RouteInsetSurface>
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          SETTINGS_PAGE_BACKGROUND_CLASS_NAME,
        )}
      >
        <RouteSurfaceHeader className="shrink-0" rowClassName="sm:gap-2">
          <h1 className="text-ui-lg font-medium text-foreground">Cloud</h1>
          <SegmentedPicker
            value={provider}
            options={PROVIDER_OPTIONS}
            onValueChange={(next) => {
              setProvider(next);
              setSelectedKey(null);
            }}
            ariaLabel="Cloud provider"
            className="w-44"
          />
          <div className="ml-auto flex items-center gap-2">
            {isCodex ? (
              <Button
                size="sm"
                disabled={!capabilities?.canSubmit || submitInFlight}
                title={
                  capabilities && !capabilities.canSubmit
                    ? (notice?.detail ?? "This CLI cannot submit cloud tasks.")
                    : undefined
                }
                onClick={() => setSubmitOpen(true)}
              >
                New task
              </Button>
            ) : null}
          </div>
        </RouteSurfaceHeader>
        {capabilitiesQuery.isError ? (
          <div className="shrink-0 px-4 pt-3">
            <Alert variant="error" size="sm">
              <AlertDescription>{cloudErrorMessage(capabilitiesQuery.error)}</AlertDescription>
            </Alert>
          </div>
        ) : null}
        {notice ? (
          <div className="shrink-0 px-4 pt-3">
            <Alert variant="warning">
              <AlertTitle>{notice.title}</AlertTitle>
              <AlertDescription>{notice.detail}</AlertDescription>
              <AlertAction>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={refreshCapabilities.isPending}
                  onClick={() => refreshCapabilities.mutate()}
                >
                  {refreshCapabilities.isPending ? "Checking…" : "Check again"}
                </Button>
              </AlertAction>
            </Alert>
          </div>
        ) : null}
        {!isCodex ? (
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 overflow-y-auto p-5">
            {capabilities ? <ClaudeCloudFollowUp capabilities={capabilities} /> : null}
          </div>
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1">
            <section
              aria-label="Cloud tasks"
              className="flex min-h-0 w-[22rem] max-w-[45%] shrink-0 flex-col border-r border-border/60"
            >
              <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
                {listPending ? (
                  <CloudListSkeleton />
                ) : entries.length === 0 && !listError ? (
                  <Empty className="py-12">
                    <EmptyHeader>
                      <EmptyTitle>No cloud tasks</EmptyTitle>
                      <EmptyDescription>
                        {usable
                          ? "Tasks you start in Codex cloud show up here."
                          : "Cloud tasks show up here once the CLI is ready."}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    {entries.map((entry) => (
                      <CloudTaskRow
                        key={entry.key}
                        entry={entry}
                        selected={entry.key === selectedKey}
                        onSelect={(next) => setSelectedKey(next.key)}
                      />
                    ))}
                    <SidebarShowMoreRow
                      canShowMore={tasksQuery.hasNextPage && !tasksQuery.isFetchingNextPage}
                      canShowLess={false}
                      onShowMore={() => void tasksQuery.fetchNextPage()}
                      onShowLess={() => undefined}
                    />
                  </div>
                )}
                {listError ? (
                  <Alert variant="error" size="sm" className="mt-2">
                    <AlertDescription>{cloudErrorMessage(listError)}</AlertDescription>
                  </Alert>
                ) : null}
              </div>
            </section>
            <section
              aria-label="Cloud task details"
              className="flex min-h-0 min-w-0 flex-1 flex-col"
            >
              {selectedEntry && capabilities ? (
                <CloudTaskDetail
                  key={selectedEntry.key}
                  provider={provider}
                  entry={selectedEntry}
                  capabilities={capabilities}
                  projects={projects}
                  initialProjectId={initialProjectId}
                />
              ) : (
                <CloudDetailEmptyState />
              )}
            </section>
          </div>
        )}
        {isCodex && capabilities ? (
          <CloudSubmitDialog
            open={submitOpen}
            onOpenChange={setSubmitOpen}
            provider={provider}
            capabilities={capabilities}
            projects={projects}
            initialProjectId={initialProjectId}
            hasUncertainSubmission={hasUncertainSubmission}
            submitInFlight={submitInFlight}
            onSubmitted={selectSubmitted}
          />
        ) : null}
      </div>
    </RouteInsetSurface>
  );
}
