import Fastify from "fastify";
import type { DecisionTaskSnapshotV1 } from "@choicemind/contracts/decision/v1";
import { afterEach, describe, expect, it } from "vitest";
import { buildApiApp as buildApiAppWithoutIdentity } from "./app.js";

const testIdentityResolver = {
  async resolve(authorization: string | undefined) {
    const userId = authorization === "Bearer token-user-b" ? "user-b" : "user-a";

    return {
      principalId: `principal-${userId}`,
      role: "USER" as const,
      userId
    };
  }
};

function buildApiApp(
  options: Parameters<typeof buildApiAppWithoutIdentity>[0] = {}
) {
  return buildApiAppWithoutIdentity({
    identityResolver: testIdentityResolver,
    ...options
  });
}

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
    const auditRecords: unknown[] = [];
    const app = buildApiApp({
      auditLog: { async append(record) { auditRecords.push(record); } },
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
        },
        async listEvents() {
          return [];
        }
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/decision-tasks:execute",
      headers: { "x-correlation-id": "correlation-submit-1" },
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
    expect(auditRecords).toEqual([
      {
        actor: { principalId: "principal-user-a", role: "USER", userId: "user-a" },
        action: "DECISION_TASK_SUBMIT",
        object: { id: "task-api-persistent", type: "DECISION_TASK" },
        result: "ALLOWED",
        correlationId: "correlation-submit-1"
      }
    ]);
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
        },
        async listEvents() {
          return [];
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
        },
        async listEvents() {
          return [];
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
  it("hides a user's task from another authenticated user", async () => {
    const snapshot: DecisionTaskSnapshotV1 = {
      contractType: "decision-task-snapshot",
      contractVersion: "1.0",
      executionRequestId: "exec-api-owned",
      decisionTaskId: "task-api-owned",
      agentRunId: "agent-run-api-owned",
      state: "ACCEPTED",
      terminal: false,
      updatedAt: "2026-08-24T00:00:00.000Z"
    };
    const app = buildApiApp({
      decisionTaskPersistence: {
        async submit() {
          throw new Error("本测试不应提交任务");
        },
        async get(_decisionTaskId, ownerUserId) {
          return ownerUserId === "user-a" ? snapshot : undefined;
        },
        async listEvents() {
          return [];
        }
      }
    });
    openApps.push(app);

    const ownerResponse = await app.inject({
      method: "GET",
      url: "/api/v1/decision-tasks/task-api-owned",
      headers: {
        authorization: "Bearer token-user-a"
      }
    });
    const otherUserResponse = await app.inject({
      method: "GET",
      url: "/api/v1/decision-tasks/task-api-owned",
      headers: {
        authorization: "Bearer token-user-b"
      }
    });

    expect(ownerResponse.statusCode).toBe(200);
    expect(otherUserResponse.statusCode).toBe(404);
    expect(otherUserResponse.json()).toMatchObject({
      ok: false,
      error: {
        code: "DECISION_TASK_NOT_FOUND"
      }
    });
  });

  it.each(["USER", "ADMIN", "SUPERADMIN"] as const)(
    "denies a %s access to another user's task and records the audit result",
    async (role) => {
      const auditRecords: unknown[] = [];
      const app = buildApiApp({
        auditLog: {
          async append(record) {
            auditRecords.push(record);
          }
        },
        identityResolver: {
          async resolve() {
            return {
              principalId: `principal-other-${role.toLowerCase()}`,
              role,
              userId: "user-other"
            };
          }
        },
        decisionTaskPersistence: {
          async submit() {
            throw new Error("本测试不应提交任务");
          },
          async get() {
            return undefined;
          },
          async listEvents() {
            return [];
          }
        }
      });
      openApps.push(app);

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/decision-tasks/task-private",
        headers: {
          authorization: "Bearer opaque-other",
          "x-correlation-id": `correlation-${role.toLowerCase()}`
        }
      });

      expect(response.statusCode).toBe(404);
      expect(auditRecords).toEqual([
        {
          actor: {
            principalId: `principal-other-${role.toLowerCase()}`,
            role,
            userId: "user-other"
          },
          action: "DECISION_TASK_READ",
          object: { id: "task-private", type: "DECISION_TASK" },
          result: "NOT_FOUND",
          correlationId: `correlation-${role.toLowerCase()}`
        }
      ]);
    }
  );

  it("records an allowed owner read with its correlation identifier", async () => {
    const auditRecords: unknown[] = [];
    const app = buildApiApp({
      auditLog: { async append(record) { auditRecords.push(record); } },
      decisionTaskPersistence: {
        async submit() { throw new Error("本测试不应提交任务"); },
        async get(decisionTaskId) {
          return {
            contractType: "decision-task-snapshot",
            contractVersion: "1.0",
            executionRequestId: "exec-audit-allowed",
            decisionTaskId,
            agentRunId: "agent-run-audit-allowed",
            state: "ACCEPTED",
            terminal: false,
            updatedAt: "2026-08-24T00:12:00.000Z"
          };
        },
        async listEvents() { return []; }
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/decision-tasks/task-audit-allowed",
      headers: { "x-correlation-id": "correlation-allowed" }
    });

    expect(response.statusCode).toBe(200);
    expect(auditRecords).toEqual([
      {
        actor: { principalId: "principal-user-a", role: "USER", userId: "user-a" },
        action: "DECISION_TASK_READ",
        object: { id: "task-audit-allowed", type: "DECISION_TASK" },
        result: "ALLOWED",
        correlationId: "correlation-allowed"
      }
    ]);
  });

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
        },
        async listEvents() {
          return [];
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
        },
        async listEvents() {
          return [];
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
        },
        async listEvents() {
          return [];
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
        },
        async listEvents() {
          return [];
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
        },
        async listEvents() {
          return [];
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

describe("GET /api/v1/decision-tasks/:decisionTaskId/events", () => {
  it("audits a denied event-stream read without revealing task ownership", async () => {
    const auditRecords: unknown[] = [];
    const app = buildApiApp({
      auditLog: { async append(record) { auditRecords.push(record); } },
      identityResolver: {
        async resolve() {
          return { principalId: "principal-user-b", role: "USER", userId: "user-b" };
        }
      },
      decisionTaskPersistence: {
        async submit() { throw new Error("本测试不应提交任务"); },
        async get() { return undefined; },
        async listEvents() { return []; }
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/decision-tasks/task-private/events",
      headers: { "x-correlation-id": "correlation-events-denied" }
    });

    expect(response.statusCode).toBe(404);
    expect(auditRecords).toEqual([
      {
        actor: { principalId: "principal-user-b", role: "USER", userId: "user-b" },
        action: "DECISION_TASK_EVENTS_READ",
        object: { id: "task-private", type: "DECISION_TASK" },
        result: "NOT_FOUND",
        correlationId: "correlation-events-denied"
      }
    ]);
  });

  it("replays persisted events as SSE records with the cursor as id", async () => {
    const persistedEvent = {
      contractType: "persisted-run-event" as const,
      contractVersion: "1.0" as const,
      cursor: "42",
      event: {
        contractType: "run-event" as const,
        contractVersion: "1.0" as const,
        eventId: "event-api-replay-1",
        decisionTaskId: "task-api-replay",
        agentRunId: "agent-run-api-replay",
        sequence: 1,
        occurredAt: "2026-08-24T01:40:00.000Z",
        eventType: "TASK_STATE_CHANGED" as const,
        taskState: "CREATED" as const,
        summary: "决策任务已接受",
        synthetic: true as const
      }
    };
    const app = buildApiApp({
      decisionTaskPersistence: {
        async submit() {
          throw new Error("本测试不应提交任务");
        },
        async get(decisionTaskId) {
          return {
            contractType: "decision-task-snapshot",
            contractVersion: "1.0",
            executionRequestId: "exec-api-replay",
            decisionTaskId,
            agentRunId: "agent-run-api-replay",
            state: "ACCEPTED",
            terminal: false,
            updatedAt: "2026-08-24T01:40:00.000Z"
          };
        },
        async listEvents() {
          return [persistedEvent];
        }
      }
    });
    openApps.push(app);
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();

    try {
      const response = await fetch(`${origin}/api/v1/decision-tasks/task-api-replay/events`, {
        signal: controller.signal
      });
      const reader = response.body?.getReader();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(reader).toBeDefined();
      const chunk = await reader?.read();
      const body = new TextDecoder().decode(chunk?.value);

      expect(body).toContain(`id: 42\ndata: ${JSON.stringify(persistedEvent)}\n\n`);
      await reader?.cancel();
    } finally {
      controller.abort();
    }
  });

  it("continues replay strictly after Last-Event-ID", async () => {
    let receivedCursor: string | undefined;
    const persistedEvent = {
      contractType: "persisted-run-event" as const,
      contractVersion: "1.0" as const,
      cursor: "43",
      event: {
        contractType: "run-event" as const,
        contractVersion: "1.0" as const,
        eventId: "event-api-replay-2",
        decisionTaskId: "task-api-reconnect",
        agentRunId: "agent-run-api-reconnect",
        sequence: 2,
        occurredAt: "2026-08-24T01:41:00.000Z",
        eventType: "TASK_STATE_CHANGED" as const,
        taskState: "UNDERSTANDING" as const,
        summary: "决策任务开始执行",
        synthetic: true as const
      }
    };
    const app = buildApiApp({
      decisionTaskPersistence: {
        async submit() {
          throw new Error("本测试不应提交任务");
        },
        async get(decisionTaskId) {
          return {
            contractType: "decision-task-snapshot",
            contractVersion: "1.0",
            executionRequestId: "exec-api-reconnect",
            decisionTaskId,
            agentRunId: "agent-run-api-reconnect",
            state: "RUNNING",
            terminal: false,
            updatedAt: "2026-08-24T01:41:00.000Z"
          };
        },
        async listEvents(_decisionTaskId, _ownerUserId, afterCursor) {
          receivedCursor = afterCursor;
          return [persistedEvent];
        }
      }
    });
    openApps.push(app);
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();

    try {
      const response = await fetch(`${origin}/api/v1/decision-tasks/task-api-reconnect/events`, {
        headers: { "Last-Event-ID": "42" },
        signal: controller.signal
      });
      const reader = response.body?.getReader();
      const chunk = await reader?.read();

      expect(response.status).toBe(200);
      expect(receivedCursor).toBe("42");
      expect(new TextDecoder().decode(chunk?.value)).toContain("id: 43\n");
      await reader?.cancel();
    } finally {
      controller.abort();
    }
  });

  it("rejects an invalid Last-Event-ID before querying event storage", async () => {
    let eventQueries = 0;
    const app = buildApiApp({
      decisionTaskPersistence: {
        async submit() {
          throw new Error("本测试不应提交任务");
        },
        async get(decisionTaskId) {
          return {
            contractType: "decision-task-snapshot",
            contractVersion: "1.0",
            executionRequestId: "exec-api-invalid-cursor",
            decisionTaskId,
            agentRunId: "agent-run-api-invalid-cursor",
            state: "RUNNING",
            terminal: false,
            updatedAt: "2026-08-24T01:42:00.000Z"
          };
        },
        async listEvents() {
          eventQueries += 1;
          throw new Error("非法 cursor 不应访问事件存储");
        }
      },
      now: () => new Date("2026-08-24T01:42:00.000Z")
    });
    openApps.push(app);

    const response = await app.inject({
      headers: { "last-event-id": "-1" },
      method: "GET",
      url: "/api/v1/decision-tasks/task-api-invalid-cursor/events"
    });

    expect(response.statusCode).toBe(400);
    expect(eventQueries).toBe(0);
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: "CONTRACT_INVALID",
        issues: [{ path: "Last-Event-ID" }],
        occurredAt: "2026-08-24T01:42:00.000Z"
      }
    });
  });

  it("requeries Postgres after a Redis notification wakes the stream", async () => {
    let eventQueries = 0;
    let notificationWaits = 0;
    let wake: (() => void) | undefined;
    let markWaitStarted: (() => void) | undefined;
    const waitStarted = new Promise<void>((resolve) => {
      markWaitStarted = resolve;
    });
    const persistedEvent = {
      contractType: "persisted-run-event" as const,
      contractVersion: "1.0" as const,
      cursor: "44",
      event: {
        contractType: "run-event" as const,
        contractVersion: "1.0" as const,
        eventId: "event-api-notified-1",
        decisionTaskId: "task-api-notified",
        agentRunId: "agent-run-api-notified",
        sequence: 1,
        occurredAt: "2026-08-24T01:43:00.000Z",
        eventType: "TASK_STATE_CHANGED" as const,
        taskState: "CREATED" as const,
        summary: "决策任务已接受",
        synthetic: true as const
      }
    };
    const app = buildApiApp({
      decisionTaskEventNotifications: {
        async waitFor() {
          notificationWaits += 1;
          markWaitStarted?.();
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
      decisionTaskPersistence: {
        async submit() {
          throw new Error("本测试不应提交任务");
        },
        async get(decisionTaskId) {
          return {
            contractType: "decision-task-snapshot",
            contractVersion: "1.0",
            executionRequestId: "exec-api-notified",
            decisionTaskId,
            agentRunId: "agent-run-api-notified",
            state: "RUNNING",
            terminal: false,
            updatedAt: "2026-08-24T01:43:00.000Z"
          };
        },
        async listEvents() {
          eventQueries += 1;
          return eventQueries === 1 ? [] : [persistedEvent];
        }
      }
    });
    openApps.push(app);
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();

    try {
      const response = await fetch(`${origin}/api/v1/decision-tasks/task-api-notified/events`, {
        signal: controller.signal
      });
      const reader = response.body?.getReader();
      await waitStarted;
      wake?.();
      const chunk = await reader?.read();

      expect(response.status).toBe(200);
      expect(notificationWaits).toBeGreaterThanOrEqual(1);
      expect(eventQueries).toBe(2);
      expect(new TextDecoder().decode(chunk?.value)).toContain("id: 44\n");
      await reader?.cancel();
    } finally {
      controller.abort();
    }
  });

  it("falls back to Postgres polling when Redis notification waiting fails", async () => {
    let eventQueries = 0;
    const persistedEvent = {
      contractType: "persisted-run-event" as const,
      contractVersion: "1.0" as const,
      cursor: "45",
      event: {
        contractType: "run-event" as const,
        contractVersion: "1.0" as const,
        eventId: "event-api-poll-fallback-1",
        decisionTaskId: "task-api-poll-fallback",
        agentRunId: "agent-run-api-poll-fallback",
        sequence: 1,
        occurredAt: "2026-08-24T01:44:00.000Z",
        eventType: "TASK_STATE_CHANGED" as const,
        taskState: "CREATED" as const,
        summary: "从 Postgres 补查恢复",
        synthetic: true as const
      }
    };
    const app = buildApiApp({
      decisionTaskEventNotifications: {
        async waitFor() {
          throw new Error("Redis unavailable");
        }
      },
      decisionTaskEventPollIntervalMs: 10,
      decisionTaskPersistence: {
        async submit() {
          throw new Error("本测试不应提交任务");
        },
        async get(decisionTaskId) {
          return {
            contractType: "decision-task-snapshot",
            contractVersion: "1.0",
            executionRequestId: "exec-api-poll-fallback",
            decisionTaskId,
            agentRunId: "agent-run-api-poll-fallback",
            state: "RUNNING",
            terminal: false,
            updatedAt: "2026-08-24T01:44:00.000Z"
          };
        },
        async listEvents() {
          eventQueries += 1;
          return eventQueries === 1 ? [] : [persistedEvent];
        }
      }
    });
    openApps.push(app);
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();

    try {
      const response = await fetch(
        `${origin}/api/v1/decision-tasks/task-api-poll-fallback/events`,
        { signal: controller.signal }
      );
      const reader = response.body?.getReader();
      const chunk = await reader?.read();

      expect(response.status).toBe(200);
      expect(eventQueries).toBe(2);
      expect(new TextDecoder().decode(chunk?.value)).toContain("id: 45\n");
      await reader?.cancel();
    } finally {
      controller.abort();
    }
  });

  it("sends an SSE comment heartbeat without fabricating a RunEvent", async () => {
    const app = buildApiApp({
      decisionTaskEventPollIntervalMs: 10,
      decisionTaskPersistence: {
        async submit() {
          throw new Error("本测试不应提交任务");
        },
        async get(decisionTaskId) {
          return {
            contractType: "decision-task-snapshot",
            contractVersion: "1.0",
            executionRequestId: "exec-api-heartbeat",
            decisionTaskId,
            agentRunId: "agent-run-api-heartbeat",
            state: "RUNNING",
            terminal: false,
            updatedAt: "2026-08-24T01:45:00.000Z"
          };
        },
        async listEvents() {
          return [];
        }
      }
    });
    openApps.push(app);
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);

    try {
      const response = await fetch(`${origin}/api/v1/decision-tasks/task-api-heartbeat/events`, {
        signal: controller.signal
      });
      const reader = response.body?.getReader();
      const chunk = await reader?.read();
      const body = new TextDecoder().decode(chunk?.value);

      expect(body).toContain(": heartbeat\n\n");
      expect(body).not.toContain("data:");
      await reader?.cancel();
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
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
