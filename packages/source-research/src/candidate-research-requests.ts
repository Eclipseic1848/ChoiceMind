import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
	type AdapterCandidateSource,
	parseAdapterCandidateSource,
} from "./adapter-candidate.js";
import type { SourceResearchClaim } from "./index.js";

export type CandidateResearchExecution = Readonly<{
	jobId: string;
	ownerUserId: string;
	decisionTaskId: string;
	agentRunId: string;
	sourceId: string;
	token: string;
	proposal?: AdapterCandidateSource;
}>;

// 请求、领取和每次付费前复核使用同一原任务归属条件。
const originJoin = `FROM source_research_jobs AS job
	JOIN source_research_batches AS batch ON batch.batch_id=job.batch_id
	JOIN decision_task_submissions AS submission
	  ON submission.decision_task_id=job.decision_task_id
	 AND submission.owner_user_id=job.owner_user_id
	JOIN agent_run_operations AS operation
	  ON operation.execution_request_id=submission.execution_request_id
	 AND operation.decision_task_id=job.decision_task_id
	 AND operation.agent_run_id=batch.origin_agent_run_id`;
const activeOrigin = `job.source_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'
	AND (operation.state IN ('ACCEPTED','RUNNING') OR (
	  operation.state='PAUSED_USER'
	  AND operation.result_payload->>'contractType'='runtime-paused-outcome'
	  AND operation.result_payload->>'contractVersion'='1.0'
	  AND operation.result_payload->>'state'='PAUSED_USER'
	  AND operation.result_payload->>'pauseReason'='SOURCE_RESEARCH'
	  AND operation.result_payload->'snapshot'->>'decisionTaskId'=operation.decision_task_id
	  AND operation.result_payload->'snapshot'->>'agentRunId'=operation.agent_run_id))
	AND NOT EXISTS (SELECT 1 FROM runtime_control_states AS control
	  WHERE control.agent_run_id=operation.agent_run_id AND control.state='CANCELLED')
	AND operation.agent_run_id=(
	  SELECT latest.agent_run_id FROM agent_run_operations AS latest
	  JOIN decision_task_submissions AS owner USING(execution_request_id)
	  WHERE latest.decision_task_id=job.decision_task_id AND owner.owner_user_id=job.owner_user_id
	  ORDER BY latest.created_at DESC, latest.agent_run_id DESC LIMIT 1)`;

function validateLease(leaseMs: number) {
	if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000)
		throw new Error("ADAPTER_CANDIDATE_LEASE_INVALID");
}

// 仅供已认证的采集 Worker 调用；费用归属从原作业和任务解析，不接受外部传入的用户或 Key。
export async function openPostgresCandidateResearchRequests(
	databaseUrl: string,
) {
	const pool = new Pool({
		connectionString: databaseUrl,
		connectionTimeoutMillis: 5_000,
		query_timeout: 5_000,
		statement_timeout: 5_000,
	});
	try {
		// 复用原作业的隔离与删除生命周期；不建立第二份用户任务数据。
		await pool.query(`ALTER TABLE source_research_jobs
			ADD COLUMN IF NOT EXISTS candidate_agent_run_id text,
			ADD COLUMN IF NOT EXISTS candidate_requested_at timestamptz,
			ADD COLUMN IF NOT EXISTS candidate_state text,
			ADD COLUMN IF NOT EXISTS candidate_token text,
			ADD COLUMN IF NOT EXISTS candidate_lease_expires_at timestamptz,
			ADD COLUMN IF NOT EXISTS candidate_proposal jsonb,
			ADD COLUMN IF NOT EXISTS candidate_review_state text,
			ADD COLUMN IF NOT EXISTS candidate_review_token text,
			ADD COLUMN IF NOT EXISTS candidate_review_lease_expires_at timestamptz;`);
	} catch (error) {
		await pool.end();
		throw error;
	}
	const commands = {
		async submitProposal(
			claim: CandidateResearchExecution,
			source: unknown,
		): Promise<boolean> {
			const proposal = parseAdapterCandidateSource(source);
			const result = await pool.query(
				`WITH eligible AS (SELECT job.job_id ${originJoin}
				 WHERE job.job_id::text=$1 AND job.candidate_token=$2
				 AND job.owner_user_id=$3 AND job.decision_task_id=$4
				 AND job.candidate_agent_run_id=$5 AND job.source_id=$6
				 AND job.candidate_agent_run_id=operation.agent_run_id
				 AND job.candidate_state='RUNNING' AND job.candidate_lease_expires_at>now()
				 AND ${activeOrigin} FOR UPDATE OF job, operation)
				 UPDATE source_research_jobs AS target SET candidate_proposal=$7::jsonb
				 FROM eligible WHERE target.job_id=eligible.job_id
				 AND (target.candidate_proposal IS NULL OR target.candidate_proposal=$7::jsonb)
				 RETURNING target.job_id`,
				[
					claim.jobId,
					claim.token,
					claim.ownerUserId,
					claim.decisionTaskId,
					claim.agentRunId,
					claim.sourceId,
					JSON.stringify(proposal),
				],
			);
			return result.rowCount === 1;
		},
		async request(
			claim: Pick<SourceResearchClaim, "jobId" | "workerId" | "attemptCount">,
		) {
			if (
				typeof claim.jobId !== "string" ||
				!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
					claim.jobId,
				) ||
				typeof claim.workerId !== "string" ||
				!claim.workerId ||
				claim.workerId.length > 200 ||
				!Number.isSafeInteger(claim.attemptCount) ||
				claim.attemptCount < 1
			)
				throw new Error("ADAPTER_CANDIDATE_REQUEST_INVALID");
			// 仅接受活跃原任务或可信的等待来源研究暂停。
			// 锁住原作业和任务，防止已提交的终态/租约变更被旧请求越过。
			const result = await pool.query(
				`WITH eligible AS (
				SELECT job.job_id, operation.agent_run_id, job.source_id
				${originJoin}
				WHERE job.job_id=$1 AND job.worker_id=$2 AND job.attempt_count=$3
				  AND job.state='RUNNING' AND job.lease_expires_at > now()
				  AND ${activeOrigin}
				FOR UPDATE OF job, operation
			) UPDATE source_research_jobs AS target
			SET candidate_agent_run_id=eligible.agent_run_id, candidate_requested_at=now()
			FROM eligible WHERE target.job_id=eligible.job_id AND target.candidate_requested_at IS NULL
			RETURNING target.job_id`,
				[claim.jobId, claim.workerId, claim.attemptCount],
			);
			return { recorded: result.rowCount === 1 };
		},
	};
	// 只在两组固定列名间选择；研究与审查共享原任务门禁但持有独立租约。
	function consumer(stage: "research" | "review") {
		const prefix = stage === "research" ? "candidate" : "candidate_review";
		return {
			async claimNext(
				leaseMs = 30_000,
				allowedKinds?: readonly AdapterCandidateSource["kind"][],
			): Promise<CandidateResearchExecution | undefined> {
				validateLease(leaseMs);
				if (
					allowedKinds !== undefined &&
					(stage !== "review" ||
						!Array.isArray(allowedKinds) ||
						allowedKinds.length < 1 ||
						allowedKinds.length > 3 ||
						new Set(allowedKinds).size !== allowedKinds.length ||
						allowedKinds.some(
							(kind) => !["GITHUB", "NPM", "PYPI"].includes(kind),
						))
				)
					throw new Error("ADAPTER_CANDIDATE_REVIEW_KINDS_INVALID");
				// 进程死亡后无法确认是否外发；过期只记 UNKNOWN，永不自动重领。
				await pool.query(`UPDATE source_research_jobs SET ${prefix}_state='UNKNOWN'
				WHERE ${prefix}_state='RUNNING' AND ${prefix}_lease_expires_at<=now()`);
				const result = await pool.query<CandidateResearchExecution>(
					`WITH eligible AS (SELECT job.job_id ${originJoin}
				 WHERE job.candidate_requested_at IS NOT NULL AND job.${prefix}_state IS NULL
				 AND job.${prefix}_token IS NULL AND job.candidate_agent_run_id=operation.agent_run_id
				 ${stage === "review" ? "AND job.candidate_state='COMPLETED' AND job.candidate_proposal IS NOT NULL" : ""}
				 ${allowedKinds === undefined ? "" : "AND job.candidate_proposal->>'kind'=ANY($3::text[])"}
				 AND ${activeOrigin}
				 ORDER BY job.candidate_requested_at, job.job_id
				 LIMIT 1 FOR UPDATE OF job, operation SKIP LOCKED)
				 UPDATE source_research_jobs AS target SET ${prefix}_state='RUNNING',
				 ${prefix}_token=$1, ${prefix}_lease_expires_at=now()+$2*interval '1 millisecond'
				 FROM eligible WHERE target.job_id=eligible.job_id
				 RETURNING target.job_id AS "jobId", target.owner_user_id AS "ownerUserId",
				 target.decision_task_id AS "decisionTaskId", target.candidate_agent_run_id AS "agentRunId",
				 target.source_id AS "sourceId", target.${prefix}_token AS token
				 ${stage === "review" ? ", target.candidate_proposal AS proposal" : ""}`,
					[
						randomUUID(),
						leaseMs,
						...(allowedKinds === undefined ? [] : [[...allowedKinds]]),
					],
				);
				const claim = result.rows[0];
				if (claim && stage === "review")
					return {
						...claim,
						proposal: parseAdapterCandidateSource(claim.proposal),
					};
				return claim;
			},
			async check(
				claim: CandidateResearchExecution,
				leaseMs = 30_000,
			): Promise<boolean> {
				validateLease(leaseMs);
				const result = await pool.query(
					`WITH eligible AS (SELECT job.job_id ${originJoin}
				 WHERE job.job_id::text=$1 AND job.${prefix}_token=$2
				 AND job.owner_user_id=$3 AND job.decision_task_id=$4
				 AND job.candidate_agent_run_id=$5 AND job.source_id=$6
				 AND job.candidate_agent_run_id=operation.agent_run_id
				 AND job.${prefix}_state='RUNNING' AND job.${prefix}_lease_expires_at>now()
				 AND ${activeOrigin} FOR UPDATE OF job, operation)
				 UPDATE source_research_jobs AS target
				 SET ${prefix}_lease_expires_at=now()+$7*interval '1 millisecond'
				 FROM eligible WHERE target.job_id=eligible.job_id RETURNING target.job_id`,
					[
						claim.jobId,
						claim.token,
						claim.ownerUserId,
						claim.decisionTaskId,
						claim.agentRunId,
						claim.sourceId,
						leaseMs,
					],
				);
				return result.rowCount === 1;
			},
			async finish(
				claim: CandidateResearchExecution,
				state: "COMPLETED" | "FAILED_FINAL" | "CANCELLED" | "UNKNOWN",
			): Promise<boolean> {
				if (
					!["COMPLETED", "FAILED_FINAL", "CANCELLED", "UNKNOWN"].includes(state)
				)
					throw new Error("ADAPTER_CANDIDATE_OUTCOME_INVALID");
				// 原任务取消后仍可封存已发请求的结果；失去租约不得覆盖 UNKNOWN。
				const result = await pool.query(
					`UPDATE source_research_jobs SET ${prefix}_state=$7, ${prefix}_lease_expires_at=NULL
				 WHERE job_id::text=$1 AND ${prefix}_token=$2 AND owner_user_id=$3
				 AND decision_task_id=$4 AND candidate_agent_run_id=$5 AND source_id=$6
				 AND ${prefix}_state='RUNNING' AND ${prefix}_lease_expires_at>now() RETURNING job_id`,
					[
						claim.jobId,
						claim.token,
						claim.ownerUserId,
						claim.decisionTaskId,
						claim.agentRunId,
						claim.sourceId,
						state,
					],
				);
				return result.rowCount === 1;
			},
		};
	}
	return {
		...commands,
		...consumer("research"),
		review: consumer("review"),
		close: () => pool.end(),
	};
}
