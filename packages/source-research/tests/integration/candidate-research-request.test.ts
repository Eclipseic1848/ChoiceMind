import { randomUUID } from "node:crypto";
import { openPostgresCandidateStore } from "@choicemind/source-research/candidate-store";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createSourceWorker } from "../../../../apps/source-worker/src/worker.js";

function setup(
	requestCandidateResearch: (sourceId: string) => Promise<void>,
	sourceId: string,
) {
	const secretAccess = vi.fn(() => {
		throw new Error("SECRET_ACCESS_FORBIDDEN");
	});
	const complete = vi.fn(async () => ({ status: "COMMITTED" as const }));
	const worker = createSourceWorker({
		workerId: "worker-test",
		systemActor: { userId: "worker-test", role: "SYSTEM" },
		adapters: new Map(),
		requestCandidateResearch,
		sourceAccess: {
			read: secretAccess,
			execute: secretAccess,
			withCredential: secretAccess,
		},
		sourceResearch: {
			claimNext: vi.fn(async () => ({
				status: "CLAIMED" as const,
				jobId: "job-test",
				batchId: "batch-test",
				ownerUserId: "private-user-canary",
				decisionTaskId: "private-task-canary",
				query: "private-query-canary",
				sourceId,
				sourceAccountId: "private-account-canary",
				accessMode: "CREDENTIAL" as const,
				researchTarget: null,
				checkpoint: null,
				workerId: "worker-test",
				attemptCount: 1,
			})),
			saveCheckpoint: vi.fn(),
			renewLease: vi.fn(),
			complete,
		},
	});
	return { worker, complete, secretAccess };
}

it("能力缺口写入失败走既有重试，不接触凭据或泄漏内部错误", async () => {
	const { worker, complete, secretAccess } = setup(async () => {
		throw new Error("private-db-canary");
	}, "missing-source");
	await expect(worker.runOnce()).resolves.toEqual({ claimed: 1, completed: 1 });
	expect(complete).toHaveBeenCalledWith(expect.anything(), {
		type: "FAILED_RETRYABLE",
		summary: "来源工具研究请求暂时无法记录",
	});
	expect(secretAccess).not.toHaveBeenCalled();
});

describe.runIf(process.env.CHOICEMIND_TEST_DATABASE_URL)(
	"缺失Adapter到持久研究请求",
	() => {
		it("真实Worker发现缺口，重复与重开只留一条，不复制私人任务字段", async () => {
			const url = process.env.CHOICEMIND_TEST_DATABASE_URL ?? "";
			let store = await openPostgresCandidateStore(url);
			const db = new Client({ connectionString: url });
			const sourceId = `missing-${randomUUID()}`;
			try {
				await db.connect();
				const request = vi.fn((id: string) => store.requestResearch(id));
				const { worker, complete, secretAccess } = setup(request, sourceId);
				await Promise.all([worker.runOnce(), worker.runOnce()]);
				expect(request.mock.calls).toEqual([[sourceId], [sourceId]]);
				expect(complete).toHaveBeenCalledWith(
					expect.anything(),
					expect.objectContaining({ type: "FAILED_FINAL" }),
				);
				expect(secretAccess).not.toHaveBeenCalled();
				await store.close();
				store = await openPostgresCandidateStore(url);
				await store.requestResearch(sourceId);
				const rows = await db.query(
					"SELECT * FROM source_research_candidate_requests WHERE source_id=$1",
					[sourceId],
				);
				expect(rows.rows).toHaveLength(1);
				expect(Object.keys(rows.rows[0]).sort()).toEqual([
					"requested_at",
					"source_id",
				]);
				expect(JSON.stringify(rows.rows)).not.toContain("private-");
				await expect(
					store.requestResearch("https://private.invalid/?token=canary"),
				).rejects.toThrow("ADAPTER_CANDIDATE_SOURCE_INVALID");
			} finally {
				await db.end();
				await store.close();
			}
		});
	},
);
