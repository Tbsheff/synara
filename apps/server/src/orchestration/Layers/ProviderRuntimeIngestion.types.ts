import type {
  OrchestrationEvent,
  OrchestrationThreadActivity,
  ProviderRuntimeEvent,
} from "@synara/contracts";

// FILE: ProviderRuntimeIngestion.types.ts
// Purpose: Shared types for provider runtime ingestion projection.
// Layer: Server orchestration ingestion
// Exports: TurnStartRequestedDomainEvent, RuntimeIngestionInput, ActivityPayload, SubagentIdentity

export type TurnStartRequestedDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;

export type RuntimeIngestionDomainEvent = Extract<
  OrchestrationEvent,
  {
    type: "thread.turn-start-requested" | "thread.reverted" | "thread.conversation-rolled-back";
  }
>;

export type RuntimeIngestionInput =
  | {
      source: "runtime";
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: RuntimeIngestionDomainEvent;
    };

export type ActivityPayload = OrchestrationThreadActivity["payload"];

export interface SubagentIdentity {
  readonly providerThreadId: string;
  readonly agentId?: string;
  readonly nickname?: string;
  readonly role?: string;
  readonly model?: string;
  readonly modelIsRequestedHint?: boolean;
}
