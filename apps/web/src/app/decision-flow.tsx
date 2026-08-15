"use client";

import {
  createUnknownDecisionExecutionResultV1,
  decodeDecisionTaskResultV1,
  getDecisionTaskResultHttpStatusV1,
  type ClaimValueV1,
  type DecisionTaskResultV1,
  type SuccessfulDecisionTaskResultV1
} from "@choicemind/contracts/decision/v1";
import { type FormEvent, useState } from "react";

const defaultRequirement = "预算不超过 8000 元，至少 32 GiB 内存和 1 TiB 存储。";

export function DecisionFlow() {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<DecisionTaskResultV1 | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setResult(null);
    const id = crypto.randomUUID();

    try {
      const response = await fetch("/api/decision-tasks/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contractType: "execute-decision-task-command",
          contractVersion: "1.0",
          executionRequestId: `exec-${id}`,
          requirementRevision: {
            contractType: "requirement-revision",
            contractVersion: "1.0",
            requirementRevisionId: `req-${id}-r1`,
            decisionTaskId: `task-${id}`,
            revision: 1,
            submittedText: defaultRequirement,
            market: { country: "CN", currency: "CNY", locale: "zh-CN" },
            intendedUses: ["软件开发"],
            budget: {
              confirmed: true,
              currency: "CNY",
              hard: true,
              maxAmountMinor: 800000
            },
            mustHaves: [
              {
                key: "memory.capacity",
                operator: "AT_LEAST",
                value: { amount: 32, unit: "GiB" }
              },
              {
                key: "storage.capacity",
                operator: "AT_LEAST",
                value: { amount: 1, unit: "TiB" }
              }
            ],
            niceToHaves: [],
            mustNotHaves: [],
            unknowns: []
          }
        })
      });
      const decodedResult = decodeDecisionTaskResultV1(await response.json());
      const responseBody = decodedResult.ok ? decodedResult.value : undefined;

      setResult(
        responseBody !== undefined &&
          response.status === getDecisionTaskResultHttpStatusV1(responseBody)
          ? responseBody
          : createUnknownDecisionExecutionResultV1({
              errorId: "error-web-response-status-mismatch",
              occurredAt: new Date().toISOString()
            })
      );
    } catch {
      setResult(
        createUnknownDecisionExecutionResultV1({
          errorId: "error-web-decision-execution-status-unknown",
          occurredAt: new Date().toISOString()
        })
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="decision-heading">
      <h1 id="decision-heading">智能消费决策</h1>
      <p>使用固定合成候选验证 ChoiceMind 的决策合同，不访问真实商品或价格。</p>
      <form onSubmit={submit}>
        <label htmlFor="requirement">合成消费需求</label>
        <textarea
          id="requirement"
          name="requirement"
          rows={4}
          required
          readOnly
          value={defaultRequirement}
        />
        <p>P0 固定合成示例，不解析任意自然语言需求。</p>
        <button type="submit" disabled={pending}>
          {pending ? "正在执行" : "运行合成决策"}
        </button>
      </form>
      <p aria-live="polite">{pending ? "正在理解需求并核验合成证据" : ""}</p>
      {result === null ? null : result.ok ? (
        <DecisionResult result={result} />
      ) : (
        <section aria-labelledby="decision-error-heading">
          <h2 id="decision-error-heading">决策任务失败</h2>
          <p>{result.error.message}</p>
          <p>{result.error.code}</p>
        </section>
      )}
    </section>
  );
}

function DecisionResult({ result }: Readonly<{ result: SuccessfulDecisionTaskResultV1 }>) {
  const { candidates, claimAssessments, claims, decision, evidence } = result.bundle;
  const selected = candidates.find(
    (candidate) => candidate.candidateId === decision.selectedCandidateId
  );
  const claimsById = new Map(claims.map((claim) => [claim.claimId, claim] as const));
  const assessmentsByClaimId = new Map(
    claimAssessments.map((assessment) => [assessment.claimId, assessment] as const)
  );
  const evidenceById = new Map(evidence.map((item) => [item.evidenceId, item] as const));
  const decisionHeading =
    decision.status === "BUY_IF_PRICE"
      ? "有条件购买"
      : decision.status === "NEED_MORE_INFO"
        ? "需要补充信息"
        : decision.status;

  return (
    <section aria-labelledby="decision-result-heading">
      <p role="note">合成测试数据，不代表真实商品、价格或购买建议</p>
      <h2 id="decision-result-heading">{decisionHeading}</h2>
      <p>{decision.summary}</p>
      {selected === undefined ? null : (
        <p>
          候选：{selected.displayName}（{selected.identity.sku}）
        </p>
      )}

      <h3>成立条件</h3>
      <ul>
        {decision.conditions.map((condition) => (
          <li key={condition.conditionId}>
            {condition.conditionType === "MAX_PRICE"
              ? `实际到手价不高于 ${condition.amountMinor / 100} 元；${condition.verification}`
              : `必须提供官方保修；${condition.verification}`}
          </li>
        ))}
      </ul>

      <h3>候选去向</h3>
      <ul>
        {decision.candidateDispositions.map((disposition) => (
          <li key={disposition.dispositionId}>
            违反硬约束，已淘汰：{disposition.reason}
          </li>
        ))}
      </ul>

      <h3>风险</h3>
      <ul>
        {decision.risks.map((risk) => {
          const statementClaim = claimsById.get(risk.statementClaimId);
          const assessment = assessmentsByClaimId.get(risk.statementClaimId);
          const supportingEvidence = assessment?.supportingEvidenceIds
            .map((evidenceId) => evidenceById.get(evidenceId))
            .find((item) => item !== undefined);

          return (
            <li key={risk.riskId}>
              {statementClaim === undefined
                ? "风险依据不可用"
                : `${statementClaim.predicate}：${formatClaimValue(statementClaim.value)}；${supportingEvidence?.excerpt ?? "证据摘录不可用"}；${risk.verification}`}
            </li>
          );
        })}
      </ul>

      <h3>Claim 评估</h3>
      <ul>
        {claimAssessments.map((assessment) => {
          const claim = claimsById.get(assessment.claimId);

          if (claim === undefined) {
            return <li key={assessment.claimId}>Claim 依据不可用</li>;
          }

          return (
            <li key={assessment.claimId}>
              {claim.predicate}：{formatClaimValue(claim.value)}；类型：{claim.claimKind}
              ；证据状态：{assessment.evidenceState}
              <EvidenceReferences
                evidenceIds={assessment.supportingEvidenceIds}
                evidenceById={evidenceById}
                label="支持证据"
              />
              <EvidenceReferences
                evidenceIds={assessment.refutingEvidenceIds}
                evidenceById={evidenceById}
                label="反驳证据"
              />
            </li>
          );
        })}
      </ul>

      <h3>下一步</h3>
      <ul>
        {decision.nextSteps.map((nextStep) => {
          const target =
            nextStep.actionType === "PROVIDE_REQUIREMENT"
              ? nextStep.requirementKey
              : nextStep.actionType === "VERIFY_CONDITION"
                ? nextStep.conditionId
                : nextStep.riskId;

          return <li key={`${nextStep.actionType}-${target}`}>{nextStep.instruction}</li>;
        })}
      </ul>

      {decision.criticalGaps.length > 0 ? (
        <section aria-labelledby="critical-gaps-heading">
          <h3 id="critical-gaps-heading">需要你补充</h3>
          <ul>
            {decision.criticalGaps.map((gap) => (
              <li key={gap.gapId}>{gap.question}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <h3>证据链</h3>
      {evidence.map((item) => (
        <details key={item.evidenceId} open>
          <summary>{item.source.title}</summary>
          <p>来源类型：{item.source.sourceKind}</p>
          <p>{item.excerpt}</p>
          <p>
            定位：{item.locator.section} / {item.locator.field}
          </p>
          <p>证据有效期：{item.validUntil}</p>
          {Date.parse(item.validUntil) < Date.parse(decision.validFrom) ? (
            <p>形成 Decision 时已过期，仅供追溯</p>
          ) : null}
        </details>
      ))}

      <p>Decision 有效期：{decision.validUntil}</p>
      <h3>执行过程</h3>
      <ol>
        {result.runEvents.map((runEvent) => (
          <li key={runEvent.eventId}>{runEvent.summary}</li>
        ))}
      </ol>
    </section>
  );
}

function EvidenceReferences({
  evidenceIds,
  evidenceById,
  label
}: Readonly<{
  evidenceIds: readonly string[];
  evidenceById: ReadonlyMap<
    string,
    SuccessfulDecisionTaskResultV1["bundle"]["evidence"][number]
  >;
  label: string;
}>) {
  if (evidenceIds.length === 0) {
    return <p>{label}：无</p>;
  }

  return (
    <p>
      {label}：
      {evidenceIds
        .map((evidenceId) => evidenceById.get(evidenceId)?.excerpt ?? "证据摘录不可用")
        .join("；")}
    </p>
  );
}

function formatClaimValue(value: ClaimValueV1): string {
  switch (value.kind) {
    case "MONEY":
      return `${value.amountMinor / 100} 元`;
    case "QUANTITY":
      return `${value.amount} ${value.unit}`;
    case "BOOLEAN":
      return value.value ? "是" : "否";
    case "TEXT":
      return value.value;
  }
}
