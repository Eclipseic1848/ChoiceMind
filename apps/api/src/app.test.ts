import Fastify from "fastify";
import type { DecisionTaskSnapshotV1 } from "@choicemind/contracts/decision/v1";
import { afterEach, describe, expect, it } from "vitest";
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
  it("accepts a valid command as a persistent background task", async () => {
    const app = buildApiApp({
      decisionTaskPersistence: {
        async submit(command) {
          return {
            contractType: "decision-task-snapshot",
            contractVersion: "1.0",
            executionRequestId: command.executionRequestId,
            decisionTaskId: command.requirementRevision.decisionTaskId,
            agentRunId: "agent-run-api-persistent",
            state: "ACCEPTED",
            terminal: false,
            updatedAt: "2026-08-23T20:20:00.000Z"
          };
        },
        async get() {
          return undefined;
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
        executionRequestId: "exec-api-persistent",
        requirementRevision: {
          contractType: "requirement-revision",
          contractVersion: "1.0",
          requirementRevisionId: "req-api-persistent-r1",
          decisionTaskId: "task-api-persistent",
          revision: 1,
          submittedText: "提交持久后台任务",
          market: { country: "CN", currency: "CNY", locale: "zh-CN" },
          intendedUses: ["后台任务测试"],
          mustHaves: [],
          niceToHaves: [],
          mustNotHaves: [],
          unknowns: ["budget.maxAmountMinor"]
        }
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      contractType: "decision-task-snapshot",
      contractVersion: "1.0",
      executionRequestId: "exec-api-persistent",
      decisionTaskId: "task-api-persistent",
      agentRunId: "agent-run-api-persistent",
      state: "ACCEPTED",
      terminal: false,
      updatedAt: "2026-08-23T20:20:00.000Z"
    });
  });

  it("returns a versioned 409 for an idempotency conflict", async () => {
    const app = buildApiApp({
      decisionTaskPersistence: {
        async submit() {
          throw Object.assign(new Error("内部冲突"), {
            code: "IDEMPOTENCY_CONFLICT"
          });
        },
        async get() {
          return undefined;
        }
      },
      now: () => new Date("2026-08-23T20:25:00.000Z")
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/decision-tasks:execute",
      payload: {
        contractType: "execute-decision-task-command",
        contractVersion: "1.0",
        executionRequestId: "exec-api-conflict",
        requirementRevision: {
          contractType: "requirement-revision",
          contractVersion: "1.0",
          requirementRevisionId: "req-api-conflict-r1",
          decisionTaskId: "task-api-conflict",
          revision: 1,
          submittedText: "验证幂等冲突",
          market: { country: "CN", currency: "CNY", locale: "zh-CN" },
          intendedUses: ["后台任务测试"],
          mustHaves: [],
          niceToHaves: [],
          mustNotHaves: [],
          unknowns: ["budget.maxAmountMinor"]
        }
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: "IDEMPOTENCY_CONFLICT",
        category: "VALIDATION",
        retryMode: "NONE",
        occurredAt: "2026-08-23T20:25:00.000Z"
      }
    });
    expect(response.body).not.toContain("内部冲突");
  });

  it("returns a versioned storage failure when submission persistence is unavailable", async () => {
    const app = buildApiApp({
      decisionTaskPersistence: {
        async submit() {
          throw Object.assign(new Error("password=private connection refused"), {
            code: "PERSISTENCE_UNAVAILABLE"
          });
        },
        async get() {
          return undefined;
        }
      },
      now: () => new Date("2026-08-23T20:27:00.000Z")
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/decision-tasks:execute",
      payload: {
        contractType: "execute-decision-task-command",
        contractVersion: "1.0",
        executionRequestId: "exec-api-storage-failure",
        requirementRevision: {
          contractType: "requirement-revision",
          contractVersion: "1.0",
          requirementRevisionId: "req-api-storage-failure-r1",
          decisionTaskId: "task-api-storage-failure",
          revision: 1,
          submittedText: "验证持久存储故障",
          market: { country: "CN", currency: "CNY", locale: "zh-CN" },
          intendedUses: ["后台任务测试"],
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
        code: "PERSISTENCE_UNAVAILABLE",
        category: "STORAGE",
        retryMode: "SAME_EXECUTION_ONLY",
        occurredAt: "2026-08-23T20:27:00.000Z"
      }
    });
    expect(response.body).not.toContain("password");
    expect(response.body).not.toContain("connection refused");
  });

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

  it("rejects an invalid budget before submitting to persistence", async () => {
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

});

describe("GET /api/v1/decision-tasks/:decisionTaskId", () => {
  it("returns the persisted task snapshot", async () => {
    const app = buildApiApp({
      decisionTaskPersistence: {
        async submit() {
          throw new Error("本测试不应提交任务");
        },
        async get(decisionTaskId) {
          return {
            contractType: "decision-task-snapshot",
            contractVersion: "1.0",
            executionRequestId: "exec-api-get",
            decisionTaskId,
            agentRunId: "agent-run-api-get",
            state: "ACCEPTED",
            terminal: false,
            updatedAt: "2026-08-23T20:21:00.000Z"
          };
        }
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/decision-tasks/task-api-get"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      contractType: "decision-task-snapshot",
      contractVersion: "1.0",
      executionRequestId: "exec-api-get",
      decisionTaskId: "task-api-get",
      agentRunId: "agent-run-api-get",
      state: "ACCEPTED",
      terminal: false,
      updatedAt: "2026-08-23T20:21:00.000Z"
    });
  });

  it.each([
    {
      contractType: "decision-task-snapshot",
      contractVersion: "1.0",
      executionRequestId: "exec-api-failed-retryable",
      decisionTaskId: "task-api-failed-retryable",
      agentRunId: "agent-run-api-failed-retryable",
      state: "FAILED_RETRYABLE",
      terminal: false,
      updatedAt: "2026-08-23T21:35:00.000Z"
    },
    {
      contractType: "decision-task-snapshot",
      contractVersion: "1.0",
      executionRequestId: "exec-api-failed-final",
      decisionTaskId: "task-api-failed-final",
      agentRunId: "agent-run-api-failed-final",
      state: "FAILED_FINAL",
      terminal: true,
      updatedAt: "2026-08-23T21:35:00.000Z"
    },
    {
      contractType: "decision-task-snapshot",
      contractVersion: "1.0",
      executionRequestId: "exec-api-partial",
      decisionTaskId: "task-api-partial",
      agentRunId: "agent-run-api-partial",
      state: "PARTIAL",
      terminal: false,
      updatedAt: "2026-08-23T21:35:00.000Z"
    }
  ] satisfies readonly DecisionTaskSnapshotV1[])(
    "returns the public $state task state",
    async (snapshot) => {
    const app = buildApiApp({
      decisionTaskPersistence: {
        async submit() {
          throw new Error("本测试不应提交任务");
        },
        async get() {
          return snapshot;
        }
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/decision-tasks/${snapshot.decisionTaskId}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(snapshot);
    expect(response.body).not.toContain('"ok":true');
    }
  );

  it("returns a persisted terminal task result", async () => {
    const app = buildApiApp({
      decisionTaskPersistence: {
        async submit() {
          throw new Error("本测试不应提交任务");
        },
        async get(decisionTaskId) {
          return buildPersistedFailureResult(decisionTaskId);
        }
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/decision-tasks/task-api-failed"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(buildPersistedFailureResult("task-api-failed"));
  });

  it("returns a versioned 404 when the task does not exist", async () => {
    const app = buildApiApp({
      decisionTaskPersistence: {
        async submit() {
          throw new Error("本测试不应提交任务");
        },
        async get() {
          return undefined;
        }
      },
      now: () => new Date("2026-08-23T20:23:00.000Z")
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/decision-tasks/task-api-missing"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: "DECISION_TASK_NOT_FOUND",
        category: "RESOURCE",
        retryMode: "NONE",
        occurredAt: "2026-08-23T20:23:00.000Z"
      }
    });
  });

  it("returns a versioned storage failure when the persisted task cannot be read", async () => {
    const app = buildApiApp({
      decisionTaskPersistence: {
        async submit() {
          throw new Error("本测试不应提交任务");
        },
        async get() {
          throw Object.assign(new Error("private database timeout"), {
            code: "PERSISTENCE_UNAVAILABLE"
          });
        }
      },
      now: () => new Date("2026-08-23T20:28:00.000Z")
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/decision-tasks/task-api-storage-failure"
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: "PERSISTENCE_UNAVAILABLE",
        category: "STORAGE",
        retryMode: "SAME_EXECUTION_ONLY",
        occurredAt: "2026-08-23T20:28:00.000Z"
      }
    });
    expect(response.body).not.toContain("private database timeout");
  });
});

function buildPersistedFailureResult(decisionTaskId: string) {
  return {
    contractType: "decision-task-result" as const,
    contractVersion: "1.0" as const,
    ok: false as const,
    taskStatus: {
      contractType: "decision-task-status" as const,
      contractVersion: "1.0" as const,
      decisionTaskId,
      agentRunId: "agent-run-api-failed",
      state: "FAILED" as const,
      terminal: true as const,
      latestEventSequence: 1,
      errorId: "error-api-persisted-runtime",
      updatedAt: "2026-08-23T20:40:00.000Z"
    },
    runEvents: [
      {
        contractType: "run-event" as const,
        contractVersion: "1.0" as const,
        eventId: "event-api-persisted-runtime",
        decisionTaskId,
        agentRunId: "agent-run-api-failed",
        sequence: 1,
        occurredAt: "2026-08-23T20:40:00.000Z",
        eventType: "RUNTIME_FAILED" as const,
        taskState: "FAILED" as const,
        summary: "合成 Runtime 执行失败",
        synthetic: true as const
      }
    ],
    error: {
      contractType: "choice-mind-error" as const,
      contractVersion: "1.0" as const,
      errorId: "error-api-persisted-runtime",
      code: "AGENT_RUNTIME_FAILED" as const,
      category: "RUNTIME" as const,
      message: "决策任务失败",
      retryMode: "NEW_EXECUTION_ALLOWED" as const,
      issues: [],
      occurredAt: "2026-08-23T20:40:00.000Z"
    }
  };
}

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
