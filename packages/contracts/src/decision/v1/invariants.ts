import { checkDecisionBasisV1 } from "./decision-basis.js";
import type { ContractIssueV1, DecisionTaskResultV1 } from "./index.js";

const authoritativeRunStates = [
  "CREATED",
  "UNDERSTANDING",
  "PLANNING",
  "RESEARCHING",
  "VERIFYING",
  "GAP_RESEARCH",
  "COMPARING",
  "CRITIQUING",
  "GENERATING",
  "COMPLETED"
] as const;

const errorSemanticsByCode = {
  CONTRACT_INVALID: { category: "VALIDATION", retryMode: "NONE" },
  CONTRACT_VERSION_UNSUPPORTED: { category: "VERSION", retryMode: "NONE" },
  AGENT_RUNTIME_FAILED: { category: "RUNTIME", retryMode: "NEW_EXECUTION_ALLOWED" },
  DECISION_EXECUTION_STATUS_UNKNOWN: {
    category: "TRANSPORT",
    retryMode: "SAME_EXECUTION_ONLY"
  }
} as const;

export function checkDecisionTaskResultInvariants(
  result: DecisionTaskResultV1
): readonly ContractIssueV1[] {
  const issues: ContractIssueV1[] = [];

  if ("runEvents" in result) {
    collectUniqueIds(
      result.runEvents,
      (event) => event.eventId,
      "runEvents",
      "eventId",
      "RunEvent",
      issues
    );

    result.runEvents.forEach((event, index) => {
      if (event.sequence !== index + 1) {
        issues.push({
          path: `runEvents.${index}.sequence`,
          message: "RunEvent 序号必须从 1 开始严格递增"
        });
      }

      if (event.decisionTaskId !== result.taskStatus.decisionTaskId) {
        issues.push({
          path: `runEvents.${index}.decisionTaskId`,
          message: "RunEvent 必须属于结果中的 Decision Task"
        });
      }

      if (event.agentRunId !== result.taskStatus.agentRunId) {
        issues.push({
          path: `runEvents.${index}.agentRunId`,
          message: "RunEvent 必须属于 Task Status 中的 Agent Run"
        });
      }
    });

    if (result.taskStatus.latestEventSequence !== result.runEvents.at(-1)?.sequence) {
      issues.push({
        path: "taskStatus.latestEventSequence",
        message: "Task Status 必须指向最后一个 RunEvent"
      });
    }

    if (result.taskStatus.updatedAt !== result.runEvents.at(-1)?.occurredAt) {
      issues.push({
        path: "taskStatus.updatedAt",
        message: "Task Status 更新时间必须等于最后一个 RunEvent 时间"
      });
    }
  }

  if (!result.ok) {
    const expectedErrorSemantics = errorSemanticsByCode[result.error.code];

    if (result.error.category !== expectedErrorSemantics.category) {
      issues.push({
        path: "error.category",
        message: "错误分类必须与错误码的固定语义一致"
      });
    }

    if (result.error.retryMode !== expectedErrorSemantics.retryMode) {
      issues.push({
        path: "error.retryMode",
        message: "重试模式必须与错误码的固定语义一致"
      });
    }

    if ("taskStatus" in result) {
      const finalEvent = result.runEvents.at(-1);

      if (result.error.code !== "AGENT_RUNTIME_FAILED") {
        issues.push({
          path: "error.code",
          message: "已创建任务的失败结果必须使用 Runtime 失败错误码"
        });
      }

      if (result.taskStatus.errorId !== result.error.errorId) {
        issues.push({
          path: "taskStatus.errorId",
          message: "Task Status 必须指向结果中的 Error"
        });
      }

      if (finalEvent?.taskState !== "FAILED") {
        issues.push({
          path: `runEvents.${Math.max(result.runEvents.length - 1, 0)}.taskState`,
          message: "失败结果的最后事件必须是 FAILED"
        });
      }

      if (finalEvent?.eventType !== "RUNTIME_FAILED") {
        issues.push({
          path: `runEvents.${Math.max(result.runEvents.length - 1, 0)}.eventType`,
          message: "失败结果的最后事件必须是 RUNTIME_FAILED"
        });
      }
    } else if (result.error.code === "AGENT_RUNTIME_FAILED") {
      issues.push({
        path: "error.code",
        message: "AGENT_RUNTIME_FAILED 必须属于已创建任务的失败结果"
      });
    }

    return issues;
  }

  const finalEvent = result.runEvents.at(-1);

  if (finalEvent?.taskState !== "COMPLETED") {
    issues.push({
      path: `runEvents.${Math.max(result.runEvents.length - 1, 0)}.taskState`,
      message: "成功结果的最后事件必须是 COMPLETED"
    });
  }

  if (finalEvent?.eventType !== "RUNTIME_SUCCEEDED") {
    issues.push({
      path: `runEvents.${Math.max(result.runEvents.length - 1, 0)}.eventType`,
      message: "成功结果的最后事件必须是 RUNTIME_SUCCEEDED"
    });
  }

  if (result.runEvents[0]?.taskState !== "CREATED") {
    issues.push({
      path: "runEvents.0.taskState",
      message: "成功结果的 RunEvent 必须从 CREATED 开始"
    });
  }

  let previousStateIndex = -1;

  result.runEvents.forEach((event, index) => {
    const currentStateIndex = (authoritativeRunStates as readonly string[]).indexOf(
      event.taskState
    );

    if (currentStateIndex === -1 || currentStateIndex <= previousStateIndex) {
      issues.push({
        path: `runEvents.${index}.taskState`,
        message: "成功结果的 RunEvent 必须按权威阶段顺序单调向前"
      });
    }

    previousStateIndex = currentStateIndex;
  });

  result.runEvents.slice(0, -1).forEach((event, index) => {
    if (event.eventType !== "TASK_STATE_CHANGED") {
      issues.push({
        path: `runEvents.${index}.eventType`,
        message: "成功结果的中间 RunEvent 必须是任务状态变化"
      });
    }
  });

  if (
    result.bundle.decision.status !== "BUY_IF_PRICE" &&
    result.bundle.decision.status !== "NEED_MORE_INFO"
  ) {
    issues.push({
      path: "bundle.decision.status",
      message: "P0-03 仅开放 BUY_IF_PRICE 和 NEED_MORE_INFO"
    });
  }

  const candidateIds = new Set(
    result.bundle.candidates.map((candidate) => candidate.candidateId)
  );
  const decisionTaskId = result.taskStatus.decisionTaskId;

  if (result.taskStatus.decisionRevisionId !== result.bundle.decision.decisionRevisionId) {
    issues.push({
      path: "taskStatus.decisionRevisionId",
      message: "Task Status 必须指向结果中的 Decision Revision"
    });
  }

  if (result.bundle.requirementRevision.decisionTaskId !== decisionTaskId) {
    issues.push({
      path: "bundle.requirementRevision.decisionTaskId",
      message: "Requirement Revision 必须属于结果中的 Decision Task"
    });
  }

  if (result.bundle.decision.decisionTaskId !== decisionTaskId) {
    issues.push({
      path: "bundle.decision.decisionTaskId",
      message: "Decision Revision 必须属于结果中的 Decision Task"
    });
  }

  if (
    result.bundle.decision.requirementRevisionId !==
    result.bundle.requirementRevision.requirementRevisionId
  ) {
    issues.push({
      path: "bundle.decision.requirementRevisionId",
      message: "Decision 必须引用结果中的 Requirement Revision"
    });
  }

  const budgetNeedsConfirmation =
    result.bundle.requirementRevision.budget?.confirmed !== true ||
    result.bundle.requirementRevision.unknowns.includes("budget.maxAmountMinor");

  if (budgetNeedsConfirmation) {
    if (result.bundle.decision.status !== "NEED_MORE_INFO") {
      issues.push({
        path: "bundle.decision.status",
        message: "预算上限未确认时必须返回 NEED_MORE_INFO"
      });
    }

    if (result.bundle.decision.selectedCandidateId !== undefined) {
      issues.push({
        path: "bundle.decision.selectedCandidateId",
        message: "预算上限未确认时不能选择 Candidate"
      });
    }

    if (
      !result.bundle.decision.criticalGaps.some(
        (gap) => gap.key === "budget.maxAmountMinor"
      )
    ) {
      issues.push({
        path: "bundle.decision.criticalGaps",
        message: "预算上限未确认时必须保留对应 Critical Gap"
      });
    }

    if (
      !result.bundle.decision.nextSteps.some(
        (nextStep) =>
          nextStep.actionType === "PROVIDE_REQUIREMENT" &&
          nextStep.requirementKey === "budget.maxAmountMinor"
      )
    ) {
      issues.push({
        path: "bundle.decision.nextSteps",
        message: "预算上限未确认时必须要求用户补充预算"
      });
    }
  }

  if (
    result.bundle.decision.status === "NEED_MORE_INFO" &&
    result.bundle.decision.criticalGaps.length === 0
  ) {
    issues.push({
      path: "bundle.decision.criticalGaps",
      message: "NEED_MORE_INFO 必须至少包含一个可回答的 Critical Gap"
    });
  }

  if (
    result.bundle.decision.status === "NEED_MORE_INFO" &&
    result.bundle.decision.selectedCandidateId !== undefined
  ) {
    issues.push({
      path: "bundle.decision.selectedCandidateId",
      message: "NEED_MORE_INFO 不得选择 Candidate"
    });
  }

  if (
    result.bundle.decision.status === "NEED_MORE_INFO" &&
    result.bundle.decision.candidateDispositions.length > 0
  ) {
    issues.push({
      path: "bundle.decision.candidateDispositions",
      message: "NEED_MORE_INFO 不得形成 Candidate Disposition"
    });
  }

  if (result.bundle.decision.status === "NEED_MORE_INFO") {
    result.bundle.decision.criticalGaps.forEach((gap, index) => {
      const resolution = gap.resolution;

      if (resolution.resolutionType !== "PROVIDE_REQUIREMENT") {
        issues.push({
          path: `bundle.decision.criticalGaps.${index}.resolution.resolutionType`,
          message: "NEED_MORE_INFO Critical Gap 必须由同一 Requirement 补充步骤闭合"
        });
        return;
      }

      if (
        resolution.requirementKey !== gap.key ||
        !result.bundle.decision.nextSteps.some(
          (nextStep) =>
            nextStep.actionType === "PROVIDE_REQUIREMENT" &&
            nextStep.requirementKey === resolution.requirementKey
        )
      ) {
        issues.push({
          path: `bundle.decision.criticalGaps.${index}.resolution.requirementKey`,
          message: "NEED_MORE_INFO Critical Gap 必须由同一 Requirement 补充步骤闭合"
        });
      }
    });
  }

  const hardBudget = result.bundle.requirementRevision.budget;

  if (
    result.bundle.decision.status === "NO_MATCH" &&
    result.bundle.decision.selectedCandidateId !== undefined
  ) {
    issues.push({
      path: "bundle.decision.selectedCandidateId",
      message: "NO_MATCH 不得选择 Candidate"
    });
  }

  result.bundle.decision.conditions.forEach((condition, index) => {
    if (!candidateIds.has(condition.candidateId)) {
      issues.push({
        path: `bundle.decision.conditions.${index}.candidateId`,
        message: "Decision Condition 必须关联存在的 Candidate"
      });
    }

    if (condition.candidateId !== result.bundle.decision.selectedCandidateId) {
      issues.push({
        path: `bundle.decision.conditions.${index}.candidateId`,
        message: "Decision Condition 必须关联被选 Candidate"
      });
    }

    if (
      condition.conditionType === "MAX_PRICE" &&
      hardBudget?.confirmed === true &&
      hardBudget.hard &&
      condition.amountMinor > hardBudget.maxAmountMinor
    ) {
      issues.push({
        path: `bundle.decision.conditions.${index}.amountMinor`,
        message: "MAX_PRICE 条件不得超过已确认硬预算"
      });
    }

    if (
      !result.bundle.decision.nextSteps.some(
        (nextStep) =>
          nextStep.actionType === "VERIFY_CONDITION" &&
          nextStep.conditionId === condition.conditionId
      )
    ) {
      issues.push({
        path: `bundle.decision.conditions.${index}.conditionId`,
        message: "每个 Decision Condition 必须有对应的 VERIFY_CONDITION next step"
      });
    }
  });

  if (result.bundle.decision.status === "BUY_IF_PRICE") {
    result.bundle.decision.criticalGaps.forEach((gap, index) => {
      const resolution = gap.resolution;

      if (resolution.resolutionType !== "VERIFY_CONDITION") {
        issues.push({
          path: `bundle.decision.criticalGaps.${index}.resolution.resolutionType`,
          message: "BUY_IF_PRICE Critical Gap 必须由可核验的 Decision Condition 闭合"
        });
        return;
      }

      if (
        !result.bundle.decision.conditions.some(
          (condition) => condition.conditionId === resolution.conditionId
        )
      ) {
        issues.push({
          path: `bundle.decision.criticalGaps.${index}.resolution.conditionId`,
          message: "BUY_IF_PRICE Critical Gap 必须由可核验的 Decision Condition 闭合"
        });
      }
    });
  }

  result.bundle.decision.nextSteps.forEach((nextStep, index) => {
    if (
      nextStep.actionType === "VERIFY_CONDITION" &&
      !result.bundle.decision.conditions.some(
        (condition) => condition.conditionId === nextStep.conditionId
      )
    ) {
      issues.push({
        path: `bundle.decision.nextSteps.${index}.conditionId`,
        message: "VERIFY_CONDITION 必须引用存在的 Decision Condition"
      });
    }

    if (
      nextStep.actionType === "VERIFY_RISK" &&
      !result.bundle.decision.risks.some((risk) => risk.riskId === nextStep.riskId)
    ) {
      issues.push({
        path: `bundle.decision.nextSteps.${index}.riskId`,
        message: "VERIFY_RISK 必须引用存在的 Decision Risk"
      });
    }
  });

  result.bundle.decision.risks.forEach((risk, index) => {
    if (
      !result.bundle.decision.nextSteps.some(
        (nextStep) =>
          nextStep.actionType === "VERIFY_RISK" && nextStep.riskId === risk.riskId
      )
    ) {
      issues.push({
        path: `bundle.decision.risks.${index}.riskId`,
        message: "每个 Decision Risk 必须有对应的 VERIFY_RISK next step"
      });
    }
  });

  if (
    result.bundle.decision.status === "BUY_IF_PRICE" &&
    result.bundle.decision.conditions.length === 0
  ) {
    issues.push({
      path: "bundle.decision.conditions",
      message: "BUY_IF_PRICE 必须包含至少一个可核验条件"
    });
  }

  if (
    result.bundle.decision.status === "BUY_NOW" &&
    result.bundle.decision.criticalGaps.length > 0
  ) {
    issues.push({
      path: "bundle.decision.criticalGaps",
      message: "存在 Critical Gap 时禁止 BUY_NOW"
    });
  }

  issues.push(
    ...checkDecisionBasisV1({
      decisionTaskId: result.taskStatus.decisionTaskId,
      bundle: result.bundle
    })
  );

  return issues;
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
