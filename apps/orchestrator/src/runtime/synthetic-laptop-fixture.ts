import type { AgentRuntimeRunCommandV1, AgentRuntimeRunOutputV1 } from "./port.js";

const observedAt = "2026-08-12T12:00:00.000Z";
const validUntil = "2026-08-19T12:00:00.000Z";

export function buildSyntheticLaptopRunOutput(
  command: AgentRuntimeRunCommandV1
): AgentRuntimeRunOutputV1 {
  const taskId = command.decisionTaskId;
  const needsBudget =
    command.requirementRevision.budget?.confirmed !== true ||
    command.requirementRevision.unknowns.includes("budget.maxAmountMinor");
  const needsPreference =
    !needsBudget &&
    command.requirementRevision.budget?.hard === true &&
    command.requirementRevision.budget.maxAmountMinor >= 839900;
  const candidates = [
    {
      contractType: "candidate" as const,
      contractVersion: "1.0" as const,
      candidateId: "candidate-synth-a",
      decisionTaskId: taskId,
      displayName: "合成笔记本 A",
      synthetic: true as const,
      identity: {
        model: "CM-SYNTH-LAPTOP-A",
        sku: "CM-SYNTH-LAPTOP-A-32",
        market: "CN" as const,
        configuration: "32 GiB 内存 / 1 TiB 存储"
      },
      observedPrice: {
        amountMinor: 769900,
        currency: "CNY" as const,
        observedAt
      }
    },
    {
      contractType: "candidate" as const,
      contractVersion: "1.0" as const,
      candidateId: "candidate-synth-b",
      decisionTaskId: taskId,
      displayName: "合成笔记本 B",
      synthetic: true as const,
      identity: {
        model: "CM-SYNTH-LAPTOP-B",
        sku: "CM-SYNTH-LAPTOP-B-32",
        market: "CN" as const,
        configuration: "32 GiB 内存 / 1 TiB 存储"
      },
      observedPrice: {
        amountMinor: 839900,
        currency: "CNY" as const,
        observedAt
      }
    }
  ];

  const claims = [
    {
      contractType: "claim" as const,
      contractVersion: "1.0" as const,
      claimId: "claim-synth-a-price",
      decisionTaskId: taskId,
      subject: { subjectType: "CANDIDATE" as const, subjectId: "candidate-synth-a" },
      predicate: "price.observed",
      value: { kind: "MONEY" as const, amountMinor: 769900, currency: "CNY" as const },
      claimKind: "FACT_ASSERTION" as const
    },
    {
      contractType: "claim" as const,
      contractVersion: "1.0" as const,
      claimId: "claim-synth-a-memory-upgradeable",
      decisionTaskId: taskId,
      subject: { subjectType: "CANDIDATE" as const, subjectId: "candidate-synth-a" },
      predicate: "memory.upgradeable",
      value: { kind: "BOOLEAN" as const, value: false },
      claimKind: "FACT_ASSERTION" as const
    },
    {
      contractType: "claim" as const,
      contractVersion: "1.0" as const,
      claimId: "claim-synth-a-memory-capacity",
      decisionTaskId: taskId,
      subject: { subjectType: "CANDIDATE" as const, subjectId: "candidate-synth-a" },
      predicate: "memory.capacity",
      value: { kind: "QUANTITY" as const, amount: 32, unit: "GiB" },
      claimKind: "FACT_ASSERTION" as const
    },
    {
      contractType: "claim" as const,
      contractVersion: "1.0" as const,
      claimId: "claim-synth-a-storage-capacity",
      decisionTaskId: taskId,
      subject: { subjectType: "CANDIDATE" as const, subjectId: "candidate-synth-a" },
      predicate: "storage.capacity",
      value: { kind: "QUANTITY" as const, amount: 1, unit: "TiB" },
      claimKind: "FACT_ASSERTION" as const
    },
    {
      contractType: "claim" as const,
      contractVersion: "1.0" as const,
      claimId: "claim-synth-b-price",
      decisionTaskId: taskId,
      subject: { subjectType: "CANDIDATE" as const, subjectId: "candidate-synth-b" },
      predicate: "price.observed",
      value: { kind: "MONEY" as const, amountMinor: 839900, currency: "CNY" as const },
      claimKind: "FACT_ASSERTION" as const
    },
    {
      contractType: "claim" as const,
      contractVersion: "1.0" as const,
      claimId: "claim-synth-b-memory-capacity",
      decisionTaskId: taskId,
      subject: { subjectType: "CANDIDATE" as const, subjectId: "candidate-synth-b" },
      predicate: "memory.capacity",
      value: { kind: "QUANTITY" as const, amount: 32, unit: "GiB" },
      claimKind: "FACT_ASSERTION" as const
    },
    {
      contractType: "claim" as const,
      contractVersion: "1.0" as const,
      claimId: "claim-synth-b-storage-capacity",
      decisionTaskId: taskId,
      subject: { subjectType: "CANDIDATE" as const, subjectId: "candidate-synth-b" },
      predicate: "storage.capacity",
      value: { kind: "QUANTITY" as const, amount: 1, unit: "TiB" },
      claimKind: "FACT_ASSERTION" as const
    }
  ];

  const evidence = [
    buildEvidence(taskId, "evidence-synth-a-price", "price", "合成观测价为 7699 元"),
    buildEvidence(
      taskId,
      "evidence-synth-a-memory-upgradeable",
      "memory.upgradeable",
      "合成规格标记内存不可升级"
    ),
    buildEvidence(
      taskId,
      "evidence-synth-a-memory-capacity",
      "memory.capacity",
      "合成内存容量为 32 GiB"
    ),
    buildEvidence(
      taskId,
      "evidence-synth-a-storage-capacity",
      "storage.capacity",
      "合成存储容量为 1 TiB"
    ),
    buildEvidence(taskId, "evidence-synth-b-price", "price", "合成观测价为 8399 元"),
    buildEvidence(
      taskId,
      "evidence-synth-b-memory-capacity",
      "memory.capacity",
      "合成内存容量为 32 GiB"
    ),
    buildEvidence(
      taskId,
      "evidence-synth-b-storage-capacity",
      "storage.capacity",
      "合成存储容量为 1 TiB"
    )
  ];

  const claimEvidenceLinks = ([
    ["claim-synth-a-price", "evidence-synth-a-price"],
    ["claim-synth-a-memory-upgradeable", "evidence-synth-a-memory-upgradeable"],
    ["claim-synth-a-memory-capacity", "evidence-synth-a-memory-capacity"],
    ["claim-synth-a-storage-capacity", "evidence-synth-a-storage-capacity"],
    ["claim-synth-b-price", "evidence-synth-b-price"],
    ["claim-synth-b-memory-capacity", "evidence-synth-b-memory-capacity"],
    ["claim-synth-b-storage-capacity", "evidence-synth-b-storage-capacity"]
  ] as const).map(([claimId, evidenceId], index) => ({
    contractType: "claim-evidence-link" as const,
    contractVersion: "1.0" as const,
    linkId: `link-synth-${index + 1}`,
    decisionTaskId: taskId,
    claimId,
    evidenceId,
    direction: "SUPPORTS" as const
  }));

  const states = [
    ["CREATED", "已创建合成决策任务"],
    ["UNDERSTANDING", "正在理解合成需求"],
    ["PLANNING", "正在规划合成研究"],
    ["RESEARCHING", "正在读取合成候选资料"],
    ["VERIFYING", "正在核验合成证据"],
    ["COMPARING", "正在比较候选与硬约束"],
    ["CRITIQUING", "正在检查风险与反例"],
    ["GENERATING", "正在形成结构化决策"],
    ["COMPLETED", "合成决策已经完成"]
  ] as const;

  return {
    candidates,
    claims,
    evidence,
    claimEvidenceLinks,
    decision: {
      contractType: "decision-revision",
      contractVersion: "1.0",
      decisionRevisionId: `decision-${taskId}-r1`,
      decisionTaskId: taskId,
      requirementRevisionId: command.requirementRevision.requirementRevisionId,
      revision: 1,
      status: needsBudget || needsPreference ? "NEED_MORE_INFO" : "BUY_IF_PRICE",
      summary: needsBudget
        ? "预算上限尚未确认，当前不能安全形成购买结论。"
        : needsPreference
          ? "两个候选都满足已知硬约束，需要补充偏好后才能形成可审查的选择。"
          : "候选 A 满足硬约束；仅在核验价不高于 7800 元且提供官方保修时考虑购买。",
      ...(needsBudget || needsPreference ? {} : { selectedCandidateId: "candidate-synth-a" }),
      conditions: needsBudget || needsPreference
        ? []
        : [
            {
              conditionId: "condition-synth-max-price",
              conditionType: "MAX_PRICE",
              candidateId: "candidate-synth-a",
              amountMinor: 780000,
              currency: "CNY",
              verification: "由用户在外部销售渠道核验实际到手价"
            },
            {
              conditionId: "condition-synth-official-warranty",
              conditionType: "OFFICIAL_WARRANTY",
              candidateId: "candidate-synth-a",
              verification: "由用户确认销售渠道提供官方保修"
            }
          ],
      candidateDispositions: needsBudget || needsPreference
        ? []
        : [
            {
              dispositionId: "disposition-synth-b-budget",
              dispositionType: "ELIMINATED",
              candidateId: "candidate-synth-b",
              requirementKey: "budget.maxAmountMinor",
              reason: "合成观测价 8399 元超过 8000 元硬预算",
              evidenceIds: ["evidence-synth-b-price"]
            }
          ],
      risks: needsBudget || needsPreference
        ? []
        : [
            {
              riskId: "risk-synth-memory-upgradeable",
              candidateId: "candidate-synth-a",
              statementClaimId: "claim-synth-a-memory-upgradeable",
              verification: "购买前由用户核验准确 SKU 的官方规格"
            }
          ],
      evidenceIds: [
        "evidence-synth-a-price",
        "evidence-synth-a-memory-upgradeable",
        "evidence-synth-a-memory-capacity",
        "evidence-synth-a-storage-capacity",
        "evidence-synth-b-price",
        "evidence-synth-b-memory-capacity",
        "evidence-synth-b-storage-capacity"
      ],
      criticalGaps: needsBudget
        ? [
            {
              gapId: "gap-synth-budget",
              key: "budget.maxAmountMinor",
              question: "你的最高预算是多少？",
              resolution: {
                resolutionType: "PROVIDE_REQUIREMENT",
                requirementKey: "budget.maxAmountMinor"
              }
            }
          ]
        : needsPreference
          ? [
              {
                gapId: "gap-synth-primary-preference",
                key: "preference.primary",
                question: "两个候选都满足硬约束，你更看重更低价格还是其他使用偏好？",
                resolution: {
                  resolutionType: "PROVIDE_REQUIREMENT",
                  requirementKey: "preference.primary"
                }
              }
            ]
        : [],
      assumptions: [],
      validFrom: observedAt,
      validUntil,
      nextSteps: needsBudget
        ? [
            {
              actionType: "PROVIDE_REQUIREMENT" as const,
              requirementKey: "budget.maxAmountMinor",
              instruction: "请补充最高预算后重新执行决策"
            }
          ]
        : needsPreference
          ? [
              {
                actionType: "PROVIDE_REQUIREMENT" as const,
                requirementKey: "preference.primary",
                instruction: "请说明更看重价格、重量、续航或其他使用偏好"
              }
            ]
        : [
            {
              actionType: "VERIFY_CONDITION" as const,
              conditionId: "condition-synth-max-price",
              instruction: "核验实际到手价"
            },
            {
              actionType: "VERIFY_CONDITION" as const,
              conditionId: "condition-synth-official-warranty",
              instruction: "确认销售渠道提供官方保修"
            },
            {
              actionType: "VERIFY_RISK" as const,
              riskId: "risk-synth-memory-upgradeable",
              instruction: "核验准确 SKU 的内存规格"
            }
          ],
      synthetic: true
    },
    runEvents: states.map(([taskState, summary], index) => ({
      contractType: "run-event" as const,
      contractVersion: "1.0" as const,
      eventId: `event-synth-${index + 1}`,
      decisionTaskId: taskId,
      agentRunId: command.agentRunId,
      sequence: index + 1,
      occurredAt: `2026-08-12T12:00:0${index}.000Z`,
      eventType: index === states.length - 1 ? ("RUNTIME_SUCCEEDED" as const) : ("TASK_STATE_CHANGED" as const),
      taskState,
      summary,
      synthetic: true as const
    }))
  };
}

function buildEvidence(
  decisionTaskId: string,
  evidenceId: string,
  field: string,
  excerpt: string
) {
  return {
    contractType: "evidence" as const,
    contractVersion: "1.0" as const,
    evidenceId,
    decisionTaskId,
    synthetic: true as const,
    source: {
      sourceKind: "SYNTHETIC" as const,
      sourceId: "source-synth-laptop-fixture",
      title: "ChoiceMind 合成笔记本测试资料"
    },
    capturedAt: observedAt,
    locator: { section: "synthetic-laptop", field },
    excerpt,
    validUntil
  };
}
