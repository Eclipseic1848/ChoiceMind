import type {
  CandidateV1,
  ClaimEvidenceLinkV1,
  ClaimV1,
  DecisionRevisionV1,
  EvidenceV1,
  RequirementRevisionV1,
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

export interface AgentRuntimeRunPort {
  run(command: AgentRuntimeRunCommandV1): Promise<AgentRuntimeRunOutputV1>;
}
