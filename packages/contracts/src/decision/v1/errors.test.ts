import { describe, expect, it } from "vitest";

import {
  createContractRejectedDecisionTaskResultV1,
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
});
