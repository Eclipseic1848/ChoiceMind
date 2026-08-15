import {
  decisionTaskResultSchema,
  executeDecisionTaskCommandSchema,
  successfulDecisionTaskResultDraftSchema
} from "./schemas.js";
import { evaluateDecisionBasisV1 } from "./decision-basis.js";
import { checkDecisionTaskResultInvariants } from "./invariants.js";

export {
  createContractRejectedDecisionTaskResultV1,
  createUnknownDecisionExecutionResultV1
} from "./errors.js";

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

export type EvidenceV1 = Readonly<{
  contractType: "evidence";
  contractVersion: "1.0";
  evidenceId: string;
  decisionTaskId: string;
  synthetic: true;
  source: Readonly<{
    sourceKind: "SYNTHETIC";
    sourceId: string;
    title: string;
  }>;
  capturedAt: string;
  locator: Readonly<{ section: string; field: string }>;
  excerpt: string;
  validUntil: string;
}>;

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
    | "FAKE_RUNTIME_FAILED"
    | "DECISION_EXECUTION_STATUS_UNKNOWN";
  category: "VALIDATION" | "VERSION" | "RUNTIME" | "TRANSPORT";
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
