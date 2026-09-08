import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createSourceWorker } from "../../../../apps/source-worker/src/worker.js";
import { migratePersistentDecisionTasks } from "../../../task-persistence/src/migration.js";
import { openPostgresCandidateResearchRequests } from "../../src/candidate-research-requests.js";
import { openPostgresSourceResearch } from "../../src/index.js";

describe.runIf(process.env.CHOICEMIND_TEST_DATABASE_URL)(
	"候选请求绑定原任务",
	() => {
		it("真实 Worker 持久绑定原作业；终态、跨用户、旧租约和删除均受控", async () => {
			const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL ?? "";
			const pool = new Pool({ connectionString: databaseUrl });
			const client = await pool.connect();
			try {
				await migratePersistentDecisionTasks(client);
			} finally {
				client.release();
			}
			const sourceResearch = await openPostgresSourceResearch({ databaseUrl });
			let requests = await openPostgresCandidateResearchRequests(databaseUrl);
			const secretAccess = vi.fn(() => {
				throw new Error("SECRET_ACCESS_FORBIDDEN");
			});
			async function origin(state = "RUNNING", foreignOwner = false) {
				const taskId = randomUUID();
				const runId = randomUUID();
				const owner = randomUUID();
				await pool.query(
					`INSERT INTO decision_task_submissions
				(execution_request_id,command_fingerprint,decision_task_id,command_payload,created_at,owner_user_id)
				VALUES($1,'synthetic',$1,'{}',now(),$2)`,
					[taskId, owner],
				);
				await pool.query(
					`INSERT INTO agent_run_operations
				(operation_id,agent_run_id,execution_request_id,decision_task_id,state,created_at,updated_at)
				VALUES($1,$2,$3,$3,$4,now(),now())`,
					[randomUUID(), runId, taskId, state],
				);
				const batch = await sourceResearch.execute({
					type: "CREATE_BATCH",
					batchId: randomUUID(),
					ownerUserId: foreignOwner ? randomUUID() : owner,
					decisionTaskId: taskId,
					originAgentRunId: runId,
					idempotencyKey: randomUUID(),
					query: "private-query-canary",
					sources: [
						{
							sourceId: "missing-source",
							sourceAccountId: "private-account-canary",
						},
					],
				});
				return { taskId, runId, owner, batch };
			}
			try {
				const initial = await origin();
				const worker = createSourceWorker({
					workerId: "candidate-binding-test",
					systemActor: { userId: "test", role: "SYSTEM" },
					sourceResearch,
					sourceAccess: {
						read: secretAccess,
						execute: secretAccess,
						withCredential: secretAccess,
					},
					adapters: new Map(),
					requestCandidateResearch: async (_source, claim) => {
						await requests.request(claim);
					},
				});
				await expect(worker.runOnce()).resolves.toEqual({
					claimed: 1,
					completed: 1,
				});
				await requests.close();
				requests = await openPostgresCandidateResearchRequests(databaseUrl);
				const persisted = await pool.query(
					`SELECT candidate_agent_run_id, candidate_requested_at, state
				FROM source_research_jobs WHERE batch_id=$1`,
					[initial.batch.batchId],
				);
				expect(persisted.rows[0]).toMatchObject({
					candidate_agent_run_id: initial.runId,
					state: "FAILED_FINAL",
				});
				expect(persisted.rows[0].candidate_requested_at).toBeInstanceOf(Date);
				expect(secretAccess).not.toHaveBeenCalled();

				for (const state of [
					"COMPLETED",
					"CANCELLED",
					"FAILED_FINAL",
					"FAILED_RETRYABLE",
					"PARTIAL",
					"PAUSED_USER",
					"PAUSED_PERMISSION",
					"PAUSED_SOURCE_LOGIN",
					"PAUSED_LIMIT",
				]) {
					await origin(state);
					const claim = await sourceResearch.claimNext("binding-check", 30_000);
					if (claim.status !== "CLAIMED") throw new Error("TEST_CLAIM_MISSING");
					await expect(requests.request(claim)).resolves.toEqual({
						recorded: false,
					});
					await sourceResearch.complete(claim, {
						type: "FAILED_FINAL",
						summary: "测试结束",
					});
				}
				await origin("RUNNING", true);
				const foreign = await sourceResearch.claimNext("binding-check", 30_000);
				if (foreign.status !== "CLAIMED") throw new Error("TEST_CLAIM_MISSING");
				await expect(requests.request(foreign)).resolves.toEqual({
					recorded: false,
				});
				await sourceResearch.complete(foreign, {
					type: "FAILED_FINAL",
					summary: "测试结束",
				});

				const stale = await origin();
				const staleClaim = await sourceResearch.claimNext(
					"binding-check",
					30_000,
				);
				if (staleClaim.status !== "CLAIMED")
					throw new Error("TEST_CLAIM_MISSING");
				await pool.query(
					"UPDATE agent_run_operations SET agent_run_id=$1 WHERE agent_run_id=$2",
					[randomUUID(), stale.runId],
				);
				await expect(requests.request(staleClaim)).resolves.toEqual({
					recorded: false,
				});
				await sourceResearch.complete(staleClaim, {
					type: "FAILED_FINAL",
					summary: "测试结束",
				});
				const legacy = await origin();
				await pool.query(
					"UPDATE source_research_batches SET origin_agent_run_id=NULL WHERE batch_id=$1",
					[legacy.batch.batchId],
				);
				const legacyClaim = await sourceResearch.claimNext(
					"binding-check",
					30_000,
				);
				if (legacyClaim.status !== "CLAIMED")
					throw new Error("TEST_CLAIM_MISSING");
				await expect(requests.request(legacyClaim)).resolves.toEqual({
					recorded: false,
				});
				await sourceResearch.complete(legacyClaim, {
					type: "FAILED_FINAL",
					summary: "测试结束",
				});

				const active = await origin();
				const claim = await sourceResearch.claimNext("binding-check", 30_000);
				if (claim.status !== "CLAIMED") throw new Error("TEST_CLAIM_MISSING");
				await expect(
					requests.request({ ...claim, workerId: "wrong" }),
				).resolves.toEqual({ recorded: false });
				await expect(
					requests.request({ ...claim, attemptCount: claim.attemptCount + 1 }),
				).resolves.toEqual({ recorded: false });
				await pool.query(
					"UPDATE source_research_jobs SET lease_expires_at=now()-interval '1 second' WHERE job_id=$1",
					[claim.jobId],
				);
				await expect(requests.request(claim)).resolves.toEqual({
					recorded: false,
				});
				await pool.query(
					"UPDATE source_research_jobs SET lease_expires_at=now()+interval '1 minute' WHERE job_id=$1",
					[claim.jobId],
				);
				const recorded = await Promise.all([
					requests.request(claim),
					requests.request(claim),
				]);
				expect(recorded.filter((result) => result.recorded)).toHaveLength(1);
				await sourceResearch.purgePrivateDataForOwner(active.owner);
				await expect(requests.request(claim)).resolves.toEqual({
					recorded: false,
				});
				const remaining = await pool.query(
					"SELECT job_id FROM source_research_jobs WHERE candidate_agent_run_id=$1",
					[active.runId],
				);
				expect(remaining.rows).toEqual([]);
			} finally {
				await Promise.all([
					requests.close(),
					sourceResearch.close(),
					pool.end(),
				]);
			}
		});
	},
);
