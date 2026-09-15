import type {
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  UserInputQuestion,
} from "@synara/contracts";
import type { JsonValue } from "@synara/plugin-sdk";
import type {
  PluginPendingInteractionRegistration,
  SynaraPluginAppContext,
} from "@synara/plugin-sdk/app";
import { useMemo, type ReactNode } from "react";

import { availableApprovalActions } from "../components/chat/ComposerPendingApprovalPanel";
import { Button } from "../components/ui/button";
import {
  buildPendingUserInputAnswers,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import type { PendingApproval } from "../session-logic";
import type { ActivePluginContribution } from "./frontendRuntime";
import { PluginContributionErrorBoundary, usePluginContributions } from "./runtime";

export type PluginPendingInteractionKind = PluginPendingInteractionRegistration["kind"];
export type ActivePluginPendingInteraction = ActivePluginContribution<"pendingInteractions">;

export function parsePluginApprovalDecision(
  value: JsonValue,
  approval: Pick<PendingApproval, "sessionApprovalAvailable">,
): ProviderApprovalDecision {
  const decisions = availableApprovalActions(approval).map((action) => action.decision);
  const decision = decisions.find((candidate) => candidate === value);
  if (decision === undefined) {
    throw new Error(`Plugin approval responses must be one of: ${decisions.join(", ")}.`);
  }
  return decision;
}

export function parsePluginUserInputAnswers(
  value: JsonValue,
  questions: ReadonlyArray<UserInputQuestion>,
): ProviderUserInputAnswers {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Plugin question responses must be an answer object.");
  }
  const drafts: Record<string, PendingUserInputDraftAnswer> = {};
  for (const [questionId, answer] of Object.entries(value)) {
    const question = questions.find((candidate) => candidate.id === questionId);
    if (!question) {
      throw new Error(`Plugin answer ${questionId} does not match a pending question.`);
    }
    if (typeof answer === "string") {
      drafts[questionId] = { customAnswer: answer };
      continue;
    }
    if (!question.multiSelect || !Array.isArray(answer)) {
      throw new Error(
        question.multiSelect
          ? `Plugin answer ${questionId} must be text or a list of option labels.`
          : `Plugin answer ${questionId} must be text or one option label.`,
      );
    }
    const optionLabels = new Set(question.options.map((option) => option.label));
    const selectedOptionLabels = answer.filter(
      (entry): entry is string => typeof entry === "string" && optionLabels.has(entry),
    );
    if (selectedOptionLabels.length !== answer.length) {
      throw new Error(`Plugin answer ${questionId} must only select listed options.`);
    }
    drafts[questionId] = { selectedOptionLabels };
  }
  const answers = buildPendingUserInputAnswers(questions, drafts);
  if (!answers) {
    throw new Error("Plugin question responses must answer every pending question.");
  }
  return answers;
}

function toJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Plugin interaction must be JSON serializable.");
  return JSON.parse(serialized) as JsonValue;
}

export function resolvePluginPendingInteraction(
  contributions: ReadonlyArray<ActivePluginPendingInteraction>,
  kind: PluginPendingInteractionKind,
): ActivePluginPendingInteraction | null {
  const matches = contributions.filter((candidate) => candidate.kind === kind);
  if (matches.length > 1) {
    console.warn(
      `Plugins ${matches.map((match) => `${match.plugin.id}/${match.id}`).join(", ")} all registered a ${kind} pending interaction card. Synara uses the built-in card.`,
    );
    return null;
  }
  return matches[0] ?? null;
}

export function usePluginPendingInteraction(
  kind: PluginPendingInteractionKind,
): ActivePluginPendingInteraction | null {
  const contributions = usePluginContributions("pendingInteractions");
  return useMemo(() => resolvePluginPendingInteraction(contributions, kind), [contributions, kind]);
}

export function pluginOwnsPendingInteraction(input: {
  readonly registration: ActivePluginPendingInteraction | null;
  readonly requestKey: string | null;
  readonly defaultCardRequestKey: string | null;
}): boolean {
  return (
    input.registration !== null &&
    input.requestKey !== null &&
    input.requestKey !== input.defaultCardRequestKey
  );
}

interface PluginPendingInteractionMountProps {
  readonly registration: ActivePluginPendingInteraction;
  readonly context: SynaraPluginAppContext;
  readonly interaction: unknown;
  readonly submit: (value: JsonValue) => Promise<void>;
  readonly cancel: () => Promise<void>;
}

function PluginPendingInteractionMount(props: PluginPendingInteractionMountProps) {
  const Interaction = props.registration.component;
  return (
    <Interaction
      context={props.context}
      plugin={props.registration.plugin}
      interaction={toJsonValue(props.interaction)}
      submit={props.submit}
      cancel={props.cancel}
    />
  );
}

export interface PluginPendingInteractionViewProps {
  readonly requestKey: string;
  readonly defaultCardRequestKey: string | null;
  readonly registration: ActivePluginPendingInteraction | null;
  readonly context: SynaraPluginAppContext;
  readonly interaction: unknown;
  readonly submit: (value: JsonValue) => Promise<void>;
  readonly cancel: () => Promise<void>;
  readonly fallback: ReactNode;
  readonly onUseDefaultCard: (requestKey: string) => void;
}

export function PluginPendingInteractionView(props: PluginPendingInteractionViewProps) {
  const { registration, requestKey, onUseDefaultCard, submit, cancel } = props;
  if (!registration || !pluginOwnsPendingInteraction(props)) return props.fallback;
  const useDefaultCard = () => onUseDefaultCard(requestKey);
  return (
    <div key={requestKey} className="flex flex-col gap-1">
      <PluginContributionErrorBoundary
        plugin={registration.plugin}
        contributionId={registration.id}
        fallback={props.fallback}
        onError={useDefaultCard}
      >
        <PluginPendingInteractionMount
          registration={registration}
          context={props.context}
          interaction={props.interaction}
          submit={async (value) => {
            await submit(value);
          }}
          cancel={async () => {
            await cancel();
          }}
        />
      </PluginContributionErrorBoundary>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="self-end text-muted-foreground"
        onClick={useDefaultCard}
      >
        Use default card
      </Button>
    </div>
  );
}
