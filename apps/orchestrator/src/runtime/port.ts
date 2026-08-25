import type {
  CandidateV1,
  ClaimEvidenceLinkV1,
  ClaimV1,
  DecisionRevisionV1,
  EvidenceV1,
  EffectReceiptV1,
  RequirementRevisionV1,
  RuntimeRecoveryPermissionV1,
  RuntimePausedOutcomeV1,
  RuntimeSnapshotV1,
  RunEventV1
} from "@choicemind/contracts/decision/v1";

export type AgentRuntimeRunCommandV1 = Readonly<{
  contractVersion: "1.0";
  decisionTaskId: string;
  agentRunId: string;
  requirementRevision: RequirementRevisionV1;
}>;

export type AgentRuntimeRunOutputV1 = Readonly<{
  candidates: readonly CandidateV1[];
  claims: readonly ClaimV1[];
  evidence: readonly EvidenceV1[];
  claimEvidenceLinks: readonly ClaimEvidenceLinkV1[];
  decision: DecisionRevisionV1;
  runEvents: readonly RunEventV1[];
}>;

export type AgentRuntimeNonSuccessfulOutcomeV1 = Readonly<{
  state: "FAILED_RETRYABLE" | "FAILED_FINAL" | "PARTIAL";
  summary: string;
}>;

export type AgentRuntimePersistentRunResultV1 =
  | AgentRuntimeRunOutputV1
  | AgentRuntimeNonSuccessfulOutcomeV1
  | AgentRuntimePausedOutcomeV1;

export type AgentRuntimePausedOutcomeV1 = RuntimePausedOutcomeV1;

export type AgentRuntimeResumeCommandV1 = Readonly<{
  contractVersion: "1.0";
  decisionTaskId: string;
  agentRunId: string;
  requirementRevision?: RequirementRevisionV1;
  snapshot: RuntimeSnapshotV1;
  effectReceipts: readonly EffectReceiptV1[];
}>;

export type AgentRuntimeCancelCommandV1 = Readonly<{
  contractVersion: "1.0";
  decisionTaskId: string;
  agentRunId: string;
  cancellationId: string;
}>;

export type AgentRuntimeControlResultV1 =
  | Readonly<{
      ok: true;
      changed: boolean;
      state:
        | "RUNNING"
        | "PAUSED_USER"
        | "PAUSED_PERMISSION"
        | "PAUSED_SOURCE_LOGIN"
        | "PAUSED_LIMIT"
        | "COMPLETED"
        | "CANCELLED";
      runEvents: readonly RunEventV1[];
      outcome?: AgentRuntimePersistentRunResultV1;
    }>
  | Readonly<{
      ok: false;
      code:
        | "RUNTIME_SNAPSHOT_INVALID"
        | "RUNTIME_PROTOCOL_UNSUPPORTED"
        | "RUNTIME_RESUME_DENIED"
        | "RUNTIME_RESUME_IN_PROGRESS"
        | "RUNTIME_FAILED"
        | "RUNTIME_CANCEL_RACE";
      message: string;
      recoveryPermission?: RuntimeRecoveryPermissionV1;
    }>;

export type AgentRuntimeSecurityContext = Readonly<{
  userId: string;
  operationId: string;
  correlationId: string;
  egressConfirmation: Readonly<{ operationId: string; userId: string }>;
}>;

export interface AgentRuntimeRunPort {
  run(
    command: AgentRuntimeRunCommandV1,
    securityContext?: AgentRuntimeSecurityContext
  ): Promise<AgentRuntimeRunOutputV1>;
  runPersistent?(
    command: AgentRuntimeRunCommandV1,
    securityContext?: AgentRuntimeSecurityContext
  ): Promise<AgentRuntimePersistentRunResultV1>;
  resume?(
    command: AgentRuntimeResumeCommandV1,
    securityContext?: AgentRuntimeSecurityContext
  ): Promise<AgentRuntimeControlResultV1>;
}

export interface AgentRuntimePort extends AgentRuntimeRunPort {
  resume(
    command: AgentRuntimeResumeCommandV1,
    securityContext?: AgentRuntimeSecurityContext
  ): Promise<AgentRuntimeControlResultV1>;
  cancel(command: AgentRuntimeCancelCommandV1): Promise<AgentRuntimeControlResultV1>;
  subscribe(
    agentRunId: string,
    listener: (event: RunEventV1) => void
  ): () => void;
}
