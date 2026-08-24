import type { ContractIssueV1, RejectedDecisionTaskResultV1 } from "./index.js";

type ContractRejectionOptions = Readonly<{
  errorId: string;
  code: "CONTRACT_INVALID" | "CONTRACT_VERSION_UNSUPPORTED";
  issues: readonly ContractIssueV1[];
  occurredAt: string;
}>;

export function createContractRejectedDecisionTaskResultV1(
  options: ContractRejectionOptions
): RejectedDecisionTaskResultV1 {
  const versionError = options.code === "CONTRACT_VERSION_UNSUPPORTED";

  return {
    contractType: "decision-task-result",
    contractVersion: "1.0",
    ok: false,
    error: {
      contractType: "choice-mind-error",
      contractVersion: "1.0",
      errorId: options.errorId,
      code: options.code,
      category: versionError ? "VERSION" : "VALIDATION",
      message: versionError ? "合同版本不受支持" : "请求不符合合同要求",
      retryMode: "NONE",
      issues: options.issues,
      occurredAt: options.occurredAt
    }
  };
}

export function createUnknownDecisionExecutionResultV1(
  options: Readonly<{ errorId: string; occurredAt: string }>
): RejectedDecisionTaskResultV1 {
  return {
    contractType: "decision-task-result",
    contractVersion: "1.0",
    ok: false,
    error: {
      contractType: "choice-mind-error",
      contractVersion: "1.0",
      errorId: options.errorId,
      code: "DECISION_EXECUTION_STATUS_UNKNOWN",
      category: "TRANSPORT",
      message: "本次执行状态暂时无法确认",
      retryMode: "SAME_EXECUTION_ONLY",
      issues: [],
      occurredAt: options.occurredAt
    }
  };
}

export function createDecisionTaskNotFoundResultV1(
  options: Readonly<{ errorId: string; occurredAt: string }>
): RejectedDecisionTaskResultV1 {
  return {
    contractType: "decision-task-result",
    contractVersion: "1.0",
    ok: false,
    error: {
      contractType: "choice-mind-error",
      contractVersion: "1.0",
      errorId: options.errorId,
      code: "DECISION_TASK_NOT_FOUND",
      category: "RESOURCE",
      message: "决策任务不存在",
      retryMode: "NONE",
      issues: [],
      occurredAt: options.occurredAt
    }
  };
}

export function createIdempotencyConflictResultV1(
  options: Readonly<{ errorId: string; occurredAt: string }>
): RejectedDecisionTaskResultV1 {
  return {
    contractType: "decision-task-result",
    contractVersion: "1.0",
    ok: false,
    error: {
      contractType: "choice-mind-error",
      contractVersion: "1.0",
      errorId: options.errorId,
      code: "IDEMPOTENCY_CONFLICT",
      category: "VALIDATION",
      message: "执行标识与原命令不一致",
      retryMode: "NONE",
      issues: [
        {
          path: "executionRequestId",
          message: "同一执行标识不能绑定不同命令"
        }
      ],
      occurredAt: options.occurredAt
    }
  };
}

export function createPersistenceUnavailableResultV1(
  options: Readonly<{ errorId: string; occurredAt: string }>
): RejectedDecisionTaskResultV1 {
  return {
    contractType: "decision-task-result",
    contractVersion: "1.0",
    ok: false,
    error: {
      contractType: "choice-mind-error",
      contractVersion: "1.0",
      errorId: options.errorId,
      code: "PERSISTENCE_UNAVAILABLE",
      category: "STORAGE",
      message: "持久任务存储暂时不可用",
      retryMode: "SAME_EXECUTION_ONLY",
      issues: [],
      occurredAt: options.occurredAt
    }
  };
}
