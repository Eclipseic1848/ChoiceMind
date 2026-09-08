import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import {
	type AdapterCandidate,
	type AdapterCandidateLifecycle,
	createAdapterCandidate,
	createAdapterCandidateLifecycle,
	readApprovedAdapterCandidate,
	transitionAdapterCandidateLifecycle,
} from "./adapter-candidate.js";

type StoredCandidate = {
	candidate: AdapterCandidate;
	lifecycle: AdapterCandidateLifecycle;
};

// Source Research 内部存储；调用方必须先认证管理员和可信报告，不暴露为请求体透传接口。
export async function openPostgresCandidateStore(databaseUrl: string) {
	const pool = new Pool({ connectionString: databaseUrl });
	try {
		await pool.query(`CREATE TABLE IF NOT EXISTS source_research_candidate_reviews (
			revision bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
			candidate_id text NOT NULL, review_binding text NOT NULL,
			candidate jsonb NOT NULL, lifecycle jsonb NOT NULL,
			UNIQUE(candidate_id, review_binding));
		CREATE TABLE IF NOT EXISTS source_research_candidate_actions (
			candidate_id text NOT NULL, request_id text NOT NULL, command_sha256 text NOT NULL,
			result jsonb NOT NULL, PRIMARY KEY(candidate_id, request_id));`);
	} catch (error) {
		await pool.end();
		throw error;
	}

	async function transaction<T>(
		candidateId: string,
		operation: (client: PoolClient) => Promise<T>,
	): Promise<T> {
		if (!/^adapter-candidate-[a-f0-9]{64}$/.test(candidateId))
			throw new Error("ADAPTER_CANDIDATE_INVALID");
		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			// 覆盖首次创建的并发；不同候选互不阻塞，相同候选按数据库事务串行。
			await client.query(
				"SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
				[candidateId],
			);
			const result = await operation(client);
			await client.query("COMMIT");
			return result;
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	return {
		async record(input: unknown): Promise<StoredCandidate> {
			const candidate = createAdapterCandidate(input);
			const lifecycle = createAdapterCandidateLifecycle(candidate);
			return transaction(candidate.candidateId, async (client) => {
				await client.query(
					`INSERT INTO source_research_candidate_reviews(candidate_id, review_binding, candidate, lifecycle)
					VALUES ($1,$2,$3::jsonb,$4::jsonb) ON CONFLICT(candidate_id, review_binding) DO NOTHING`,
					[
						candidate.candidateId,
						lifecycle.reviewBindingSha256,
						JSON.stringify(candidate),
						JSON.stringify(lifecycle),
					],
				);
				// 重复收到旧报告不得使旧批准再次成为当前版本。
				const result = await client.query<StoredCandidate>(
					"SELECT candidate,lifecycle FROM source_research_candidate_reviews WHERE candidate_id=$1 ORDER BY revision DESC LIMIT 1",
					[candidate.candidateId],
				);
				const stored = result.rows[0];
				if (stored === undefined)
					throw new Error("ADAPTER_CANDIDATE_WRITE_UNCONFIRMED");
				return stored;
			});
		},
		async readApproved(
			candidateId: string,
			reviewBinding: string,
			artifactSha256: string,
		): Promise<AdapterCandidate | undefined> {
			const result = await pool.query<StoredCandidate>(
				"SELECT candidate,lifecycle FROM source_research_candidate_reviews WHERE candidate_id=$1 ORDER BY revision DESC LIMIT 1",
				[candidateId],
			);
			const current = result.rows[0];
			return current === undefined
				? undefined
				: readApprovedAdapterCandidate(
						current.candidate,
						current.lifecycle,
						reviewBinding,
						artifactSha256,
					);
		},
		async read(candidateId: string): Promise<StoredCandidate | undefined> {
			const result = await pool.query<StoredCandidate>(
				"SELECT candidate,lifecycle FROM source_research_candidate_reviews WHERE candidate_id=$1 ORDER BY revision DESC LIMIT 1",
				[candidateId],
			);
			return result.rows[0];
		},
		async transition(
			candidateId: string,
			reviewBinding: string,
			requestId: string,
			action: unknown,
		): Promise<AdapterCandidateLifecycle> {
			if (
				!/^[a-f0-9]{64}$/.test(reviewBinding) ||
				!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)
			)
				throw new Error("ADAPTER_CANDIDATE_ACTION_INVALID");
			const encoded = JSON.stringify(action);
			if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 4096)
				throw new Error("ADAPTER_CANDIDATE_ACTION_INVALID");
			const snapshot: unknown = JSON.parse(encoded);
			// 服务端重试时间可以不同；幂等身份绑定业务动作、操作者和报告。
			const commandHash = createHash("sha256")
				.update(
					JSON.stringify([reviewBinding, snapshot], (key, value) =>
						key === "occurredAt" ? undefined : value,
					),
				)
				.digest("hex");
			return transaction(candidateId, async (client) => {
				const current = (
					await client.query<StoredCandidate>(
						"SELECT candidate,lifecycle FROM source_research_candidate_reviews WHERE candidate_id=$1 ORDER BY revision DESC LIMIT 1",
						[candidateId],
					)
				).rows[0];
				if (
					current === undefined ||
					current.lifecycle.reviewBindingSha256 !== reviewBinding
				)
					throw new Error("ADAPTER_CANDIDATE_REVIEW_STALE");
				const prior = (
					await client.query<{
						command_sha256: string;
						result: AdapterCandidateLifecycle;
					}>(
						"SELECT command_sha256,result FROM source_research_candidate_actions WHERE candidate_id=$1 AND request_id=$2",
						[candidateId, requestId],
					)
				).rows[0];
				if (prior !== undefined) {
					if (prior.command_sha256 !== commandHash)
						throw new Error("ADAPTER_CANDIDATE_REQUEST_CONFLICT");
					// 请求重试不复活后续已停用的状态，返回当前权威状态。
					return current.lifecycle;
				}
				const result = transitionAdapterCandidateLifecycle(
					current.candidate,
					current.lifecycle,
					snapshot,
				);
				await client.query(
					"UPDATE source_research_candidate_reviews SET lifecycle=$3::jsonb WHERE candidate_id=$1 AND review_binding=$2",
					[candidateId, reviewBinding, JSON.stringify(result)],
				);
				await client.query(
					"INSERT INTO source_research_candidate_actions(candidate_id,request_id,command_sha256,result) VALUES($1,$2,$3,$4::jsonb)",
					[candidateId, requestId, commandHash, JSON.stringify(result)],
				);
				return result;
			});
		},
		close: () => pool.end(),
	};
}
