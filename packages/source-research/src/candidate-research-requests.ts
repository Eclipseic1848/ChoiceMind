import { Pool } from "pg";
import type { SourceResearchClaim } from "./index.js";

// 仅供已认证的采集 Worker 调用；费用归属从原作业和任务解析，不接受外部传入的用户或 Key。
export async function openPostgresCandidateResearchRequests(
	databaseUrl: string,
) {
	const pool = new Pool({ connectionString: databaseUrl });
	try {
		// 复用原作业的隔离与删除生命周期；不建立第二份用户任务数据。
		await pool.query(`ALTER TABLE source_research_jobs
			ADD COLUMN IF NOT EXISTS candidate_agent_run_id text,
			ADD COLUMN IF NOT EXISTS candidate_requested_at timestamptz;`);
	} catch (error) {
		await pool.end();
		throw error;
	}
	return {
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
			// 活跃白名单：暂停、失败、部分完成、结束和取消均不得新增候选研究。
			// 锁住原作业和任务，防止已提交的终态/租约变更被旧请求越过。
			const result = await pool.query(
				`WITH eligible AS (
				SELECT job.job_id, operation.agent_run_id, job.source_id
				FROM source_research_jobs AS job
				JOIN source_research_batches AS batch ON batch.batch_id=job.batch_id
				JOIN decision_task_submissions AS submission
				  ON submission.decision_task_id=job.decision_task_id
				 AND submission.owner_user_id=job.owner_user_id
				JOIN agent_run_operations AS operation
				  ON operation.execution_request_id=submission.execution_request_id
				 AND operation.decision_task_id=job.decision_task_id
				 AND operation.agent_run_id=batch.origin_agent_run_id
				WHERE job.job_id=$1 AND job.worker_id=$2 AND job.attempt_count=$3
				  AND job.state='RUNNING' AND job.lease_expires_at > now()
				  AND job.source_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'
				  AND operation.state IN ('ACCEPTED','RUNNING')
				  AND NOT EXISTS (SELECT 1 FROM runtime_control_states AS control
				    WHERE control.agent_run_id=operation.agent_run_id AND control.state='CANCELLED')
				  AND operation.agent_run_id=(
				    SELECT latest.agent_run_id FROM agent_run_operations AS latest
				    JOIN decision_task_submissions AS owner USING(execution_request_id)
				    WHERE latest.decision_task_id=job.decision_task_id AND owner.owner_user_id=job.owner_user_id
				    ORDER BY latest.created_at DESC, latest.agent_run_id DESC LIMIT 1)
				FOR UPDATE OF job, operation
			) UPDATE source_research_jobs AS target
			SET candidate_agent_run_id=eligible.agent_run_id, candidate_requested_at=now()
			FROM eligible WHERE target.job_id=eligible.job_id AND target.candidate_requested_at IS NULL
			RETURNING target.job_id`,
				[claim.jobId, claim.workerId, claim.attemptCount],
			);
			return { recorded: result.rowCount === 1 };
		},
		close: () => pool.end(),
	};
}
