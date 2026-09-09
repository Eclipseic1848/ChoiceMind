import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect, it } from "vitest";
import { openPostgresSourceResearch } from "../../src/index.js";

it("新增访问模式不改变历史多账号请求的幂等指纹", async () => {
	const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL;
	if (!databaseUrl) throw new Error("CHOICEMIND_TEST_DATABASE_URL_REQUIRED");
	const store = await openPostgresSourceResearch({ databaseUrl });
	const client = new Client({ connectionString: databaseUrl });
	try {
		await client.connect();
		const command = {
			type: "CREATE_BATCH" as const,
			batchId: randomUUID(),
			ownerUserId: randomUUID(),
			decisionTaskId: randomUUID(),
			idempotencyKey: randomUUID(),
			query: "历史账号重试",
			sources: ["a", "ab"].map((sourceAccountId) => ({
				sourceId: "legacy",
				sourceAccountId,
			})),
		};
		const batch = await store.execute(command);
		// 模拟升级前已保存的指纹；旧排序为 a、ab，显式模式不能使重试冲突。
		const fingerprint = createHash("sha256")
			.update(
				JSON.stringify({
					decisionTaskId: command.decisionTaskId,
					query: command.query,
					sources: command.sources,
				}),
			)
			.digest("hex");
		await client.query(
			"UPDATE source_research_batches SET request_fingerprint = $2 WHERE batch_id = $1",
			[batch.batchId, fingerprint],
		);
		await expect(
			store.execute({
				...command,
				sources: command.sources.map((source) => ({
					...source,
					accessMode: "CREDENTIAL",
				})),
			}),
		).resolves.toEqual(batch);
		for (const _source of command.sources) {
			const claim = await store.claimNext("legacy-test", 30_000);
			if (claim.status !== "CLAIMED") throw new Error("CLAIM_REQUIRED");
			await store.complete(claim, {
				type: "NO_RESULT",
				summary: "合成测试",
				costUnits: 0,
			});
		}
	} finally {
		await client.end();
		await store.close();
	}
});

it("公开目标持久化，错误输入拒绝；旧凭据任务仍幂等且保留访问模式", async () => {
	const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL;
	if (!databaseUrl) throw new Error("CHOICEMIND_TEST_DATABASE_URL_REQUIRED");
	let store = await openPostgresSourceResearch({ databaseUrl });
	try {
		const command = {
			type: "CREATE_BATCH" as const,
			batchId: randomUUID(),
			ownerUserId: randomUUID(),
			decisionTaskId: randomUUID(),
			idempotencyKey: randomUUID(),
			query: "核验公开规格",
			sources: [
				{
					sourceId: "public-test",
					sourceAccountId: "public",
					accessMode: "PUBLIC" as const,
				},
			],
		};
		await expect(store.execute(command)).rejects.toThrow(
			"SOURCE_RESEARCH_TARGET_REQUIRED",
		);
		const target = {
			subject: { kind: "CANDIDATE", value: "synthetic" },
			claimTargets: [{ claimId: "usb-c", statement: "支持 USB-C" }],
		};
		await expect(
			store.execute({
				...command,
				target: {
					...target,
					claimTargets: [...target.claimTargets, ...target.claimTargets],
				},
			}),
		).rejects.toThrow("SOURCE_RESEARCH_TARGET_INVALID");
		await expect(
			store.execute({
				...command,
				target,
				sources: command.sources.map((source) => ({
					...source,
					sourceAccountId: "private",
				})),
			}),
		).rejects.toThrow("SOURCE_RESEARCH_BATCH_INVALID");
		await store.execute({ ...command, target });
		await store.close();
		store = await openPostgresSourceResearch({ databaseUrl });
		const claim = await store.claimNext("public-test", 30_000);
		expect(claim).toMatchObject({
			status: "CLAIMED",
			accessMode: "PUBLIC",
			researchTarget: target,
		});
		if (claim.status !== "CLAIMED") throw new Error("CLAIM_REQUIRED");
		await store.complete(claim, {
			type: "NO_RESULT",
			summary: "合成测试",
			costUnits: 0,
		});
		await expect(
			store.read({
				type: "GET_BATCH",
				batchId: command.batchId,
				ownerUserId: "another-user",
			}),
		).resolves.toBeUndefined();
		const legacy = {
			...command,
			batchId: randomUUID(),
			idempotencyKey: randomUUID(),
			sources: [{ sourceId: "credential-test", sourceAccountId: "account" }],
		};
		const created = await store.execute(legacy);
		expect(
			await store.execute({
				...legacy,
				sources: legacy.sources.map((source) => ({
					...source,
					accessMode: "CREDENTIAL",
				})),
			}),
		).toEqual(created);
		const credentialClaim = await store.claimNext("public-test", 30_000);
		expect(credentialClaim).toMatchObject({
			status: "CLAIMED",
			accessMode: "CREDENTIAL",
			researchTarget: null,
		});
		if (credentialClaim.status !== "CLAIMED") throw new Error("CLAIM_REQUIRED");
		await store.complete(credentialClaim, {
			type: "NO_RESULT",
			summary: "合成测试",
			costUnits: 0,
		});
	} finally {
		await store.close();
	}
});
