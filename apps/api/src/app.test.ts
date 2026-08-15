import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { DecisionTaskResultV1 } from "@choicemind/contracts/decision/v1";

import { buildApiApp } from "./app.js";

const openApps: Array<ReturnType<typeof buildApiApp>> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

describe("GET /health/live", () => {
  it("reports the API process as healthy", async () => {
    const app = buildApiApp();
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/health/live"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: "api",
      status: "healthy"
    });
  });
});

describe("GET /api/v1/system/health", () => {
  it("reports all four processes when every health probe succeeds", async () => {
    const probeResults = {
      web: { service: "web" as const, status: "healthy" as const, latencyMs: 12 },
      orchestrator: {
        service: "orchestrator" as const,
        status: "healthy" as const,
        latencyMs: 8
      },
      "data-worker": {
        service: "data-worker" as const,
        status: "healthy" as const,
        latencyMs: 5
      }
    };
    const app = buildApiApp({
      now: () => new Date("2026-08-12T20:30:00.000Z"),
      probe: async (service) => probeResults[service]
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/health"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      checkedAt: "2026-08-12T20:30:00.000Z",
      components: [
        { service: "web", status: "healthy", latencyMs: 12 },
        { service: "api", status: "healthy", latencyMs: 0 },
        { service: "orchestrator", status: "healthy", latencyMs: 8 },
        { service: "data-worker", status: "healthy", latencyMs: 5 }
      ],
      status: "healthy"
    });
  });

  it("probes the configured health URLs instead of returning static data", async () => {
    const web = await listenToHealthApp("web");
    const orchestrator = await listenToHealthApp("orchestrator");
    const dataWorker = await listenToHealthApp("data-worker");
    openApps.push(web.app, orchestrator.app, dataWorker.app);

    const app = buildApiApp({
      healthUrls: {
        web: `${web.url}/health/live`,
        orchestrator: `${orchestrator.url}/health/live`,
        "data-worker": `${dataWorker.url}/health/live`
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/health"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().components).toEqual([
      expect.objectContaining({ service: "web", status: "healthy" }),
      { service: "api", status: "healthy", latencyMs: 0 },
      expect.objectContaining({ service: "orchestrator", status: "healthy" }),
      expect.objectContaining({ service: "data-worker", status: "healthy" })
    ]);
  });

  it("returns 503 and identifies a dependency that cannot be reached", async () => {
    const probeResults = {
      web: { service: "web" as const, status: "healthy" as const, latencyMs: 10 },
      orchestrator: {
        service: "orchestrator" as const,
        status: "unhealthy" as const,
        latencyMs: 1,
        error: "connection_refused"
      },
      "data-worker": {
        service: "data-worker" as const,
        status: "healthy" as const,
        latencyMs: 4
      }
    };
    const app = buildApiApp({
      now: () => new Date("2026-08-12T20:31:00.000Z"),
      probe: async (service) => probeResults[service]
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/health"
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      checkedAt: "2026-08-12T20:31:00.000Z",
      components: [
        { service: "web", status: "healthy", latencyMs: 10 },
        { service: "api", status: "healthy", latencyMs: 0 },
        {
          service: "orchestrator",
          status: "unhealthy",
          latencyMs: 1,
          error: "connection_refused"
        },
        { service: "data-worker", status: "healthy", latencyMs: 4 }
      ],
      status: "unhealthy"
    });
  });
});

describe("POST /api/v1/decision-tasks:execute", () => {
  it("returns a versioned contract error for malformed JSON", async () => {
    const app = buildApiApp();
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/decision-tasks:execute",
      headers: { "content-type": "application/json" },
      payload: "{"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      contractType: "decision-task-result",
      contractVersion: "1.0",
      ok: false,
      error: {
        contractType: "choice-mind-error",
        contractVersion: "1.0",
        code: "CONTRACT_INVALID",
        category: "VALIDATION",
        retryMode: "NONE"
      }
    });
    expect(response.json()).not.toHaveProperty("code", "FST_ERR_CTP_INVALID_JSON_BODY");
  });

  it("returns a versioned contract error for an empty JSON body", async () => {
    const app = buildApiApp();
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/decision-tasks:execute",
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
    const app = buildApiApp();
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/decision-tasks:execute",
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
    const app = buildApiApp();
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/decision-tasks:execute",
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

  it("returns a versioned contract error for deeply nested valid JSON", async () => {
    const app = buildApiApp();
    openApps.push(app);
    const depth = 12_000;
    const payload = `${'{"nested":'.repeat(depth)}null${"}".repeat(depth)}`;

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/decision-tasks:execute",
      headers: { "content-type": "application/json" },
      payload
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

  it("rejects an invalid budget before calling the Orchestrator", async () => {
    const app = buildApiApp();
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/decision-tasks:execute",
      payload: {
        contractType: "execute-decision-task-command",
        contractVersion: "1.0",
        executionRequestId: "exec-api-invalid-budget",
        requirementRevision: {
          contractType: "requirement-revision",
          contractVersion: "1.0",
          budget: {
            confirmed: true,
            currency: "CNY",
            hard: true,
            maxAmountMinor: "800000"
          }
        }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: "CONTRACT_INVALID",
        category: "VALIDATION",
        retryMode: "NONE",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "requirementRevision.budget.maxAmountMinor" })
        ])
      }
    });
  });

  it("does not expose a malformed Orchestrator response as a successful decision", async () => {
    const app = buildApiApp({
      decisionOrchestrator: {
        async execute() {
          return {
            contractType: "decision-task-result",
            contractVersion: "1.0",
            ok: true,
            bundle: { decision: { status: "BUY_NOW" } }
          } as unknown as DecisionTaskResultV1;
        }
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/decision-tasks:execute",
      payload: {
        contractType: "execute-decision-task-command",
        contractVersion: "1.0",
        executionRequestId: "exec-api-malformed-response",
        requirementRevision: {
          contractType: "requirement-revision",
          contractVersion: "1.0",
          requirementRevisionId: "req-api-malformed-response-r1",
          decisionTaskId: "task-api-malformed-response",
          revision: 1,
          submittedText: "校验上游响应",
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
    expect(response.json()).not.toHaveProperty("bundle");
  });

  it("normalizes an Orchestrator transport exception without creating a decision", async () => {
    const app = buildApiApp({
      decisionOrchestrator: {
        async execute() {
          throw new TypeError("connection reset");
        }
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/decision-tasks:execute",
      payload: {
        contractType: "execute-decision-task-command",
        contractVersion: "1.0",
        executionRequestId: "exec-api-transport-error",
        requirementRevision: {
          contractType: "requirement-revision",
          contractVersion: "1.0",
          requirementRevisionId: "req-api-transport-error-r1",
          decisionTaskId: "task-api-transport-error",
          revision: 1,
          submittedText: "验证传输异常",
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
        retryMode: "SAME_EXECUTION_ONLY"
      }
    });
    expect(response.json()).not.toHaveProperty("taskStatus");
  });

  it("normalizes an exception while reading the Orchestrator result", async () => {
    const app = buildApiApp({
      decisionOrchestrator: {
        async execute() {
          return Object.defineProperties(
            {},
            {
              contractType: { value: "decision-task-result", enumerable: true },
              contractVersion: {
                enumerable: true,
                get() {
                  throw new Error("Orchestrator getter leaked");
                }
              }
            }
          ) as DecisionTaskResultV1;
        }
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/decision-tasks:execute",
      payload: {
        contractType: "execute-decision-task-command",
        contractVersion: "1.0",
        executionRequestId: "exec-api-throwing-result",
        requirementRevision: {
          contractType: "requirement-revision",
          contractVersion: "1.0",
          requirementRevisionId: "req-api-throwing-result-r1",
          decisionTaskId: "task-api-throwing-result",
          revision: 1,
          submittedText: "校验上游结果读取异常",
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
    expect(response.body).not.toContain("Orchestrator getter leaked");
  });

  it("returns 503 when the Orchestrator reports an unknown execution status", async () => {
    const app = buildApiApp({
      decisionOrchestrator: {
        async execute() {
          return {
            contractType: "decision-task-result",
            contractVersion: "1.0",
            ok: false,
            error: {
              contractType: "choice-mind-error",
              contractVersion: "1.0",
              errorId: "error-api-status-unknown",
              code: "DECISION_EXECUTION_STATUS_UNKNOWN",
              category: "TRANSPORT",
              message: "本次执行状态暂时无法确认",
              retryMode: "SAME_EXECUTION_ONLY",
              issues: [],
              occurredAt: "2026-08-13T08:00:00.000Z"
            }
          };
        }
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/decision-tasks:execute",
      payload: {
        contractType: "execute-decision-task-command",
        contractVersion: "1.0",
        executionRequestId: "exec-api-status-unknown",
        requirementRevision: {
          contractType: "requirement-revision",
          contractVersion: "1.0",
          requirementRevisionId: "req-api-status-unknown-r1",
          decisionTaskId: "task-api-status-unknown",
          revision: 1,
          submittedText: "验证状态未知响应",
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
    expect(response.json()).not.toHaveProperty("taskStatus");
  });
});

async function listenToHealthApp(service: "web" | "orchestrator" | "data-worker") {
  const app = buildTestHealthApp(service);
  const url = await app.listen({ host: "127.0.0.1", port: 0 });

  return { app, url };
}

function buildTestHealthApp(service: "web" | "orchestrator" | "data-worker") {
  const app = Fastify({ logger: false });

  app.get("/health/live", async () => ({ service, status: "healthy" }));

  return app;
}
