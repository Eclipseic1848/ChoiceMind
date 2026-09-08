import {
  createCredentialVault,
  type EncryptedCredentialRecord,
  SecretValue
} from "@choicemind/security";
import { describe, expect, it, vi } from "vitest";

import { createSourceWorker } from "./worker.js";

const claim = {
  status: "CLAIMED" as const,
  jobId: "job-a",
  batchId: "batch-a",
  ownerUserId: "user-a",
  decisionTaskId: "task-a",
  query: "通勤耳机",
  sourceId: "fixture",
  sourceAccountId: "default",
  accessMode: "CREDENTIAL" as const,
  researchTarget: null,
  checkpoint: null,
  workerId: "worker-a",
  attemptCount: 1
};
const systemActor = Object.freeze({
  userId: "source-worker:worker-a",
  role: "SYSTEM" as const
});

describe("Source Worker", () => {
  it("公开来源不读取登录状态或凭据，直接提交研究结果", async () => {
    const complete = vi.fn(async () => ({ status: "COMMITTED" as const }));
    const sourceAccessUsed = vi.fn(() => {
      throw new Error("公开来源不应访问 Source Access");
    });
    const publicClaim = {
      ...claim,
      sourceId: "brand-web",
      sourceAccountId: "public",
      accessMode: "PUBLIC" as const,
      researchTarget: {
        subject: { kind: "CANDIDATE", value: "candidate-a" },
        claimTargets: [{ claimId: "claim-a", statement: "候选产品支持 USB-C" }]
      }
    };
    const run = vi.fn(async () => ({
      type: "NO_RESULT" as const,
      summary: "公开页面没有匹配内容",
      costUnits: 0
    }));
    const worker = createSourceWorker({
      workerId: "worker-a",
      systemActor,
      sourceAccess: {
        read: sourceAccessUsed,
        execute: sourceAccessUsed as never,
        withCredential: sourceAccessUsed as never
      },
      sourceResearch: {
        claimNext: vi.fn(async () => publicClaim),
        saveCheckpoint: vi.fn(),
        renewLease: vi.fn(async () => ({ status: "RENEWED" as const })),
        complete
      },
      adapters: new Map([
        [
          "brand-web",
          {
            accessMode: "PUBLIC" as const,
            run
          }
        ]
      ])
    });

    await expect(worker.runOnce()).resolves.toEqual({ claimed: 1, completed: 1 });
    expect(sourceAccessUsed).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith(
      publicClaim,
      expect.objectContaining({ type: "NO_RESULT" })
    );
  });

  it("公开来源缺少研究目标时失败关闭，不运行 Adapter", async () => {
    const complete = vi.fn(async () => ({ status: "COMMITTED" as const }));
    const run = vi.fn();
    const publicClaim = {
      ...claim,
      sourceId: "brand-web",
      sourceAccountId: "public",
      accessMode: "PUBLIC" as const,
      researchTarget: null
    };
    const worker = createSourceWorker({
      workerId: "worker-a",
      systemActor,
      sourceAccess: {
        read: vi.fn(),
        execute: vi.fn() as never,
        withCredential: vi.fn()
      },
      sourceResearch: {
        claimNext: vi.fn(async () => publicClaim),
        saveCheckpoint: vi.fn(),
        renewLease: vi.fn(async () => ({ status: "RENEWED" as const })),
        complete
      },
      adapters: new Map([
        ["brand-web", { accessMode: "PUBLIC" as const, run }]
      ])
    });

    await expect(worker.runOnce()).resolves.toEqual({ claimed: 1, completed: 1 });
    expect(run).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(publicClaim, {
      type: "FAILED_FINAL",
      summary: "公开来源缺少可验证的研究目标"
    });
  });

  it("没有有效登录时发起挑战并暂停，而不是报告失败", async () => {
    const complete = vi.fn(async () => ({ status: "COMMITTED" as const }));
    const beginLogin = vi.fn(async () => ({
      loginSessionId: "login-a",
      officialLoginUrl: "http://127.0.0.1:3000/source-login/login-a",
      ownerUserId: "user-a",
      sourceId: "fixture",
      sourceAccountId: "default",
      status: "WAITING_CHALLENGE" as const,
      createdAt: "2026-08-27T10:00:00.000Z",
      updatedAt: "2026-08-27T10:00:00.000Z"
    }));
    const worker = createSourceWorker({
      workerId: "worker-a",
      systemActor,
      sourceAccess: {
        read: vi.fn(async () => undefined),
        execute: beginLogin as never,
        withCredential: vi.fn()
      },
      sourceResearch: {
        claimNext: vi.fn(async () => claim),
        saveCheckpoint: vi.fn(),
        renewLease: vi.fn(async () => ({ status: "RENEWED" as const })),
        complete
      },
      adapters: new Map([
        ["fixture", { accessMode: "CREDENTIAL", officialLoginUrl: "http://127.0.0.1:3000/source-login", run: vi.fn() }]
      ])
    });

    await expect(worker.runOnce()).resolves.toEqual({ claimed: 1, completed: 1 });
    expect(beginLogin).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith(claim, {
      type: "WAITING_CHALLENGE",
      challenge: "QR_CODE",
      loginSessionId: "login-a"
    });
  });

  it("有效登录只在短时凭据回调中运行 Adapter 并提交结果", async () => {
    const complete = vi.fn(async () => ({ status: "COMMITTED" as const }));
    const run = vi.fn(async ({ revealCredential }: { revealCredential(): string }) => {
      expect(revealCredential()).toBe("opaque-cookie");
      return {
        type: "EVIDENCE" as const,
        resultKey: "fixture:item-1",
        evidenceId: "evidence-1",
        summary: "测试证据",
        material: { synthetic: true, summary: "测试证据" },
        costUnits: 1
      };
    });
    const worker = createSourceWorker({
      workerId: "worker-a",
      systemActor,
      sourceAccess: {
        read: vi.fn(async () => ({
          ownerUserId: "user-a",
          sourceId: "fixture",
          sourceAccountId: "default",
          status: "ACTIVE" as const,
          updatedAt: "2026-08-27T10:00:00.000Z"
        })),
        execute: vi.fn(),
        withCredential: vi.fn(async (_input, operation) => {
          const secret = new SecretValue(Buffer.from("opaque-cookie"));
          try {
            await operation(secret);
          } finally {
            secret.dispose();
          }
        })
      },
      sourceResearch: {
        claimNext: vi.fn(async () => claim),
        saveCheckpoint: vi.fn(),
        renewLease: vi.fn(async () => ({ status: "RENEWED" as const })),
        complete
      },
      adapters: new Map([["fixture", { accessMode: "CREDENTIAL", officialLoginUrl: "fixture", run }]])
    });

    await worker.runOnce();
    expect(run).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith(
      claim,
      expect.objectContaining({ type: "EVIDENCE", resultKey: "fixture:item-1" })
    );
  });

  it("运行期凭据失效时清理状态并返回可继续的登录挑战", async () => {
    const complete = vi.fn(async () => ({ status: "COMMITTED" as const }));
    const execute = vi.fn(async (command: { type: string }) =>
      command.type === "BEGIN_LOGIN"
        ? {
            loginSessionId: "login-recovery",
            officialLoginUrl: "fixture",
            ownerUserId: "user-a",
            sourceId: "fixture",
            sourceAccountId: "default",
            status: "WAITING_CHALLENGE" as const,
            createdAt: "2026-08-27T10:00:00.000Z",
            updatedAt: "2026-08-27T10:00:00.000Z"
          }
        : {
            ownerUserId: "user-a",
            sourceId: "fixture",
            sourceAccountId: "default",
            status: "INVALID" as const,
            updatedAt: "2026-08-27T10:00:00.000Z"
          }
    );
    const records = new Map<string, EncryptedCredentialRecord>();
    const appendAuditRecord = vi.fn(async () => undefined);
    const vault = createCredentialVault({
      masterKey: Buffer.alloc(32, 7),
      systemAccess: {
        actor: systemActor,
        secretType: "SOURCE_CREDENTIAL",
        actions: ["USE", "DELETE"]
      },
      storage: {
        save: async (record) => {
          records.set(record.credentialId, record);
        },
        load: async (credentialId) => records.get(credentialId)
      },
      appendAuditRecord
    });
    await vault.store({
      credentialId: "credential-a",
      ownerUserId: "user-a",
      secret: "expired-cookie",
      secretType: "SOURCE_CREDENTIAL",
      actor: { userId: "user-a", role: "USER" },
      correlationId: "store-a"
    });
    const worker = createSourceWorker({
      workerId: "worker-a",
      systemActor,
      sourceAccess: {
        read: vi.fn(async () => ({
          ownerUserId: "user-a",
          sourceId: "fixture",
          sourceAccountId: "default",
          status: "ACTIVE" as const,
          updatedAt: "2026-08-27T10:00:00.000Z"
        })),
        execute: execute as never,
        withCredential: vi.fn(async (input, operation) =>
          vault.use(
            {
              credentialId: "credential-a",
              ownerUserId: input.ownerUserId,
              actor: input.actor,
              correlationId: input.correlationId
            },
            operation
          )
        )
      },
      sourceResearch: {
        claimNext: vi.fn(async () => claim),
        saveCheckpoint: vi.fn(),
        renewLease: vi.fn(async () => ({ status: "RENEWED" as const })),
        complete
      },
      adapters: new Map([
        [
          "fixture",
          {
            accessMode: "CREDENTIAL",
            officialLoginUrl: "fixture",
            run: vi.fn(async () => ({ type: "AUTH_REQUIRED" as const, challenge: "QR_CODE" as const }))
          }
        ]
      ])
    });

    await worker.runOnce();
    expect(execute.mock.calls.map(([command]) => command.type)).toEqual([
      "MARK_INVALID",
      "BEGIN_LOGIN"
    ]);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      actor: { userId: "source-worker:worker-a", role: "SYSTEM" }
    });
    expect(appendAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CREDENTIAL_USE",
        actor: { userId: "source-worker:worker-a", role: "SYSTEM" }
      })
    );
    expect(complete).toHaveBeenCalledWith(
      claim,
      expect.objectContaining({ type: "WAITING_CHALLENGE", loginSessionId: "login-recovery" })
    );
  });

  it("Vault 读取故障只重试研究，不把凭据误判为登录失效", async () => {
    const execute = vi.fn();
    const complete = vi.fn(async () => ({ status: "COMMITTED" as const }));
    const vault = createCredentialVault({
      masterKey: Buffer.alloc(32, 17),
      systemAccess: {
        actor: systemActor,
        secretType: "SOURCE_CREDENTIAL",
        actions: ["USE", "DELETE"]
      },
      storage: {
        save: async () => undefined,
        load: async () => {
          throw new Error("POSTGRES_TEMPORARILY_UNAVAILABLE");
        }
      },
      appendAuditRecord: vi.fn(async () => undefined)
    });
    const worker = createSourceWorker({
      workerId: "worker-a",
      systemActor,
      sourceAccess: {
        read: vi.fn(async () => ({
          ownerUserId: "user-a",
          sourceId: "fixture",
          sourceAccountId: "default",
          status: "ACTIVE" as const,
          updatedAt: "2026-08-27T10:00:00.000Z"
        })),
        execute: execute as never,
        withCredential: vi.fn(async (input, operation) =>
          vault.use(
            {
              credentialId: "credential-a",
              ownerUserId: input.ownerUserId,
              actor: input.actor,
              correlationId: input.correlationId
            },
            operation
          )
        )
      },
      sourceResearch: {
        claimNext: vi.fn(async () => claim),
        saveCheckpoint: vi.fn(),
        renewLease: vi.fn(async () => ({ status: "RENEWED" as const })),
        complete
      },
      adapters: new Map([["fixture", { accessMode: "CREDENTIAL", officialLoginUrl: "fixture", run: vi.fn() }]])
    });

    await worker.runOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      claim,
      expect.objectContaining({ type: "FAILED_RETRYABLE" })
    );
  });

	it("长时间 Adapter 运行时续租，避免第二个 Worker 重复执行", async () => {
		vi.useFakeTimers();
		try {
			let finishRun: (() => void) | undefined;
			const run = vi.fn(
				() =>
					new Promise<{
						type: "NO_RESULT";
						summary: string;
						costUnits: number;
					}>((resolve) => {
						finishRun = () => resolve({ type: "NO_RESULT", summary: "完成", costUnits: 0 });
					}),
			);
			const renewLease = vi.fn(async () => ({ status: "RENEWED" as const }));
			const worker = createSourceWorker({
				workerId: "worker-a",
				systemActor,
				leaseDurationMs: 300,
				heartbeatIntervalMs: 100,
				sourceAccess: {
					read: vi.fn(async () => ({
						ownerUserId: "user-a",
						sourceId: "fixture",
						sourceAccountId: "default",
						status: "ACTIVE" as const,
						updatedAt: "2026-08-27T10:00:00.000Z",
					})),
					execute: vi.fn(),
					withCredential: vi.fn(async (_input, operation) => {
						const secret = new SecretValue(Buffer.from("opaque-cookie"));
						try { await operation(secret); } finally { secret.dispose(); }
					}),
				},
				sourceResearch: {
					claimNext: vi.fn(async () => claim),
					saveCheckpoint: vi.fn(),
					renewLease,
					complete: vi.fn(async () => ({ status: "COMMITTED" as const })),
				},
				adapters: new Map([["fixture", { accessMode: "CREDENTIAL", officialLoginUrl: "fixture", run }]]),
			});
			const running = worker.runOnce();
			await vi.advanceTimersByTimeAsync(110);
			expect(renewLease).toHaveBeenCalledOnce();
			finishRun?.();
			await running;
		} finally {
			vi.useRealTimers();
		}
	});
});
