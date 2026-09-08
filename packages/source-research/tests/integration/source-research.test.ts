import { randomUUID } from "node:crypto";

import { createClient } from "@redis/client";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  openPostgresSourceResearch,
  openSourceResearchNotificationPublisher,
  type SourceResearch
} from "../../src/index.js";

const databaseUrl = requireEnvironment("CHOICEMIND_TEST_DATABASE_URL");
const openModules: SourceResearch[] = [];

beforeEach(async () => {
  const module = await openPostgresSourceResearch({ databaseUrl });
  await module.close();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      "TRUNCATE source_research_results, source_research_outbox, source_research_jobs, source_research_batches"
    );
  } finally {
    await client.end();
  }
});

afterEach(async () => {
  await Promise.all(openModules.splice(0).map(async (module) => module.close()));
});

describe("Postgres Source Research", () => {
  it("公开来源必须携带可验证的研究目标，并在领取后保持不变", async () => {
    const module = await openPostgresSourceResearch({ databaseUrl });
    openModules.push(module);
    const command = {
      type: "CREATE_BATCH" as const,
      batchId: randomUUID(),
      ownerUserId: "user-a",
      decisionTaskId: "task-public",
      idempotencyKey: randomUUID(),
      query: "核验显示器的 USB-C 能力",
      sources: [
        {
          sourceId: "brand-official",
          sourceAccountId: "public",
          accessMode: "PUBLIC" as const
        }
      ]
    };

    await expect(module.execute(command)).rejects.toThrow(
      "SOURCE_RESEARCH_TARGET_REQUIRED"
    );

    const researchTarget = {
      subject: { kind: "CANDIDATE", value: "candidate-a" },
      claimTargets: [{ claimId: "claim-a", statement: "候选产品支持 USB-C" }]
    };
    await module.execute({ ...command, target: researchTarget });
    await expect(module.claimNext("worker-public", 30_000)).resolves.toMatchObject({
      status: "CLAIMED",
      accessMode: "PUBLIC",
      researchTarget
    });
  });

  it("一个作业原子提交多条 Evidence，重复完成不重复计费", async () => {
    const module = await openPostgresSourceResearch({ databaseUrl });
    openModules.push(module);
    const batch = await module.execute({
      type: "CREATE_BATCH",
      batchId: randomUUID(),
      ownerUserId: "user-a",
      decisionTaskId: "task-batch-evidence",
      idempotencyKey: randomUUID(),
      query: "核验两项产品规格",
      target: {
        subject: { kind: "CANDIDATE", value: "candidate-a" },
        claimTargets: [
          { claimId: "claim-a", statement: "支持 USB-C" },
          { claimId: "claim-b", statement: "支持升降支架" }
        ]
      },
      sources: [
        {
          sourceId: "brand-official",
          sourceAccountId: "public",
          accessMode: "PUBLIC"
        }
      ]
    });
    const claim = await module.claimNext("worker-public", 30_000);
    if (claim.status !== "CLAIMED") throw new Error("公开来源作业未领取");
    const outcome = {
      type: "EVIDENCE_BATCH" as const,
      items: [
        {
          resultKey: "brand:item-a",
          evidenceId: "evidence-a",
          summary: "USB-C 规格",
          material: { excerpt: "支持 USB-C" }
        },
        {
          resultKey: "brand:item-b",
          evidenceId: "evidence-b",
          summary: "支架规格",
          material: { excerpt: "支持升降" }
        }
      ],
      costUnits: 3,
      checkpoint: { searched: 8, deepRead: 2, hasMore: true }
    };

    await expect(module.complete(claim, {
      ...outcome,
      items: outcome.items.map((item, index) => index === 1 ? { ...item, material: { invalid: 1n } } : item)
    })).rejects.toThrow();
    await expect(module.read({
      type: "GET_BATCH", batchId: batch.batchId, ownerUserId: "user-a"
    })).resolves.toMatchObject({ state: "RUNNING", costUnits: 0, results: [] });
    const verification = new Client({ connectionString: databaseUrl });
    await verification.connect();
    try {
      const jobs = await verification.query(
        "SELECT state, cost_units, checkpoint FROM source_research_jobs WHERE batch_id = $1",
        [batch.batchId]
      );
      expect(jobs.rows).toEqual([{ state: "RUNNING", cost_units: 0, checkpoint: null }]);
    } finally {
      await verification.end();
    }

    await expect(module.complete(claim, outcome)).resolves.toEqual({
      status: "COMMITTED"
    });
    await expect(module.complete(claim, outcome)).resolves.toEqual({
      status: "ALREADY_COMMITTED"
    });
    for (const conflicting of [
      { ...outcome, items: outcome.items.slice(0, 1) },
      { ...outcome, items: outcome.items.map((item) => ({ ...item, material: { excerpt: "改变后的正文" } })) },
      { ...outcome, costUnits: 4 },
      { ...outcome, checkpoint: { ...outcome.checkpoint, hasMore: false } }
    ]) {
      await expect(module.complete(claim, conflicting)).rejects.toThrow(
        "SOURCE_RESEARCH_OUTCOME_CONFLICT"
      );
    }
    await expect(
      module.read({ type: "GET_BATCH", batchId: batch.batchId, ownerUserId: "user-a" })
    ).resolves.toMatchObject({
      state: "COMPLETED",
      costUnits: 3,
      results: [
        { resultKey: "brand:item-a", evidenceId: "evidence-a" },
        { resultKey: "brand:item-b", evidenceId: "evidence-b" }
      ]
    });
  });

  it("恢复过期租约并且同一作业只允许一个 Worker 领取", async () => {
    let now = new Date("2026-08-27T10:00:00.000Z");
    const module = await openPostgresSourceResearch({ databaseUrl, now: () => now });
    openModules.push(module);
    const batch = await module.execute({
      type: "CREATE_BATCH",
      batchId: randomUUID(),
      ownerUserId: "user-a",
      decisionTaskId: "task-a",
      idempotencyKey: randomUUID(),
      query: "适合通勤的轻薄本",
      sources: [{ sourceId: "fixture", sourceAccountId: "default" }]
    });

    const claims = await Promise.all(
      Array.from({ length: 6 }, async (_, index) =>
        module.claimNext(`worker-${index}`, 30_000)
      )
    );
    const firstClaim = claims.find((claim) => claim.status === "CLAIMED");
    expect(firstClaim).toBeDefined();
    if (firstClaim?.status !== "CLAIMED") throw new Error("测试作业未领取");
    await expect(
      module.saveCheckpoint(firstClaim, { cursor: "fixture-page-2" })
    ).resolves.toEqual({ status: "SAVED" });
		now = new Date("2026-08-27T10:00:20.000Z");
		await expect(module.renewLease(firstClaim, 30_000)).resolves.toEqual({
			status: "RENEWED",
		});
		now = new Date("2026-08-27T10:00:40.000Z");
		await expect(module.claimNext("worker-too-early", 30_000)).resolves.toEqual({
			status: "EMPTY",
		});

    now = new Date("2026-08-27T10:01:00.000Z");
    await expect(module.claimNext("worker-recovery", 30_000)).resolves.toMatchObject({
      status: "CLAIMED",
      batchId: batch.batchId,
      checkpoint: { cursor: "fixture-page-2" }
    });
  });

  it("登录挑战是等待状态，登录成功后可自动恢复", async () => {
    const module = await openPostgresSourceResearch({ databaseUrl });
    openModules.push(module);
    await module.execute({
      type: "CREATE_BATCH",
      batchId: randomUUID(),
      ownerUserId: "user-a",
      decisionTaskId: "task-a",
      idempotencyKey: randomUUID(),
      query: "无线耳机",
      sources: [{ sourceId: "fixture", sourceAccountId: "default" }]
    });
    const claim = await module.claimNext("worker-a", 30_000);
    if (claim.status !== "CLAIMED") throw new Error("测试作业未领取");

    await module.complete(claim, {
      type: "WAITING_CHALLENGE",
      challenge: "QR_CODE",
      loginSessionId: "login-a"
    });
    await expect(
      module.read({ type: "GET_BATCH", batchId: claim.batchId, ownerUserId: "user-a" })
    ).resolves.toMatchObject({
			state: "WAITING_SOURCE_LOGIN",
			jobs: [{ loginSessionId: "login-a" }],
		});
		await expect(
			module.read({
				type: "GET_BATCH_FOR_TASK",
				decisionTaskId: "task-a",
				ownerUserId: "user-a",
			}),
		).resolves.toMatchObject({ batchId: claim.batchId });
    await expect(module.claimNext("worker-b", 30_000)).resolves.toEqual({ status: "EMPTY" });

    await expect(
      module.execute({
        type: "RESUME_SOURCE",
        ownerUserId: "user-a",
        sourceId: "fixture",
        sourceAccountId: "default"
      })
    ).resolves.toEqual({ resumed: 1 });
    await expect(module.claimNext("worker-b", 30_000)).resolves.toMatchObject({
      status: "CLAIMED",
      jobId: claim.jobId
    });
  });

  it("隔离用户读取，并以结果键阻止重复 Evidence 与成本", async () => {
    const module = await openPostgresSourceResearch({ databaseUrl });
    openModules.push(module);
    const batch = await module.execute({
      type: "CREATE_BATCH",
      batchId: randomUUID(),
      ownerUserId: "user-a",
      decisionTaskId: "task-a",
      idempotencyKey: "same-request",
      query: "人体工学椅",
      sources: [{ sourceId: "fixture", sourceAccountId: "default" }]
    });
    await expect(
      module.read({ type: "GET_BATCH", batchId: batch.batchId, ownerUserId: "user-b" })
    ).resolves.toBeUndefined();
    const claim = await module.claimNext("worker-a", 30_000);
    if (claim.status !== "CLAIMED") throw new Error("测试作业未领取");
    const material = {
      excerpt: "测试证据原始材料",
      locator: { section: "fixture", field: "body" },
      rawArtifact: {
        objectKey: "source-artifacts/sha256/fixture",
        digest: "fixture"
      }
    };
    const outcome = {
      type: "EVIDENCE" as const,
      resultKey: "fixture:item-1",
      evidenceId: "evidence-1",
      summary: "测试证据",
      material,
      costUnits: 3
    };
    await expect(module.complete(claim, outcome)).resolves.toEqual({
      status: "COMMITTED"
    });
    await expect(module.complete(claim, outcome)).resolves.toEqual({
      status: "ALREADY_COMMITTED"
    });

    await expect(
      module.read({ type: "GET_BATCH", batchId: batch.batchId, ownerUserId: "user-a" })
    ).resolves.toMatchObject({
      state: "COMPLETED",
      costUnits: 3,
      results: [{ evidenceId: "evidence-1", resultKey: "fixture:item-1" }]
    });
    expect(
      JSON.stringify(
        await module.read({
          type: "GET_BATCH",
          batchId: batch.batchId,
          ownerUserId: "user-a"
        })
      )
    ).not.toContain("rawArtifact");
    await expect(
      module.readEvidenceCandidates({ batchId: batch.batchId, ownerUserId: "user-b" })
    ).resolves.toBeUndefined();
    await expect(
      module.readEvidenceCandidates({ batchId: batch.batchId, ownerUserId: "user-a" })
    ).resolves.toEqual({
      batchId: batch.batchId,
      ownerUserId: "user-a",
      decisionTaskId: "task-a",
      results: [{ resultKey: "fixture:item-1", material }]
    });
  });

  it("从 Postgres Outbox 向 Redis 发送仅用于唤醒的通知", async () => {
    const redisUrl = requireEnvironment("CHOICEMIND_TEST_REDIS_URL");
    const channelName = `choicemind:test:source-research:${randomUUID()}`;
    const module = await openPostgresSourceResearch({ databaseUrl });
    openModules.push(module);
    await module.execute({
      type: "CREATE_BATCH",
      batchId: randomUUID(),
      ownerUserId: "user-a",
      decisionTaskId: "task-notify",
      idempotencyKey: randomUUID(),
      query: "通知测试",
      sources: [{ sourceId: "fixture", sourceAccountId: "default" }]
    });
    const subscriber = createClient({ url: redisUrl });
    await subscriber.connect();
    let resolveMessage: ((message: string) => void) | undefined;
    const received = new Promise<string>((resolve) => {
      resolveMessage = resolve;
    });
    await subscriber.subscribe(channelName, (message) => resolveMessage?.(message));
    const publisher = await openSourceResearchNotificationPublisher({
      databaseUrl,
      redisUrl,
      channelName
    });
    try {
      await expect(publisher.runOnce()).resolves.toEqual({ published: 1 });
      await expect(received).resolves.toContain("SOURCE_RESEARCH_QUEUED");
      await expect(publisher.runOnce()).resolves.toEqual({ published: 0 });
    } finally {
      await Promise.all([publisher.close(), subscriber.close()]);
    }
  });

  it("混合 Evidence 与正常无结果会终结批次并准确累计成本", async () => {
    const module = await openPostgresSourceResearch({ databaseUrl });
    openModules.push(module);
    const batch = await module.execute({
      type: "CREATE_BATCH",
      batchId: randomUUID(),
      ownerUserId: "user-a",
      decisionTaskId: "task-mixed",
      idempotencyKey: randomUUID(),
      query: "混合结果测试",
      sources: [
        { sourceId: "fixture", sourceAccountId: "first" },
        { sourceId: "fixture", sourceAccountId: "second" }
      ]
    });
    const first = await module.claimNext("worker-a", 30_000);
    if (first.status !== "CLAIMED") throw new Error("第一个作业未领取");
    await module.complete(first, {
      type: "EVIDENCE",
      resultKey: "fixture:mixed",
      evidenceId: "evidence-mixed",
      summary: "一个结果",
      material: { synthetic: true, summary: "一个结果" },
      costUnits: 2
    });
    const second = await module.claimNext("worker-b", 30_000);
    if (second.status !== "CLAIMED") throw new Error("第二个作业未领取");
    await module.complete(second, {
      type: "NO_RESULT",
      summary: "正常没有更多结果",
      costUnits: 4
    });

    await expect(
      module.read({ type: "GET_BATCH", batchId: batch.batchId, ownerUserId: "user-a" })
    ).resolves.toMatchObject({ state: "COMPLETED", costUnits: 6 });
  });

	it("并发同键请求只创建一个批次，并拒绝同键不同语义", async () => {
		const module = await openPostgresSourceResearch({ databaseUrl });
		openModules.push(module);
		const command = {
			type: "CREATE_BATCH" as const,
			batchId: randomUUID(),
			ownerUserId: "user-a",
			decisionTaskId: "task-idempotent",
			idempotencyKey: randomUUID(),
			query: "同一个请求",
			sources: [{ sourceId: "fixture", sourceAccountId: "default" }],
		};
		const [first, second] = await Promise.all([
			module.execute(command),
			module.execute({ ...command, batchId: randomUUID() }),
		]);
		expect(second.batchId).toBe(first.batchId);
		await expect(
			module.execute({ ...command, batchId: randomUUID(), query: "不同请求" }),
		).rejects.toThrow("SOURCE_RESEARCH_IDEMPOTENCY_CONFLICT");
	});

	it("可重试失败会退避、达到上限后终结，混合最终失败不会伪装排队", async () => {
		let now = new Date("2026-08-27T10:00:00.000Z");
		const module = await openPostgresSourceResearch({ databaseUrl, now: () => now });
		openModules.push(module);
		const batch = await module.execute({
			type: "CREATE_BATCH",
			batchId: randomUUID(),
			ownerUserId: "user-a",
			decisionTaskId: "task-retry",
			idempotencyKey: randomUUID(),
			query: "重试测试",
			sources: [
				{ sourceId: "fixture", sourceAccountId: "success" },
				{ sourceId: "fixture", sourceAccountId: "failure" },
			],
		});
		const success = await module.claimNext("worker-success", 30_000);
		if (success.status !== "CLAIMED") throw new Error("成功作业未领取");
		await module.complete(success, { type: "NO_RESULT", summary: "完成", costUnits: 0 });
		for (let attempt = 1; attempt <= 5; attempt += 1) {
			const failed = await module.claimNext(`worker-${attempt}`, 30_000);
			if (failed.status !== "CLAIMED") throw new Error("失败作业未领取");
			await module.complete(failed, { type: "FAILED_RETRYABLE", summary: "暂时失败" });
			if (attempt < 5) {
				await expect(module.claimNext("worker-hot-loop", 30_000)).resolves.toEqual({ status: "EMPTY" });
				now = new Date(now.getTime() + 2 ** (attempt - 1) * 1_000);
			}
		}
		await expect(
			module.read({ type: "GET_BATCH", batchId: batch.batchId, ownerUserId: "user-a" }),
		).resolves.toMatchObject({ state: "FAILED" });
	});

	it("Worker 连续崩溃也不能绕过五次领取上限", async () => {
		let now = new Date("2026-08-27T10:00:00.000Z");
		const module = await openPostgresSourceResearch({ databaseUrl, now: () => now });
		openModules.push(module);
		const batch = await module.execute({
			type: "CREATE_BATCH",
			batchId: randomUUID(),
			ownerUserId: "user-a",
			decisionTaskId: "task-crash-loop",
			idempotencyKey: randomUUID(),
			query: "崩溃恢复上限",
			sources: [{ sourceId: "fixture", sourceAccountId: "default" }],
		});
		for (let attempt = 1; attempt <= 5; attempt += 1) {
			await expect(module.claimNext(`crashed-worker-${attempt}`, 100)).resolves.toMatchObject({
				status: "CLAIMED",
				attemptCount: attempt,
			});
			now = new Date(now.getTime() + 101);
		}
		await expect(module.claimNext("worker-over-limit", 100)).resolves.toEqual({
			status: "EMPTY",
		});
		await expect(
			module.read({ type: "GET_BATCH", batchId: batch.batchId, ownerUserId: "user-a" }),
		).resolves.toMatchObject({ state: "FAILED", jobs: [{ state: "FAILED_FINAL" }] });
	});
});

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} 未配置`);
  return value;
}
