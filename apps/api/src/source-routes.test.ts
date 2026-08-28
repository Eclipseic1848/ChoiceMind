import { describe, expect, it, vi } from "vitest";

import { buildApiApp } from "./app.js";

const principal = {
  principalId: "principal-a",
  role: "USER" as const,
  userId: "user-a"
};

describe("Source Access 与 Research 路由", () => {
  it("使用已认证用户身份创建研究批次，不接受客户端伪造 owner", async () => {
    const executeResearch = vi.fn(async (command) => ({
      batchId: command.batchId,
      ownerUserId: command.ownerUserId,
      decisionTaskId: command.decisionTaskId,
      query: command.query,
      state: "QUEUED" as const,
      costUnits: 0,
      jobs: [],
      results: [],
      createdAt: "2026-08-27T10:00:00.000Z",
      updatedAt: "2026-08-27T10:00:00.000Z"
    }));
    const app = buildApiApp({
      identityResolver: { resolve: vi.fn(async () => principal) },
      decisionTaskPersistence: decisionTaskPersistenceStub(),
      sourceAccess: sourceAccessStub(),
      sourceResearch: sourceResearchStub({ execute: executeResearch })
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/source-research/batches",
      payload: {
        batchId: "7ae28cca-a1b8-4e9c-aafd-3d40a82b7815",
        decisionTaskId: "task-a",
        idempotencyKey: "request-a",
        ownerUserId: "user-b",
        query: "通勤耳机",
        sources: [{ sourceId: "fixture", sourceAccountId: "default" }]
      }
    });

    expect(response.statusCode).toBe(201);
    expect(executeResearch).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: "user-a" })
    );
    expect(executeResearch).not.toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: "user-b" })
    );
    await app.close();
  });

  it("拒绝把研究批次绑定到不属于当前用户的任务", async () => {
    const executeResearch = vi.fn();
    const app = buildApiApp({
      identityResolver: { resolve: vi.fn(async () => principal) },
      decisionTaskPersistence: decisionTaskPersistenceStub({ get: vi.fn(async () => undefined) }),
      sourceAccess: sourceAccessStub(),
      sourceResearch: sourceResearchStub({ execute: executeResearch })
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/source-research/batches",
      payload: {
        batchId: "7ae28cca-a1b8-4e9c-aafd-3d40a82b7815",
        decisionTaskId: "task-b",
        idempotencyKey: "request-a",
        query: "通勤耳机",
        sources: [{ sourceId: "fixture", sourceAccountId: "default" }]
      }
    });

    expect(response.statusCode).toBe(404);
    expect(executeResearch).not.toHaveBeenCalled();
    await app.close();
  });

  it("Fixture 登录完成后激活凭据并恢复该用户等待中的来源作业", async () => {
    const loginSessionId = "7ae28cca-a1b8-4e9c-aafd-3d40a82b7815";
    const executeAccess = vi
      .fn()
      .mockResolvedValueOnce({
        loginSessionId,
        officialLoginUrl: `/source-login/${loginSessionId}`,
        ownerUserId: "user-a",
        sourceId: "fixture",
        sourceAccountId: "default",
        status: "WAITING_CHALLENGE",
        createdAt: "2026-08-27T10:00:00.000Z",
        updatedAt: "2026-08-27T10:00:00.000Z"
      })
      .mockResolvedValueOnce({
        ownerUserId: "user-a",
        sourceId: "fixture",
        sourceAccountId: "default",
        status: "ACTIVE",
        updatedAt: "2026-08-27T10:01:00.000Z"
      });
    const executeResearch = vi.fn(async () => ({ resumed: 1 }));
    const app = buildApiApp({
      identityResolver: { resolve: vi.fn(async () => principal) },
      sourceAccess: sourceAccessStub({ execute: executeAccess }),
      sourceResearch: sourceResearchStub({ execute: executeResearch })
    });

    const begin = await app.inject({
      method: "POST",
      url: "/api/v1/sources/fixture/login",
      payload: { sourceAccountId: "default" }
    });
    expect(begin.statusCode).toBe(201);
    expect(begin.json()).not.toHaveProperty("credentialSecret");

    const complete = await app.inject({
      method: "POST",
      url: `/api/v1/source-login/${loginSessionId}/fixture-complete`
    });
    expect(complete.statusCode).toBe(200);
    expect(executeAccess.mock.calls[1]?.[0]).toMatchObject({
      type: "COMPLETE_LOGIN",
      ownerUserId: "user-a",
      loginSessionId
    });
    expect(executeResearch).toHaveBeenCalledWith({
      type: "RESUME_SOURCE",
      ownerUserId: "user-a",
      sourceId: "fixture",
      sourceAccountId: "default"
    });
    await app.close();
  });

  it("当前用户可以主动撤销自己的来源凭据", async () => {
    const executeAccess = vi.fn(async () => ({
      ownerUserId: "user-a",
      sourceId: "fixture",
      sourceAccountId: "default",
      status: "REVOKED" as const,
      updatedAt: "2026-08-27T10:01:00.000Z"
    }));
    const adminPrincipal = { ...principal, role: "ADMIN" as const };
    const app = buildApiApp({
      identityResolver: { resolve: vi.fn(async () => adminPrincipal) },
      sourceAccess: sourceAccessStub({ execute: executeAccess })
    });
    const response = await app.inject({
      method: "DELETE",
      url: "/api/v1/sources/fixture/credentials/default"
    });
    expect(response.statusCode).toBe(200);
    expect(executeAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "REVOKE_CREDENTIAL",
        ownerUserId: "user-a",
        actor: { userId: "user-a", role: "ADMIN" }
      })
    );
    await app.close();
  });

  it("非法批次 UUID 返回 404 而不是进入 Postgres", async () => {
    const read = vi.fn();
    const app = buildApiApp({
      identityResolver: { resolve: vi.fn(async () => principal) },
      sourceResearch: sourceResearchStub({ read })
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/source-research/batches/${"-".repeat(36)}`
    });
    expect(response.statusCode).toBe(404);
    expect(read).not.toHaveBeenCalled();
    await app.close();
  });
});

function sourceAccessStub(overrides: Record<string, unknown> = {}) {
  return {
    execute: vi.fn(),
    read: vi.fn(async () => []),
    withCredential: vi.fn(),
    purgePrivateDataForOwner: vi.fn(),
    close: vi.fn(),
    ...overrides
  } as never;
}

function sourceResearchStub(overrides: Record<string, unknown> = {}) {
  return {
    execute: vi.fn(),
    read: vi.fn(),
    claimNext: vi.fn(),
    saveCheckpoint: vi.fn(),
    complete: vi.fn(),
    purgePrivateDataForOwner: vi.fn(),
    close: vi.fn(),
    ...overrides
  } as never;
}

function decisionTaskPersistenceStub(overrides: Record<string, unknown> = {}) {
  return {
    submit: vi.fn(),
    get: vi.fn(async () => ({ decisionTaskId: "task-a" })),
    listEvents: vi.fn(async () => []),
    ...overrides
  } as never;
}
