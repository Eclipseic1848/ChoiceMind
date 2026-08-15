import { afterEach, describe, expect, it } from "vitest";
import {
  createContractRejectedDecisionTaskResultV1,
  createUnknownDecisionExecutionResultV1
} from "@choicemind/contracts/decision/v1";

import { buildOrchestratorApp } from "./app.js";
import { createDecisionTaskExecutor } from "./decision-tasks/executor.js";
import { createFakeAgentRuntimeAdapter } from "./runtime/fake-agent-runtime-adapter.js";

const openApps: Array<ReturnType<typeof buildOrchestratorApp>> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

describe("GET /health/live", () => {
  it("reports the Orchestrator process as healthy", async () => {
    const app = buildOrchestratorApp();
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/health/live"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: "orchestrator",
      status: "healthy"
    });
  });
});

describe("POST /internal/v1/decision-tasks:execute", () => {
  it("returns a versioned contract error for malformed JSON", async () => {
    const app = buildOrchestratorApp({
      decisionTaskExecutor: createDecisionTaskExecutor({
        runtime: createFakeAgentRuntimeAdapter()
      })
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/decision-tasks:execute",
      headers: { "content-type": "application/json" },
      payload: "{"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      contractType: "decision-task-result",
      contractVersion: "1.0",
      ok: false,
      error: {
        code: "CONTRACT_INVALID",
        category: "VALIDATION",
        retryMode: "NONE"
      }
    });
  });

  it("returns a versioned contract error for an empty JSON body", async () => {
    const app = buildOrchestratorApp({
      decisionTaskExecutor: createDecisionTaskExecutor({
        runtime: createFakeAgentRuntimeAdapter()
      })
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/decision-tasks:execute",
      headers: { "content-type": "application/json" },
      payload: ""
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      contractType: "decision-task-result",
      contractVersion: "1.0",
      ok: false,
      error: {
        code: "CONTRACT_INVALID",
        category: "VALIDATION",
        retryMode: "NONE"
      }
    });
    expect(response.json()).not.toHaveProperty("code", "FST_ERR_CTP_EMPTY_JSON_BODY");
  });

  it("returns a versioned contract error for an unsupported decision media type", async () => {
    const app = buildOrchestratorApp({
      decisionTaskExecutor: createDecisionTaskExecutor({
        runtime: createFakeAgentRuntimeAdapter()
      })
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/decision-tasks:execute",
      headers: { "content-type": "application/octet-stream" },
      payload: "{}"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      contractType: "decision-task-result",
      contractVersion: "1.0",
      ok: false,
      error: {
        code: "CONTRACT_INVALID",
        category: "VALIDATION",
        retryMode: "NONE"
      }
    });
    expect(response.json()).not.toHaveProperty("code", "FST_ERR_CTP_INVALID_MEDIA_TYPE");
  });

  it("returns a versioned contract error for an oversized decision body", async () => {
    const app = buildOrchestratorApp({
      decisionTaskExecutor: createDecisionTaskExecutor({
        runtime: createFakeAgentRuntimeAdapter()
      })
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/decision-tasks:execute",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ payload: "a".repeat(1_100_000) })
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      contractType: "decision-task-result",
      contractVersion: "1.0",
      ok: false,
      error: {
        code: "CONTRACT_INVALID",
        category: "VALIDATION",
        retryMode: "NONE"
      }
    });
    expect(response.json()).not.toHaveProperty("code", "FST_ERR_CTP_BODY_TOO_LARGE");
  });

  it("returns the complete decision produced by the executor", async () => {
    const app = buildOrchestratorApp({
      decisionTaskExecutor: createDecisionTaskExecutor({
        runtime: createFakeAgentRuntimeAdapter()
      })
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/decision-tasks:execute",
      payload: {
        contractType: "execute-decision-task-command",
        contractVersion: "1.0",
        executionRequestId: "exec-orchestrator-http",
        requirementRevision: {
          contractType: "requirement-revision",
          contractVersion: "1.0",
          requirementRevisionId: "req-orchestrator-http-r1",
          decisionTaskId: "task-orchestrator-http",
          revision: 1,
          submittedText: "预算不超过 8000 元。",
          market: { country: "CN", currency: "CNY", locale: "zh-CN" },
          intendedUses: ["软件开发"],
          budget: {
            confirmed: true,
            currency: "CNY",
            hard: true,
            maxAmountMinor: 800000
          },
          mustHaves: [],
          niceToHaves: [],
          mustNotHaves: [],
          unknowns: []
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      taskStatus: { state: "COMPLETED" },
      bundle: { decision: { status: "BUY_IF_PRICE" } }
    });
  });

  it("preserves the frozen HTTP status for every rejected executor result", async () => {
    const cases = [
      {
        expectedStatus: 422,
        result: createContractRejectedDecisionTaskResultV1({
          errorId: "error-orchestrator-version-result",
          code: "CONTRACT_VERSION_UNSUPPORTED",
          issues: [],
          occurredAt: "2026-08-13T12:00:00.000Z"
        })
      },
      {
        expectedStatus: 503,
        result: createUnknownDecisionExecutionResultV1({
          errorId: "error-orchestrator-unknown-result",
          occurredAt: "2026-08-13T12:00:00.000Z"
        })
      }
    ];

    for (const testCase of cases) {
      const app = buildOrchestratorApp({
        decisionTaskExecutor: {
          async execute() {
            return testCase.result;
          }
        }
      });
      openApps.push(app);

      const response = await app.inject({
        method: "POST",
        url: "/internal/v1/decision-tasks:execute",
        payload: {
          contractType: "execute-decision-task-command",
          contractVersion: "1.0",
          executionRequestId: `exec-orchestrator-status-${testCase.expectedStatus}`,
          requirementRevision: {
            contractType: "requirement-revision",
            contractVersion: "1.0",
            requirementRevisionId: `req-orchestrator-status-${testCase.expectedStatus}-r1`,
            decisionTaskId: `task-orchestrator-status-${testCase.expectedStatus}`,
            revision: 1,
            submittedText: "校验冻结的 HTTP 状态映射",
            market: { country: "CN", currency: "CNY", locale: "zh-CN" },
            intendedUses: ["测试"],
            mustHaves: [],
            niceToHaves: [],
            mustNotHaves: [],
            unknowns: ["budget.maxAmountMinor"]
          }
        }
      });

      expect(response.statusCode).toBe(testCase.expectedStatus);
    }
  });

  it("returns a structured unknown result when the executor output is malformed", async () => {
    const app = buildOrchestratorApp({
      decisionTaskExecutor: {
        async execute() {
          return {
            contractType: "decision-task-result",
            contractVersion: "1.0",
            ok: true
          } as never;
        }
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/decision-tasks:execute",
      payload: {
        contractType: "execute-decision-task-command",
        contractVersion: "1.0",
        executionRequestId: "exec-orchestrator-malformed-output",
        requirementRevision: {
          contractType: "requirement-revision",
          contractVersion: "1.0",
          requirementRevisionId: "req-orchestrator-malformed-output-r1",
          decisionTaskId: "task-orchestrator-malformed-output",
          revision: 1,
          submittedText: "校验 Orchestrator 出站合同",
          market: { country: "CN", currency: "CNY", locale: "zh-CN" },
          intendedUses: ["测试"],
          mustHaves: [],
          niceToHaves: [],
          mustNotHaves: [],
          unknowns: ["budget.maxAmountMinor"]
        }
      }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      contractType: "decision-task-result",
      contractVersion: "1.0",
      ok: false,
      error: {
        code: "DECISION_EXECUTION_STATUS_UNKNOWN",
        category: "TRANSPORT",
        retryMode: "SAME_EXECUTION_ONLY"
      }
    });
    expect(response.json()).not.toHaveProperty("taskStatus");
    expect(response.json()).not.toHaveProperty("bundle");
  });

  it("returns a structured unknown result when the executor throws", async () => {
    const app = buildOrchestratorApp({
      decisionTaskExecutor: {
        async execute() {
          throw new Error("Executor 私有错误");
        }
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/decision-tasks:execute",
      payload: {
        contractType: "execute-decision-task-command",
        contractVersion: "1.0",
        executionRequestId: "exec-orchestrator-throwing-executor",
        requirementRevision: {
          contractType: "requirement-revision",
          contractVersion: "1.0",
          requirementRevisionId: "req-orchestrator-throwing-executor-r1",
          decisionTaskId: "task-orchestrator-throwing-executor",
          revision: 1,
          submittedText: "校验 Executor 私有错误不会逸出",
          market: { country: "CN", currency: "CNY", locale: "zh-CN" },
          intendedUses: ["测试"],
          mustHaves: [],
          niceToHaves: [],
          mustNotHaves: [],
          unknowns: ["budget.maxAmountMinor"]
        }
      }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      contractType: "decision-task-result",
      contractVersion: "1.0",
      ok: false,
      error: {
        code: "DECISION_EXECUTION_STATUS_UNKNOWN",
        category: "TRANSPORT",
        retryMode: "SAME_EXECUTION_ONLY"
      }
    });
    expect(response.json()).not.toHaveProperty("message", "Executor 私有错误");
  });

  it("returns a structured unknown result when reading the executor output throws", async () => {
    const app = buildOrchestratorApp({
      decisionTaskExecutor: {
        async execute() {
          return Object.defineProperties(
            {},
            {
              contractType: { value: "decision-task-result", enumerable: true },
              contractVersion: {
                enumerable: true,
                get() {
                  throw new Error("Executor getter leaked");
                }
              }
            }
          ) as never;
        }
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/decision-tasks:execute",
      payload: {
        contractType: "execute-decision-task-command",
        contractVersion: "1.0",
        executionRequestId: "exec-orchestrator-throwing-output",
        requirementRevision: {
          contractType: "requirement-revision",
          contractVersion: "1.0",
          requirementRevisionId: "req-orchestrator-throwing-output-r1",
          decisionTaskId: "task-orchestrator-throwing-output",
          revision: 1,
          submittedText: "校验出站读取异常不会逸出",
          market: { country: "CN", currency: "CNY", locale: "zh-CN" },
          intendedUses: ["测试"],
          mustHaves: [],
          niceToHaves: [],
          mustNotHaves: [],
          unknowns: ["budget.maxAmountMinor"]
        }
      }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: "DECISION_EXECUTION_STATUS_UNKNOWN",
        category: "TRANSPORT",
        retryMode: "SAME_EXECUTION_ONLY"
      }
    });
    expect(response.body).not.toContain("Executor getter leaked");
  });
});
