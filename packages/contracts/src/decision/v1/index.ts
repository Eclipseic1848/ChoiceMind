import {
  checkpointRefSchema,
  decisionTaskResultSchema,
  decisionTaskSnapshotSchema,
  effectReceiptSchema,
  executeDecisionTaskCommandSchema,
  persistedRunEventSchema,
  runtimePausedOutcomeSchema,
  runtimeResumeRequestSchema,
  runtimeCancelRequestSchema,
  runtimeControlStatusSchema,
  runtimeRecoveryPermissionSchema,
  runtimeSnapshotSchema,
  successfulDecisionTaskResultDraftSchema
} from "./schemas.js";
import { evaluateDecisionBasisV1 } from "./decision-basis.js";
import { checkDecisionTaskResultInvariants } from "./invariants.js";

export {
  createContractRejectedDecisionTaskResultV1,
  createDecisionTaskNotFoundResultV1,
  createIdempotencyConflictResultV1,
  createPersistenceUnavailableResultV1,
  createUnknownDecisionExecutionResultV1
} from "./errors.js";
export { isPersistedRunEventCursorV1 } from "./cursor.js";
export { canonicalizeJsonV1 } from "./canonical-json.js";

export type QuantityV1 = Readonly<{
  amount: number;
  unit: string;
}>;

export type RequirementConstraintV1 = Readonly<{
  key: string;
  operator: "AT_LEAST" | "AT_MOST" | "EQUALS";
  value: QuantityV1;
}>;

export type RequirementRevisionV1 = Readonly<{
  contractType: "requirement-revision";
  contractVersion: "1.0";
  requirementRevisionId: string;
  decisionTaskId: string;
  revision: number;
  submittedText: string;
  market: Readonly<{
    country: "CN";
    currency: "CNY";
    locale: "zh-CN";
  }>;
  intendedUses: readonly string[];
  budget?:
    | Readonly<{
        confirmed: boolean;
        currency: "CNY";
        hard: boolean;
        maxAmountMinor: number;
      }>
    | undefined;
  mustHaves: readonly RequirementConstraintV1[];
  niceToHaves: readonly string[];
  mustNotHaves: readonly string[];
  unknowns: readonly string[];
}>;

export type ExecuteDecisionTaskCommandV1 = Readonly<{
  contractType: "execute-decision-task-command";
  contractVersion: "1.0";
  executionRequestId: string;
  requirementRevision: RequirementRevisionV1;
}>;

export type AcceptedDecisionTaskSnapshotV1 = Readonly<{
  contractType: "decision-task-snapshot";
  contractVersion: "1.0";
  executionRequestId: string;
  decisionTaskId: string;
  agentRunId: string;
  state: "ACCEPTED";
  terminal: false;
  updatedAt: string;
}>;

export type RunningDecisionTaskSnapshotV1 = Readonly<{
  contractType: "decision-task-snapshot";
  contractVersion: "1.0";
  executionRequestId: string;
  decisionTaskId: string;
  agentRunId: string;
  state: "RUNNING";
  terminal: false;
  updatedAt: string;
}>;

export type RetryableFailedDecisionTaskSnapshotV1 = Readonly<{
  contractType: "decision-task-snapshot";
  contractVersion: "1.0";
  executionRequestId: string;
  decisionTaskId: string;
  agentRunId: string;
  state: "FAILED_RETRYABLE";
  terminal: false;
  updatedAt: string;
}>;

export type FinalFailedDecisionTaskSnapshotV1 = Readonly<{
  contractType: "decision-task-snapshot";
  contractVersion: "1.0";
  executionRequestId: string;
  decisionTaskId: string;
  agentRunId: string;
  state: "FAILED_FINAL";
  terminal: true;
  updatedAt: string;
}>;

export type PartialDecisionTaskSnapshotV1 = Readonly<{
  contractType: "decision-task-snapshot";
  contractVersion: "1.0";
  executionRequestId: string;
  decisionTaskId: string;
  agentRunId: string;
  state: "PARTIAL";
  terminal: false;
  updatedAt: string;
}>;

export type CancelledDecisionTaskSnapshotV1 = Readonly<{
  contractType: "decision-task-snapshot";
  contractVersion: "1.0";
  executionRequestId: string;
  decisionTaskId: string;
  agentRunId: string;
  state: "CANCELLED";
  terminal: true;
  updatedAt: string;
}>;

export type PausedDecisionTaskStateV1 =
  | "PAUSED_USER"
  | "PAUSED_PERMISSION"
  | "PAUSED_SOURCE_LOGIN"
  | "PAUSED_LIMIT";

export type PausedDecisionTaskSnapshotV1<
  State extends PausedDecisionTaskStateV1 = PausedDecisionTaskStateV1
> = State extends PausedDecisionTaskStateV1
  ? Readonly<{
      contractType: "decision-task-snapshot";
      contractVersion: "1.0";
      executionRequestId: string;
      decisionTaskId: string;
      agentRunId: string;
      state: State;
      terminal: false;
      runtimeSnapshotId: string;
      updatedAt: string;
    }>
  : never;

export type DecisionTaskSnapshotV1 =
  | AcceptedDecisionTaskSnapshotV1
  | RunningDecisionTaskSnapshotV1
  | RetryableFailedDecisionTaskSnapshotV1
  | FinalFailedDecisionTaskSnapshotV1
  | PartialDecisionTaskSnapshotV1
  | CancelledDecisionTaskSnapshotV1
  | PausedDecisionTaskSnapshotV1;

export type CandidateV1 = Readonly<{
  contractType: "candidate";
  contractVersion: "1.0";
  candidateId: string;
  decisionTaskId: string;
  displayName: string;
  synthetic: true;
  identity: Readonly<{
    model: string;
    sku: string;
    market: "CN";
    configuration: string;
  }>;
  observedPrice: Readonly<{
    amountMinor: number;
    currency: "CNY";
    observedAt: string;
  }>;
}>;

export type ClaimValueV1 =
  | Readonly<{ kind: "MONEY"; amountMinor: number; currency: "CNY" }>
  | Readonly<{ kind: "QUANTITY"; amount: number; unit: string }>
  | Readonly<{ kind: "BOOLEAN"; value: boolean }>
  | Readonly<{ kind: "TEXT"; value: string }>;

export type ClaimKindV1 =
  | "FACT_ASSERTION"
  | "SOURCE_OPINION"
  | "SYSTEM_INFERENCE";

export type EvidenceStateV1 =
  | "SUPPORTED"
  | "REFUTED"
  | "CONFLICTED"
  | "INSUFFICIENT";

export type ClaimV1 = Readonly<{
  contractType: "claim";
  contractVersion: "1.0";
  claimId: string;
  decisionTaskId: string;
  subject: Readonly<{ subjectType: "CANDIDATE"; subjectId: string }>;
  predicate: string;
  value: ClaimValueV1;
  claimKind: ClaimKindV1;
}>;

type EvidenceHeaderV1 = Readonly<{
  contractType: "evidence";
  contractVersion: "1.0";
  evidenceId: string;
  decisionTaskId: string;
  capturedAt: string;
  locator: Readonly<{ section: string; field: string }>;
  excerpt: string;
  validUntil: string;
}>;

export type SyntheticEvidenceV1 = EvidenceHeaderV1 &
  Readonly<{
  synthetic: true;
  source: Readonly<{
    sourceKind: "SYNTHETIC";
    sourceId: string;
    title: string;
  }>;
}>;

export type PublicWebEvidenceV1 = EvidenceHeaderV1 &
  Readonly<{
    synthetic: false;
    source: Readonly<{
      sourceKind: "PUBLIC_WEB";
      sourceId: string;
      title: string;
      url: string;
    }>;
    excerptHash: Readonly<{ algorithm: "sha256"; digest: string }>;
    parserVersion: string;
    rawArtifact: Readonly<{
      algorithm: "sha256";
      digest: string;
      objectKey: string;
    }>;
  }>;

export type EvidenceV1 = SyntheticEvidenceV1 | PublicWebEvidenceV1;

export type ClaimEvidenceLinkV1 = Readonly<{
  contractType: "claim-evidence-link";
  contractVersion: "1.0";
  linkId: string;
  decisionTaskId: string;
  claimId: string;
  evidenceId: string;
  direction: "SUPPORTS" | "REFUTES";
}>;

export type ClaimAssessmentV1 = Readonly<{
  contractType: "claim-assessment";
  contractVersion: "1.0";
  claimId: string;
  evidenceState: EvidenceStateV1;
  supportingEvidenceIds: readonly string[];
  refutingEvidenceIds: readonly string[];
}>;

export type DecisionConditionV1 =
  | Readonly<{
      conditionId: string;
      conditionType: "MAX_PRICE";
      candidateId: string;
      amountMinor: number;
      currency: "CNY";
      verification: string;
    }>
  | Readonly<{
      conditionId: string;
      conditionType: "OFFICIAL_WARRANTY";
      candidateId: string;
      verification: string;
    }>;

export type CandidateDispositionV1 = Readonly<{
  dispositionId: string;
  dispositionType: "ELIMINATED";
  candidateId: string;
  requirementKey: string;
  reason: string;
  evidenceIds: readonly string[];
}>;

export type DecisionRiskV1 = Readonly<{
  riskId: string;
  candidateId: string;
  statementClaimId: string;
  verification: string;
}>;

export type CriticalGapResolutionV1 =
  | Readonly<{
      resolutionType: "VERIFY_CONDITION";
      conditionId: string;
    }>
  | Readonly<{
      resolutionType: "PROVIDE_REQUIREMENT";
      requirementKey: string;
    }>;

export type CriticalGapV1 = Readonly<{
  gapId: string;
  key: string;
  question: string;
  resolution: CriticalGapResolutionV1;
}>;

export type DecisionNextStepV1 =
  | Readonly<{
      actionType: "PROVIDE_REQUIREMENT";
      requirementKey: string;
      instruction: string;
    }>
  | Readonly<{
      actionType: "VERIFY_CONDITION";
      conditionId: string;
      instruction: string;
    }>
  | Readonly<{
      actionType: "VERIFY_RISK";
      riskId: string;
      instruction: string;
    }>;

export type DecisionRevisionV1 = Readonly<{
  contractType: "decision-revision";
  contractVersion: "1.0";
  decisionRevisionId: string;
  decisionTaskId: string;
  requirementRevisionId: string;
  revision: number;
  status:
    | "BUY_NOW"
    | "BUY_IF_PRICE"
    | "WAIT"
    | "KEEP_CURRENT"
    | "NEED_MORE_INFO"
    | "NO_MATCH"
    | "REFUSE_RISK";
  summary: string;
  selectedCandidateId?: string | undefined;
  conditions: readonly DecisionConditionV1[];
  candidateDispositions: readonly CandidateDispositionV1[];
  risks: readonly DecisionRiskV1[];
  evidenceIds: readonly string[];
  criticalGaps: readonly CriticalGapV1[];
  assumptions: readonly string[];
  validFrom: string;
  validUntil: string;
  nextSteps: readonly DecisionNextStepV1[];
  synthetic: true;
}>;

export type DecisionTaskStateV1 =
  | "CREATED"
  | "UNDERSTANDING"
  | "PLANNING"
  | "RESEARCHING"
  | "VERIFYING"
  | "GAP_RESEARCH"
  | "COMPARING"
  | "CRITIQUING"
  | "GENERATING"
  | "PAUSED_USER"
  | "PAUSED_PERMISSION"
  | "PAUSED_SOURCE_LOGIN"
  | "PAUSED_LIMIT"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type RunEventV1 = Readonly<{
  contractType: "run-event";
  contractVersion: "1.0";
  eventId: string;
  decisionTaskId: string;
  agentRunId: string;
  sequence: number;
  occurredAt: string;
  eventType: "TASK_STATE_CHANGED" | "RUNTIME_SUCCEEDED" | "RUNTIME_FAILED";
  taskState: DecisionTaskStateV1;
  summary: string;
  synthetic: true;
}>;

export type PersistedRunEventV1 = Readonly<{
  contractType: "persisted-run-event";
  contractVersion: "1.0";
  cursor: string;
  event: RunEventV1;
}>;

export type CheckpointRefV1 = Readonly<{
  contractType: "checkpoint-ref";
  contractVersion: "1.0";
  checkpointId: string;
  decisionTaskId: string;
  agentRunId: string;
  sequence: number;
  persistedAt: string;
}>;

export type RawRuntimeSnapshotRefV1 = Readonly<{
  algorithm: "sha256";
  digest: string;
  objectKey: string;
}>;

export type RuntimeSnapshotV1 = Readonly<{
  contractType: "runtime-snapshot";
  contractVersion: "1.0";
  snapshotId: string;
  decisionTaskId: string;
  agentRunId: string;
  taskState: DecisionTaskStateV1;
  resumable: boolean;
  runtimeProtocol: Readonly<{
    name: "agent-runtime-protocol";
    version: "1";
  }>;
  rawSnapshot: RawRuntimeSnapshotRefV1;
  checkpoint: CheckpointRefV1;
  capturedAt: string;
}>;

export type EffectReceiptStateV1 = "not_started" | "started" | "committed" | "unknown";

export type EffectResultRefV1 = Readonly<{
  algorithm: "sha256";
  digest: string;
  objectKey: string;
  decisionTaskId: string;
  agentRunId: string;
  checkpointId: string;
  effectId: string;
}>;

type EffectReceiptBaseV1 = Readonly<{
  contractType: "effect-receipt";
  contractVersion: "1.0";
  effectReceiptId: string;
  decisionTaskId: string;
  agentRunId: string;
  checkpointId: string;
  effectId: string;
  recordedAt: string;
}>;

export type EffectReceiptV1 =
  | (EffectReceiptBaseV1 &
      Readonly<{
        state: Exclude<EffectReceiptStateV1, "committed">;
      }>)
  | (EffectReceiptBaseV1 &
      Readonly<{
        state: "committed";
        result: EffectResultRefV1;
      }>);

export type RuntimeRecoveryPermissionV1 = Readonly<{
  contractType: "runtime-recovery-permission";
  contractVersion: "1.0";
  decisionTaskId: string;
  agentRunId: string;
  snapshotId: string;
  decision: "RESUME_ALLOWED" | "RESUME_DENIED" | "MANUAL_VERIFICATION_REQUIRED";
  reason:
    | "SAFE_TO_RESUME"
    | "TASK_NOT_PAUSED"
    | "SNAPSHOT_NOT_RESUMABLE"
    | "EFFECT_STATUS_UNSAFE"
    | "EFFECT_RESULT_UNAVAILABLE"
    | "EFFECT_RESULT_INVALID"
    | "RECOVERY_FACTS_INVALID";
}>;

export type RuntimePausedOutcomeV1 = Readonly<{
  contractType: "runtime-paused-outcome";
  contractVersion: "1.0";
  state: PausedDecisionTaskSnapshotV1["state"];
  summary: string;
  snapshot: RuntimeSnapshotV1;
  effectReceipts: readonly EffectReceiptV1[];
  runEvents: readonly RunEventV1[];
}>;

export type RuntimeResumeRequestV1 = Readonly<{
  contractType: "runtime-resume-request";
  contractVersion: "1.0";
  controlRequestId: string;
  runtimeSnapshotId: string;
}>;

export type RuntimeCancelRequestV1 = Readonly<{
  contractType: "runtime-cancel-request";
  contractVersion: "1.0";
  controlRequestId: string;
  cancellationId: string;
}>;

export type RuntimeControlErrorV1 = Readonly<{
  code:
    | "RUNTIME_SNAPSHOT_INVALID"
    | "RUNTIME_PROTOCOL_UNSUPPORTED"
    | "RUNTIME_RESUME_DENIED"
    | "RUNTIME_RESUME_IN_PROGRESS"
    | "RUNTIME_FAILED"
    | "RUNTIME_CANCEL_RACE"
    | "PERSISTENCE_UNAVAILABLE"
    | "RUNTIME_RESULT_UNAVAILABLE";
  message: string;
}>;

export type RuntimeControlStatusV1 = Readonly<{
  contractType: "runtime-control-status";
  contractVersion: "1.0";
  controlRequestId: string;
  decisionTaskId: string;
  agentRunId: string;
  action: "RESUME" | "CANCEL";
  state: "ACCEPTED" | "RUNNING" | "COMPLETED" | "FAILED";
  error?: RuntimeControlErrorV1 | undefined;
  updatedAt: string;
}>;

export type CompletedDecisionTaskStatusV1 = Readonly<{
  contractType: "decision-task-status";
  contractVersion: "1.0";
  decisionTaskId: string;
  agentRunId: string;
  state: "COMPLETED";
  terminal: true;
  latestEventSequence: number;
  decisionRevisionId: string;
  updatedAt: string;
}>;

export type FailedDecisionTaskStatusV1 = Readonly<{
  contractType: "decision-task-status";
  contractVersion: "1.0";
  decisionTaskId: string;
  agentRunId: string;
  state: "FAILED";
  terminal: true;
  latestEventSequence: number;
  errorId: string;
  updatedAt: string;
}>;

export type RetryModeV1 = "NONE" | "SAME_EXECUTION_ONLY" | "NEW_EXECUTION_ALLOWED";

export type ChoiceMindErrorV1 = Readonly<{
  contractType: "choice-mind-error";
  contractVersion: "1.0";
  errorId: string;
  code:
    | "CONTRACT_INVALID"
    | "CONTRACT_VERSION_UNSUPPORTED"
    | "AGENT_RUNTIME_FAILED"
    | "DECISION_EXECUTION_STATUS_UNKNOWN"
    | "DECISION_TASK_NOT_FOUND"
    | "IDEMPOTENCY_CONFLICT"
    | "PERSISTENCE_UNAVAILABLE";
  category:
    | "VALIDATION"
    | "VERSION"
    | "RUNTIME"
    | "TRANSPORT"
    | "RESOURCE"
    | "STORAGE";
  message: string;
  retryMode: RetryModeV1;
  issues: readonly ContractIssueV1[];
  occurredAt: string;
}>;

export type DecisionBundleV1 = Readonly<{
  requirementRevision: RequirementRevisionV1;
  candidates: readonly CandidateV1[];
  claims: readonly ClaimV1[];
  evidence: readonly EvidenceV1[];
  claimEvidenceLinks: readonly ClaimEvidenceLinkV1[];
  claimAssessments: readonly ClaimAssessmentV1[];
  decision: DecisionRevisionV1;
}>;

type DecisionBundleDraftV1 = Omit<DecisionBundleV1, "claimAssessments">;

export type SuccessfulDecisionTaskResultV1 = Readonly<{
  contractType: "decision-task-result";
  contractVersion: "1.0";
  ok: true;
  taskStatus: CompletedDecisionTaskStatusV1;
  runEvents: readonly RunEventV1[];
  bundle: DecisionBundleV1;
}>;

type SuccessfulDecisionTaskResultDraftV1 = Readonly<{
  contractType: "decision-task-result";
  contractVersion: "1.0";
  ok: true;
  taskStatus: CompletedDecisionTaskStatusV1;
  runEvents: readonly RunEventV1[];
  bundle: DecisionBundleDraftV1;
}>;

export type FailedDecisionTaskResultV1 = Readonly<{
  contractType: "decision-task-result";
  contractVersion: "1.0";
  ok: false;
  taskStatus: FailedDecisionTaskStatusV1;
  runEvents: readonly RunEventV1[];
  error: ChoiceMindErrorV1;
}>;

export type RejectedDecisionTaskResultV1 = Readonly<{
  contractType: "decision-task-result";
  contractVersion: "1.0";
  ok: false;
  error: ChoiceMindErrorV1;
}>;

export type DecisionTaskResultV1 =
  | SuccessfulDecisionTaskResultV1
  | FailedDecisionTaskResultV1
  | RejectedDecisionTaskResultV1;

export type DecisionTaskResultHttpStatusV1 = 200 | 400 | 422 | 502 | 503;

export type ContractIssueV1 = Readonly<{
  path: string;
  message: string;
}>;

export type ContractDecodeResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{
      ok: false;
      code: "CONTRACT_INVALID" | "CONTRACT_VERSION_UNSUPPORTED";
      issues: readonly ContractIssueV1[];
    }>;

export function decodeExecuteDecisionTaskCommandV1(
  input: unknown
): ContractDecodeResult<ExecuteDecisionTaskCommandV1> {
  const unsupportedVersion = findUnsupportedVersion(input);

  if (unsupportedVersion !== undefined) {
    return {
      ok: false,
      code: "CONTRACT_VERSION_UNSUPPORTED",
      issues: [unsupportedVersion]
    };
  }

  const parsed = executeDecisionTaskCommandSchema.safeParse(input);

  if (!parsed.success) {
    return {
      ok: false,
      code: "CONTRACT_INVALID",
      issues: parsed.error.issues.map((issue) => {
        const path = issue.path.join(".");

        return {
          message:
            path === "requirementRevision.budget.maxAmountMinor"
              ? "金额必须是非负整数人民币分"
              : /^requirementRevision\.mustHaves\.\d+\.key$/.test(path)
                ? "must-have key 在 Requirement Revision 中必须唯一"
              : "字段不符合合同要求",
          path
        };
      })
    };
  }

  return { ok: true, value: parsed.data };
}

export function decodeDecisionTaskSnapshotV1(
  input: unknown
): ContractDecodeResult<DecisionTaskSnapshotV1> {
  const unsupportedVersion = findUnsupportedVersion(input);

  if (unsupportedVersion !== undefined) {
    return {
      ok: false,
      code: "CONTRACT_VERSION_UNSUPPORTED",
      issues: [unsupportedVersion]
    };
  }

  const parsed = decisionTaskSnapshotSchema.safeParse(input);

  if (!parsed.success) {
    return {
      ok: false,
      code: "CONTRACT_INVALID",
      issues: parsed.error.issues.map((issue) => ({
        message: "字段不符合合同要求",
        path: issue.path.join(".")
      }))
    };
  }

  return { ok: true, value: parsed.data };
}

export function decodeDecisionTaskResultV1(
  input: unknown
): ContractDecodeResult<DecisionTaskResultV1> {
  const unsupportedVersion = findUnsupportedVersion(input);

  if (unsupportedVersion !== undefined) {
    return {
      ok: false,
      code: "CONTRACT_VERSION_UNSUPPORTED",
      issues: [unsupportedVersion]
    };
  }

  const parsed = decisionTaskResultSchema.safeParse(input);

  if (!parsed.success) {
    return {
      ok: false,
      code: "CONTRACT_INVALID",
      issues: parsed.error.issues.map((issue) => ({
        message: "字段不符合合同要求",
        path: issue.path.join(".")
      }))
    };
  }

  const value = parsed.data as DecisionTaskResultV1;
  const invariantIssues = checkDecisionTaskResultInvariants(value);

  if (invariantIssues.length > 0) {
    return {
      ok: false,
      code: "CONTRACT_INVALID",
      issues: invariantIssues
    };
  }

  return { ok: true, value };
}

export function decodePersistedRunEventV1(
  input: unknown
): ContractDecodeResult<PersistedRunEventV1> {
  const unsupportedVersion = findUnsupportedVersion(input);

  if (unsupportedVersion !== undefined) {
    return {
      ok: false,
      code: "CONTRACT_VERSION_UNSUPPORTED",
      issues: [unsupportedVersion]
    };
  }

  const parsed = persistedRunEventSchema.safeParse(input);

  if (!parsed.success) {
    return {
      ok: false,
      code: "CONTRACT_INVALID",
      issues: parsed.error.issues.map((issue) => ({
        message: "字段不符合合同要求",
        path: issue.path.join(".")
      }))
    };
  }

  return { ok: true, value: parsed.data };
}

export function decodeRuntimeSnapshotV1(
  input: unknown
): ContractDecodeResult<RuntimeSnapshotV1> {
  const unsupportedVersion = findUnsupportedVersion(input);

  if (unsupportedVersion !== undefined) {
    return {
      ok: false,
      code: "CONTRACT_VERSION_UNSUPPORTED",
      issues: [unsupportedVersion]
    };
  }

  if (
    isRecord(input) &&
    isRecord(input.runtimeProtocol) &&
    input.runtimeProtocol.version !== "1"
  ) {
    return {
      ok: false,
      code: "CONTRACT_VERSION_UNSUPPORTED",
      issues: [
        {
          path: "runtimeProtocol.version",
          message: "Runtime Protocol 版本不受支持"
        }
      ]
    };
  }

  const parsed = runtimeSnapshotSchema.safeParse(input);

  if (!parsed.success) {
    return invalidContractResult(parsed.error.issues);
  }

  if (
    parsed.data.checkpoint.decisionTaskId !== parsed.data.decisionTaskId ||
    parsed.data.checkpoint.agentRunId !== parsed.data.agentRunId
  ) {
    return {
      ok: false,
      code: "CONTRACT_INVALID",
      issues: [
        {
          path: "checkpoint",
          message: "Checkpoint 必须属于同一 Agent Run"
        }
      ]
    };
  }

  return { ok: true, value: parsed.data };
}

export function decodeCheckpointRefV1(
  input: unknown
): ContractDecodeResult<CheckpointRefV1> {
  const unsupportedVersion = findUnsupportedVersion(input);

  if (unsupportedVersion !== undefined) {
    return {
      ok: false,
      code: "CONTRACT_VERSION_UNSUPPORTED",
      issues: [unsupportedVersion]
    };
  }

  const parsed = checkpointRefSchema.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : invalidContractResult(parsed.error.issues);
}

export function decodeEffectReceiptV1(
  input: unknown
): ContractDecodeResult<EffectReceiptV1> {
  const unsupportedVersion = findUnsupportedVersion(input);

  if (unsupportedVersion !== undefined) {
    return {
      ok: false,
      code: "CONTRACT_VERSION_UNSUPPORTED",
      issues: [unsupportedVersion]
    };
  }

  const parsed = effectReceiptSchema.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : invalidContractResult(parsed.error.issues);
}

export function decodeRuntimeRecoveryPermissionV1(
  input: unknown
): ContractDecodeResult<RuntimeRecoveryPermissionV1> {
  const unsupportedVersion = findUnsupportedVersion(input);

  if (unsupportedVersion !== undefined) {
    return {
      ok: false,
      code: "CONTRACT_VERSION_UNSUPPORTED",
      issues: [unsupportedVersion]
    };
  }

  const parsed = runtimeRecoveryPermissionSchema.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : invalidContractResult(parsed.error.issues);
}

export function decodeRuntimePausedOutcomeV1(
  input: unknown
): ContractDecodeResult<RuntimePausedOutcomeV1> {
  const unsupportedVersion = findUnsupportedVersion(input);
  if (unsupportedVersion !== undefined) {
    return {
      ok: false,
      code: "CONTRACT_VERSION_UNSUPPORTED",
      issues: [unsupportedVersion]
    };
  }

  const parsed = runtimePausedOutcomeSchema.safeParse(input);
  if (!parsed.success) {
    return invalidContractResult(parsed.error.issues);
  }

  const value = parsed.data;
  const decodedSnapshot = decodeRuntimeSnapshotV1(value.snapshot);
  const decodedReceipts = value.effectReceipts.map(decodeEffectReceiptV1);
  if (!decodedSnapshot.ok || decodedReceipts.some((receipt) => !receipt.ok)) {
    return {
      ok: false,
      code:
        !decodedSnapshot.ok && decodedSnapshot.code === "CONTRACT_VERSION_UNSUPPORTED"
          ? "CONTRACT_VERSION_UNSUPPORTED"
          : "CONTRACT_INVALID",
      issues: !decodedSnapshot.ok
        ? decodedSnapshot.issues.map((issue) => ({
            ...issue,
            path: `snapshot${issue.path.length > 0 ? `.${issue.path}` : ""}`
          }))
        : [{ path: "effectReceipts", message: "Effect Receipt 不符合合同要求" }]
    };
  }
  const firstEvent = value.runEvents[0];
  const allFactsBelongToRun =
    firstEvent !== undefined &&
    value.snapshot.decisionTaskId === firstEvent.decisionTaskId &&
    value.snapshot.agentRunId === firstEvent.agentRunId &&
    value.effectReceipts.every(
      (receipt) =>
        receipt.decisionTaskId === value.snapshot.decisionTaskId &&
        receipt.agentRunId === value.snapshot.agentRunId &&
        receipt.checkpointId === value.snapshot.checkpoint.checkpointId
    );
  if (
    value.state !== value.snapshot.taskState ||
    value.runEvents.at(-1)?.taskState !== value.state ||
    !allFactsBelongToRun
  ) {
    return {
      ok: false,
      code: "CONTRACT_INVALID",
      issues: [{ path: "", message: "暂停 Outcome 的恢复事实必须属于同一暂停运行" }]
    };
  }

  return { ok: true, value };
}

export function decodeRuntimeResumeRequestV1(
  input: unknown
): ContractDecodeResult<RuntimeResumeRequestV1> {
  return decodeRuntimeControlContract(input, runtimeResumeRequestSchema);
}

export function decodeRuntimeCancelRequestV1(
  input: unknown
): ContractDecodeResult<RuntimeCancelRequestV1> {
  return decodeRuntimeControlContract(input, runtimeCancelRequestSchema);
}

export function decodeRuntimeControlStatusV1(
  input: unknown
): ContractDecodeResult<RuntimeControlStatusV1> {
  const decoded = decodeRuntimeControlContract(input, runtimeControlStatusSchema);
  if (
    decoded.ok &&
    ((decoded.value.state === "FAILED") !== (decoded.value.error !== undefined))
  ) {
    return {
      ok: false,
      code: "CONTRACT_INVALID",
      issues: [{ path: "error", message: "FAILED 状态必须且只能携带控制错误" }]
    };
  }
  return decoded;
}

function decodeRuntimeControlContract<T>(
  input: unknown,
  schema: Readonly<{ safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: readonly Readonly<{ path: readonly PropertyKey[] }>[] } } }>
): ContractDecodeResult<T> {
  const unsupportedVersion = findUnsupportedVersion(input);
  if (unsupportedVersion !== undefined) {
    return { ok: false, code: "CONTRACT_VERSION_UNSUPPORTED", issues: [unsupportedVersion] };
  }
  const parsed = schema.safeParse(input);
  return parsed.success ? { ok: true, value: parsed.data } : invalidContractResult(parsed.error.issues);
}

export function evaluateRuntimeRecoveryPermissionV1(input: Readonly<{
  snapshot: unknown;
  effectReceipts: readonly unknown[];
}>): RuntimeRecoveryPermissionV1 {
  const decodedSnapshot = decodeRuntimeSnapshotV1(input.snapshot);
  const decodedReceipts = input.effectReceipts.map(decodeEffectReceiptV1);
  const snapshot = decodedSnapshot.ok ? decodedSnapshot.value : undefined;
  const identity = snapshot ?? recoveryIdentityFromUnknown(input.snapshot);

  if (
    snapshot === undefined ||
    decodedReceipts.some((receipt) => !receipt.ok) ||
    decodedReceipts.some(
      (receipt) =>
        receipt.ok &&
        (receipt.value.decisionTaskId !== snapshot.decisionTaskId ||
          receipt.value.agentRunId !== snapshot.agentRunId ||
          receipt.value.checkpointId !== snapshot.checkpoint.checkpointId)
    )
  ) {
    return buildRuntimeRecoveryPermission(identity, "RESUME_DENIED", "RECOVERY_FACTS_INVALID");
  }

  if (!snapshot.taskState.startsWith("PAUSED_")) {
    return buildRuntimeRecoveryPermission(snapshot, "RESUME_DENIED", "TASK_NOT_PAUSED");
  }

  if (!snapshot.resumable) {
    return buildRuntimeRecoveryPermission(snapshot, "RESUME_DENIED", "SNAPSHOT_NOT_RESUMABLE");
  }

  if (
    decodedReceipts.some(
      (receipt) => receipt.ok && (receipt.value.state === "started" || receipt.value.state === "unknown")
    )
  ) {
    return buildRuntimeRecoveryPermission(
      snapshot,
      "MANUAL_VERIFICATION_REQUIRED",
      "EFFECT_STATUS_UNSAFE"
    );
  }

  return buildRuntimeRecoveryPermission(snapshot, "RESUME_ALLOWED", "SAFE_TO_RESUME");
}

function invalidContractResult(
  issues: readonly Readonly<{ path: readonly PropertyKey[] }>[]
): ContractDecodeResult<never> {
  return {
    ok: false,
    code: "CONTRACT_INVALID",
    issues: issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: "字段不符合合同要求"
    }))
  };
}

function recoveryIdentityFromUnknown(input: unknown): Readonly<{
  decisionTaskId: string;
  agentRunId: string;
  snapshotId: string;
}> {
  if (!isRecord(input)) {
    return { decisionTaskId: "unknown", agentRunId: "unknown", snapshotId: "unknown" };
  }

  return {
    decisionTaskId: typeof input.decisionTaskId === "string" ? input.decisionTaskId : "unknown",
    agentRunId: typeof input.agentRunId === "string" ? input.agentRunId : "unknown",
    snapshotId: typeof input.snapshotId === "string" ? input.snapshotId : "unknown"
  };
}

function buildRuntimeRecoveryPermission(
  identity: Readonly<{ decisionTaskId: string; agentRunId: string; snapshotId: string }>,
  decision: RuntimeRecoveryPermissionV1["decision"],
  reason: RuntimeRecoveryPermissionV1["reason"]
): RuntimeRecoveryPermissionV1 {
  return {
    contractType: "runtime-recovery-permission",
    contractVersion: "1.0",
    decisionTaskId: identity.decisionTaskId,
    agentRunId: identity.agentRunId,
    snapshotId: identity.snapshotId,
    decision,
    reason
  };
}

export function finalizeSuccessfulDecisionTaskResultV1(
  input: unknown
): ContractDecodeResult<SuccessfulDecisionTaskResultV1> {
  const unsupportedVersion = findUnsupportedVersion(input);

  if (unsupportedVersion !== undefined) {
    return {
      ok: false,
      code: "CONTRACT_VERSION_UNSUPPORTED",
      issues: [unsupportedVersion]
    };
  }

  const parsed = successfulDecisionTaskResultDraftSchema.safeParse(input);

  if (!parsed.success) {
    return {
      ok: false,
      code: "CONTRACT_INVALID",
      issues: parsed.error.issues.map((issue) => ({
        message: "字段不符合合同要求",
        path: issue.path.join(".")
      }))
    };
  }

  const draft = parsed.data as SuccessfulDecisionTaskResultDraftV1;
  const evaluation = evaluateDecisionBasisV1({
    decisionTaskId: draft.taskStatus.decisionTaskId,
    bundle: draft.bundle
  });

  if (evaluation.issues.length > 0) {
    return { ok: false, code: "CONTRACT_INVALID", issues: evaluation.issues };
  }

  const value: SuccessfulDecisionTaskResultV1 = {
    ...draft,
    bundle: {
      ...draft.bundle,
      claimAssessments: evaluation.claimAssessments
    }
  };
  const invariantIssues = checkDecisionTaskResultInvariants(value);

  if (invariantIssues.length > 0) {
    return { ok: false, code: "CONTRACT_INVALID", issues: invariantIssues };
  }

  return { ok: true, value };
}

export function getDecisionTaskResultHttpStatusV1(
  result: DecisionTaskResultV1
): DecisionTaskResultHttpStatusV1 {
  if (result.ok) {
    return 200;
  }

  if ("taskStatus" in result) {
    return 502;
  }

  if (result.error.code === "CONTRACT_VERSION_UNSUPPORTED") {
    return 422;
  }

  if (result.error.code === "DECISION_EXECUTION_STATUS_UNKNOWN") {
    return 503;
  }

  return 400;
}

const MAX_CONTRACT_VERSION_SCAN_DEPTH = 32;

function findUnsupportedVersion(input: unknown): ContractIssueV1 | undefined {
  const pending: Array<{
    value: unknown;
    path: readonly (string | number)[];
    depth: number;
  }> = [{ value: input, path: [], depth: 0 }];

  while (pending.length > 0) {
    const current = pending.pop();

    if (current === undefined) {
      break;
    }

    if (isRecord(current.value)) {
      if (
        "contractType" in current.value &&
        current.value.contractVersion !== "1.0"
      ) {
        return {
          path: [...current.path, "contractVersion"].join("."),
          message: "仅支持合同版本 1.0"
        };
      }
    }

    if (current.depth >= MAX_CONTRACT_VERSION_SCAN_DEPTH) {
      continue;
    }

    const entries: Array<readonly [string | number, unknown]> = [];

    if (Array.isArray(current.value)) {
      for (let index = 0; index < current.value.length; index += 1) {
        entries.push([index, current.value[index]]);
      }
    } else if (isRecord(current.value)) {
      for (const entry of Object.entries(current.value)) {
        entries.push(entry);
      }
    }

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];

      if (entry !== undefined) {
        pending.push({
          value: entry[1],
          path: [...current.path, entry[0]],
          depth: current.depth + 1
        });
      }
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
