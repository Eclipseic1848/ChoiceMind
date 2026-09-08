import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createCandidateResearchWorker } from "../../../../apps/source-worker/src/candidate-research-worker.js";
import { migratePersistentDecisionTasks } from "../../../task-persistence/src/migration.js";
import { openPostgresCandidateResearchRequests } from "../../src/candidate-research-requests.js";
import { openPostgresSourceResearch } from "../../src/index.js";

describe.runIf(process.env.CHOICEMIND_TEST_DATABASE_URL)(
	"候选执行生命周期",
	() => {
		it("真实 PG 单次领取、续租、取消、可信暂停和 UNKNOWN 均保持原费用归属", async () => {
			const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL ?? "";
			const pool = new Pool({ connectionString: databaseUrl });
			const client = await pool.connect();
			try {
				await migratePersistentDecisionTasks(client);
			} finally {
				client.release();
			}
			const research = await openPostgresSourceResearch({ databaseUrl });
			let requests = await openPostgresCandidateResearchRequests(databaseUrl);
			const owners: string[] = [];
			async function origin() {
				const task = randomUUID();
				const run = randomUUID();
				const owner = randomUUID();
				owners.push(owner);
				await pool.query(
					`INSERT INTO decision_task_submissions
				(execution_request_id,command_fingerprint,decision_task_id,command_payload,created_at,owner_user_id)
				VALUES($1,'synthetic',$1,'{}',now(),$2)`,
					[task, owner],
				);
				await pool.query(
					`INSERT INTO agent_run_operations
				(operation_id,agent_run_id,execution_request_id,decision_task_id,state,created_at,updated_at)
				VALUES($1,$2,$3,$3,'RUNNING',now(),now())`,
					[randomUUID(), run, task],
				);
				await research.execute({
					type: "CREATE_BATCH",
					batchId: randomUUID(),
					ownerUserId: owner,
					decisionTaskId: task,
					originAgentRunId: run,
					idempotencyKey: randomUUID(),
					query: "private-query-canary",
					sources: [
						{
							sourceId: "missing-source",
							sourceAccountId: "private-account-canary",
						},
					],
				});
				const sourceClaim = await research.claimNext("lifecycle-test", 30_000);
				if (sourceClaim.status !== "CLAIMED")
					throw new Error("TEST_CLAIM_MISSING");
				expect(await requests.request(sourceClaim)).toEqual({ recorded: true });
				await research.complete(sourceClaim, {
					type: "FAILED_FINAL",
					summary: "测试缺少适配器",
				});
				return { task, run, owner, jobId: sourceClaim.jobId };
			}
			try {
				const first = await origin();
				const claims = await Promise.all([
					requests.claimNext(),
					requests.claimNext(),
				]);
				expect(claims.filter(Boolean)).toHaveLength(1);
				const claim = claims.find(Boolean);
				if (!claim) throw new Error("TEST_CLAIM_MISSING");
				expect(claim).toEqual({
					jobId: first.jobId,
					ownerUserId: first.owner,
					decisionTaskId: first.task,
					agentRunId: first.run,
					sourceId: "missing-source",
					token: expect.any(String),
				});
				expect(
					await requests.check({ ...claim, ownerUserId: randomUUID() }),
				).toBe(false);
				expect(await requests.check({ ...claim, token: randomUUID() })).toBe(
					false,
				);
				expect(await requests.check(claim)).toBe(true);
				expect(await requests.finish(claim, "COMPLETED")).toBe(true);
				expect(await requests.check(claim)).toBe(false);
				expect(await requests.finish(claim, "UNKNOWN")).toBe(false);
				expect(await requests.claimNext()).toBeUndefined();

				await origin();
				const expired = await requests.claimNext();
				if (!expired) throw new Error("TEST_CLAIM_MISSING");
				await pool.query(
					"UPDATE source_research_jobs SET candidate_lease_expires_at=now()-interval '1 second' WHERE job_id=$1",
					[expired.jobId],
				);
				expect(await requests.check(expired)).toBe(false);
				expect(await requests.finish(expired, "COMPLETED")).toBe(false);
				await requests.close();
				requests = await openPostgresCandidateResearchRequests(databaseUrl);
				expect(await requests.claimNext()).toBeUndefined();
				expect(
					(
						await pool.query(
							"SELECT candidate_state FROM source_research_jobs WHERE job_id=$1",
							[expired.jobId],
						)
					).rows[0].candidate_state,
				).toBe("UNKNOWN");

				const paused = await origin();
				const payload = {
					contractType: "runtime-paused-outcome",
					contractVersion: "1.0",
					state: "PAUSED_USER",
					pauseReason: "SOURCE_RESEARCH",
					snapshot: { decisionTaskId: paused.task, agentRunId: paused.run },
				};
				for (const invalid of [
					null,
					{ ...payload, pauseReason: "PRIVATE_FILE_PROCESSING" },
					{ ...payload, contractVersion: "2.0" },
					{
						...payload,
						snapshot: { ...payload.snapshot, agentRunId: randomUUID() },
					},
				]) {
					await pool.query(
						"UPDATE agent_run_operations SET state='PAUSED_USER',result_payload=$2 WHERE agent_run_id=$1",
						[paused.run, invalid],
					);
					expect(await requests.claimNext()).toBeUndefined();
				}
				await pool.query(
					"UPDATE agent_run_operations SET result_payload=$2 WHERE agent_run_id=$1",
					[paused.run, payload],
				);
				const waiting = await requests.claimNext();
				if (!waiting) throw new Error("TEST_CLAIM_MISSING");
				expect(await requests.check(waiting)).toBe(true);
				await pool.query(
					"UPDATE agent_run_operations SET state='CANCELLED' WHERE agent_run_id=$1",
					[paused.run],
				);
				expect(await requests.check(waiting)).toBe(false);
				expect(await requests.claimNext()).toBeUndefined();
				expect(await requests.finish(waiting, "UNKNOWN")).toBe(true);

				const cancelledBeforeStart = await origin();
				await pool.query(
					"UPDATE agent_run_operations SET state='COMPLETED' WHERE agent_run_id=$1",
					[cancelledBeforeStart.run],
				);
				expect(await requests.claimNext()).toBeUndefined();
				const controlled = await origin();
				const controlledClaim = await requests.claimNext();
				if (!controlledClaim) throw new Error("TEST_CLAIM_MISSING");
				await pool.query(
					`INSERT INTO runtime_control_states(agent_run_id,state,updated_at)
					 VALUES($1,'CANCELLED',now())`,
					[controlled.run],
				);
				expect(await requests.check(controlledClaim)).toBe(false);
				expect(await requests.claimNext()).toBeUndefined();

				const replaced = await origin();
				const old = await requests.claimNext();
				if (!old) throw new Error("TEST_CLAIM_MISSING");
				await pool.query(
					"UPDATE agent_run_operations SET agent_run_id=$1 WHERE agent_run_id=$2",
					[randomUUID(), replaced.run],
				);
				expect(await requests.check(old)).toBe(false);
				expect(await requests.claimNext()).toBeUndefined();
				await research.purgePrivateDataForOwner(replaced.owner);
				expect(await requests.finish(old, "UNKNOWN")).toBe(false);
				expect(
					(
						await pool.query(
							"SELECT job_id FROM source_research_jobs WHERE job_id=$1",
							[old.jobId],
						)
					).rows,
				).toEqual([]);
				const consuming = await origin();
				let paidCalls = 0;
				const worker = createCandidateResearchWorker({
					requests,
					async execute({ scope, assertActive }) {
						expect(scope.ownerUserId).toBe(consuming.owner);
						await assertActive();
						paidCalls++;
						await pool.query(
							"UPDATE agent_run_operations SET state='CANCELLED' WHERE agent_run_id=$1",
							[consuming.run],
						);
						await assertActive();
						paidCalls++;
					},
				});
				expect(await worker.runOnce()).toEqual({ claimed: 1, completed: 0 });
				expect(paidCalls).toBe(1);
				expect(await worker.runOnce()).toEqual({ claimed: 0, completed: 0 });
				expect(
					(
						await pool.query(
							"SELECT candidate_state FROM source_research_jobs WHERE job_id=$1",
							[consuming.jobId],
						)
					).rows[0].candidate_state,
				).toBe("UNKNOWN");
			} finally {
				for (const owner of owners)
					await research.purgePrivateDataForOwner(owner);
				await Promise.all([requests.close(), research.close(), pool.end()]);
			}
		});
	},
);
