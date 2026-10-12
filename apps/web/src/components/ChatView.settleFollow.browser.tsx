import { FEATURE_TOUR_STORAGE_KEY } from "../featureTour/store";
import {
  buildStalePendingRequestFailureDetail,
  pendingRequestInstanceKey,
} from "@synara/shared/threadSummary";
import "../index.css";

import {
  ApprovalRequestId,
  AutomationId,
  type AutomationCreateInput,
  type AutomationDefinition,
  CheckpointRef,
  DEFAULT_AUTOMATION_STOP_AFTER_CONSECUTIVE_FAILURES,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  DEVICE_WS_METHODS,
  COMPUTER_WS_METHODS,
  ORCHESTRATION_WS_METHODS,
  OrchestrationProposedPlanId,
  type OrchestrationReadModel,
  type ProjectId,
  type ProjectAgentOverview,
  type ServerConfig,
  SpaceId,
  ThreadId,
  TurnId,
  type WsWelcomePayload,
  WS_METHODS,
  OrchestrationSessionStatus,
} from "@synara/contracts";
import {
  ATTACHMENT_CANCEL_ROUTE_PATH,
  ATTACHMENT_UPLOAD_ROUTE_PATH,
} from "@synara/shared/binaryTransfer";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import { cdp, page, userEvent } from "vitest/browser";
import React, { Profiler, type ProfilerOnRenderCallback } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { render } from "vitest-browser-react";

import { type ComposerImageAttachment, useComposerDraftStore } from "../composerDraftStore";
import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  getScrollContainerDistanceFromBottom,
} from "../chat-scroll";
import { useGroupPanelClosedStore } from "../groupPanelClosedStore";
import { useLatestProjectStore } from "../latestProjectStore";
import { useProjectEnvironmentStore } from "../projectEnvironmentStore";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  type TerminalContextDraft,
  removeInlineTerminalContextPlaceholder,
} from "../lib/terminalContext";
import { extractTrailingBrowserAnnotations } from "../lib/browserAnnotations";
import { isMacNavigatorPlatform } from "../lib/utils";
import { STARRED_MODELS_STORAGE_KEY } from "../lib/starredModels";
import { readNativeApi } from "../nativeApi";
import { emitWsTransportState } from "../wsTransportEvents";
import { dispatchKanbanDraftThread } from "../lib/kanbanDispatch";
import { useKanbanUiStore } from "../kanbanUiStore";
import { setThreadDetailResumeCursor } from "../threadDetailResumeCursors";
import { resetHomeChatProjectPrewarmStateForTests } from "../lib/chatProjects";
import { hasReconciledServerProviderStatuses } from "../lib/serverReactQuery";
import { getRouter } from "../router";
import { showContextMenuFallback } from "../contextMenuFallback";
import { useRightDockStore } from "../rightDockStore";
import { dockTerminalThreadId } from "../lib/dockTerminalScope";
import { collectLeaves } from "../splitView.logic";
import { GITHUB_INBOX_DOCK_HOST_ID } from "../rightDockStore.logic";
import { useOpenThreadTabsStore } from "../openThreadTabsStore";
import { resolveSplitViewPaneIdForThread, useSplitViewStore } from "../splitViewStore";
import { splitViewPaneScopeId } from "../lib/chatPaneScope";
import { gitQueryKeys } from "../lib/gitReactQuery";
import { useSpacesUiStore } from "../spacesUiStore";
import { useRailShellStore } from "../railShellStore";
import { usePinnedThreadsStore } from "../pinnedThreadsStore";
import { getAppTypographyScale } from "../lib/appTypography";
import { threadJumpCommandForIndex } from "../keybindings";
import { useStore } from "../store";
import {
  createShellSnapshotFromReadModel,
  flattenEffectRpcRequestPayload,
  readEffectRpcClientMessage,
  sendEffectRpcChunk,
  sendEffectRpcExit,
} from "../test/effectRpcWebSocketMock";
import { makeDomainEvent } from "../storeTestFixtures";
import {
  acknowledgeStartupAnnouncementsForTest,
  createBrowserTestServerConfig,
  createBrowserTestServerSettings,
  createFullscreenTestHost,
} from "../test/browserHarness";
import { useTemporaryThreadStore } from "../temporaryThreadStore";
import { useTerminalStateStore } from "../terminalStateStore";
import { resetRetainedThreadDetailSubscriptionsForTests } from "../threadDetailSubscriptionRetention";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { getWorkspaceEditorSession } from "../lib/workspaceEditorSession";
import { resetWsNativeApiForTest } from "../wsNativeApi";
import { trackWsTurnSettlement } from "../wsTransportEvents";
import { useProjectAgentSummariesStore } from "./chat/project/useProjectAgentSummaries";
import { useThreadDispatchStore } from "./chat/useChatLocalDispatch";
import { hasUnseenSnoozeReturn } from "./Sidebar.logic";
import "./ChatView";

const THREAD_ID = "thread-browser-test" as ThreadId;
const OTHER_THREAD_ID = "thread-browser-test-other" as ThreadId;

const SNAPSHOT_SEQUENCE_GAP_ABOVE_ANY_SINGLE_TEST_INCREMENTS = 1_000_000;
let snapshotSequenceFactory = 0;
function nextSnapshotSequenceAboveLateSnapshotsFromPreviousTests(): number {
  snapshotSequenceFactory += SNAPSHOT_SEQUENCE_GAP_ABOVE_ANY_SINGLE_TEST_INCREMENTS;
  return snapshotSequenceFactory;
}
const THREAD_TITLE = "Browser test thread";
const UUID_ROUTE_RE = /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_ID = "project-1" as ProjectId;
const OTHER_PROJECT_ID = "project-2" as ProjectId;
const HOME_PROJECT_ID = "project-home" as ProjectId;
const STUDIO_PROJECT_ID = "project-studio" as ProjectId;
const STUDIO_DRAFT_THREAD_ID = "thread-studio-draft" as ThreadId;
const NOW_ISO = "2026-03-04T12:00:00.000Z";
const BASE_TIME_MS = Date.parse(NOW_ISO);
const ATTACHMENT_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='300'></svg>";
let attachmentResponseDelayMs = 0;
let attachmentUploadSequence = 0;
let attachmentUploadBarrier: Promise<void> | null = null;
let attachmentCancelBarrier: Promise<void> | null = null;

interface WsRequestEnvelope {
  id: string;
  body: {
    _tag: string;
    [key: string]: unknown;
  };
}

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  providerStatusesSnapshot: ServerConfig["providers"] | null;
  welcome: WsWelcomePayload;
  gitBranchByCwd: Record<string, string>;
  projectAgentOverviews: Record<string, unknown>;
}

let fixture: TestFixture;
const wsRequests: WsRequestEnvelope["body"][] = [];
const wsLink = ws.link(/ws(s)?:\/\/.*/);

interface ViewportSpec {
  name: string;
  width: number;
  height: number;
}

const DEFAULT_VIEWPORT: ViewportSpec = {
  name: "desktop",
  width: 960,
  height: 1_100,
};
const TEXT_VIEWPORT_MATRIX = [
  DEFAULT_VIEWPORT,
  { name: "tablet", width: 720, height: 1_024 },
  { name: "mobile", width: 430, height: 932 },
  { name: "narrow", width: 320, height: 700 },
] as const satisfies readonly ViewportSpec[];
const ATTACHMENT_VIEWPORT_MATRIX = [
  { name: "narrow", width: 320, height: 700 },
] as const satisfies readonly ViewportSpec[];

interface UserRowMeasurement {
  measuredRowHeightPx: number;
  timelineWidthMeasuredPx: number;
}

interface MountedChatView {
  [Symbol.asyncDispose]: () => Promise<void>;
  cleanup: () => Promise<void>;
  measureLayout: () => Promise<ChatLayoutMeasurement>;
  measureUserRow: (targetMessageId: MessageId) => Promise<UserRowMeasurement>;
  setViewport: (viewport: ViewportSpec) => Promise<void>;
  router: ReturnType<typeof getRouter>;
}

interface ChatLayoutMeasurement {
  hostHeightPx: number;
  composerBottomPx: number;
  scrollClientHeightPx: number;
  scrollHeightPx: number;
  distanceFromBottomPx: number;
}

function isoAt(offsetSeconds: number): string {
  return new Date(BASE_TIME_MS + offsetSeconds * 1_000).toISOString();
}

function createBaseServerConfig(): ServerConfig {
  return createBrowserTestServerConfig(NOW_ISO);
}

function createUserMessage(options: {
  id: MessageId;
  text: string;
  offsetSeconds: number;
  attachments?: Array<{
    type: "image";
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }>;
}) {
  return {
    id: options.id,
    role: "user" as const,
    text: options.text,
    ...(options.attachments ? { attachments: options.attachments } : {}),
    turnId: null,
    streaming: false,
    source: "native" as const,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

function createAssistantMessage(options: { id: MessageId; text: string; offsetSeconds: number }) {
  return {
    id: options.id,
    role: "assistant" as const,
    text: options.text,
    turnId: null,
    streaming: false,
    source: "native" as const,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

function createTerminalContext(input: {
  id: string;
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
  text: string;
}): TerminalContextDraft {
  return {
    id: input.id,
    threadId: THREAD_ID,
    terminalId: `terminal-${input.id}`,
    terminalLabel: input.terminalLabel,
    lineStart: input.lineStart,
    lineEnd: input.lineEnd,
    text: input.text,
    createdAt: NOW_ISO,
  };
}

function createComposerImage(input: {
  id: string;
  previewUrl: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
}): ComposerImageAttachment {
  const name = input.name ?? "queued-image.png";
  const mimeType = input.mimeType ?? "image/png";
  const sizeBytes = input.sizeBytes ?? 8;
  const file = new File([new Uint8Array(sizeBytes).fill(1)], name, {
    type: mimeType,
    lastModified: BASE_TIME_MS,
  });
  return {
    type: "image",
    id: input.id,
    name,
    mimeType,
    sizeBytes: file.size,
    previewUrl: input.previewUrl,
    file,
  };
}

function createSnapshotForTargetUser(options: {
  targetMessageId: MessageId;
  targetText: string;
  targetAttachmentCount?: number;
  sessionStatus?: OrchestrationSessionStatus;
}): OrchestrationReadModel {
  const messages: Array<OrchestrationReadModel["threads"][number]["messages"][number]> = [];

  for (let index = 0; index < 22; index += 1) {
    const isTarget = index === 3;
    const userId = `msg-user-${index}` as MessageId;
    const assistantId = `msg-assistant-${index}` as MessageId;
    const attachments =
      isTarget && (options.targetAttachmentCount ?? 0) > 0
        ? Array.from({ length: options.targetAttachmentCount ?? 0 }, (_, attachmentIndex) => ({
            type: "image" as const,
            id: `attachment-${attachmentIndex + 1}`,
            name: `attachment-${attachmentIndex + 1}.png`,
            mimeType: "image/png",
            sizeBytes: 128,
          }))
        : undefined;

    messages.push(
      createUserMessage({
        id: isTarget ? options.targetMessageId : userId,
        text: isTarget ? options.targetText : `filler user message ${index}`,
        offsetSeconds: messages.length * 3,
        ...(attachments ? { attachments } : {}),
      }),
    );
    messages.push(
      createAssistantMessage({
        id: assistantId,
        text: `assistant filler ${index}`,
        offsetSeconds: messages.length * 3,
      }),
    );
  }

  return {
    snapshotSequence: nextSnapshotSequenceAboveLateSnapshotsFromPreviousTests(),
    spaces: [],
    projects: [
      {
        id: PROJECT_ID,
        kind: "project",
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: THREAD_TITLE,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        envMode: "local",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        handoff: null,
        messages,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: options.sessionStatus ?? "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId:
            options.sessionStatus === "running"
              ? TurnId.makeUnsafe("turn-browser-fixture-active")
              : null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
    updatedAt: NOW_ISO,
  };
}

function createIssue550Snapshot(options: {
  messageCount: number;
  activityCount: number;
}): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-issue-550" as MessageId,
    targetText: "issue 550 baseline",
  });
  const messages = Array.from({ length: options.messageCount }, (_, index) =>
    index % 2 === 0
      ? createUserMessage({
          id: MessageId.makeUnsafe(`msg-issue-550-user-${index}`),
          text: `user message ${index}`,
          offsetSeconds: index * 2,
        })
      : createAssistantMessage({
          id: MessageId.makeUnsafe(`msg-issue-550-assistant-${index}`),
          text: `assistant message ${index}`,
          offsetSeconds: index * 2,
        }),
  );
  const activities = Array.from({ length: options.activityCount }, (_, index) => ({
    id: EventId.makeUnsafe(`activity-issue-550-${index}`),
    createdAt: isoAt(options.messageCount * 2 + index),
    kind: "tool.completed" as const,
    summary: `tool ${index}`,
    tone: "tool" as const,
    turnId: null,
    payload: {
      itemType: "dynamic_tool_call",
      toolName: `tool-${index}`,
    },
  }));

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID ? { ...thread, messages, activities } : thread,
    ),
  };
}

function createSnapshotWithLongAssistantResponse(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-assistant-overflow-target" as MessageId,
    targetText: "start",
  });

  const threads = [...snapshot.threads];
  const threadIndex = threads.findIndex((thread) => thread.id === THREAD_ID);
  if (threadIndex < 0) {
    return snapshot;
  }

  const thread = threads[threadIndex]!;
  const messages = [...thread.messages];
  const messageIndex = messages.findIndex(
    (message, index) => message.role === "assistant" && index === 7,
  );
  if (messageIndex < 0) {
    return snapshot;
  }

  const message = messages[messageIndex]!;
  messages[messageIndex] = {
    ...message,
    text: Array.from(
      { length: 240 },
      (_, lineIndex) =>
        `${lineIndex + 1}. keep the viewport stable while this response keeps growing`,
    ).join("\n"),
  };
  threads[threadIndex] = {
    ...thread,
    messages,
  };

  return {
    ...snapshot,
    threads,
  };
}

function createSnapshotWithBottomAttachments(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-bottom-attachments" as MessageId,
    targetText: "bottom attachments",
  });

  const threads = [...snapshot.threads];
  const threadIndex = threads.findIndex((thread) => thread.id === THREAD_ID);
  if (threadIndex < 0) {
    return snapshot;
  }

  const thread = threads[threadIndex]!;
  const messages = [...thread.messages];
  let lastUserMessageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserMessageIndex = index;
      break;
    }
  }
  if (lastUserMessageIndex < 0) {
    return snapshot;
  }

  const lastUserMessage = messages[lastUserMessageIndex]!;
  messages[lastUserMessageIndex] = {
    ...lastUserMessage,
    text: "final user message with delayed attachments",
    attachments: Array.from({ length: 3 }, (_, attachmentIndex) => ({
      type: "image" as const,
      id: `bottom-attachment-${attachmentIndex + 1}`,
      name: `bottom-attachment-${attachmentIndex + 1}.png`,
      mimeType: "image/png",
      sizeBytes: 128,
    })),
  };
  threads[threadIndex] = {
    ...thread,
    messages,
  };

  return {
    ...snapshot,
    threads,
  };
}

function buildFixture(snapshot: OrchestrationReadModel): TestFixture {
  return {
    snapshot,
    serverConfig: createBaseServerConfig(),
    providerStatusesSnapshot: null,
    gitBranchByCwd: {},
    projectAgentOverviews: {},
    welcome: {
      cwd: "/repo/project",
      projectName: "Project",
      bootstrapProjectId: PROJECT_ID,
      bootstrapThreadId: THREAD_ID,
    },
  };
}

function findThreadDetailFromFixtureSnapshot(
  threadId: ThreadId,
): OrchestrationReadModel["threads"][number] | null {
  return fixture.snapshot.threads.find((entry) => entry.id === threadId) ?? null;
}

function contextMenuRows() {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-slot="context-menu-popup"] button'),
  );
}

function addThreadToSnapshot(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationReadModel {
  return {
    ...snapshot,
    snapshotSequence: snapshot.snapshotSequence + 1,
    threads: [
      ...snapshot.threads,
      {
        id: threadId,
        projectId: PROJECT_ID,
        title: "New thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        envMode: "local",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        handoff: null,
        messages: [],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
  };
}

function createAutomationDefinitionFromCreateRequest(
  body: WsRequestEnvelope["body"],
): AutomationDefinition {
  const input = body as unknown as AutomationCreateInput;
  const definition: AutomationDefinition = {
    id: AutomationId.makeUnsafe(`automation-${wsRequests.length}`),
    projectId: input.projectId,
    sourceThreadId: input.sourceThreadId ?? null,
    name: input.name,
    prompt: input.prompt,
    schedule: input.schedule,
    enabled: input.enabled ?? true,
    nextRunAt: null,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode ?? "approval-required",
    interactionMode: input.interactionMode ?? "default",
    worktreeMode: input.worktreeMode ?? "auto",
    mode: input.mode ?? "standalone",
    targetThreadId: input.targetThreadId ?? null,
    maxIterations: input.maxIterations ?? null,
    stopAfterConsecutiveFailures:
      input.stopAfterConsecutiveFailures === undefined
        ? DEFAULT_AUTOMATION_STOP_AFTER_CONSECUTIVE_FAILURES
        : input.stopAfterConsecutiveFailures,
    consecutiveFailureCount: 0,
    disabledReason: null,
    disabledAt: null,
    completionPolicy: input.completionPolicy ?? { type: "none" },
    completionPolicyVersion: 1,
    completionPolicyUpdatedAt: NOW_ISO,
    minimumIntervalSeconds: input.minimumIntervalSeconds ?? 60,
    maxRuntimeSeconds: input.maxRuntimeSeconds ?? 3_600,
    retryPolicy: input.retryPolicy ?? { type: "none" },
    misfirePolicy: input.misfirePolicy ?? "coalesce",
    acknowledgedRisks: input.acknowledgedRisks ?? [],
    iterationCount: 0,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    archivedAt: null,
  };
  return input.providerOptions === undefined
    ? definition
    : { ...definition, providerOptions: input.providerOptions };
}

function createDraftOnlySnapshot(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-draft-target" as MessageId,
    targetText: "draft thread",
  });
  return {
    ...snapshot,
    threads: [],
  };
}

function withSettledThreadBranch(
  snapshot: OrchestrationReadModel,
  branch: string,
): OrchestrationReadModel {
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID ? { ...thread, branch, settledAt: NOW_ISO } : thread,
    ),
  };
}

function withOpenProjectPickerFixtures(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: [
      ...snapshot.projects,
      {
        id: OTHER_PROJECT_ID,
        kind: "project",
        title: "Other Project",
        workspaceRoot: "/repo/other",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
  };
}

function withHomeChatProject(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: [
      ...snapshot.projects,
      {
        id: HOME_PROJECT_ID,
        kind: "chat",
        title: "Home",
        workspaceRoot: "/Users/tester",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
  };
}

function withActiveHomeChatThread(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  const snapshotWithHomeProject = withHomeChatProject(snapshot);
  return {
    ...snapshotWithHomeProject,
    threads: snapshotWithHomeProject.threads.map((thread) =>
      thread.id === THREAD_ID ? { ...thread, projectId: HOME_PROJECT_ID } : thread,
    ),
  };
}

function withStudioProject(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: [
      ...snapshot.projects,
      {
        id: STUDIO_PROJECT_ID,
        kind: "studio",
        title: "Studio",
        workspaceRoot: "/Users/tester/Documents/Synara/Studio",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
  };
}

function withProjectScripts(
  snapshot: OrchestrationReadModel,
  scripts: OrchestrationReadModel["projects"][number]["scripts"],
): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === PROJECT_ID ? { ...project, scripts: Array.from(scripts) } : project,
    ),
  };
}

function createSnapshotWithLongProposedPlan(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-plan-target" as MessageId,
    targetText: "plan thread",
  });
  const planMarkdown = [
    "# Ship plan mode follow-up",
    "",
    "- Step 1: capture the thread-open trace",
    "- Step 2: identify the main-thread bottleneck",
    "- Step 3: keep collapsed cards cheap",
    "- Step 4: render the full markdown only on demand",
    "- Step 5: preserve export and save actions",
    "- Step 6: add regression coverage",
    "- Step 7: verify route transitions stay responsive",
    "- Step 8: confirm no server-side work changed",
    "- Step 9: confirm short plans still render normally",
    "- Step 10: confirm long plans stay collapsed by default",
    "- Step 11: confirm preview text is still useful",
    "- Step 12: confirm plan follow-up flow still works",
    "- Step 13: confirm timeline virtualization still behaves",
    "- Step 14: confirm theme styling still looks correct",
    "- Step 15: confirm save dialog behavior is unchanged",
    "- Step 16: confirm download behavior is unchanged",
    "- Step 17: confirm code fences do not parse until expand",
    "- Step 18: confirm preview truncation ends cleanly",
    "- Step 19: confirm markdown links still open in editor after expand",
    "- Step 20: confirm deep hidden detail only appears after expand",
    "",
    "```ts",
    "export const hiddenPlanImplementationDetail = 'deep hidden detail only after expand';",
    "```",
  ].join("\n");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            proposedPlans: [
              {
                id: "plan-browser-test",
                turnId: null,
                planMarkdown,
                implementedAt: null,
                implementationThreadId: null,
                createdAt: isoAt(1_000),
                updatedAt: isoAt(1_001),
              },
            ],
            updatedAt: isoAt(1_001),
          })
        : thread,
    ),
  };
}

function createSnapshotWithActiveInlinePlan(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-inline-plan-target" as MessageId,
    targetText: "inline plan thread",
    sessionStatus: "running",
  });
  const activeTurnId = TurnId.makeUnsafe("turn-inline-plan");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            latestTurn: {
              turnId: activeTurnId,
              state: "running",
              requestedAt: isoAt(1_000),
              startedAt: isoAt(1_001),
              completedAt: null,
              assistantMessageId: null,
            },
            activities: [
              {
                id: EventId.makeUnsafe("activity-inline-plan"),
                createdAt: isoAt(1_002),
                kind: "turn.tasks.updated",
                summary: "Tasks updated",
                tone: "info",
                turnId: activeTurnId,
                payload: {
                  tasks: [
                    {
                      task: "Inspecting ChatView boundaries",
                      status: "inProgress",
                    },
                    {
                      task: "Patch the shared checklist receiver",
                      status: "pending",
                    },
                    {
                      task: "Run final validation",
                      status: "completed",
                    },
                  ],
                },
              },
              {
                id: EventId.makeUnsafe("activity-inline-background-task"),
                createdAt: isoAt(1_003),
                kind: "task.started",
                summary: "Background agent started",
                tone: "info",
                turnId: activeTurnId,
                payload: {
                  taskId: "task-inline-background-agent",
                  taskType: "subagent",
                },
              },
            ],
            session: thread.session
              ? {
                  ...thread.session,
                  status: "running",
                  activeTurnId,
                  updatedAt: isoAt(1_003),
                }
              : null,
            updatedAt: isoAt(1_003),
          }
        : thread,
    ),
  };
}

function createSnapshotWithTallComposerStack(): OrchestrationReadModel {
  const snapshot = createSnapshotWithActiveInlinePlan();
  const activeTurnId = TurnId.makeUnsafe("turn-inline-plan");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            checkpoints: [
              {
                turnId: activeTurnId,
                checkpointTurnCount: 1,
                checkpointRef: CheckpointRef.makeUnsafe("checkpoint-inline-plan"),
                status: "ready",
                files: [
                  {
                    path: "apps/web/src/components/ChatView.tsx",
                    kind: "modified",
                    additions: 12,
                    deletions: 4,
                  },
                  {
                    path: "apps/web/src/components/ChatView.browser.tsx",
                    kind: "modified",
                    additions: 36,
                    deletions: 0,
                  },
                ],
                assistantMessageId: null,
                completedAt: isoAt(1_004),
              },
            ],
          }
        : thread,
    ),
  };
}

function createSnapshotWithSettledInlinePlan(): OrchestrationReadModel {
  const snapshot = createSnapshotWithActiveInlinePlan();
  const activeTurnId = TurnId.makeUnsafe("turn-inline-plan");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            latestTurn: {
              turnId: activeTurnId,
              state: "completed",
              requestedAt: isoAt(1_000),
              startedAt: isoAt(1_001),
              completedAt: isoAt(1_004),
              assistantMessageId: MessageId.makeUnsafe("msg-assistant-inline-plan-complete"),
            },
            messages: [
              ...thread.messages,
              {
                turnId: activeTurnId,
                id: MessageId.makeUnsafe("msg-assistant-inline-plan-complete"),
                role: "assistant",
                text: "Finished the investigation.",
                createdAt: isoAt(1_004),
                updatedAt: isoAt(1_004),
                completedAt: isoAt(1_004),
                streaming: false,
                source: "native",
              },
            ],
            session: thread.session
              ? {
                  ...thread.session,
                  status: "ready",
                  activeTurnId: null,
                  updatedAt: isoAt(1_004),
                }
              : null,
            updatedAt: isoAt(1_004),
          }
        : thread,
    ),
  };
}

function createSnapshotWithSettledPlanAwaitingFollowUp(): OrchestrationReadModel {
  const snapshot = createSnapshotWithSettledInlinePlan();
  const planMarkdown = [
    "# Proposed plan",
    "",
    "- Step 1: capture the failing state",
    "- Step 2: apply the fix",
    "- Step 3: add regression coverage",
  ].join("\n");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            interactionMode: "plan",
            hasActionableProposedPlan: true,
            proposedPlans: [
              {
                id: "plan-awaiting-follow-up",
                turnId: null,
                planMarkdown,
                implementedAt: null,
                implementationThreadId: null,
                createdAt: isoAt(1_005),
                updatedAt: isoAt(1_005),
              },
            ],
            updatedAt: isoAt(1_005),
          }
        : thread,
    ),
  };
}

function createSnapshotWithInlineToolOverflow(options: {
  active: boolean;
}): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-inline-tools-target" as MessageId,
    targetText: "inline tools thread",
    sessionStatus: options.active ? "running" : "ready",
  });
  const activeTurnId = TurnId.makeUnsafe("turn-inline-tools");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            latestTurn: {
              turnId: activeTurnId,
              state: options.active ? "running" : "completed",
              requestedAt: isoAt(1_100),
              startedAt: isoAt(1_101),
              completedAt: options.active ? null : isoAt(1_108),
              assistantMessageId: MessageId.makeUnsafe("msg-assistant-inline-tools"),
            },
            activities: Array.from({ length: 6 }, (_, index) => ({
              id: EventId.makeUnsafe(`activity-inline-tool-${index + 1}`),
              createdAt: isoAt(1_102 + index),
              kind: "tool.completed" as const,
              summary: `tool ${index + 1}`,
              tone: "tool" as const,
              turnId: activeTurnId,
              payload: {
                itemType: "dynamic_tool_call",
                toolName: `tool-${index + 1}`,
              },
            })),
            messages: [
              ...thread.messages,
              {
                turnId: activeTurnId,
                id: MessageId.makeUnsafe("msg-assistant-inline-tools"),
                role: "assistant",
                text: "Wrapped up the inline tool review.",
                createdAt: isoAt(1_109),
                updatedAt: isoAt(1_109),
                completedAt: options.active ? undefined : isoAt(1_109),
                streaming: false,
                source: "native",
              },
            ],
            session: thread.session
              ? {
                  ...thread.session,
                  status: options.active ? "running" : "ready",
                  activeTurnId: options.active ? activeTurnId : null,
                  updatedAt: options.active ? isoAt(1_107) : isoAt(1_108),
                }
              : null,
            updatedAt: options.active ? isoAt(1_107) : isoAt(1_109),
          }
        : thread,
    ),
  };
}

function createSnapshotWithHistoricalToolHydrationDuringLiveTurn(options: {
  hydrateHistoricalActivities: boolean;
}): OrchestrationReadModel {
  const snapshot = createSnapshotWithInlineToolOverflow({ active: false });
  const liveTurnId = TurnId.makeUnsafe("turn-after-inline-tools");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            latestTurn: {
              turnId: liveTurnId,
              state: "running",
              requestedAt: isoAt(1_200),
              startedAt: isoAt(1_201),
              completedAt: null,
              assistantMessageId: MessageId.makeUnsafe("msg-assistant-live-after-history"),
            },
            activities: options.hydrateHistoricalActivities ? thread.activities : [],
            messages: [
              ...thread.messages,
              {
                turnId: liveTurnId,
                id: MessageId.makeUnsafe("msg-user-live-after-history"),
                role: "user",
                text: "Keep working while history hydrates.",
                createdAt: isoAt(1_200),
                updatedAt: isoAt(1_200),
                streaming: false,
                source: "native",
              },
              {
                turnId: liveTurnId,
                id: MessageId.makeUnsafe("msg-assistant-live-after-history"),
                role: "assistant",
                text: "Current turn is still running.",
                createdAt: isoAt(1_202),
                updatedAt: isoAt(1_202),
                streaming: false,
                source: "native",
              },
            ],
            session: thread.session
              ? {
                  ...thread.session,
                  status: "running",
                  activeTurnId: liveTurnId,
                  updatedAt: isoAt(1_202),
                }
              : null,
            updatedAt: isoAt(1_202),
          }
        : thread,
    ),
  };
}

function recordProjectCreateCommand(command: unknown): boolean {
  if (
    !command ||
    typeof command !== "object" ||
    !("type" in command) ||
    command.type !== "project.create" ||
    !("projectId" in command) ||
    !("workspaceRoot" in command) ||
    !("title" in command)
  ) {
    return false;
  }

  const projectId = command.projectId as ProjectId;
  fixture = {
    ...fixture,
    snapshot: {
      ...fixture.snapshot,
      snapshotSequence: fixture.snapshot.snapshotSequence + 1,
      projects: [
        ...fixture.snapshot.projects.filter((project) => project.id !== projectId),
        {
          id: projectId,
          kind:
            "kind" in command && (command.kind === "chat" || command.kind === "studio")
              ? command.kind
              : "project",
          title: String(command.title),
          workspaceRoot: String(command.workspaceRoot),
          defaultModelSelection:
            "defaultModelSelection" in command &&
            command.defaultModelSelection &&
            typeof command.defaultModelSelection === "object"
              ? (command.defaultModelSelection as OrchestrationReadModel["projects"][number]["defaultModelSelection"])
              : {
                  provider: "codex" as const,
                  model: "gpt-5",
                },
          scripts: [],
          createdAt:
            "createdAt" in command && typeof command.createdAt === "string"
              ? command.createdAt
              : NOW_ISO,
          updatedAt: NOW_ISO,
          deletedAt: null,
        },
      ],
      updatedAt: NOW_ISO,
    },
  };
  return true;
}

function resolveWsRpc(body: WsRequestEnvelope["body"]): unknown {
  const tag = body._tag;
  if (tag === ORCHESTRATION_WS_METHODS.getShellSnapshot) {
    return createShellSnapshotFromReadModel(fixture.snapshot);
  }
  if (tag === ORCHESTRATION_WS_METHODS.getSnapshot) {
    return fixture.snapshot;
  }
  if (tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
    if (recordProjectCreateCommand(body.command)) {
      return { sequence: fixture.snapshot.snapshotSequence };
    }
    return { sequence: fixture.snapshot.snapshotSequence + 1 };
  }
  if (tag === WS_METHODS.automationCreate) {
    return createAutomationDefinitionFromCreateRequest(body);
  }
  if (tag === WS_METHODS.serverGetSettings) {
    return createBrowserTestServerSettings(NOW_ISO);
  }
  if (tag === WS_METHODS.serverGetConfig) {
    return fixture.serverConfig;
  }
  if (tag === WS_METHODS.providerListModels) {
    return { models: [], source: "unsupported", cached: false };
  }
  if (tag === WS_METHODS.projectsListDevServers) {
    return { servers: [] };
  }
  if (tag === WS_METHODS.automationList) {
    return { definitions: [], runs: [] };
  }
  if (tag === WS_METHODS.todoList) {
    return { todos: [] };
  }
  if (tag === WS_METHODS.githubInboxList) {
    return {
      viewer: null,
      items: [],
      errors: [],
      repositoryBatches: [],
      rateLimit: null,
      reviewRequestedCount: 0,
      reviewRequestedCountIncomplete: false,
    };
  }
  if (tag === WS_METHODS.gitListBranches) {
    const cwd = typeof body.cwd === "string" ? body.cwd : null;
    const branchName = cwd ? (fixture.gitBranchByCwd[cwd] ?? "main") : "main";
    return {
      isRepo: true,
      hasOriginRemote: true,
      branches: [
        {
          name: branchName,
          current: true,
          isDefault: true,
          worktreePath: null,
        },
      ],
    };
  }
  if (tag === WS_METHODS.gitStatus) {
    const cwd = typeof body.cwd === "string" ? body.cwd : null;
    const branchName = cwd ? (fixture.gitBranchByCwd[cwd] ?? "main") : "main";
    return {
      branch: branchName,
      hasWorkingTreeChanges: false,
      workingTree: {
        files: [],
        insertions: 0,
        deletions: 0,
      },
      hasUpstream: true,
      upstreamBranch: null,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };
  }
  if (tag === WS_METHODS.gitCreateWorktree) {
    const requestedBranch =
      typeof body.newBranch === "string"
        ? body.newBranch
        : typeof body.branch === "string"
          ? body.branch
          : "main";
    return {
      worktree: {
        path: `/repo/.codex/worktrees/project/${requestedBranch.replaceAll("/", "-")}`,
        branch: requestedBranch,
      },
    };
  }
  if (tag === WS_METHODS.gitCreateDetachedWorktree) {
    return {
      worktree: {
        path: "/repo/.codex/worktrees/generated/synara",
        ref: "0123456789abcdef0123456789abcdef01234567",
        branch: typeof body.newBranch === "string" ? body.newBranch : null,
      },
    };
  }
  if (tag === WS_METHODS.projectsSearchEntries) {
    return {
      entries: [],
      truncated: false,
    };
  }
  if (tag === WS_METHODS.projectAgentListTasks) return { tasks: [], nextCursor: null };
  if (tag === WS_METHODS.projectAgentListActivity) return { activity: [], nextCursor: null };
  if (tag === WS_METHODS.projectAgentListDocuments) return { documents: [] };
  if (tag === WS_METHODS.projectAgentListThreadIndex) return { threads: [] };
  if (tag === WS_METHODS.projectAgentGetOverview) {
    const projectId = typeof body.projectId === "string" ? body.projectId : "";
    return fixture.projectAgentOverviews[projectId] ?? {};
  }
  if (tag === WS_METHODS.terminalOpen) {
    return {
      threadId: typeof body.threadId === "string" ? body.threadId : THREAD_ID,
      terminalId: typeof body.terminalId === "string" ? body.terminalId : "default",
      cwd: typeof body.cwd === "string" ? body.cwd : "/repo/project",
      status: "running",
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: NOW_ISO,
    };
  }
  if (
    tag === WS_METHODS.shellOpenInEditor ||
    tag === WS_METHODS.terminalWrite ||
    tag === WS_METHODS.terminalClose
  ) {
    return null;
  }
  return {};
}

function installDeterministicSendNativeApi(options?: {
  rejectTurnStart?: boolean;
  beforeWorktreeCreation?: () => Promise<void>;
  beforeTurnStart?: () => Promise<void>;
  projectThreadCommands?: boolean;
}): () => void {
  const previousNativeApi = window.nativeApi;
  const wsNativeApi = readNativeApi();
  if (!wsNativeApi) {
    throw new Error("Expected browser native API fixture.");
  }

  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: {
      ...wsNativeApi,
      git: {
        ...wsNativeApi.git,
        createDetachedWorktree: async (
          input: Parameters<typeof wsNativeApi.git.createDetachedWorktree>[0],
        ) => {
          const request: WsRequestEnvelope["body"] = {
            _tag: WS_METHODS.gitCreateDetachedWorktree,
            ...input,
          };
          wsRequests.push(request);
          await options?.beforeWorktreeCreation?.();
          return resolveWsRpc(request) as Awaited<
            ReturnType<typeof wsNativeApi.git.createDetachedWorktree>
          >;
        },
      },
      terminal: {
        ...wsNativeApi.terminal,
        open: async (input: Parameters<typeof wsNativeApi.terminal.open>[0]) => {
          const request: WsRequestEnvelope["body"] = {
            _tag: WS_METHODS.terminalOpen,
            ...input,
          };
          wsRequests.push(request);
          return resolveWsRpc(request) as Awaited<ReturnType<typeof wsNativeApi.terminal.open>>;
        },
        write: async (input: Parameters<typeof wsNativeApi.terminal.write>[0]) => {
          wsRequests.push({
            _tag: WS_METHODS.terminalWrite,
            ...input,
          });
        },
      },
      orchestration: {
        ...wsNativeApi.orchestration,
        dispatchCommand: async (
          command: Parameters<typeof wsNativeApi.orchestration.dispatchCommand>[0],
        ) => {
          wsRequests.push({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            command,
          });
          if (command.type === "thread.turn.start") await options?.beforeTurnStart?.();
          if (options?.rejectTurnStart && command.type === "thread.turn.start") {
            throw new Error("Turn start failed for test.");
          }
          if (options?.projectThreadCommands && command.type === "thread.create") {
            const snapshot = addThreadToSnapshot(fixture.snapshot, command.threadId);
            fixture.snapshot = {
              ...snapshot,
              threads: snapshot.threads.map((thread) =>
                thread.id === command.threadId
                  ? { ...thread, ...command, id: command.threadId, session: null }
                  : thread,
              ),
            };
            useStore.getState().syncServerReadModel(fixture.snapshot);
          }
          if (options?.projectThreadCommands && command.type === "thread.meta.update") {
            const patch = Object.fromEntries(
              Object.entries(command).filter(([, value]) => value !== undefined),
            );
            fixture.snapshot = {
              ...fixture.snapshot,
              snapshotSequence: fixture.snapshot.snapshotSequence + 1,
              threads: fixture.snapshot.threads.map((thread) =>
                thread.id === command.threadId ? { ...thread, ...patch } : thread,
              ),
            };
            useStore.getState().syncServerReadModel(fixture.snapshot);
          }
          return { sequence: fixture.snapshot.snapshotSequence + 1 };
        },
      },
    },
  });

  return () => {
    if (previousNativeApi) {
      Object.defineProperty(window, "nativeApi", {
        configurable: true,
        value: previousNativeApi,
      });
    } else {
      Reflect.deleteProperty(window, "nativeApi");
    }
  };
}

function toRecordedWsRequestBody(request: {
  readonly tag: string;
  readonly payload: unknown;
}): WsRequestEnvelope["body"] {
  if (request.tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
    return {
      _tag: request.tag,
      command: request.payload,
    };
  }
  return flattenEffectRpcRequestPayload(request.tag, request.payload);
}

const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    client.addEventListener("message", (event) => {
      const rawData = event.data;
      if (typeof rawData !== "string") return;
      const parsed = readEffectRpcClientMessage(client, rawData);
      if (parsed.kind !== "request") return;

      const requestBody = toRecordedWsRequestBody(parsed.request);
      const method = requestBody._tag;
      wsRequests.push(requestBody);

      if (method === WS_METHODS.subscribeServerLifecycle) {
        sendEffectRpcChunk(client, parsed.request.id, {
          type: "welcome",
          payload: fixture.welcome,
        });
        return;
      }
      if (method === WS_METHODS.subscribeServerConfig) {
        sendEffectRpcChunk(client, parsed.request.id, {
          type: "snapshot",
          config: fixture.serverConfig,
        });
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeShell) {
        sendEffectRpcChunk(client, parsed.request.id, {
          kind: "snapshot",
          snapshot: createShellSnapshotFromReadModel(fixture.snapshot),
        });
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeThread && "threadId" in requestBody) {
        const threadId = requestBody.threadId as ThreadId;
        const thread = findThreadDetailFromFixtureSnapshot(threadId);
        if (!thread) {
          return;
        }
        sendEffectRpcChunk(client, parsed.request.id, {
          kind: "snapshot",
          snapshot: {
            snapshotSequence: fixture.snapshot.snapshotSequence,
            thread,
          },
        });
        return;
      }
      if (method === WS_METHODS.subscribeServerProviderStatuses) {
        if (fixture.providerStatusesSnapshot) {
          sendEffectRpcChunk(client, parsed.request.id, {
            providers: fixture.providerStatusesSnapshot,
          });
        }
        return;
      }
      if (
        method === WS_METHODS.subscribeServerSettings ||
        method === WS_METHODS.subscribeServerKeepAwake ||
        method === WS_METHODS.subscribeTerminalEvents ||
        method === WS_METHODS.subscribeOrchestrationDomainEvents ||
        method === WS_METHODS.subscribeProjectDevServerEvents ||
        method === WS_METHODS.subscribeAutomationEvents ||
        method === WS_METHODS.subscribeTodoEvents ||
        method === DEVICE_WS_METHODS.subscribeEvents ||
        method === COMPUTER_WS_METHODS.subscribeEvents
      ) {
        return;
      }
      sendEffectRpcExit(client, parsed.request.id, resolveWsRpc(requestBody));
    });
  }),
  http.post(`*${ATTACHMENT_UPLOAD_ROUTE_PATH}`, async ({ request }) => {
    const url = new URL(request.url);
    const bytes = await request.arrayBuffer();
    await attachmentUploadBarrier;
    attachmentUploadSequence += 1;
    return HttpResponse.json(
      {
        type: url.searchParams.get("type") ?? "file",
        id: `att_v2_${String(attachmentUploadSequence).padStart(32, "0")}`,
        name: url.searchParams.get("name") ?? "attachment.bin",
        mimeType: url.searchParams.get("mimeType") ?? "application/octet-stream",
        sizeBytes: bytes.byteLength,
      },
      { status: 201 },
    );
  }),
  http.post(`*${ATTACHMENT_CANCEL_ROUTE_PATH}`, async () => {
    await attachmentCancelBarrier;
    return HttpResponse.json({ cancelled: true }, { status: 200 });
  }),
  http.get("*/attachments/:attachmentId", async () => {
    if (attachmentResponseDelayMs > 0) {
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(() => resolve(), attachmentResponseDelayMs);
      });
    }
    return HttpResponse.text(ATTACHMENT_SVG, {
      headers: {
        "Content-Type": "image/svg+xml",
      },
    });
  }),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

function skipReactDevOwnerStacks(): () => void {
  const internals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: Record<string, unknown>;
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  if (typeof internals?.recentlyCreatedOwnerStacks !== "number") {
    throw new Error("React no longer exposes recentlyCreatedOwnerStacks in development.");
  }
  Object.defineProperty(internals, "recentlyCreatedOwnerStacks", {
    configurable: true,
    get: () => Number.POSITIVE_INFINITY,
    set: () => {},
  });
  return () => {
    Object.defineProperty(internals, "recentlyCreatedOwnerStacks", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: 0,
    });
  };
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function mousePointerEvent(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerType: "mouse",
    pointerId: 1,
    isPrimary: true,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    clientX: x,
    clientY: y,
  });
}

async function waitForLayout(): Promise<void> {
  await nextFrame();
  await nextFrame();
  await nextFrame();
}

async function waitForTranscriptLayoutToSettle(container: HTMLElement): Promise<void> {
  let lastTop = container.scrollTop;
  let lastHeight = container.scrollHeight;
  let lastViewportHeight = container.clientHeight;
  let stableSince = performance.now();
  const scrollOffsets = [lastTop];
  await vi.waitFor(
    () => {
      if (
        container.scrollTop !== lastTop ||
        container.scrollHeight !== lastHeight ||
        container.clientHeight !== lastViewportHeight
      ) {
        lastTop = container.scrollTop;
        lastHeight = container.scrollHeight;
        lastViewportHeight = container.clientHeight;
        stableSince = performance.now();
        scrollOffsets.push(lastTop);
        if (scrollOffsets.length > 20) scrollOffsets.shift();
      }
      expect(
        performance.now() - stableSince,
        `Transcript scroll did not settle: ${scrollOffsets.join(" -> ")} (height ${container.scrollHeight}, viewport ${container.clientHeight})`,
      ).toBeGreaterThanOrEqual(150);
    },
    { timeout: 3_000, interval: 20 },
  );
}

function isTranscriptPaintedAfterInitialScroll(scrollContainer: HTMLElement): boolean {
  const wrapper = scrollContainer.querySelector<HTMLElement>('div[style*="opacity"]');
  if (!wrapper) {
    return false;
  }
  return Number.parseFloat(wrapper.style.opacity || "1") > 0;
}

async function recordTranscriptScrollTravel(durationMs: number): Promise<{
  readonly downwardTravelPx: number;
  readonly maxDistanceFromBottomPx: number;
  readonly visibleFrames: number;
}> {
  const startedAt = performance.now();
  let downwardTravelPx = 0;
  let maxDistanceFromBottomPx = 0;
  let visibleFrames = 0;
  let previousScrollTop: number | null = null;

  while (performance.now() - startedAt < durationMs) {
    await nextFrame();
    const container = document.querySelector<HTMLElement>("[data-chat-scroll-container='true']");
    if (!container || !isTranscriptPaintedAfterInitialScroll(container)) {
      previousScrollTop = null;
      continue;
    }
    if (container.scrollHeight <= container.clientHeight) {
      continue;
    }
    visibleFrames += 1;
    maxDistanceFromBottomPx = Math.max(
      maxDistanceFromBottomPx,
      getScrollContainerDistanceFromBottom(container),
    );
    if (previousScrollTop !== null) {
      downwardTravelPx += Math.max(0, container.scrollTop - previousScrollTop);
    }
    previousScrollTop = container.scrollTop;
  }

  return { downwardTravelPx, maxDistanceFromBottomPx, visibleFrames };
}

function installImmediateScrollToSpy(
  scrollContainer: HTMLElement,
  config?: { readonly suspendSmoothScroll?: boolean },
): {
  readonly calls: ScrollToOptions[];
  readonly restore: () => void;
} {
  const originalScrollTo = scrollContainer.scrollTo;
  const calls: ScrollToOptions[] = [];
  scrollContainer.scrollTo = ((options?: ScrollToOptions | number, y?: number) => {
    const normalized: ScrollToOptions =
      typeof options === "object" && options !== null
        ? options
        : {
            ...(typeof options === "number" ? { left: options } : {}),
            ...(typeof y === "number" ? { top: y } : {}),
          };
    calls.push(normalized);
    if (config?.suspendSmoothScroll && normalized.behavior === "smooth") {
      return;
    }
    if (typeof normalized.left === "number") {
      scrollContainer.scrollLeft = normalized.left;
    }
    if (typeof normalized.top === "number") {
      scrollContainer.scrollTop = normalized.top;
    }
    scrollContainer.dispatchEvent(new Event("scroll"));
  }) as typeof scrollContainer.scrollTo;

  return {
    calls,
    restore: () => {
      scrollContainer.scrollTo = originalScrollTo;
    },
  };
}

async function setViewport(viewport: ViewportSpec): Promise<void> {
  await page.viewport(viewport.width, viewport.height);
  await waitForLayout();
}

async function waitForProductionStyles(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      ).not.toBe("");
      expect(getComputedStyle(document.body).marginTop).toBe("0px");
    },
    {
      timeout: 4_000,
      interval: 16,
    },
  );
}

async function waitForElement<T extends Element>(
  query: () => T | null,
  errorMessage: string,
): Promise<T> {
  let element: T | null = null;
  await vi.waitFor(
    () => {
      element = query();
      expect(element, errorMessage).toBeTruthy();
    },
    {
      timeout: 8_000,
      interval: 16,
    },
  );
  if (!element) {
    throw new Error(errorMessage);
  }
  return element;
}

async function waitForURL(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  let pathname = "";
  await vi.waitFor(
    () => {
      pathname = router.state.location.pathname;
      expect(predicate(pathname), errorMessage).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
  return pathname;
}

async function waitForComposerEditor(): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>('[contenteditable="true"]'),
    "Unable to find composer editor.",
  );
}

async function waitForSendButton(): Promise<HTMLButtonElement> {
  return waitForElement(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
    "Unable to find send button.",
  );
}

function readDispatchedCommand(request: WsRequestEnvelope["body"]): Record<string, unknown> | null {
  if (
    request._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand ||
    typeof request.command !== "object" ||
    request.command === null
  ) {
    return null;
  }
  return request.command as Record<string, unknown>;
}

function hasDispatchedCommandType(type: string): boolean {
  return wsRequests.some((request) => readDispatchedCommand(request)?.type === type);
}

async function waitForWorktreeCheckbox(): Promise<HTMLElement> {
  return waitForElement(
    () =>
      document.querySelector<HTMLElement>('[data-empty-landing-controls] [data-slot="checkbox"]'),
    "Unable to find the Worktree checkbox.",
  );
}

async function waitForServerConfigToApply(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(wsRequests.some((request) => request._tag === WS_METHODS.serverGetConfig)).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
  await waitForLayout();
}

function dispatchComposerPickerShortcut(target: EventTarget, key: "m" | "e"): void {
  const useMetaForMod = isMacNavigatorPlatform();
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      shiftKey: true,
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function dispatchModelCycleShortcut(target: EventTarget, key: "[" | "]"): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    code: key === "]" ? "BracketRight" : "BracketLeft",
    altKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

async function dispatchModelCycleShortcutWhenReady(
  target: EventTarget,
  key: "[" | "]",
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(dispatchModelCycleShortcut(target, key).defaultPrevented).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
}

function dispatchConfiguredShortcut(
  target: EventTarget,
  input: { key: string; shiftKey?: boolean; altKey?: boolean },
): KeyboardEvent {
  const useMetaForMod = isMacNavigatorPlatform();
  const event = new KeyboardEvent("keydown", {
    key: input.key,
    shiftKey: input.shiftKey ?? false,
    altKey: input.altKey ?? false,
    metaKey: useMetaForMod,
    ctrlKey: !useMetaForMod,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

async function dispatchConfiguredShortcutWhenReady(
  target: EventTarget,
  input: { key: string; shiftKey?: boolean; altKey?: boolean },
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(dispatchConfiguredShortcut(target, input).defaultPrevented).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
}

function dispatchComposerFocusToggleShortcut(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "l",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

async function waitForComposerPickerSurfaceOpen(): Promise<void> {
  await vi.waitFor(() => {
    const popup = document.querySelector('[data-slot="menu-popup"]');
    expect(popup).not.toBeNull();
    expect(popup?.textContent ?? "").toContain("GPT-5");
  });
}

function dispatchChatNewShortcut(): void {
  dispatchThreadShortcut("o");
}

function dispatchTerminalThreadShortcut(): void {
  dispatchThreadShortcut("t");
}

function dispatchThreadShortcut(key: string): void {
  const useMetaForMod = isMacNavigatorPlatform();
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      shiftKey: true,
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
}

async function triggerChatNewShortcutUntilPath(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  return triggerThreadShortcutUntilPath(router, dispatchChatNewShortcut, predicate, errorMessage);
}

async function triggerTerminalThreadShortcutUntilPath(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  return triggerThreadShortcutUntilPath(
    router,
    dispatchTerminalThreadShortcut,
    predicate,
    errorMessage,
  );
}

async function triggerThreadShortcutUntilPath(
  router: ReturnType<typeof getRouter>,
  dispatchShortcut: () => void,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  let pathname = router.state.location.pathname;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    dispatchShortcut();
    await waitForLayout();
    pathname = router.state.location.pathname;
    if (predicate(pathname)) {
      return pathname;
    }
  }
  throw new Error(`${errorMessage} Last path: ${pathname}`);
}

async function waitForNewThreadShortcutLabel(): Promise<void> {
  const newThreadButton = page.getByTestId("new-thread-button");
  await expect.element(newThreadButton).toBeInTheDocument();
  await waitForLayout();
}

async function waitForImagesToLoad(scope: ParentNode): Promise<void> {
  const images = Array.from(scope.querySelectorAll("img"));
  if (images.length === 0) {
    return;
  }
  await Promise.all(
    images.map(
      (image) =>
        new Promise<void>((resolve) => {
          if (image.complete) {
            resolve();
            return;
          }
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        }),
    ),
  );
  await waitForLayout();
}

async function measureUserRow(options: {
  host: HTMLElement;
  targetMessageId: MessageId;
}): Promise<UserRowMeasurement> {
  const { host, targetMessageId } = options;
  const rowSelector = `[data-message-id="${targetMessageId}"][data-message-role="user"]`;

  const scrollContainer = await waitForElement(
    () => host.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
    "Unable to find ChatView message scroll container.",
  );

  let row: HTMLElement | null = null;
  await vi.waitFor(
    async () => {
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();
      row = host.querySelector<HTMLElement>(rowSelector);
      expect(row, "Unable to locate targeted user message row.").toBeTruthy();
    },
    {
      timeout: 8_000,
      interval: 16,
    },
  );

  await waitForImagesToLoad(row!);
  scrollContainer.scrollTop = 0;
  scrollContainer.dispatchEvent(new Event("scroll"));
  await nextFrame();

  let timelineWidthMeasuredPx = 0;
  let measuredRowHeightPx = 0;
  await vi.waitFor(
    async () => {
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await nextFrame();
      const measuredRow = host.querySelector<HTMLElement>(rowSelector);
      expect(measuredRow, "Unable to measure targeted user row height.").toBeTruthy();
      timelineWidthMeasuredPx = measuredRow!.getBoundingClientRect().width;
      measuredRowHeightPx = measuredRow!.getBoundingClientRect().height;
      expect(timelineWidthMeasuredPx, "Unable to measure timeline width.").toBeGreaterThan(0);
      expect(measuredRowHeightPx, "Unable to measure targeted user row height.").toBeGreaterThan(0);
    },
    {
      timeout: 4_000,
      interval: 16,
    },
  );

  return { measuredRowHeightPx, timelineWidthMeasuredPx };
}

async function measureChatLayout(host: HTMLElement): Promise<ChatLayoutMeasurement> {
  const scrollContainer = await waitForElement(
    () => host.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
    "Unable to find ChatView message scroll container.",
  );
  const composerForm = await waitForElement(
    () => host.querySelector<HTMLElement>("[data-chat-composer-form='true']"),
    "Unable to find chat composer form.",
  );

  await waitForLayout();

  const hostHeightPx = host.getBoundingClientRect().height;
  const composerBottomPx = composerForm.getBoundingClientRect().bottom;
  return {
    hostHeightPx,
    composerBottomPx,
    scrollClientHeightPx: scrollContainer.clientHeight,
    scrollHeightPx: scrollContainer.scrollHeight,
    distanceFromBottomPx: getScrollContainerDistanceFromBottom(scrollContainer),
  };
}

async function waitForMountedChatReady(options: {
  host: HTMLElement;
  snapshot: OrchestrationReadModel;
  routeThreadId: ThreadId;
}): Promise<void> {
  const expectedThread = options.snapshot.threads.find(
    (thread) => thread.id === options.routeThreadId,
  );

  await vi.waitFor(
    () => {
      expect(
        options.host.querySelector("[data-chat-composer-form='true']"),
        "Chat composer did not mount.",
      ).toBeTruthy();
      expect(
        wsRequests.some((request) => request._tag === WS_METHODS.serverGetConfig),
        "Browser RPC configuration did not load.",
      ).toBe(true);

      if (!expectedThread) return;
      const state = useStore.getState();
      expect(state.threadIds?.includes(expectedThread.id)).toBe(true);
      const hydratedMessageIdSet = new Set(state.messageIdsByThreadId?.[expectedThread.id] ?? []);
      expect(
        expectedThread.messages.every((message) => hydratedMessageIdSet.has(message.id)),
        "Active thread detail did not hydrate.",
      ).toBe(true);
    },
    { timeout: 20_000, interval: 16 },
  );
  await waitForLayout();
}

async function mountChatView(options: {
  viewport: ViewportSpec;
  snapshot: OrchestrationReadModel;
  configureFixture?: (fixture: TestFixture) => void;
  initialEntry?: string;
  onRender?: ProfilerOnRenderCallback;
}): Promise<MountedChatView> {
  fixture = buildFixture(options.snapshot);
  options.configureFixture?.(fixture);
  await setViewport(options.viewport);
  await waitForProductionStyles();

  const host = createFullscreenTestHost();

  const initialEntry = options.initialEntry ?? `/${THREAD_ID}`;

  const router = getRouter(
    createMemoryHistory({
      initialEntries: [initialEntry],
    }),
  );

  const content = options.onRender ? (
    <Profiler id="issue-550-root" onRender={options.onRender}>
      <RouterProvider router={router} />
    </Profiler>
  ) : (
    <RouterProvider router={router} />
  );
  const screen = await render(content, {
    container: host,
  });

  try {
    await waitForMountedChatReady({
      host,
      snapshot: options.snapshot,
      routeThreadId: ThreadId.makeUnsafe(initialEntry.slice(1)),
    });
  } catch (cause) {
    await screen.unmount();
    if (host.isConnected) host.remove();
    throw cause;
  }

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await screen.unmount();
    if (host.isConnected) host.remove();
    await router.options.context.queryClient.cancelQueries();
    router.options.context.queryClient.clear();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
    measureLayout: async () => measureChatLayout(host),
    measureUserRow: async (targetMessageId: MessageId) => measureUserRow({ host, targetMessageId }),
    setViewport: async (viewport: ViewportSpec) => {
      await setViewport(viewport);
      await waitForProductionStyles();
    },
    router,
  };
}

describe("ChatView settle follow (full app)", () => {
  beforeAll(async () => {
    fixture = buildFixture(
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-bootstrap" as MessageId,
        targetText: "bootstrap",
      }),
    );
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: {
        url: "/mockServiceWorker.js",
      },
    });
  });

  afterAll(async () => {
    await resetWsNativeApiForTest();
    await worker.stop();
  });

  beforeEach(async () => {
    fixture = buildFixture({
      ...fixture.snapshot,
      snapshotSequence: 0,
      spaces: [],
      projects: [],
      threads: [],
      updatedAt: NOW_ISO,
    });
    await resetWsNativeApiForTest();
    resetRetainedThreadDetailSubscriptionsForTests();
    await resetHomeChatProjectPrewarmStateForTests();
    attachmentResponseDelayMs = 0;
    attachmentUploadSequence = 0;
    attachmentUploadBarrier = null;
    attachmentCancelBarrier = null;
    localStorage.clear();
    acknowledgeStartupAnnouncementsForTest(createBaseServerConfig());
    useProjectEnvironmentStore.setState({ envModeByProjectId: {} });
    useThreadDispatchStore.setState({ threads: {} });
    useLatestProjectStore.setState({ latestProjectId: null });
    useWorkspacePathsStore.setState({
      homeDir: null,
      chatWorkspaceRoot: null,
      studioWorkspaceRoot: null,
      groupsWorkspaceRoot: null,
    });
    document.body.innerHTML = "";
    wsRequests.length = 0;
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
    useStore.setState({
      shellSnapshotSequence: 0,
      spaces: [],
      projects: [],
      threadIds: [],
      threadShellById: {},
      threadSessionById: {},
      threadTurnStateById: {},
      messageIdsByThreadId: {},
      messageByThreadId: {},
      activityIdsByThreadId: {},
      activityByThreadId: {},
      proposedPlanIdsByThreadId: {},
      proposedPlanByThreadId: {},
      turnDiffIdsByThreadId: {},
      turnDiffSummaryByThreadId: {},
      threadDetailSyncById: {},
      deletedProjectIdsById: {},
      deletedThreadIdsById: {},
      sidebarThreadSummaryById: {},
      threadsHydrated: false,
    });
    useTemporaryThreadStore.setState({
      temporaryThreadIds: {},
    });
    useTerminalStateStore.setState({
      terminalStateByThreadId: {},
    });
    useSplitViewStore.setState({
      splitViewsById: {},
      splitViewIdBySourceThreadId: {},
    });
  });

  afterEach(async () => {
    await resetHomeChatProjectPrewarmStateForTests();
    resetRetainedThreadDetailSubscriptionsForTests();
    document.body.innerHTML = "";
  });

  it.each([
    "anchored",
    "anchored-extra-text",
    "not-anchored",
    "baseline-without-same-frame-follow",
    "anchored-shorter-final",
  ])(
    "keeps a followed turn at the bottom on every frame through completion (%s)",
    async (variant) => {
      if (variant === "not-anchored") {
        localStorage.setItem(
          "synara:app-settings:v1",
          JSON.stringify({ anchorSentMessagesToTop: false }),
        );
      }
      const restoreNativeApi = installDeterministicSendNativeApi();
      let snapshot = createSnapshotForTargetUser({
        targetMessageId: "msg-user-settle-target" as MessageId,
        targetText: "settle target",
      });
      const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
      const probe = installScrollWriteProbe({
        blockGuardFollow: variant === "baseline-without-same-frame-follow",
      });
      try {
        const scroller = await waitForElement(
          () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
          "Unable to find message scroll container.",
        );
        probe.setScroller(scroller);
        await vi.waitFor(() =>
          expect(getScrollContainerDistanceFromBottom(scroller)).toBeLessThanOrEqual(4),
        );

        const prompt = "Explain the settle frame in detail";
        useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
        await vi.waitFor(async () => {
          expect((await waitForComposerEditor()).textContent).toContain(prompt);
        });
        const sendButton = await waitForSendButton();
        await userEvent.click(sendButton);

        const turnStart = await vi.waitFor(() => {
          const command = wsRequests
            .map(readDispatchedCommand)
            .find((entry) => entry?.type === "thread.turn.start");
          expect(command, "turn start not dispatched").toBeTruthy();
          return command as { message: { messageId: MessageId; text: string } };
        });
        const userMessageId = turnStart.message.messageId;
        const turnId = TurnId.makeUnsafe("turn-settle-follow");
        const assistantId = MessageId.makeUnsafe("msg-assistant-settle-follow");
        const requestedAt = new Date().toISOString();
        const userMessage = {
          id: userMessageId,
          role: "user" as const,
          text: prompt,
          turnId: null,
          streaming: false,
          source: "native" as const,
          createdAt: requestedAt,
          updatedAt: requestedAt,
        };
        let assistantCreatedAt: string | null = null;
        const sync = (phase: "running" | "completed", assistantText: string | null) => {
          const now = new Date().toISOString();
          if (assistantText !== null && assistantCreatedAt === null) assistantCreatedAt = now;
          const streaming = phase === "running";
          snapshot = {
            ...snapshot,
            snapshotSequence: snapshot.snapshotSequence + 1,
            threads: snapshot.threads.map((thread) =>
              thread.id !== THREAD_ID
                ? thread
                : {
                    ...thread,
                    updatedAt: now,
                    session: thread.session
                      ? {
                          ...thread.session,
                          status: streaming ? "running" : "ready",
                          activeTurnId: streaming ? turnId : null,
                          updatedAt: now,
                        }
                      : null,
                    latestTurn: {
                      turnId,
                      state: streaming ? "running" : "completed",
                      requestedAt,
                      startedAt: requestedAt,
                      completedAt: streaming ? null : now,
                      assistantMessageId: assistantText === null ? null : assistantId,
                    },
                    messages: [
                      ...thread.messages.filter(
                        (message) => message.id !== assistantId && message.id !== userMessageId,
                      ),
                      { ...userMessage, turnId },
                      ...(assistantText === null
                        ? []
                        : [
                            {
                              id: assistantId,
                              role: "assistant" as const,
                              source: "native" as const,
                              text: assistantText,
                              turnId,
                              streaming,
                              createdAt: assistantCreatedAt!,
                              updatedAt: now,
                              ...(streaming ? {} : { completedAt: now }),
                            },
                          ]),
                    ],
                  },
            ),
          };
          fixture = { ...fixture, snapshot };
          useStore.getState().syncServerReadModel(snapshot);
        };

        sync("running", null);
        await waitForLayout();
        await wait(250);

        const chunkCount = variant === "short" ? 6 : 15;
        logSettle("overflowAnchor", getComputedStyle(scroller).overflowAnchor);
        const paragraphsPerChunk = variant === "long" ? 4 : 2;
        const paragraph = (index: number) =>
          `Paragraph ${index}. ${"Streaming assistant output that wraps several lines. ".repeat(5)}`;
        const textAt = (chunk: number) =>
          Array.from({ length: (chunk + 1) * paragraphsPerChunk }, (_, index) =>
            paragraph(index),
          ).join("\n\n");

        const sampler = startFrameSampler(probe, scroller);
        probe.mark("stream-start");
        for (let chunk = 0; chunk < chunkCount; chunk += 1) {
          sync("running", textAt(chunk));
          await wait(60);
        }
        const lastParagraph = `Paragraph ${chunkCount * paragraphsPerChunk - 1}.`;
        await vi.waitFor(
          () => {
            const row = scroller.querySelector(`[data-message-id='${assistantId}']`);
            expect(row?.textContent ?? "").toContain(lastParagraph);
          },
          { timeout: 20_000, interval: 50 },
        );
        await wait(variant === "fast-complete" ? 0 : 600);
        probe.mark("before-complete");
        probe.enableStacks(true);
        sync(
          "completed",
          variant === "anchored-extra-text"
            ? `${textAt(chunkCount - 1)}\n\nEnd of reply.`
            : variant === "anchored-shorter-final"
              ? textAt(chunkCount - 2)
              : textAt(chunkCount - 1),
        );
        probe.mark("complete");
        await wait(1_500);
        probe.mark("end");
        const samples = sampler.stop();
        probe.enableStacks(false);

        const completeFrame = probe.markFrame("complete");
        const window_ = samples.filter(
          (sample) => sample.frame >= completeFrame - 4 && sample.frame <= completeFrame + 60,
        );
        logSettle("variant", variant);
        logSettle("marks", probe.marks);
        logSettle(
          "frames",
          window_.map((sample) => ({
            f: sample.frame,
            t: Math.round(sample.t),
            top: sample.scrollTop,
            sh: sample.scrollHeight,
            ch: sample.clientHeight,
            gap: sample.gap,
            pb: sample.paddingBottom,
            rows: sample.rows,
          })),
        );
        logSettle(
          "writes",
          probe.writes.filter((write) => write.frame >= completeFrame - 4),
        );
        logSettle(
          "clamps",
          probe.clampLog.filter(
            (entry) => entry.frame >= completeFrame - 1 && entry.frame <= completeFrame + 6,
          ),
        );
        logSettle(
          "mutations",
          probe.mutationLog.filter(
            (entry) => entry.frame >= completeFrame - 1 && entry.frame <= completeFrame + 3,
          ),
        );
        logSettle(
          "scrollEvents",
          probe.scrollEvents.filter((event) => event.frame >= completeFrame - 4),
        );
        logSettle(
          "streamGapMax",
          Math.max(
            ...samples
              .filter(
                (sample) =>
                  sample.frame < completeFrame &&
                  sample.frame > probe.markFrame("stream-start") + 20,
              )
              .map((sample) => sample.gap),
          ),
        );
        logSettle(
          "settleGapMax",
          Math.max(
            ...window_
              .filter((sample) => sample.frame >= completeFrame)
              .map((sample) => sample.gap),
          ),
        );
        logSettle("finalGap", getScrollContainerDistanceFromBottom(scroller));
        const streamFrames = samples.filter(
          (sample) =>
            sample.frame < completeFrame &&
            sample.frame > probe.markFrame("stream-start") + SEND_SLIDE_FRAMES,
        );
        const settleFrames = window_.filter((sample) => sample.frame >= completeFrame);
        const appWritesPerFrame = new Map<number, number>();
        const streamStartFrame = probe.markFrame("stream-start");
        for (const write of probe.writes) {
          if (!write.onScroller || write.kind.startsWith("BLOCKED")) continue;
          if (write.frame <= streamStartFrame + SEND_SLIDE_FRAMES) continue;
          appWritesPerFrame.set(write.frame, (appWritesPerFrame.get(write.frame) ?? 0) + 1);
        }
        logSettle(
          "streamGapFrames",
          streamFrames
            .filter((frame) => frame.gap > 2)
            .map((frame) => ({
              f: frame.frame,
              gap: frame.gap,
              top: frame.scrollTop,
              sh: frame.scrollHeight,
            })),
        );
        const maxGap = (frames: typeof samples) => Math.max(0, ...frames.map((frame) => frame.gap));
        if (variant === "baseline-without-same-frame-follow") {
          expect(maxGap(streamFrames) + maxGap(settleFrames)).toBeGreaterThan(2);
        } else {
          const streamGapBoundPx = variant === "not-anchored" ? 2 : ANCHOR_HOLD_RESERVE_SLACK_PX;
          expect(maxGap(streamFrames), "gap while streaming").toBeLessThanOrEqual(streamGapBoundPx);
          expect(maxGap(settleFrames), "gap through completion").toBeLessThanOrEqual(2);
          const framesWithSeveralWrites = [...appWritesPerFrame]
            .filter(([, count]) => count > 1)
            .map(([frame]) => frame);
          expect(
            probe.writes.filter((write) => framesWithSeveralWrites.includes(write.frame)),
            "frames with more than one scroll write",
          ).toEqual([]);
        }
      } finally {
        probe.restore();
        await mounted.cleanup();
        restoreNativeApi();
      }
    },
  );

  it.each([
    { order: "message-then-turn", work: "commands", reducedMotion: false },
    { order: "together", work: "commands", reducedMotion: false },
    { order: "message-then-turn", work: "notices", reducedMotion: false },
    { order: "together", work: "notices", reducedMotion: false },
    { order: "together", work: "notices", reducedMotion: true },
  ] as const)(
    "keeps the live turn's rows and answer node and holds the answer still through settle ($order, $work, reduced motion $reducedMotion)",
    async ({ order, work, reducedMotion }) => {
      if (reducedMotion) {
        await emulateReducedMotion(true);
      }
      const restoreNativeApi = installDeterministicSendNativeApi();
      let snapshot = createSnapshotForTargetUser({
        targetMessageId: "msg-user-settle-rows" as MessageId,
        targetText: "settle rows",
      });
      const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
      const probe = installScrollWriteProbe();
      try {
        const scroller = await waitForElement(
          () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
          "Unable to find message scroll container.",
        );
        probe.setScroller(scroller);
        await vi.waitFor(() =>
          expect(getScrollContainerDistanceFromBottom(scroller)).toBeLessThanOrEqual(4),
        );
        const prompt = "Inspect the workspace and report";
        useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
        await vi.waitFor(async () => {
          expect((await waitForComposerEditor()).textContent).toContain(prompt);
        });
        await userEvent.click(await waitForSendButton());
        const turnStart = await vi.waitFor(() => {
          const command = wsRequests
            .map(readDispatchedCommand)
            .find((entry) => entry?.type === "thread.turn.start");
          expect(command, "turn start not dispatched").toBeTruthy();
          return command as { message: { messageId: MessageId; text: string } };
        });
        const turnId = TurnId.makeUnsafe("turn-settle-rows");
        const assistantId = MessageId.makeUnsafe("msg-assistant-settle-rows");
        const requestedAt = new Date().toISOString();
        const userMessage = {
          id: turnStart.message.messageId,
          role: "user" as const,
          text: prompt,
          turnId,
          streaming: false,
          source: "native" as const,
          createdAt: requestedAt,
          updatedAt: requestedAt,
        };
        const activities: Array<OrchestrationReadModel["threads"][number]["activities"][number]> =
          [];
        const addWork = (index: number) => {
          const createdAt = new Date().toISOString();
          activities.push(
            work === "notices"
              ? {
                  id: EventId.makeUnsafe(`activity-settle-notice-${index}`),
                  createdAt,
                  kind: "transcript.notice",
                  summary: index % 2 === 0 ? "Skills updated" : "MCP server ready",
                  tone: "info",
                  turnId: null,
                  payload: {
                    noticeKind: index % 2 === 0 ? "skills-changed" : "mcp-server-status",
                    severity: "info",
                    title: index % 2 === 0 ? "Skills updated" : "MCP server ready",
                    dedupeKey: `notice-${index}`,
                  },
                }
              : {
                  id: EventId.makeUnsafe(`activity-settle-rows-${index}`),
                  createdAt,
                  kind: "tool.completed",
                  summary: "Ran command",
                  tone: "tool",
                  turnId,
                  payload: {
                    itemType: "command_execution",
                    data: { toolCallId: `cmd-${index}`, command: `cat src/file-${index}.ts` },
                  },
                },
          );
        };
        let assistantCreatedAt: string | null = null;
        const sync = (
          phase: "running" | "message-complete" | "completed",
          assistantText: string | null,
        ) => {
          const now = new Date().toISOString();
          if (assistantText !== null && assistantCreatedAt === null) assistantCreatedAt = now;
          const running = phase !== "completed";
          const messageStreaming = phase === "running";
          snapshot = {
            ...snapshot,
            snapshotSequence: snapshot.snapshotSequence + 1,
            threads: snapshot.threads.map((thread) =>
              thread.id !== THREAD_ID
                ? thread
                : {
                    ...thread,
                    updatedAt: now,
                    activities: [...activities],
                    session: thread.session
                      ? {
                          ...thread.session,
                          status: running ? "running" : "ready",
                          activeTurnId: running ? turnId : null,
                          updatedAt: now,
                        }
                      : null,
                    latestTurn: {
                      turnId,
                      state: running ? "running" : "completed",
                      requestedAt,
                      startedAt: requestedAt,
                      completedAt: running ? null : now,
                      assistantMessageId: assistantText === null ? null : assistantId,
                    },
                    messages: [
                      ...thread.messages.filter(
                        (message) => message.id !== assistantId && message.id !== userMessage.id,
                      ),
                      userMessage,
                      ...(assistantText === null
                        ? []
                        : [
                            {
                              id: assistantId,
                              role: "assistant" as const,
                              source: "native" as const,
                              text: assistantText,
                              turnId,
                              streaming: messageStreaming,
                              createdAt: assistantCreatedAt!,
                              updatedAt: now,
                              ...(messageStreaming ? {} : { completedAt: now }),
                            },
                          ]),
                    ],
                  },
            ),
          };
          fixture = { ...fixture, snapshot };
          useStore.getState().syncServerReadModel(snapshot);
        };

        sync("running", null);
        await wait(300);
        for (let index = 0; index < (work === "notices" ? 6 : 3); index += 1) {
          addWork(index);
          sync("running", null);
          await wait(250);
        }
        const paragraph = (index: number) =>
          `Paragraph ${index}. ${"Streaming assistant output that wraps several lines. ".repeat(4)}`;
        const textAt = (chunk: number) =>
          Array.from({ length: (chunk + 1) * 2 }, (_, index) => paragraph(index)).join("\n\n");
        const chunkCount = 10;
        for (let chunk = 0; chunk < chunkCount; chunk += 1) {
          sync("running", textAt(chunk));
          await wait(80);
        }
        const finalText = textAt(chunkCount - 1);
        await vi.waitFor(
          () => {
            const row = scroller.querySelector(`[data-message-id='${assistantId}']`);
            expect(row?.textContent ?? "").toContain(`Paragraph ${chunkCount * 2 - 1}.`);
          },
          { timeout: 20_000, interval: 50 },
        );
        await wait(400);

        const frames = startPaintedFrameSampler(() => sampleSettleRows(scroller, assistantId));
        await wait(100);
        if (order === "message-then-turn") {
          sync("message-complete", finalText);
          await wait(120);
        }
        sync("completed", finalText);
        await wait(1_200);
        const settleFrames = frames.stop();

        const answerIds = new Set(settleFrames.flatMap((frame) => frame.answerId ?? []));
        const liveRowIds = new Map<string, Set<number>>();
        for (const frame of settleFrames) {
          for (const [kind, id] of frame.liveRowIds) {
            liveRowIds.set(kind, (liveRowIds.get(kind) ?? new Set()).add(id));
          }
        }
        const answerSteps = settleFrames.flatMap((frame, index) => {
          const previous = settleFrames[index - 1];
          return previous && frame.answerTop !== null && previous.answerTop !== null
            ? [frame.answerTop - previous.answerTop]
            : [];
        });
        const maxAnswerStep = Math.max(0, ...answerSteps.map(Math.abs));
        const maxGap = Math.max(0, ...settleFrames.map((frame) => frame.gap));
        logSettle("settle-rows", {
          order,
          work,
          reducedMotion,
          frames: settleFrames.length,
          answerNodes: answerIds.size,
          liveRowNodes: Object.fromEntries([...liveRowIds].map(([kind, ids]) => [kind, ids.size])),
          maxAnswerStep,
          answerSteps: answerSteps.filter((step) => step !== 0).slice(0, 24),
          maxFold: Math.max(0, ...settleFrames.map((frame) => frame.foldH ?? 0)),
          maxGap,
        });

        expect(settleFrames.some((frame) => frame.liveRowIds.length === 0)).toBe(true);
        expect(answerIds.size, "answer node replaced at settle").toBe(1);
        for (const [kind, ids] of liveRowIds) {
          expect(ids.size, `${kind} row remounted at settle`).toBe(1);
        }
        expect(maxAnswerStep, "answer moved while the reader is pinned").toBeLessThanOrEqual(3);
        expect(maxGap, "gap through settle").toBeLessThanOrEqual(2);
      } finally {
        probe.restore();
        await mounted.cleanup();
        restoreNativeApi();
        if (reducedMotion) {
          await emulateReducedMotion(false);
        }
      }
    },
  );
});

async function emulateReducedMotion(reduce: boolean): Promise<void> {
  const protocol = cdp() as {
    send: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  };
  await protocol.send("Emulation.setEmulatedMedia", {
    features: reduce ? [{ name: "prefers-reduced-motion", value: "reduce" }] : [],
  });
}

interface SettleRowsFrame {
  gap: number;
  answerId: number | null;
  answerTop: number | null;
  foldH: number | null;
  liveRowIds: Array<[string, number]>;
}

function startPaintedFrameSampler<Frame>(sample: () => Frame): { stop: () => Frame[] } {
  const frames: Frame[] = [];
  let running = true;
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;";
  document.body.append(probe);
  const observer = new ResizeObserver(() => {
    if (running) frames.push(sample());
  });
  observer.observe(probe);
  const tick = () => {
    if (!running) return;
    probe.style.width = probe.style.width === "1px" ? "2px" : "1px";
    window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
  return {
    stop: () => {
      running = false;
      observer.disconnect();
      probe.remove();
      return frames;
    },
  };
}

function sampleSettleRows(scroller: HTMLElement, assistantId: string): SettleRowsFrame {
  const scrollerTop = scroller.getBoundingClientRect().top;
  const answer = scroller.querySelector<HTMLElement>(
    `[data-assistant-message-id='${assistantId}']`,
  );
  const fold = scroller.querySelector<HTMLElement>(
    '[data-settled-turn-collapse-transition="true"]',
  );
  const liveRows = Array.from(
    scroller.querySelectorAll<HTMLElement>(
      "[data-timeline-row-kind='working-header'],[data-timeline-row-kind='working']",
    ),
  );
  return {
    gap: Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop),
    answerId: answer ? elementId(answer) : null,
    answerTop: answer ? Math.round(answer.getBoundingClientRect().top - scrollerTop) : null,
    foldH: fold ? Math.round(fold.getBoundingClientRect().height) : null,
    liveRowIds: liveRows.map((row) => [row.dataset.timelineRowKind ?? "?", elementId(row)]),
  };
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

const ANCHOR_HOLD_RESERVE_SLACK_PX = 8;
const SEND_SLIDE_FRAMES = 20;

function logSettle(name: string, value: unknown): void {
  console.log(`SETTLE_METRIC ${JSON.stringify({ name, value })}`);
}

interface ScrollWriteRecord {
  frame: number;
  t: number;
  kind: string;
  onScroller: boolean;
  target: string;
  value: unknown;
  before: number | null;
  after: number | null;
  stack: string[];
  sh: number | null;
  rows: string[];
}

function describeElement(element: Element): string {
  const html = element as HTMLElement;
  const attrs = ["data-chat-scroll-container", "data-timeline-row-kind", "data-message-id"]
    .map((name) => (html.getAttribute?.(name) ? `[${name}=${html.getAttribute(name)}]` : ""))
    .join("");
  return `${element.tagName.toLowerCase()}${attrs}.${(html.className?.toString?.() ?? "").slice(0, 60)}`;
}

function outlineRows(scroller: HTMLElement, count = 5): string[] {
  const scrollerTop = scroller.getBoundingClientRect().top;
  return Array.from(scroller.querySelectorAll<HTMLElement>("[data-timeline-row-kind]"))
    .map((row) => {
      const rect = row.getBoundingClientRect();
      return {
        row,
        top: Math.round(rect.top - scrollerTop + scroller.scrollTop),
        h: Math.round(rect.height),
      };
    })
    .sort((a, b) => a.top - b.top)
    .slice(-count)
    .map(
      ({ row, top, h }) =>
        `${row.dataset.timelineRowKind}${row.dataset.messageId ? `:${row.dataset.messageId.slice(-12)}` : ""}#${elementId(row)}@${top}+${h}`,
    );
}

function installScrollWriteProbe(options: { blockGuardFollow?: boolean } = {}) {
  let scroller: HTMLElement | null = null;
  let stacks = false;
  const state = { frame: 0 };
  const writes: ScrollWriteRecord[] = [];
  const scrollEvents: Array<{ frame: number; t: number; top: number; gap: number }> = [];
  const marks: Array<{ name: string; frame: number; t: number }> = [];
  const mutationLog: Array<{
    frame: number;
    t: number;
    top: number;
    sh: number;
    summary: string[];
    rows: string[];
  }> = [];
  let mutationObserver: MutationObserver | null = null;
  const scrollTopDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
  const originalScrollTo = Element.prototype.scrollTo;
  const originalScrollBy = Element.prototype.scrollBy;
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  const originalFocus = HTMLElement.prototype.focus;
  const originalWindowScrollTo = window.scrollTo;
  const readTop = () => (scroller ? scrollTopDescriptor.get!.call(scroller) : null);
  const record = (target: Element | Window, kind: string, value: unknown, apply: () => void) => {
    const isScroller = target === scroller;
    const relevant =
      isScroller ||
      kind === "scrollIntoView" ||
      kind === "focus" ||
      (scroller !== null && target instanceof Element && target.contains(scroller));
    if (!relevant) {
      apply();
      return;
    }
    if (stacks) checkClamp(`pre-${kind}`);
    const before = readTop();
    const shBefore = scroller ? scroller.scrollHeight : null;
    const rowsBefore = stacks && scroller ? outlineRows(scroller, 4) : [];
    apply();
    lastKnownTop = readTop();
    writes.push({
      frame: state.frame,
      t: Math.round(performance.now()),
      kind,
      onScroller: isScroller,
      target: target instanceof Element ? describeElement(target) : "window",
      value,
      before,
      after: readTop(),
      sh: shBefore,
      rows: rowsBefore,
      stack: stacks
        ? (new Error().stack ?? "")
            .split("\n")
            .slice(3, 11)
            .map((line) =>
              line
                .trim()
                .replace(/https?:\/\/[^/]+/, "")
                .replace(/\?[^:]*/, ""),
            )
        : [],
    });
  };
  const forcedLayoutScrollClampLog: Array<{
    frame: number;
    t: number;
    reader: string;
    from: number;
    to: number;
    sh: number;
    rows: string[];
    stack: string[];
  }> = [];
  let lastKnownTop: number | null = null;
  let checking = false;
  const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollHeight",
  )!;
  const clientHeightDescriptor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "clientHeight",
  )!;
  const offsetHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight",
  )!;
  const offsetTopDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop")!;
  const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  const checkClamp = (reader: string) => {
    if (!stacks || !scroller || checking) return;
    checking = true;
    try {
      const top = scrollTopDescriptor.get!.call(scroller) as number;
      if (lastKnownTop !== null && top !== lastKnownTop) {
        forcedLayoutScrollClampLog.push({
          frame: state.frame,
          t: Math.round(performance.now()),
          reader,
          from: lastKnownTop,
          to: top,
          sh: scrollHeightDescriptor.get!.call(scroller) as number,
          rows: [
            ...outlineRows(scroller, 4),
            `foldShells=${Array.from(
              scroller.querySelectorAll<HTMLElement>(
                "[data-settled-turn-collapse-transition='true']",
              ),
            )
              .map(
                (shell) =>
                  `${shell.style.height || "auto"}/${Math.round(originalGetBoundingClientRect.call(shell).height)}`,
              )
              .join(",")}`,
            `content=${(scroller.firstElementChild as HTMLElement | null)?.style.height ?? "?"}`,
          ],
          stack: (new Error().stack ?? "")
            .split("\n")
            .slice(3, 14)
            .map((line) =>
              line
                .trim()
                .replace(/https?:\/\/[^/]+/, "")
                .replace(/\?[^:]*/, ""),
            ),
        });
      }
      lastKnownTop = top;
    } finally {
      checking = false;
    }
  };
  const wrapGetter = (proto: object, name: string, descriptor: PropertyDescriptor) => {
    Object.defineProperty(proto, name, {
      configurable: true,
      get(this: Element) {
        const value = descriptor.get!.call(this);
        checkClamp(name);
        return value;
      },
    });
  };
  wrapGetter(Element.prototype, "scrollHeight", scrollHeightDescriptor);
  wrapGetter(Element.prototype, "clientHeight", clientHeightDescriptor);
  wrapGetter(HTMLElement.prototype, "offsetHeight", offsetHeightDescriptor);
  wrapGetter(HTMLElement.prototype, "offsetTop", offsetTopDescriptor);
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const value = originalGetBoundingClientRect.call(this);
    checkClamp("getBoundingClientRect");
    return value;
  };
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) {
      const value = scrollTopDescriptor.get!.call(this);
      if (this === scroller) checkClamp("scrollTop(get)");
      return value;
    },
    set(this: Element, value: number) {
      if (
        options.blockGuardFollow &&
        this === scroller &&
        (new Error().stack ?? "").includes("useTimelineRowOverlapGuard")
      ) {
        writes.push({
          frame: state.frame,
          t: Math.round(performance.now()),
          kind: "BLOCKED guard scrollTop=",
          onScroller: true,
          target: "scroller",
          value,
          before: readTop(),
          after: readTop(),
          stack: [],
          sh: null,
          rows: [],
        });
        return;
      }
      record(this, "scrollTop=", value, () => scrollTopDescriptor.set!.call(this, value));
    },
  });
  Element.prototype.scrollTo = function (this: Element, ...args: unknown[]) {
    record(this, "scrollTo", args[0], () =>
      (originalScrollTo as (...a: unknown[]) => void).apply(this, args),
    );
  } as typeof Element.prototype.scrollTo;
  Element.prototype.scrollBy = function (this: Element, ...args: unknown[]) {
    record(this, "scrollBy", args[0], () =>
      (originalScrollBy as (...a: unknown[]) => void).apply(this, args),
    );
  } as typeof Element.prototype.scrollBy;
  Element.prototype.scrollIntoView = function (
    this: Element,
    arg?: boolean | ScrollIntoViewOptions,
  ) {
    record(this, "scrollIntoView", { arg, el: describeElement(this) }, () =>
      originalScrollIntoView.call(this, arg),
    );
  };
  HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
    if (scroller && scroller.contains(this)) {
      record(this, "focus", { options, el: describeElement(this) }, () =>
        originalFocus.call(this, options),
      );
      return;
    }
    originalFocus.call(this, options);
  };
  window.scrollTo = function (...args: unknown[]) {
    record(window, "window.scrollTo", args[0], () =>
      (originalWindowScrollTo as (...a: unknown[]) => void).apply(window, args),
    );
  } as typeof window.scrollTo;
  const onScroll = () => {
    if (!scroller) return;
    const top = readTop() ?? 0;
    scrollEvents.push({
      frame: state.frame,
      t: Math.round(performance.now()),
      top,
      gap: scroller.scrollHeight - scroller.clientHeight - top,
    });
  };
  return {
    state,
    writes,
    scrollEvents,
    marks,
    mutationLog,
    clampLog: forcedLayoutScrollClampLog,
    setScroller(next: HTMLElement) {
      scroller = next;
      mutationObserver = new MutationObserver((records) => {
        if (!stacks || !scroller) return;
        const summary = records.slice(0, 12).map((record) => {
          const target =
            record.target instanceof Element
              ? describeElement(record.target).slice(0, 70)
              : "#text";
          if (record.type === "attributes") return `attr ${record.attributeName} on ${target}`;
          if (record.type === "characterData")
            return `text in ${record.target.parentElement ? describeElement(record.target.parentElement).slice(0, 50) : "?"}`;
          return `child +${record.addedNodes.length}/-${record.removedNodes.length} on ${target}`;
        });
        mutationLog.push({
          frame: state.frame,
          t: Math.round(performance.now()),
          top: readTop() ?? 0,
          sh: scroller.scrollHeight,
          summary: [`n=${records.length}`, ...summary],
          rows: outlineRows(scroller, 4),
        });
      });
      mutationObserver.observe(next, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      next.addEventListener("scroll", onScroll, { passive: true });
    },
    enableStacks(next: boolean) {
      stacks = next;
    },
    mark(name: string) {
      marks.push({ name, frame: state.frame, t: Math.round(performance.now()) });
    },
    markFrame(name: string) {
      return marks.find((entry) => entry.name === name)?.frame ?? 0;
    },
    restore() {
      scroller?.removeEventListener("scroll", onScroll);
      mutationObserver?.disconnect();
      Object.defineProperty(Element.prototype, "scrollHeight", scrollHeightDescriptor);
      Object.defineProperty(Element.prototype, "clientHeight", clientHeightDescriptor);
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeightDescriptor);
      Object.defineProperty(HTMLElement.prototype, "offsetTop", offsetTopDescriptor);
      Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
      Object.defineProperty(Element.prototype, "scrollTop", scrollTopDescriptor);
      Element.prototype.scrollTo = originalScrollTo;
      Element.prototype.scrollBy = originalScrollBy;
      Element.prototype.scrollIntoView = originalScrollIntoView;
      HTMLElement.prototype.focus = originalFocus;
      window.scrollTo = originalWindowScrollTo;
    },
  };
}

interface SettleFrameSample {
  frame: number;
  t: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  gap: number;
  paddingBottom: string;
  rows: string[];
}

const elementIds = new WeakMap<Element, number>();
let nextElementId = 1;
function elementId(element: Element): number {
  let id = elementIds.get(element);
  if (id === undefined) {
    id = nextElementId++;
    elementIds.set(element, id);
  }
  return id;
}

function startFrameSampler(
  probe: ReturnType<typeof installScrollWriteProbe>,
  scroller: HTMLElement,
): { stop: () => SettleFrameSample[] } {
  const samples: SettleFrameSample[] = [];
  const probeElement = document.createElement("div");
  probeElement.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;";
  document.body.append(probeElement);
  const sample = (): SettleFrameSample => {
    const scrollerTop = scroller.getBoundingClientRect().top;
    const rows = Array.from(scroller.querySelectorAll<HTMLElement>("[data-timeline-row-kind]"))
      .map((row) => {
        const rect = row.getBoundingClientRect();
        return {
          row,
          top: Math.round(rect.top - scrollerTop + scroller.scrollTop),
          h: Math.round(rect.height),
        };
      })
      .sort((a, b) => a.top - b.top)
      .slice(-5)
      .map(
        ({ row, top, h }) =>
          `${row.dataset.timelineRowKind}${row.dataset.messageId ? `:${row.dataset.messageId.slice(-12)}` : ""}#${elementId(row)}@${top}+${h}`,
      );
    return {
      frame: probe.state.frame,
      t: performance.now(),
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      gap: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
      paddingBottom: `${scroller.style.paddingBottom}|${getComputedStyle(scroller).paddingBottom}`,
      rows,
    };
  };
  const observer = new ResizeObserver(() => {
    samples.push(sample());
  });
  observer.observe(probeElement);
  let running = true;
  let size = 1;
  const tick = () => {
    if (!running) return;
    probe.state.frame += 1;
    size = size === 1 ? 2 : 1;
    probeElement.style.width = `${size}px`;
    window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
  return {
    stop: () => {
      running = false;
      observer.disconnect();
      probeElement.remove();
      return samples;
    },
  };
}
