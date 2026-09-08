import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { migratePersistentDecisionTasks } from "../../../task-persistence/src/migration.js";
import { openPostgresCandidateResearchRequests } from "../../src/candidate-research-requests.js";
import { openPostgresSourceResearch } from "../../src/index.js";

describe.runIf(process.env.CHOICEMIND_TEST_DATABASE_URL)("候选审查交接", () => {
	it("提案单次绑定、完成后审查、取消门禁和过期不重领", async () => {
		const databaseUrl = process.env.CHOICEMIND_TEST_DATABASE_URL ?? "";
		const pool = new Pool({ connectionString: databaseUrl });
		const client = await pool.connect();
		try {
			await migratePersistentDecisionTasks(client);
		} finally {
			client.release();
		}
		const research = await openPostgresSourceResearch({ databaseUrl });
		const requests = await openPostgresCandidateResearchRequests(databaseUrl);
		const owners: string[] = [];
		const proposal = {
			kind: "PYPI",
			packageName: "synthetic-candidate",
			version: "1.0.0",
			artifactSha256: "a".repeat(64),
		};
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
				query: "合成测试",
				sources: [
					{
						sourceId: "synthetic-source",
						sourceAccountId: "synthetic-account",
					},
				],
			});
			const source = await research.claimNext("review-test", 30_000);
			if (source.status !== "CLAIMED") throw new Error("TEST_SOURCE_MISSING");
			expect(await requests.request(source)).toEqual({ recorded: true });
			await research.complete(source, {
				type: "FAILED_FINAL",
				summary: "合成缺失适配器",
			});
			const claim = await requests.claimNext();
			if (!claim) throw new Error("TEST_CLAIM_MISSING");
			return claim;
		}
		async function cancel(run: string) {
			await pool.query(
				"UPDATE agent_run_operations SET state='CANCELLED' WHERE agent_run_id=$1",
				[run],
			);
		}
		try {
			const claim = await origin();
			expect(claim).not.toHaveProperty("proposal");
			await expect(
				requests.submitProposal(claim, { ...proposal, version: "latest" }),
			).rejects.toThrow();
			expect(
				await requests.submitProposal(
					{ ...claim, token: randomUUID() },
					proposal,
				),
			).toBe(false);
			expect(
				await requests.submitProposal(
					{ ...claim, ownerUserId: randomUUID() },
					proposal,
				),
			).toBe(false);
			expect(await requests.submitProposal(claim, proposal)).toBe(true);
			expect(await requests.submitProposal(claim, proposal)).toBe(true);
			expect(
				await requests.submitProposal(claim, { ...proposal, version: "2.0.0" }),
			).toBe(false);
			expect(await requests.review.claimNext()).toBeUndefined();
			expect(await requests.finish(claim, "COMPLETED")).toBe(true);
			expect(await requests.submitProposal(claim, proposal)).toBe(false);
			const claims = await Promise.all([
				requests.review.claimNext(),
				requests.review.claimNext(),
			]);
			expect(claims.filter(Boolean)).toHaveLength(1);
			const review = claims.find(Boolean);
			if (!review) throw new Error("TEST_REVIEW_MISSING");
			expect(review).toEqual({ ...claim, token: expect.any(String), proposal });
			expect(review.token).not.toBe(claim.token);
			expect(await requests.review.check(claim)).toBe(false);
			expect(await requests.review.check(review)).toBe(true);
			await cancel(review.agentRunId);
			expect(await requests.review.check(review)).toBe(false);
			expect(await requests.review.finish(review, "UNKNOWN")).toBe(true);
			expect(await requests.review.claimNext()).toBeUndefined();

			const cancelled = await origin();
			await cancel(cancelled.agentRunId);
			expect(await requests.submitProposal(cancelled, proposal)).toBe(false);
			await requests.finish(cancelled, "UNKNOWN");

			const beforeReview = await origin();
			await requests.submitProposal(beforeReview, proposal);
			await requests.finish(beforeReview, "COMPLETED");
			await cancel(beforeReview.agentRunId);
			expect(await requests.review.claimNext()).toBeUndefined();

			const expired = await origin();
			await requests.submitProposal(expired, proposal);
			await requests.finish(expired, "COMPLETED");
			const expiringReview = await requests.review.claimNext();
			if (!expiringReview) throw new Error("TEST_REVIEW_MISSING");
			await pool.query(
				"UPDATE source_research_jobs SET candidate_review_lease_expires_at=now()-interval '1 second' WHERE job_id=$1",
				[expired.jobId],
			);
			expect(await requests.review.check(expiringReview)).toBe(false);
			expect(await requests.review.finish(expiringReview, "COMPLETED")).toBe(
				false,
			);
			expect(await requests.review.claimNext()).toBeUndefined();
			expect(
				(
					await pool.query(
						"SELECT candidate_review_state FROM source_research_jobs WHERE job_id=$1",
						[expired.jobId],
					)
				).rows[0].candidate_review_state,
			).toBe("UNKNOWN");

			const unsupported = [];
			for (const source of [
				{ ...proposal, kind: "NPM" },
				{
					kind: "GITHUB",
					repository: "synthetic/candidate",
					commitSha: "b".repeat(40),
					artifactSha256: "a".repeat(64),
				},
			]) {
				const pending = await origin();
				await requests.submitProposal(pending, source);
				await requests.finish(pending, "COMPLETED");
				unsupported.push(pending.jobId);
			}
			await expect(requests.review.claimNext(30_000, [])).rejects.toThrow(
				"ADAPTER_CANDIDATE_REVIEW_KINDS_INVALID",
			);
			await expect(
				requests.review.claimNext(30_000, ["PYPI", "PYPI"]),
			).rejects.toThrow("ADAPTER_CANDIDATE_REVIEW_KINDS_INVALID");
			expect(await requests.review.claimNext(30_000, ["PYPI"])).toBeUndefined();
			const supported = await origin();
			await requests.submitProposal(supported, proposal);
			await requests.finish(supported, "COMPLETED");
			const selected = await requests.review.claimNext(30_000, ["PYPI"]);
			expect(selected?.jobId).toBe(supported.jobId);
			const pending = await pool.query(
				"SELECT candidate_review_state, candidate_review_token FROM source_research_jobs WHERE job_id=ANY($1::uuid[])",
				[unsupported],
			);
			expect(pending.rows).toEqual([
				{ candidate_review_state: null, candidate_review_token: null },
				{ candidate_review_state: null, candidate_review_token: null },
			]);
		} finally {
			for (const owner of owners)
				await research.purgePrivateDataForOwner(owner);
			await Promise.all([requests.close(), research.close(), pool.end()]);
		}
	});
});
