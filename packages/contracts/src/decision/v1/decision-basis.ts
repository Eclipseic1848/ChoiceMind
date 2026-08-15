import type {
  CandidateV1,
  ClaimAssessmentV1,
  ClaimEvidenceLinkV1,
  ClaimV1,
  ContractIssueV1,
  DecisionBundleV1,
  EvidenceV1,
  RequirementConstraintV1,
  RequirementRevisionV1
} from "./index.js";

type DecisionBundleDraftV1 = Omit<DecisionBundleV1, "claimAssessments">;

type DecisionBasisEvaluationInputV1 = Readonly<{
  decisionTaskId: string;
  bundle: DecisionBundleDraftV1;
}>;

export type DecisionBasisEvaluationV1 = Readonly<{
  claimAssessments: readonly ClaimAssessmentV1[];
  issues: readonly ContractIssueV1[];
}>;

type EvidenceGraph = Readonly<{
  candidatesById: ReadonlyMap<string, CandidateV1>;
  claimsById: ReadonlyMap<string, ClaimV1>;
  evidenceById: ReadonlyMap<string, EvidenceV1>;
  linksByEvidenceId: ReadonlyMap<string, readonly ClaimEvidenceLinkV1[]>;
  claimAssessmentsById: ReadonlyMap<string, ClaimAssessmentV1>;
  claimsByCandidateAndPredicate: ReadonlyMap<string, readonly ClaimV1[]>;
}>;

type InternalEvaluation = Readonly<{
  claimAssessments: readonly ClaimAssessmentV1[];
  graph?: EvidenceGraph;
  issues: readonly ContractIssueV1[];
}>;

type CandidateConstraintAssessment = Readonly<{
  status: "SATISFIED" | "VIOLATED" | "INDETERMINATE";
  supportingEvidenceIds: ReadonlySet<string>;
}>;

type TrustedClaimValues = Readonly<{
  values: ReadonlySet<number>;
  supportingEvidenceIds: ReadonlySet<string>;
}>;

export function evaluateDecisionBasisV1(
  input: DecisionBasisEvaluationInputV1
): DecisionBasisEvaluationV1 {
  const evaluation = evaluateDecisionBasisWithGraph(input);

  return {
    claimAssessments: evaluation.claimAssessments,
    issues: evaluation.issues
  };
}

export function checkDecisionBasisV1(
  input: Readonly<{ decisionTaskId: string; bundle: DecisionBundleV1 }>
): readonly ContractIssueV1[] {
  const evaluation = evaluateDecisionBasisWithGraph(input);

  if (evaluation.graph === undefined) {
    return evaluation.issues;
  }

  const issues = [...evaluation.issues];
  const graph = evaluation.graph;
  const decision = input.bundle.decision;
  const requirement = input.bundle.requirementRevision;
  const selectedCandidate =
    decision.selectedCandidateId === undefined
      ? undefined
      : graph.candidatesById.get(decision.selectedCandidateId);

  validateCanonicalAssessments(
    input.bundle.claimAssessments,
    evaluation.claimAssessments,
    issues
  );
  collectUniqueIds(
    decision.candidateDispositions,
    (disposition) => disposition.dispositionId,
    "bundle.decision.candidateDispositions",
    "dispositionId",
    "Candidate Disposition",
    issues
  );

  if (decision.selectedCandidateId !== undefined && selectedCandidate === undefined) {
    issues.push({
      path: "bundle.decision.selectedCandidateId",
      message: "Decision 必须选择结果中存在的 Candidate"
    });
  }

  validateSelectedCandidateBasis(selectedCandidate, requirement, graph, issues);
  validateEliminations(input.bundle, graph, issues);
  validateRiskClaimBasis(input.bundle, graph, issues);
  validateDecisionEvidenceClosure(input.bundle, graph, issues);

  return issues;
}

function evaluateDecisionBasisWithGraph(
  input: DecisionBasisEvaluationInputV1
): InternalEvaluation {
  const issues: ContractIssueV1[] = [];
  const candidateIds = collectUniqueIds(
    input.bundle.candidates,
    (candidate) => candidate.candidateId,
    "bundle.candidates",
    "candidateId",
    "Candidate",
    issues
  );
  const claimIds = collectUniqueIds(
    input.bundle.claims,
    (claim) => claim.claimId,
    "bundle.claims",
    "claimId",
    "Claim",
    issues
  );
  const evidenceIds = collectUniqueIds(
    input.bundle.evidence,
    (evidence) => evidence.evidenceId,
    "bundle.evidence",
    "evidenceId",
    "Evidence",
    issues
  );
  collectUniqueIds(
    input.bundle.claimEvidenceLinks,
    (link) => link.linkId,
    "bundle.claimEvidenceLinks",
    "linkId",
    "Claim-Evidence Link",
    issues
  );

  const linkedEvidenceIds = new Set<string>();
  const claimEvidencePairs = new Set<string>();

  input.bundle.candidates.forEach((candidate, index) => {
    if (candidate.decisionTaskId !== input.decisionTaskId) {
      issues.push({
        path: `bundle.candidates.${index}.decisionTaskId`,
        message: "Candidate 必须属于结果中的 Decision Task"
      });
    }
  });

  input.bundle.claims.forEach((claim, index) => {
    if (claim.decisionTaskId !== input.decisionTaskId) {
      issues.push({
        path: `bundle.claims.${index}.decisionTaskId`,
        message: "Claim 必须属于结果中的 Decision Task"
      });
    }

    if (!candidateIds.has(claim.subject.subjectId)) {
      issues.push({
        path: `bundle.claims.${index}.subject.subjectId`,
        message: "Claim 必须关联存在的 Candidate"
      });
    }
  });

  input.bundle.evidence.forEach((evidence, index) => {
    if (evidence.decisionTaskId !== input.decisionTaskId) {
      issues.push({
        path: `bundle.evidence.${index}.decisionTaskId`,
        message: "Evidence 必须属于结果中的 Decision Task"
      });
    }

    if (compareUtc(evidence.validUntil, evidence.capturedAt) < 0) {
      issues.push({
        path: `bundle.evidence.${index}.validUntil`,
        message: "Evidence 有效期不得早于采集时间"
      });
    }

    if (compareUtc(evidence.capturedAt, input.bundle.decision.validFrom) > 0) {
      issues.push({
        path: `bundle.evidence.${index}.capturedAt`,
        message: "Decision 不得引用形成时间之后采集的 Evidence"
      });
    }
  });

  if (
    compareUtc(input.bundle.decision.validUntil, input.bundle.decision.validFrom) < 0
  ) {
    issues.push({
      path: "bundle.decision.validUntil",
      message: "Decision 有效期不得早于生效时间"
    });
  }

  input.bundle.claimEvidenceLinks.forEach((link, index) => {
    const path = `bundle.claimEvidenceLinks.${index}`;

    if (link.decisionTaskId !== input.decisionTaskId) {
      issues.push({
        path: `${path}.decisionTaskId`,
        message: "Claim-Evidence Link 必须属于结果中的 Decision Task"
      });
    }

    if (!claimIds.has(link.claimId)) {
      issues.push({
        path: `${path}.claimId`,
        message: "Claim-Evidence Link 必须引用存在的 Claim"
      });
    }

    if (!evidenceIds.has(link.evidenceId)) {
      issues.push({
        path: `${path}.evidenceId`,
        message: "Claim-Evidence Link 必须引用存在的 Evidence"
      });
    } else {
      linkedEvidenceIds.add(link.evidenceId);
    }

    const pairKey = `${link.claimId}\u0000${link.evidenceId}`;

    if (claimEvidencePairs.has(pairKey)) {
      issues.push({
        path: `${path}.evidenceId`,
        message: "同一 Claim 与 Evidence 组合只能有一个关系方向"
      });
    }

    claimEvidencePairs.add(pairKey);
  });

  input.bundle.evidence.forEach((evidence, index) => {
    if (!linkedEvidenceIds.has(evidence.evidenceId)) {
      issues.push({
        path: `bundle.evidence.${index}.evidenceId`,
        message: "每份 Evidence 必须至少关联一个 Claim"
      });
    }
  });

  if (issues.length > 0) {
    return { claimAssessments: [], issues };
  }

  const candidatesById = new Map(
    input.bundle.candidates.map((candidate) => [candidate.candidateId, candidate] as const)
  );
  const claimsById = new Map(
    input.bundle.claims.map((claim) => [claim.claimId, claim] as const)
  );
  const evidenceById = new Map(
    input.bundle.evidence.map((evidence) => [evidence.evidenceId, evidence] as const)
  );
  const linksByClaimId = new Map<string, ClaimEvidenceLinkV1[]>();
  const linksByEvidenceId = new Map<string, ClaimEvidenceLinkV1[]>();

  for (const link of input.bundle.claimEvidenceLinks) {
    const claimLinks = linksByClaimId.get(link.claimId) ?? [];
    claimLinks.push(link);
    linksByClaimId.set(link.claimId, claimLinks);

    const evidenceLinks = linksByEvidenceId.get(link.evidenceId) ?? [];
    evidenceLinks.push(link);
    linksByEvidenceId.set(link.evidenceId, evidenceLinks);
  }

  const claimAssessments = [...input.bundle.claims]
    .sort((left, right) => compareCanonicalIds(left.claimId, right.claimId))
    .map((claim) =>
      deriveClaimAssessment(
        claim,
        linksByClaimId.get(claim.claimId) ?? [],
        evidenceById,
        input.bundle.decision.validFrom
      )
    );
  const claimAssessmentsById = new Map(
    claimAssessments.map((assessment) => [assessment.claimId, assessment] as const)
  );
  const claimsByCandidateAndPredicate = new Map<string, ClaimV1[]>();

  for (const claim of input.bundle.claims) {
    const key = claimIndexKey(claim.subject.subjectId, claim.predicate);
    const relatedClaims = claimsByCandidateAndPredicate.get(key) ?? [];
    relatedClaims.push(claim);
    claimsByCandidateAndPredicate.set(key, relatedClaims);
  }

  return {
    claimAssessments,
    graph: {
      candidatesById,
      claimsById,
      evidenceById,
      linksByEvidenceId,
      claimAssessmentsById,
      claimsByCandidateAndPredicate
    },
    issues
  };
}

function deriveClaimAssessment(
  claim: ClaimV1,
  links: readonly ClaimEvidenceLinkV1[],
  evidenceById: ReadonlyMap<string, EvidenceV1>,
  validFrom: string
): ClaimAssessmentV1 {
  const supportingEvidenceIds = new Set<string>();
  const refutingEvidenceIds = new Set<string>();

  for (const link of links) {
    const evidence = evidenceById.get(link.evidenceId);

    if (evidence === undefined || compareUtc(evidence.validUntil, validFrom) < 0) {
      continue;
    }

    if (link.direction === "SUPPORTS") {
      supportingEvidenceIds.add(link.evidenceId);
    } else {
      refutingEvidenceIds.add(link.evidenceId);
    }
  }

  const supporting = [...supportingEvidenceIds].sort();
  const refuting = [...refutingEvidenceIds].sort();
  const evidenceState =
    supporting.length > 0
      ? refuting.length > 0
        ? "CONFLICTED"
        : "SUPPORTED"
      : refuting.length > 0
        ? "REFUTED"
        : "INSUFFICIENT";

  return {
    contractType: "claim-assessment",
    contractVersion: "1.0",
    claimId: claim.claimId,
    evidenceState,
    supportingEvidenceIds: supporting,
    refutingEvidenceIds: refuting
  };
}

function validateCanonicalAssessments(
  actual: readonly ClaimAssessmentV1[],
  expected: readonly ClaimAssessmentV1[],
  issues: ContractIssueV1[]
): void {
  collectUniqueIds(
    actual,
    (assessment) => assessment.claimId,
    "bundle.claimAssessments",
    "claimId",
    "Claim Assessment",
    issues
  );

  if (actual.length !== expected.length) {
    issues.push({
      path: "bundle.claimAssessments",
      message: "每个 Claim 必须恰有一份规范化 Claim Assessment"
    });
  }

  const comparisonLength = Math.min(actual.length, expected.length);

  for (let index = 0; index < comparisonLength; index += 1) {
    const actualAssessment = actual[index];
    const expectedAssessment = expected[index];

    if (
      actualAssessment === undefined ||
      expectedAssessment === undefined ||
      !isSameAssessment(actualAssessment, expectedAssessment)
    ) {
      issues.push({
        path: `bundle.claimAssessments.${index}`,
        message: "Claim Assessment 必须等于 Decision Basis 的规范化派生结果"
      });
    }
  }
}

function isSameAssessment(
  left: ClaimAssessmentV1,
  right: ClaimAssessmentV1
): boolean {
  return (
    left.contractType === right.contractType &&
    left.contractVersion === right.contractVersion &&
    left.claimId === right.claimId &&
    left.evidenceState === right.evidenceState &&
    areSameStrings(left.supportingEvidenceIds, right.supportingEvidenceIds) &&
    areSameStrings(left.refutingEvidenceIds, right.refutingEvidenceIds)
  );
}

function areSameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  );
}

function validateSelectedCandidateBasis(
  selectedCandidate: CandidateV1 | undefined,
  requirement: RequirementRevisionV1,
  graph: EvidenceGraph,
  issues: ContractIssueV1[]
): void {
  if (selectedCandidate === undefined) {
    return;
  }

  const hardBudget = requirement.budget;

  if (hardBudget?.confirmed === true && hardBudget.hard) {
    const budgetAssessment = assessCandidateBudgetConstraint(
      selectedCandidate,
      hardBudget,
      graph
    );

    if (budgetAssessment.status !== "SATISFIED") {
      issues.push({
        path: "bundle.decision.selectedCandidateId",
        message: "被选 Candidate 的价格事实必须满足已确认的硬预算"
      });
    }
  }

  const satisfiesMustHaves = requirement.mustHaves.every(
    (constraint) =>
      assessCandidateConstraint(selectedCandidate.candidateId, constraint, graph).status ===
      "SATISFIED"
  );

  if (!satisfiesMustHaves) {
    issues.push({
      path: "bundle.decision.selectedCandidateId",
      message: "被选 Candidate 必须满足每项 must-have"
    });
  }
}

function validateEliminations(
  bundle: DecisionBundleV1,
  graph: EvidenceGraph,
  issues: ContractIssueV1[]
): void {
  const decision = bundle.decision;
  const hardBudget = bundle.requirementRevision.budget;
  const hardConstraintKeys = new Set(
    bundle.requirementRevision.mustHaves.map((constraint) => constraint.key)
  );
  const dispositionCandidateIds = new Set<string>();

  if (hardBudget?.confirmed === true && hardBudget.hard) {
    hardConstraintKeys.add("budget.maxAmountMinor");
  }

  decision.candidateDispositions.forEach((disposition, index) => {
    const path = `bundle.decision.candidateDispositions.${index}`;

    if (dispositionCandidateIds.has(disposition.candidateId)) {
      issues.push({
        path: `${path}.candidateId`,
        message: "同一 Candidate 只能拥有一个 Candidate Disposition"
      });
    } else {
      dispositionCandidateIds.add(disposition.candidateId);
    }

    if (disposition.candidateId === decision.selectedCandidateId) {
      issues.push({
        path: `${path}.candidateId`,
        message: "被选 Candidate 不能拥有 Candidate Disposition"
      });
    }

    const candidate = graph.candidatesById.get(disposition.candidateId);

    if (candidate === undefined) {
      issues.push({
        path: `${path}.candidateId`,
        message: "Candidate Disposition 必须关联存在的 Candidate"
      });
    }

    disposition.evidenceIds.forEach((evidenceId, evidenceIndex) => {
      const evidence = graph.evidenceById.get(evidenceId);

      if (evidence === undefined) {
        issues.push({
          path: `${path}.evidenceIds.${evidenceIndex}`,
          message: "Candidate Disposition 引用了不存在的 Evidence"
        });
        return;
      }

      const describesCandidate = (graph.linksByEvidenceId.get(evidenceId) ?? []).some(
        (link) =>
          graph.claimsById.get(link.claimId)?.subject.subjectId === disposition.candidateId
      );

      if (!describesCandidate) {
        issues.push({
          path: `${path}.evidenceIds.${evidenceIndex}`,
          message: "Candidate Disposition Evidence 必须描述对应 Candidate"
        });
      }
    });

    if (!hardConstraintKeys.has(disposition.requirementKey)) {
      issues.push({
        path: `${path}.requirementKey`,
        message: "ELIMINATED Disposition 必须引用真实 Hard Constraint"
      });
    }

    const assessment = assessDispositionConstraint(
      disposition.candidateId,
      disposition.requirementKey,
      bundle.requirementRevision,
      graph
    );
    const provesViolation =
      assessment.status === "VIOLATED" &&
      disposition.evidenceIds.some((evidenceId) =>
        assessment.supportingEvidenceIds.has(evidenceId)
      );

    if (hardConstraintKeys.has(disposition.requirementKey) && !provesViolation) {
      issues.push({
        path: `${path}.requirementKey`,
        message: "ELIMINATED Evidence 必须证明 Candidate 违反 Hard Constraint"
      });
    }
  });

  if (decision.status !== "NEED_MORE_INFO") {
    bundle.candidates.forEach((candidate, index) => {
      if (
        candidate.candidateId !== decision.selectedCandidateId &&
        !dispositionCandidateIds.has(candidate.candidateId)
      ) {
        issues.push({
          path: `bundle.candidates.${index}.candidateId`,
          message: "未选 Candidate 必须拥有 Candidate Disposition"
        });
      }
    });
  }
}

function validateRiskClaimBasis(
  bundle: DecisionBundleV1,
  graph: EvidenceGraph,
  issues: ContractIssueV1[]
): void {
  const decisionEvidenceIds = new Set(bundle.decision.evidenceIds);

  bundle.decision.risks.forEach((risk, index) => {
    const candidatePath = `bundle.decision.risks.${index}.candidateId`;
    const claimPath = `bundle.decision.risks.${index}.statementClaimId`;

    if (!graph.candidatesById.has(risk.candidateId)) {
      issues.push({ path: candidatePath, message: "Decision Risk 必须关联存在的 Candidate" });
    }

    if (risk.candidateId !== bundle.decision.selectedCandidateId) {
      issues.push({ path: candidatePath, message: "Decision Risk 必须关联被选 Candidate" });
    }

    const statementClaim = graph.claimsById.get(risk.statementClaimId);

    if (statementClaim === undefined) {
      issues.push({ path: claimPath, message: "Decision Risk 必须引用存在的 Claim" });
      return;
    }

    if (statementClaim.subject.subjectId !== risk.candidateId) {
      issues.push({ path: claimPath, message: "Decision Risk Claim 必须描述对应 Candidate" });
    }

    const assessment = graph.claimAssessmentsById.get(statementClaim.claimId);

    if (assessment?.evidenceState !== "SUPPORTED") {
      issues.push({
        path: claimPath,
        message: "Decision Risk Claim 必须由权威 Assessment 判定为 SUPPORTED"
      });
      return;
    }

    if (assessment.supportingEvidenceIds.length === 0) {
      issues.push({
        path: claimPath,
        message: "Decision Risk Claim 必须至少有一条有效 SUPPORTS Evidence"
      });
    } else if (
      !assessment.supportingEvidenceIds.some((evidenceId) =>
        decisionEvidenceIds.has(evidenceId)
      )
    ) {
      issues.push({
        path: claimPath,
        message: "Decision Risk 的 SUPPORTS Evidence 必须进入 Decision Evidence"
      });
    }
  });
}

function validateDecisionEvidenceClosure(
  bundle: DecisionBundleV1,
  graph: EvidenceGraph,
  issues: ContractIssueV1[]
): void {
  const decisionEvidenceIds = new Set(bundle.decision.evidenceIds);

  if (bundle.decision.evidenceIds.length === 0) {
    issues.push({
      path: "bundle.decision.evidenceIds",
      message: "Decision 必须引用至少一条 Evidence"
    });
  }

  bundle.decision.evidenceIds.forEach((evidenceId, index) => {
    if (!graph.evidenceById.has(evidenceId)) {
      issues.push({
        path: `bundle.decision.evidenceIds.${index}`,
        message: "Decision 引用了不存在的 Evidence"
      });
    }
  });

  const selectedCandidate =
    bundle.decision.selectedCandidateId === undefined
      ? undefined
      : graph.candidatesById.get(bundle.decision.selectedCandidateId);

  if (selectedCandidate === undefined) {
    return;
  }

  const budget = bundle.requirementRevision.budget;

  if (budget?.confirmed === true && budget.hard) {
    const budgetAssessment = assessCandidateBudgetConstraint(selectedCandidate, budget, graph);

    if (budgetAssessment.status === "SATISFIED") {
      budgetAssessment.supportingEvidenceIds.forEach((evidenceId) => {
        if (!decisionEvidenceIds.has(evidenceId)) {
          issues.push({
            path: "bundle.decision.evidenceIds",
            message: "被选 Candidate 的预算 Evidence 必须进入 Decision Evidence"
          });
        }
      });
    }
  }

  bundle.requirementRevision.mustHaves.forEach((constraint) => {
    const assessment = assessCandidateConstraint(
      selectedCandidate.candidateId,
      constraint,
      graph
    );

    if (assessment.status === "SATISFIED") {
      assessment.supportingEvidenceIds.forEach((evidenceId) => {
        if (!decisionEvidenceIds.has(evidenceId)) {
          issues.push({
            path: "bundle.decision.evidenceIds",
            message: "被选 Candidate 的 must-have Evidence 必须进入 Decision Evidence"
          });
        }
      });
    }
  });
}

function assessDispositionConstraint(
  candidateId: string,
  requirementKey: string,
  requirement: RequirementRevisionV1,
  graph: EvidenceGraph
): CandidateConstraintAssessment {
  if (requirementKey === "budget.maxAmountMinor") {
    const candidate = graph.candidatesById.get(candidateId);
    const budget = requirement.budget;

    return candidate !== undefined && budget?.confirmed === true && budget.hard
      ? assessCandidateBudgetConstraint(candidate, budget, graph)
      : createIndeterminateAssessment();
  }

  const constraint = requirement.mustHaves.find(
    (mustHave) => mustHave.key === requirementKey
  );

  return constraint === undefined
    ? createIndeterminateAssessment()
    : assessCandidateConstraint(candidateId, constraint, graph);
}

function assessCandidateBudgetConstraint(
  candidate: CandidateV1,
  budget: NonNullable<RequirementRevisionV1["budget"]>,
  graph: EvidenceGraph
): CandidateConstraintAssessment {
  const trustedValues = collectTrustedClaimValues(
    candidate.candidateId,
    "price.observed",
    graph,
    (claim) =>
      claim.value.kind === "MONEY" && claim.value.currency === candidate.observedPrice.currency
        ? claim.value.amountMinor
        : undefined
  );
  const amountMinor = getOnlyValue(trustedValues?.values);

  if (amountMinor === undefined || amountMinor !== candidate.observedPrice.amountMinor) {
    return createIndeterminateAssessment();
  }

  return {
    status: amountMinor <= budget.maxAmountMinor ? "SATISFIED" : "VIOLATED",
    supportingEvidenceIds: trustedValues?.supportingEvidenceIds ?? new Set()
  };
}

function assessCandidateConstraint(
  candidateId: string,
  constraint: RequirementConstraintV1,
  graph: EvidenceGraph
): CandidateConstraintAssessment {
  const trustedValues = collectTrustedClaimValues(
    candidateId,
    constraint.key,
    graph,
    (claim) =>
      claim.value.kind === "QUANTITY" && claim.value.unit === constraint.value.unit
        ? claim.value.amount
        : undefined
  );
  const amount = getOnlyValue(trustedValues?.values);

  if (amount === undefined) {
    return createIndeterminateAssessment();
  }

  const satisfied =
    constraint.operator === "AT_LEAST"
      ? amount >= constraint.value.amount
      : constraint.operator === "AT_MOST"
        ? amount <= constraint.value.amount
        : amount === constraint.value.amount;

  return {
    status: satisfied ? "SATISFIED" : "VIOLATED",
    supportingEvidenceIds: trustedValues?.supportingEvidenceIds ?? new Set()
  };
}

function collectTrustedClaimValues(
  candidateId: string,
  predicate: string,
  graph: EvidenceGraph,
  readValue: (claim: ClaimV1) => number | undefined
): TrustedClaimValues | undefined {
  const relevantClaims = graph.claimsByCandidateAndPredicate.get(
    claimIndexKey(candidateId, predicate)
  );
  const factClaims = relevantClaims?.filter(
    (claim) => claim.claimKind === "FACT_ASSERTION"
  );

  if (factClaims === undefined || factClaims.length === 0) {
    return undefined;
  }

  const values = new Set<number>();
  const supportingEvidenceIds = new Set<string>();

  for (const claim of factClaims) {
    const value = readValue(claim);
    const assessment = graph.claimAssessmentsById.get(claim.claimId);

    if (assessment?.evidenceState !== "SUPPORTED" || value === undefined) {
      return undefined;
    }

    for (const evidenceId of assessment.supportingEvidenceIds) {
      supportingEvidenceIds.add(evidenceId);
    }

    values.add(value);
  }

  return { values, supportingEvidenceIds };
}

function getOnlyValue(values: ReadonlySet<number> | undefined): number | undefined {
  if (values === undefined || values.size !== 1) {
    return undefined;
  }

  return values.values().next().value;
}

function createIndeterminateAssessment(): CandidateConstraintAssessment {
  return { status: "INDETERMINATE", supportingEvidenceIds: new Set() };
}

function compareUtc(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

// 规范化 ID 排序使用固定码元比较,不依赖运行环境 Locale,保证跨进程结果逐字段一致
function compareCanonicalIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function claimIndexKey(candidateId: string, predicate: string): string {
  return `${candidateId}\u0000${predicate}`;
}

function collectUniqueIds<Item>(
  items: readonly Item[],
  getId: (item: Item) => string,
  collectionPath: string,
  idField: string,
  entityName: string,
  issues: ContractIssueV1[]
): Set<string> {
  const ids = new Set<string>();

  items.forEach((item, index) => {
    const id = getId(item);

    if (ids.has(id)) {
      issues.push({
        path: `${collectionPath}.${index}.${idField}`,
        message: `${entityName} ID 在结果中必须唯一`
      });
    }

    ids.add(id);
  });

  return ids;
}
