import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  CandidateV1,
  ClaimEvidenceLinkV1,
  ClaimV1,
  DecisionRevisionV1,
  EvidenceV1,
  RequirementRevisionV1,
  RunEventV1
} from "@choicemind/contracts/decision/v1";

export type CategoryPackageV1 = Readonly<{
  contractType: "category-package";
  contractVersion: "1.0";
  categoryId: string;
  displayName: string;
  synthetic: true;
  requirementSchema: Readonly<{
    fields: readonly Readonly<{
      key: string;
      valueType: "QUANTITY" | "BOOLEAN" | "TEXT";
      required: boolean;
    }>[];
  }>;
  rules: readonly Readonly<{
    ruleId: string;
    requirementKey: string;
    predicate: string;
  }>[];
  queryTemplates: readonly string[];
  riskTopics: readonly string[];
  goldSet: readonly Readonly<{
    caseId: string;
    expectedDecisionStatus: "BUY_IF_PRICE" | "NEED_MORE_INFO";
  }>[];
}>;

export type CategoryPackageRegistry = Readonly<{
  register(categoryPackage: CategoryPackageV1): void;
  get(categoryId: string): CategoryPackageV1 | undefined;
  list(): readonly CategoryPackageV1[];
}>;

export function createCategoryPackageRegistry(): CategoryPackageRegistry {
  const packages = new Map<string, CategoryPackageV1>();
  return {
    register(categoryPackage) {
      if (packages.has(categoryPackage.categoryId)) {
        throw new Error(
          `CATEGORY_PACKAGE_DUPLICATE: ${categoryPackage.categoryId}`
        );
      }
      packages.set(categoryPackage.categoryId, categoryPackage);
    },
    get(categoryId) {
      return packages.get(categoryId);
    },
    list() {
      return [...packages.values()];
    }
  };
}

export const syntheticFoldingTableCategory: CategoryPackageV1 = {
  contractType: "category-package",
  contractVersion: "1.0",
  categoryId: "synthetic-folding-table",
  displayName: "合成折叠露营桌",
  synthetic: true,
  requirementSchema: {
    fields: [
      { key: "dimensions.widthCm", valueType: "QUANTITY", required: true },
      { key: "load.ratedKg", valueType: "QUANTITY", required: true },
      { key: "portability.required", valueType: "BOOLEAN", required: true }
    ]
  },
  rules: [
    {
      ruleId: "max-width",
      requirementKey: "dimensions.widthCm",
      predicate: "dimensions.widthCm"
    },
    {
      ruleId: "minimum-load",
      requirementKey: "load.ratedKg",
      predicate: "load.ratedKg"
    }
  ],
  queryTemplates: ["核验准确型号的展开尺寸与额定承重"],
  riskTopics: ["夹手风险", "地面稳定性", "承重标称条件"],
  goldSet: [
    {
      caseId: "folding-table-supported-selection",
      expectedDecisionStatus: "BUY_IF_PRICE"
    },
    {
      caseId: "folding-table-missing-width",
      expectedDecisionStatus: "NEED_MORE_INFO"
    }
  ]
};

type SyntheticCategoryRunCommandV1 = Readonly<{
  decisionTaskId: string;
  agentRunId: string;
  requirementRevision: RequirementRevisionV1;
}>;

type SyntheticCategoryRunOutputV1 = Readonly<{
  candidates: readonly CandidateV1[];
  claims: readonly ClaimV1[];
  evidence: readonly EvidenceV1[];
  claimEvidenceLinks: readonly ClaimEvidenceLinkV1[];
  decision: DecisionRevisionV1;
  runEvents: readonly RunEventV1[];
}>;

const foldingTableObservedAt = "2026-08-26T12:00:00.000Z";
const foldingTableValidUntil = "2026-09-02T12:00:00.000Z";

export function buildSyntheticFoldingTableRunOutput(
  categoryPackage: CategoryPackageV1,
  command: SyntheticCategoryRunCommandV1
): SyntheticCategoryRunOutputV1 {
  if (categoryPackage.categoryId !== syntheticFoldingTableCategory.categoryId) {
    throw new Error(`CATEGORY_PACKAGE_UNSUPPORTED: ${categoryPackage.categoryId}`);
  }
  const needsWidth = command.requirementRevision.unknowns.includes(
    "dimensions.widthCm"
  );
  const taskId = command.decisionTaskId;
  const candidates: readonly CandidateV1[] = [
    {
      contractType: "candidate",
      contractVersion: "1.0",
      candidateId: "candidate-synth-table-a",
      decisionTaskId: taskId,
      displayName: "合成折叠露营桌 A",
      synthetic: true,
      identity: {
        model: "CM-SYNTH-TABLE-A",
        sku: "CM-SYNTH-TABLE-A-80",
        market: "CN",
        configuration: "80 cm 桌宽 / 40 kg 额定承重"
      },
      observedPrice: {
        amountMinor: 42900,
        currency: "CNY",
        observedAt: foldingTableObservedAt
      }
    },
    {
      contractType: "candidate",
      contractVersion: "1.0",
      candidateId: "candidate-synth-table-b",
      decisionTaskId: taskId,
      displayName: "合成折叠露营桌 B",
      synthetic: true,
      identity: {
        model: "CM-SYNTH-TABLE-B",
        sku: "CM-SYNTH-TABLE-B-95",
        market: "CN",
        configuration: "95 cm 桌宽 / 50 kg 额定承重"
      },
      observedPrice: {
        amountMinor: 47900,
        currency: "CNY",
        observedAt: foldingTableObservedAt
      }
    }
  ];
  const claims: readonly ClaimV1[] = [
    foldingTableClaim(taskId, "claim-synth-table-a-price", "candidate-synth-table-a", "price.observed", {
      kind: "MONEY",
      amountMinor: 42900,
      currency: "CNY"
    }),
    foldingTableClaim(
      taskId,
      "claim-synth-table-a-width",
      "candidate-synth-table-a",
      "dimensions.widthCm",
      { kind: "QUANTITY", amount: 80, unit: "cm" }
    ),
    foldingTableClaim(
      taskId,
      "claim-synth-table-a-load",
      "candidate-synth-table-a",
      "load.ratedKg",
      { kind: "QUANTITY", amount: 40, unit: "kg" }
    ),
    foldingTableClaim(
      taskId,
      "claim-synth-table-b-width",
      "candidate-synth-table-b",
      "dimensions.widthCm",
      { kind: "QUANTITY", amount: 95, unit: "cm" }
    )
  ];
  const evidence: readonly EvidenceV1[] = [
    foldingTableEvidence(taskId, "evidence-synth-table-a-price", "price.observed", "合成观测价为 429 元"),
    foldingTableEvidence(taskId, "evidence-synth-table-a-width", "dimensions.widthCm", "合成展开桌宽为 80 cm"),
    foldingTableEvidence(taskId, "evidence-synth-table-a-load", "load.ratedKg", "合成额定承重为 40 kg"),
    foldingTableEvidence(taskId, "evidence-synth-table-b-width", "dimensions.widthCm", "合成展开桌宽为 95 cm")
  ];
  const pairs = [
    ["claim-synth-table-a-price", "evidence-synth-table-a-price"],
    ["claim-synth-table-a-width", "evidence-synth-table-a-width"],
    ["claim-synth-table-a-load", "evidence-synth-table-a-load"],
    ["claim-synth-table-b-width", "evidence-synth-table-b-width"]
  ] as const;
  const claimEvidenceLinks: readonly ClaimEvidenceLinkV1[] = pairs.map(
    ([claimId, evidenceId], index) => ({
      contractType: "claim-evidence-link",
      contractVersion: "1.0",
      linkId: `link-synth-table-${index + 1}`,
      decisionTaskId: taskId,
      claimId,
      evidenceId,
      direction: "SUPPORTS"
    })
  );
  if (needsWidth) {
    return buildMissingFoldingTableWidthOutput(command, {
      candidates,
      claims,
      evidence,
      claimEvidenceLinks
    });
  }
  const decision: DecisionRevisionV1 = {
    contractType: "decision-revision",
    contractVersion: "1.0",
    decisionRevisionId: `decision-${taskId}-r1`,
    decisionTaskId: taskId,
    requirementRevisionId: command.requirementRevision.requirementRevisionId,
    revision: 1,
    status: "BUY_IF_PRICE",
    summary: "合成折叠露营桌 A 满足尺寸与承重硬约束，核验价格和官方保修后可考虑购买。",
    selectedCandidateId: "candidate-synth-table-a",
    conditions: [
      {
        conditionId: "condition-synth-table-price",
        conditionType: "MAX_PRICE",
        candidateId: "candidate-synth-table-a",
        amountMinor: 45000,
        currency: "CNY",
        verification: "由用户在外部销售渠道核验实际到手价"
      },
      {
        conditionId: "condition-synth-table-warranty",
        conditionType: "OFFICIAL_WARRANTY",
        candidateId: "candidate-synth-table-a",
        verification: "由用户确认销售渠道提供官方保修"
      }
    ],
    candidateDispositions: [
      {
        dispositionId: "disposition-synth-table-b-width",
        dispositionType: "ELIMINATED",
        candidateId: "candidate-synth-table-b",
        requirementKey: "dimensions.widthCm",
        reason: "合成展开桌宽 95 cm 超过 90 cm 硬约束",
        evidenceIds: ["evidence-synth-table-b-width"]
      }
    ],
    risks: [],
    evidenceIds: evidence.map((entry) => entry.evidenceId),
    criticalGaps: [],
    assumptions: [],
    validFrom: foldingTableObservedAt,
    validUntil: foldingTableValidUntil,
    nextSteps: [
      {
        actionType: "VERIFY_CONDITION",
        conditionId: "condition-synth-table-price",
        instruction: "核验实际到手价"
      },
      {
        actionType: "VERIFY_CONDITION",
        conditionId: "condition-synth-table-warranty",
        instruction: "确认官方保修"
      }
    ],
    synthetic: true
  };
  const eventStates = ["CREATED", "PLANNING", "RESEARCHING", "VERIFYING", "COMPARING", "COMPLETED"] as const;
  const runEvents: readonly RunEventV1[] = eventStates.map((taskState, index) => ({
    contractType: "run-event",
    contractVersion: "1.0",
    eventId: `event-synth-table-${index + 1}`,
    decisionTaskId: taskId,
    agentRunId: command.agentRunId,
    sequence: index + 1,
    occurredAt: `2026-08-26T12:00:0${index}.000Z`,
    eventType: index === eventStates.length - 1 ? "RUNTIME_SUCCEEDED" : "TASK_STATE_CHANGED",
    taskState,
    summary: `合成折叠露营桌流程：${taskState}`,
    synthetic: true
  }));
  return { candidates, claims, evidence, claimEvidenceLinks, decision, runEvents };
}

function buildMissingFoldingTableWidthOutput(
  command: SyntheticCategoryRunCommandV1,
  material: Pick<
    SyntheticCategoryRunOutputV1,
    "candidates" | "claims" | "evidence" | "claimEvidenceLinks"
  >
): SyntheticCategoryRunOutputV1 {
  const taskId = command.decisionTaskId;
  const decision: DecisionRevisionV1 = {
    contractType: "decision-revision",
    contractVersion: "1.0",
    decisionRevisionId: `decision-${taskId}-r1`,
    decisionTaskId: taskId,
    requirementRevisionId: command.requirementRevision.requirementRevisionId,
    revision: 1,
    status: "NEED_MORE_INFO",
    summary: "缺少可接受桌宽，当前不能安全筛选折叠露营桌。",
    conditions: [],
    candidateDispositions: [],
    risks: [],
    evidenceIds: material.evidence.map((entry) => entry.evidenceId),
    criticalGaps: [
      {
        gapId: "gap-synth-table-width",
        key: "dimensions.widthCm",
        question: "可接受的最大展开桌宽是多少厘米？",
        resolution: {
          resolutionType: "PROVIDE_REQUIREMENT",
          requirementKey: "dimensions.widthCm"
        }
      }
    ],
    assumptions: [],
    validFrom: foldingTableObservedAt,
    validUntil: foldingTableValidUntil,
    nextSteps: [
      {
        actionType: "PROVIDE_REQUIREMENT",
        requirementKey: "dimensions.widthCm",
        instruction: "请补充可接受的最大展开桌宽"
      }
    ],
    synthetic: true
  };
  const states = ["CREATED", "UNDERSTANDING", "COMPLETED"] as const;
  const runEvents: readonly RunEventV1[] = states.map((taskState, index) => ({
    contractType: "run-event",
    contractVersion: "1.0",
    eventId: `event-synth-table-gap-${index + 1}`,
    decisionTaskId: taskId,
    agentRunId: command.agentRunId,
    sequence: index + 1,
    occurredAt: `2026-08-26T12:01:0${index}.000Z`,
    eventType: index === states.length - 1 ? "RUNTIME_SUCCEEDED" : "TASK_STATE_CHANGED",
    taskState,
    summary: `合成折叠露营桌澄清流程：${taskState}`,
    synthetic: true
  }));
  return {
    ...material,
    decision,
    runEvents
  };
}

function foldingTableClaim(
  decisionTaskId: string,
  claimId: string,
  candidateId: string,
  predicate: string,
  value: ClaimV1["value"]
): ClaimV1 {
  return {
    contractType: "claim",
    contractVersion: "1.0",
    claimId,
    decisionTaskId,
    subject: { subjectType: "CANDIDATE", subjectId: candidateId },
    predicate,
    value,
    claimKind: "FACT_ASSERTION"
  };
}

function foldingTableEvidence(
  decisionTaskId: string,
  evidenceId: string,
  field: string,
  excerpt: string
): EvidenceV1 {
  return {
    contractType: "evidence",
    contractVersion: "1.0",
    evidenceId,
    decisionTaskId,
    synthetic: true,
    source: {
      sourceKind: "SYNTHETIC",
      sourceId: "source-synth-folding-table",
      title: "ChoiceMind 合成折叠露营桌测试资料"
    },
    capturedAt: foldingTableObservedAt,
    locator: { section: "synthetic-folding-table", field },
    excerpt,
    validUntil: foldingTableValidUntil
  };
}

export type P0GateResultV1 = Readonly<{
  gateId: string;
  status: "PASSED" | "FAILED";
  evidence: readonly Readonly<{
    evidenceId: string;
    locator: string;
  }>[];
}>;

export type LocalServiceSmokeInputV1 = Readonly<{
  contractType: "local-service-smoke-report";
  contractVersion: "1.0";
  status: "SMOKE_PASSED" | "SMOKE_FAILED";
  executedAt: string;
  services: readonly Readonly<{
    serviceId: string;
    status: "SMOKE_PASSED" | "SMOKE_FAILED";
  }>[];
}>;

export type P0EvaluationReportV1 = Readonly<{
  contractType: "p0-evaluation-report";
  contractVersion: "1.0";
  status: "P0_PASSED" | "P0_FAILED";
  executedAt: string;
  baselineCommit: string;
  gates: readonly P0GateResultV1[];
  blockingFailures: readonly string[];
}>;

export type P0EvidenceIndexV1 = Readonly<{
  contractType: "p0-evidence-index";
  contractVersion: "1.0";
  generatedAt: string;
  entries: readonly Readonly<{
    evidenceId: string;
    gateId: string;
    locator: string;
  }>[];
}>;

export function evaluateP0GoldGate(input: Readonly<{
  executedAt: string;
  baselineCommit: string;
  coreModifiedFiles: readonly string[];
  gateResults: readonly P0GateResultV1[];
  localServiceReport: LocalServiceSmokeInputV1;
}>): Readonly<{
  report: P0EvaluationReportV1;
  evidenceIndex: P0EvidenceIndexV1;
}> {
  const coreGate: P0GateResultV1 = {
    gateId: "core-category-independence",
    status: input.coreModifiedFiles.length === 0 ? "PASSED" : "FAILED",
    evidence: input.coreModifiedFiles.map((file) => ({
      evidenceId: `core-diff:${file}`,
      locator: file
    }))
  };
  const requiredServices = new Set([
    "qwen-model",
    "qwen-embedding",
    "qwen-reranker",
    "paddleocr-vl",
    "mineru",
    "choicemind-html-parser"
  ]);
  const reportedServiceIds = input.localServiceReport.services.map(
    (service) => service.serviceId
  );
  const uniqueReportedServiceIds = new Set(reportedServiceIds);
  const hasExactServiceSet =
    input.localServiceReport.services.length === requiredServices.size &&
    uniqueReportedServiceIds.size === requiredServices.size &&
    [...requiredServices].every((serviceId) =>
      uniqueReportedServiceIds.has(serviceId)
    );
  const serviceGate: P0GateResultV1 = {
    gateId: "local-service-contracts",
    status:
      input.localServiceReport.status === "SMOKE_PASSED" &&
      hasExactServiceSet &&
      input.localServiceReport.services.every(
        (service) => service.status === "SMOKE_PASSED"
      )
        ? "PASSED"
        : "FAILED",
    evidence: [
      ...input.localServiceReport.services.map((service) => ({
        evidenceId: `local-service:${service.serviceId}`,
        locator: `local-service-smoke:${service.serviceId}`
      })),
      ...[...requiredServices]
        .filter(
          (serviceId) =>
            !input.localServiceReport.services.some(
              (service) => service.serviceId === serviceId
            )
        )
        .map((serviceId) => ({
          evidenceId: `local-service:${serviceId}:missing`,
          locator: `local-service-smoke:missing:${serviceId}`
        }))
    ]
  };
  const gates = [...input.gateResults, coreGate, serviceGate];
  const blockingFailures = gates
    .filter((gate) => gate.status === "FAILED")
    .map((gate) => gate.gateId);
  const evidenceEntries = gates.flatMap((gate) =>
    gate.evidence.map((entry) => ({ ...entry, gateId: gate.gateId }))
  );
  return {
    report: {
      contractType: "p0-evaluation-report",
      contractVersion: "1.0",
      status: blockingFailures.length === 0 ? "P0_PASSED" : "P0_FAILED",
      executedAt: input.executedAt,
      baselineCommit: input.baselineCommit,
      gates,
      blockingFailures
    },
    evidenceIndex: {
      contractType: "p0-evidence-index",
      contractVersion: "1.0",
      generatedAt: input.executedAt,
      entries: evidenceEntries
    }
  };
}

export async function saveP0GoldArtifacts(
  outputDirectory: string,
  evaluation: Readonly<{
    report: P0EvaluationReportV1;
    evidenceIndex: P0EvidenceIndexV1;
  }>
): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await writeJsonAtomically(
    path.join(outputDirectory, "evaluation-report.json"),
    evaluation.report
  );
  await writeJsonAtomically(
    path.join(outputDirectory, "evidence-index.json"),
    evaluation.evidenceIndex
  );
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
