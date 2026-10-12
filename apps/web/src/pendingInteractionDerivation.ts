import {
  ApprovalRequestId,
  CommandParsedAction,
  FileChangeDetails,
  type OrchestrationPendingInteraction,
  type OrchestrationThreadActivity,
  type TurnId,
  type UserInputQuestion,
} from "@synara/contracts";
import { Schema } from "effect";
import {
  createStalePendingInteractionMatcher,
  isPendingInteractionResponseClaimable,
} from "@synara/shared/pendingInteractions";
import {
  approvalRequestKindFromRequestType,
  pendingRequestInstanceKey,
} from "@synara/shared/threadSummary";

import { orderedActivities, parseUserInputQuestions } from "./workLog";

export interface PendingApproval {
  requestId: ApprovalRequestId;
  lifecycleGeneration?: string;
  /** Changes only when the durable retryable response attempt changes. */
  responseAttemptKey?: string;
  requestKind: "command" | "file-read" | "file-change" | "permissions" | "tool";
  createdAt: string;
  detail?: string;
  permissionProfile?: Record<string, unknown>;
  sessionApprovalAvailable?: boolean;
  approvalScope?: "computer-task" | "computer-foreground" | "device-task";
  toolName?: string;
  toolParamsDisplay?: ReadonlyArray<PendingToolParamDisplay>;
  toolTitle?: string;
  promptTitle?: string;
  description?: string;
  displayName?: string;
  blockedPath?: string;
  decisionReason?: string;
  reason?: string;
  cwd?: string;
  parsedActions?: ReadonlyArray<CommandParsedAction>;
  fileChanges?: FileChangeDetails;
}

export interface PendingToolParamDisplay {
  name: string;
  value: unknown;
  displayName?: string;
}

export interface PendingUserInput {
  requestId: ApprovalRequestId;
  lifecycleGeneration?: string;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
}

type PendingInteractionKind = OrchestrationPendingInteraction["interactionKind"];

export interface PendingInteractionDerivationOptions {
  // Aggregate flags cannot identify a pending request. When detailed
  // settlements are missing, an explicit false clears everything. Undefined
  // trusts only latest-turn requests; true additionally retains the newest
  // unresolved older request so a background prompt can outlive later turns.
  readonly authoritativeHasPending: boolean | undefined;
  readonly latestTurnId: TurnId | undefined;
  // The active composer supplies a wall-clock reference so durable failures
  // and orphaned response claims become actionable under the same atomic
  // reclaim policy enforced by persistence. Historical/sidebar derivations
  // can omit it to remain time-independent.
  readonly responseClaimReferenceAt?: string;
}

interface PendingInteractionReplay<T extends { requestId: ApprovalRequestId }> {
  interactionKind: PendingInteractionKind;
  requestedActivityKind: string;
  resolvedActivityKind: string;
  parseRequested: (input: {
    activity: OrchestrationThreadActivity;
    payload: Record<string, unknown> | null;
    requestId: ApprovalRequestId;
    lifecycleGeneration: string | undefined;
  }) => T | null;
}

function activityPayload(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return activity.payload && typeof activity.payload === "object"
    ? (activity.payload as Record<string, unknown>)
    : null;
}

function activityLifecycleGeneration(payload: Record<string, unknown> | null): string | undefined {
  const generation = payload?.lifecycleGeneration;
  return typeof generation === "string" && generation.length > 0 ? generation : undefined;
}

function deletePendingInteraction<T extends { requestId: ApprovalRequestId }>(
  openByInstance: Map<string, T>,
  requestId: ApprovalRequestId,
  lifecycleGeneration: string | undefined,
): void {
  if (lifecycleGeneration !== undefined) {
    openByInstance.delete(pendingRequestInstanceKey(requestId, lifecycleGeneration));
    return;
  }
  for (const [key, pending] of openByInstance) {
    if (pending.requestId === requestId) openByInstance.delete(key);
  }
}

function replacePendingInteraction<T extends { requestId: ApprovalRequestId }>(
  openByInstance: Map<string, T>,
  pending: T,
  lifecycleGeneration: string | undefined,
): void {
  deletePendingInteraction(openByInstance, pending.requestId, undefined);
  openByInstance.set(pendingRequestInstanceKey(pending.requestId, lifecycleGeneration), pending);
}

function retainActionableSettlements<T extends { requestId: ApprovalRequestId }>(
  openByInstance: Map<string, T>,
  settlements: ReadonlyArray<OrchestrationPendingInteraction> | undefined,
  interactionKind: PendingInteractionKind,
  responseClaimReferenceAt: string | undefined,
): void {
  if (settlements === undefined) {
    return;
  }
  const actionableKeys = new Set(
    settlements
      .filter(
        (settlement) =>
          settlement.interactionKind === interactionKind &&
          (settlement.status === "pending" ||
            settlement.status === "retryable" ||
            (responseClaimReferenceAt !== undefined &&
              isPendingInteractionResponseClaimable({
                status: settlement.status,
                responseRequestedAt: settlement.responseRequestedAt,
                requestedAt: responseClaimReferenceAt,
              }))),
      )
      .map((settlement) =>
        pendingRequestInstanceKey(
          settlement.requestId,
          settlement.lifecycleGeneration ?? undefined,
        ),
      ),
  );
  for (const key of openByInstance.keys()) {
    if (!actionableKeys.has(key)) {
      openByInstance.delete(key);
    }
  }
}

function replayPendingInteractions<
  T extends { requestId: ApprovalRequestId; createdAt: string; lifecycleGeneration?: string },
>(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  settlements: ReadonlyArray<OrchestrationPendingInteraction> | undefined,
  replay: PendingInteractionReplay<T>,
  options?: PendingInteractionDerivationOptions,
): T[] {
  const openByInstance = new Map<string, T>();
  const isAggregateFallback = settlements === undefined && options !== undefined;
  const fallbackLatestTurnId = isAggregateFallback ? options.latestTurnId : undefined;
  const latestTurnRequestedKeys = new Set<string>();
  const replayActivities =
    !isAggregateFallback || options.authoritativeHasPending !== false ? activities : [];

  for (const activity of orderedActivities(replayActivities)) {
    const payload = activityPayload(activity);
    const requestId =
      typeof payload?.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;
    if (!requestId) {
      continue;
    }

    const lifecycleGeneration = activityLifecycleGeneration(payload);
    if (activity.kind === replay.requestedActivityKind) {
      const isLatestTurnRequest =
        fallbackLatestTurnId !== undefined && activity.turnId === fallbackLatestTurnId;
      // While aggregate state is absent, only a request tied to the latest turn
      // is fresh enough to trust. An explicit true is stronger evidence: replay
      // all request lifecycles, then bound the ambiguous result below.
      if (isAggregateFallback && options.authoritativeHasPending !== true && !isLatestTurnRequest) {
        continue;
      }
      const pending = replay.parseRequested({
        activity,
        payload,
        requestId,
        lifecycleGeneration,
      });
      if (pending) {
        replacePendingInteraction(openByInstance, pending, lifecycleGeneration);
        if (isLatestTurnRequest) {
          latestTurnRequestedKeys.add(
            pendingRequestInstanceKey(pending.requestId, lifecycleGeneration),
          );
        }
      }
      continue;
    }

    if (activity.kind === replay.resolvedActivityKind) {
      deletePendingInteraction(openByInstance, requestId, lifecycleGeneration);
      continue;
    }
  }

  // Explicit stale-callback failures are terminal for their request instance.
  // Apply them after replay: their orchestration sequence may be below an older
  // request's runtime sequence, which must not resurrect an invalid callback.
  if (openByInstance.size > 0) {
    const isStale = createStalePendingInteractionMatcher(replayActivities);
    for (const [key, pending] of openByInstance) {
      if (isStale({ ...pending, interactionKind: replay.interactionKind })) {
        openByInstance.delete(key);
      }
    }
  }
  retainActionableSettlements(
    openByInstance,
    settlements,
    replay.interactionKind,
    options?.responseClaimReferenceAt,
  );
  if (isAggregateFallback && options.authoritativeHasPending === true) {
    const actionableLatestTurnKeys = [...openByInstance.keys()].filter((key) =>
      latestTurnRequestedKeys.has(key),
    );
    if (actionableLatestTurnKeys.length > 0) {
      const retainedKeys = new Set(actionableLatestTurnKeys);
      for (const key of openByInstance.keys()) {
        if (!retainedKeys.has(key)) {
          openByInstance.delete(key);
        }
      }
    } else if (openByInstance.size > 1) {
      // A boolean shell cannot express concurrent older interactions. Keep the
      // newest unresolved lifecycle as the safest actionable fallback; current
      // servers provide detailed settlements and preserve all concurrency.
      const newest = [...openByInstance.entries()]
        .toSorted(([, left], [, right]) =>
          left.createdAt === right.createdAt
            ? left.requestId.localeCompare(right.requestId)
            : left.createdAt.localeCompare(right.createdAt),
        )
        .at(-1);
      openByInstance.clear();
      if (newest) {
        openByInstance.set(newest[0], newest[1]);
      }
    }
  }
  return [...openByInstance.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  settlements?: ReadonlyArray<OrchestrationPendingInteraction>,
  options?: PendingInteractionDerivationOptions,
): PendingApproval[] {
  let fileChangeItemsByTurn: FileChangeItemsByTurn | undefined;
  const approvals = replayPendingInteractions(
    activities,
    settlements,
    {
      interactionKind: "approval",
      requestedActivityKind: "approval.requested",
      resolvedActivityKind: "approval.resolved",
      parseRequested: ({ activity, payload, requestId, lifecycleGeneration }) => {
        const requestKind =
          payload?.requestKind === "command" ||
          payload?.requestKind === "file-read" ||
          payload?.requestKind === "file-change" ||
          payload?.requestKind === "permissions" ||
          payload?.requestKind === "tool"
            ? payload.requestKind
            : approvalRequestKindFromRequestType(payload?.requestType);
        if (!requestKind) {
          return null;
        }
        const detail = typeof payload?.detail === "string" ? payload.detail : undefined;
        const permissionProfile =
          payload?.permissionProfile !== null &&
          typeof payload?.permissionProfile === "object" &&
          !Array.isArray(payload.permissionProfile)
            ? (payload.permissionProfile as Record<string, unknown>)
            : undefined;
        const sessionApprovalAvailable =
          typeof payload?.sessionApprovalAvailable === "boolean"
            ? payload.sessionApprovalAvailable
            : undefined;
        const toolName = typeof payload?.toolName === "string" ? payload.toolName : undefined;
        const toolParamsDisplay = parseToolParamsDisplay(payload?.toolParamsDisplay);
        const presentation = parseApprovalPresentation(payload);
        const fileChanges =
          requestKind === "file-change"
            ? (decodeFileChanges(payload?.fileChanges) ??
              findApprovalFileChanges(
                (fileChangeItemsByTurn ??= indexFileChangeItemsByTurn(activities)),
                activity,
                payload,
              ))
            : undefined;
        return {
          requestId,
          ...(lifecycleGeneration !== undefined ? { lifecycleGeneration } : {}),
          requestKind,
          createdAt: activity.createdAt,
          ...(detail ? { detail } : {}),
          ...(permissionProfile ? { permissionProfile } : {}),
          ...(sessionApprovalAvailable !== undefined ? { sessionApprovalAvailable } : {}),
          ...(payload?.approvalScope === "computer-task" || payload?.approvalScope === "device-task"
            ? { approvalScope: payload.approvalScope as "computer-task" | "device-task" }
            : payload?.approvalScope === "computer-foreground"
              ? { approvalScope: "computer-foreground" as const }
              : {}),
          ...(toolName ? { toolName } : {}),
          ...(toolParamsDisplay ? { toolParamsDisplay } : {}),
          ...presentation,
          ...(fileChanges ? { fileChanges } : {}),
        };
      },
    },
    options,
  );
  if (settlements === undefined) {
    return approvals;
  }

  const retryableAttemptKeys = new Map<string, string>();
  for (const settlement of settlements) {
    if (settlement.interactionKind !== "approval" || settlement.status !== "retryable") {
      continue;
    }
    retryableAttemptKeys.set(
      pendingRequestInstanceKey(settlement.requestId, settlement.lifecycleGeneration ?? undefined),
      JSON.stringify([settlement.responseCommandId, settlement.responseRequestedAt]),
    );
  }

  return approvals.map((approval) => {
    const responseAttemptKey = retryableAttemptKeys.get(
      pendingRequestInstanceKey(approval.requestId, approval.lifecycleGeneration),
    );
    return responseAttemptKey === undefined ? approval : { ...approval, responseAttemptKey };
  });
}

const APPROVAL_TEXT_FIELDS = [
  "promptTitle",
  "description",
  "displayName",
  "blockedPath",
  "decisionReason",
  "reason",
  "cwd",
] as const;

type ApprovalPresentation = Pick<
  PendingApproval,
  (typeof APPROVAL_TEXT_FIELDS)[number] | "parsedActions" | "toolTitle"
>;

const decodeParsedActions = Schema.decodeUnknownOption(Schema.Array(CommandParsedAction));
const decodeFileChangeDetails = Schema.decodeUnknownOption(FileChangeDetails);

function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseApprovalPresentation(payload: Record<string, unknown> | null): ApprovalPresentation {
  const presentation: { -readonly [Key in keyof ApprovalPresentation]: ApprovalPresentation[Key] } =
    {};
  for (const field of APPROVAL_TEXT_FIELDS) {
    const value = nonEmptyText(payload?.[field]);
    if (value !== undefined) presentation[field] = value;
  }
  const toolTitle = nonEmptyText(payload?.title);
  if (toolTitle !== undefined) presentation.toolTitle = toolTitle;
  const parsedActions = decodeParsedActions(payload?.parsedActions);
  if (parsedActions._tag === "Some" && parsedActions.value.length > 0) {
    presentation.parsedActions = parsedActions.value;
  }
  return presentation;
}

function decodeFileChanges(value: unknown): FileChangeDetails | undefined {
  const decoded = decodeFileChangeDetails(value);
  return decoded._tag === "Some" && decoded.value.changes.length > 0 ? decoded.value : undefined;
}

function recordField(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toolActivityItemId(payload: Record<string, unknown> | null): string | undefined {
  const data = recordField(payload?.data);
  return nonEmptyText(
    data?.toolCallId ?? data?.toolUseId ?? data?.callId ?? recordField(data?.item)?.id,
  );
}

const SETTLED_TOOL_STATUSES: ReadonlySet<unknown> = new Set([
  "completed",
  "failed",
  "declined",
  "cancelled",
]);

interface FileChangeItemState {
  fileChanges?: FileChangeDetails;
  settled: boolean;
}

type FileChangeItemsByTurn = Map<string | null, Map<string, FileChangeItemState>>;

function indexFileChangeItemsByTurn(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): FileChangeItemsByTurn {
  const itemsByTurn: FileChangeItemsByTurn = new Map();
  for (const activity of orderedActivities(activities)) {
    if (!activity.kind.startsWith("tool.")) continue;
    const payload = activityPayload(activity);
    if (payload?.itemType !== "file_change") continue;
    const itemId = toolActivityItemId(payload);
    if (itemId === undefined) continue;
    let turnItems = itemsByTurn.get(activity.turnId);
    if (turnItems === undefined) {
      turnItems = new Map();
      itemsByTurn.set(activity.turnId, turnItems);
    }
    const previous = turnItems.get(itemId);
    const fileChanges = decodeFileChanges(payload?.fileChanges) ?? previous?.fileChanges;
    turnItems.set(itemId, {
      ...(fileChanges ? { fileChanges } : {}),
      settled: activity.kind === "tool.completed" || SETTLED_TOOL_STATUSES.has(payload.status),
    });
  }
  return itemsByTurn;
}

function findApprovalFileChanges(
  itemsByTurn: FileChangeItemsByTurn,
  approval: OrchestrationThreadActivity,
  approvalPayload: Record<string, unknown> | null,
): FileChangeDetails | undefined {
  const turnItems = itemsByTurn.get(approval.turnId);
  if (turnItems === undefined) return undefined;
  const approvalItemId = nonEmptyText(approvalPayload?.itemId);
  if (approvalItemId !== undefined) return turnItems.get(approvalItemId)?.fileChanges;
  let inFlight: FileChangeItemState | undefined;
  for (const item of turnItems.values()) {
    if (item.settled) continue;
    if (inFlight !== undefined) return undefined;
    inFlight = item;
  }
  return inFlight?.fileChanges;
}

function parseToolParamsDisplay(
  value: unknown,
): ReadonlyArray<PendingToolParamDisplay> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value.flatMap<PendingToolParamDisplay>((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || !Object.hasOwn(record, "value")) {
      return [];
    }
    const displayName =
      typeof record.displayName === "string"
        ? record.displayName
        : typeof record.display_name === "string"
          ? record.display_name
          : undefined;
    return [
      {
        name: record.name,
        value: record.value,
        ...(displayName ? { displayName } : {}),
      },
    ];
  });
  return entries.length > 0 ? entries : undefined;
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  settlements?: ReadonlyArray<OrchestrationPendingInteraction>,
  options?: PendingInteractionDerivationOptions,
): PendingUserInput[] {
  return replayPendingInteractions(
    activities,
    settlements,
    {
      interactionKind: "userInput",
      requestedActivityKind: "user-input.requested",
      resolvedActivityKind: "user-input.resolved",
      parseRequested: ({ activity, payload, requestId, lifecycleGeneration }) => {
        const questions = parseUserInputQuestions(payload);
        if (!questions) {
          return null;
        }
        return {
          requestId,
          ...(lifecycleGeneration !== undefined ? { lifecycleGeneration } : {}),
          createdAt: activity.createdAt,
          questions: withOptionPreviews(questions, payload),
        };
      },
    },
    options,
  );
}

function optionPreviewsByQuestion(
  payload: Record<string, unknown> | null,
): Map<string, Map<string, string>> {
  const previews = new Map<string, Map<string, string>>();
  const rawQuestions = Array.isArray(payload?.questions) ? payload.questions : [];
  for (const rawQuestion of rawQuestions) {
    const question = recordField(rawQuestion);
    const questionId = typeof question?.id === "string" ? question.id : undefined;
    if (questionId === undefined || !Array.isArray(question?.options)) continue;
    for (const rawOption of question.options) {
      const option = recordField(rawOption);
      if (typeof option?.label !== "string" || typeof option.preview !== "string") continue;
      if (option.preview.trim().length === 0) continue;
      const byLabel = previews.get(questionId) ?? new Map<string, string>();
      byLabel.set(option.label, option.preview);
      previews.set(questionId, byLabel);
    }
  }
  return previews;
}

function withOptionPreviews(
  questions: ReadonlyArray<UserInputQuestion>,
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> {
  const previews = optionPreviewsByQuestion(payload);
  if (previews.size === 0) return questions;
  return questions.map((question) => {
    const byLabel = previews.get(question.id);
    if (byLabel === undefined) return question;
    return {
      ...question,
      options: question.options.map((option) => {
        const preview = option.preview ?? byLabel.get(option.label);
        return preview === undefined ? option : { ...option, preview };
      }),
    };
  });
}
