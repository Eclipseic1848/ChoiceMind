import { describe, expect, it } from "vitest";
import { createContractRejectedDecisionTaskResultV1 } from "@choicemind/contracts/decision/v1";

import { createHttpDecisionOrchestratorAdapter } from "./http-orchestrator-adapter.js";

describe("HttpDecisionOrchestratorAdapter", () => {
  it("does not accept a valid contract body from an HTTP 500 response", async () => {
    const adapter = createHttpDecisionOrchestratorAdapter({
      baseUrl: "http://127.0.0.1:3200",
      maxAttempts: 1,
      fetch: async () =>
        Response.json(
          createContractRejectedDecisionTaskResultV1({
            errorId: "error-upstream-invalid",
            code: "CONTRACT_INVALID",
            issues: [],
            occurredAt: "2026-08-13T09:00:00.000Z"
          }),
          { status: 500 }
        )
    });

    const result = await adapter.execute({
      contractType: "execute-decision-task-command",
      contractVersion: "1.0",
      executionRequestId: "exec-http-status-mismatch",
      requirementRevision: {
        contractType: "requirement-revision",
        contractVersion: "1.0",
        requirementRevisionId: "req-http-status-mismatch-r1",
        decisionTaskId: "task-http-status-mismatch",
        revision: 1,
        submittedText: "验证 HTTP 状态与结果语义一致",
        market: { country: "CN", currency: "CNY", locale: "zh-CN" },
        intendedUses: ["测试"],
        mustHaves: [],
        niceToHaves: [],
        mustNotHaves: [],
        unknowns: ["budget.maxAmountMinor"]
      }
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "DECISION_EXECUTION_STATUS_UNKNOWN",
        category: "TRANSPORT",
        retryMode: "SAME_EXECUTION_ONLY"
      }
    });
  });

  it("reuses the same execution request ID for bounded transport retries", async () => {
    const receivedExecutionIds: string[] = [];
    const adapter = createHttpDecisionOrchestratorAdapter({
      baseUrl: "http://127.0.0.1:3200",
      maxAttempts: 2,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { executionRequestId: string };
        receivedExecutionIds.push(body.executionRequestId);
        throw new TypeError("connection reset");
      }
    });

    const result = await adapter.execute({
      contractType: "execute-decision-task-command",
      contractVersion: "1.0",
      executionRequestId: "exec-http-retry",
      requirementRevision: {
        contractType: "requirement-revision",
        contractVersion: "1.0",
        requirementRevisionId: "req-http-retry-r1",
        decisionTaskId: "task-http-retry",
        revision: 1,
        submittedText: "验证同 ID 重试",
        market: { country: "CN", currency: "CNY", locale: "zh-CN" },
        intendedUses: ["测试"],
        mustHaves: [],
        niceToHaves: [],
        mustNotHaves: [],
        unknowns: ["budget.maxAmountMinor"]
      }
    });

    expect(receivedExecutionIds).toEqual(["exec-http-retry", "exec-http-retry"]);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "DECISION_EXECUTION_STATUS_UNKNOWN",
        category: "TRANSPORT",
        retryMode: "SAME_EXECUTION_ONLY"
      }
    });
  });
});
