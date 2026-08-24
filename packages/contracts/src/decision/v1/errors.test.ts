import { describe, expect, it } from "vitest";

import {
  createContractRejectedDecisionTaskResultV1,
  createDecisionTaskNotFoundResultV1,
  createIdempotencyConflictResultV1,
  createPersistenceUnavailableResultV1,
  createUnknownDecisionExecutionResultV1
} from "./index.js";

describe("Decision Task 错误结果工厂", () => {
  it("creates a stable contract rejection without exposing a validation library", () => {
    const result = createContractRejectedDecisionTaskResultV1({
      errorId: "error-contract-test",
      code: "CONTRACT_INVALID",
      issues: [{ path: "requirementRevision.budget", message: "字段不符合合同要求" }],
      occurredAt: "2026-08-13T07:00:00.000Z"
    });

    expect(result).toEqual({
      contractType: "decision-task-result",
      contractVersion: "1.0",
      ok: false,
      error: {
        contractType: "choice-mind-error",
        contractVersion: "1.0",
        errorId: "error-contract-test",
        code: "CONTRACT_INVALID",
        category: "VALIDATION",
        message: "请求不符合合同要求",
        retryMode: "NONE",
        issues: [{ path: "requirementRevision.budget", message: "字段不符合合同要求" }],
        occurredAt: "2026-08-13T07:00:00.000Z"
      }
    });
  });

  it("creates an unknown execution result that only permits the same execution retry", () => {
    const result = createUnknownDecisionExecutionResultV1({
      errorId: "error-status-unknown",
      occurredAt: "2026-08-13T07:00:00.000Z"
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        errorId: "error-status-unknown",
        code: "DECISION_EXECUTION_STATUS_UNKNOWN",
        category: "TRANSPORT",
        retryMode: "SAME_EXECUTION_ONLY",
        occurredAt: "2026-08-13T07:00:00.000Z"
      }
    });
    expect(result).not.toHaveProperty("taskStatus");
  });

  it("creates a stable missing-task result without allowing a retry", () => {
    const result = createDecisionTaskNotFoundResultV1({
      errorId: "error-task-not-found",
      occurredAt: "2026-08-23T20:22:00.000Z"
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "DECISION_TASK_NOT_FOUND",
        category: "RESOURCE",
        message: "决策任务不存在",
        retryMode: "NONE",
        issues: []
      }
    });
  });

  it("creates a stable idempotency conflict without exposing either command", () => {
    const result = createIdempotencyConflictResultV1({
      errorId: "error-idempotency-conflict",
      occurredAt: "2026-08-23T20:24:00.000Z"
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "IDEMPOTENCY_CONFLICT",
        category: "VALIDATION",
        message: "执行标识与原命令不一致",
        retryMode: "NONE",
        issues: [
          {
            path: "executionRequestId",
            message: "同一执行标识不能绑定不同命令"
          }
        ]
      }
    });
    expect(JSON.stringify(result)).not.toContain("command_fingerprint");
  });

  it("creates a retryable storage failure without exposing its private cause", () => {
    const result = createPersistenceUnavailableResultV1({
      errorId: "error-persistence-unavailable",
      occurredAt: "2026-08-23T20:26:00.000Z"
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "PERSISTENCE_UNAVAILABLE",
        category: "STORAGE",
        message: "持久任务存储暂时不可用",
        retryMode: "SAME_EXECUTION_ONLY",
        issues: []
      }
    });
  });
});
