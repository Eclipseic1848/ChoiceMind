import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";

import { Pool, type PoolClient } from "pg";

export {
  openSourceResearchNotificationPublisher,
  type SourceResearchNotificationPublisher
} from "./notification-publisher.js";
export {
  createPublicWebSourceCatalog,
  type PublicWebSourceDefinition
} from "./public-web-source-catalog.js";

export type SourceResearchBatchState =
  | "QUEUED"
  | "RUNNING"
  | "WAITING_SOURCE_LOGIN"
  | "COMPLETED"
  | "FAILED";

export type SourceResearchAccessMode = "PUBLIC" | "CREDENTIAL";

export type PublicWebResearchContinuationV1 = Readonly<{
  contractType: "public-web-research-continuation";
  contractVersion: "1.0";
  searchUrls: readonly string[];
  deepReadUrls: readonly string[];
}>;

export type SourceResearchTarget = Readonly<{
  subject: Readonly<{
    kind: string;
    value: string;
  }>;
  claimTargets: readonly Readonly<{
    claimId: string;
    statement: string;
  }>[];
}>;

export type SourceResearchOutcome =
  | Readonly<{
      type: "EVIDENCE";
      resultKey: string;
      evidenceId: string;
      summary: string;
      material: unknown;
      costUnits: number;
    }>
  | Readonly<{
      type: "EVIDENCE_BATCH";
      items: readonly Readonly<{
        resultKey: string;
        evidenceId: string;
        summary: string;
        material: unknown;
      }>[];
      costUnits: number;
      checkpoint: Readonly<{
        searched: number;
        deepRead: number;
        hasMore: boolean;
        continuation?: PublicWebResearchContinuationV1;
      }>;
    }>
  | Readonly<{ type: "NO_RESULT"; summary: string; costUnits: number }>
  | Readonly<{
      type: "WAITING_CHALLENGE";
      challenge: "QR_CODE" | "SMS" | "CAPTCHA";
      loginSessionId: string;
    }>
  | Readonly<{ type: "FAILED_RETRYABLE" | "FAILED_FINAL"; summary: string }>;

export type SourceResearchClaim = Readonly<{
  status: "CLAIMED";
  jobId: string;
  batchId: string;
  ownerUserId: string;
  decisionTaskId: string;
  query: string;
  sourceId: string;
  sourceAccountId: string;
  accessMode: SourceResearchAccessMode;
  researchTarget: SourceResearchTarget | null;
  checkpoint: unknown | null;
  workerId: string;
  attemptCount: number;
}>;

export type SourceResearchBatch = Readonly<{
  batchId: string;
  ownerUserId: string;
  decisionTaskId: string;
  query: string;
  researchTarget?: SourceResearchTarget;
  state: SourceResearchBatchState;
  costUnits: number;
  jobs: readonly Readonly<{
    jobId: string;
    sourceId: string;
    sourceAccountId: string;
    accessMode: SourceResearchAccessMode;
    continuation?: PublicWebResearchContinuationV1;
    state:
      | "QUEUED"
      | "RUNNING"
      | "WAITING_SOURCE_LOGIN"
      | "COMPLETED"
      | "NO_RESULT"
      | "FAILED_RETRYABLE"
      | "FAILED_FINAL";
    loginSessionId?: string;
  }>[];
  results: readonly Readonly<{
    resultKey: string;
    evidenceId: string;
    summary: string;
  }>[];
  createdAt: string;
  updatedAt: string;
}>;

export type CreateSourceResearchBatchCommand = Readonly<{
    type: "CREATE_BATCH";
    batchId: string;
    ownerUserId: string;
    decisionTaskId: string;
    originAgentRunId?: string;
    idempotencyKey: string;
    query: string;
    target?: SourceResearchTarget;
    sources: readonly Readonly<{
      sourceId: string;
      sourceAccountId: string;
      accessMode?: SourceResearchAccessMode;
      continuation?: PublicWebResearchContinuationV1;
    }>[];
  }>;

export type ResumeSourceResearchCommand = Readonly<{
    type: "RESUME_SOURCE";
    ownerUserId: string;
    sourceId: string;
    sourceAccountId: string;
  }>;

export interface SourceResearch {
  execute(command: CreateSourceResearchBatchCommand): Promise<SourceResearchBatch>;
  execute(command: ResumeSourceResearchCommand): Promise<Readonly<{ resumed: number }>>;
  read(query: Readonly<{
    type: "GET_BATCH";
    batchId: string;
    ownerUserId: string;
  }>): Promise<SourceResearchBatch | undefined>;
  read(query: Readonly<{
    type: "GET_BATCH_FOR_TASK";
    decisionTaskId: string;
    ownerUserId: string;
  }>): Promise<SourceResearchBatch | undefined>;
  readEvidenceCandidates(input: Readonly<{
    batchId: string;
    ownerUserId: string;
  }>): Promise<Readonly<{
    batchId: string;
    ownerUserId: string;
    decisionTaskId: string;
    results: readonly Readonly<{ resultKey: string; material: unknown }>[];
  }> | undefined>;
  claimNext(workerId: string, leaseDurationMs: number): Promise<SourceResearchClaim | Readonly<{ status: "EMPTY" }>>;
  renewLease(
    claim: SourceResearchClaim,
    leaseDurationMs: number
  ): Promise<Readonly<{ status: "RENEWED" | "LEASE_LOST" }>>;
  saveCheckpoint(claim: SourceResearchClaim, checkpoint: unknown): Promise<Readonly<{ status: "SAVED" | "LEASE_LOST" }>>;
  complete(
    claim: SourceResearchClaim,
    outcome: SourceResearchOutcome
  ): Promise<Readonly<{ status: "COMMITTED" | "ALREADY_COMMITTED" | "LEASE_LOST" }>>;
  purgePrivateDataForOwner(ownerUserId: string): Promise<Readonly<{ deletedBatches: number }>>;
  close(): Promise<void>;
}

type BatchRow = Readonly<{
  batch_id: string;
  owner_user_id: string;
  decision_task_id: string;
  query: string;
  request_fingerprint: string;
  research_target: SourceResearchTarget | null;
  created_at: Date;
  updated_at: Date;
}>;

type JobRow = Readonly<{
  job_id: string;
  batch_id: string;
  owner_user_id: string;
  decision_task_id: string;
  query: string;
  source_id: string;
  source_account_id: string;
  access_mode: SourceResearchAccessMode;
  research_target: SourceResearchTarget | null;
  state: SourceResearchBatch["jobs"][number]["state"];
  checkpoint: unknown | null;
  worker_id: string | null;
  cost_units: number;
  attempt_count: number;
  outcome: unknown | null;
}>;

type ResultRow = Readonly<{
  result_key: string;
  evidence_id: string;
  summary: string;
}>;

type EvidenceCandidateRow = Readonly<{
  result_key: string;
  material: unknown;
}>;

export async function openPostgresSourceResearch(options: Readonly<{
  databaseUrl: string;
  now?: () => Date;
}>): Promise<SourceResearch> {
  const pool = new Pool({ connectionString: options.databaseUrl });
  try {
    await migrateSourceResearch(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }
  const now = options.now ?? (() => new Date());

  async function execute(command: CreateSourceResearchBatchCommand): Promise<SourceResearchBatch>;
  async function execute(command: ResumeSourceResearchCommand): Promise<Readonly<{ resumed: number }>>;
  async function execute(command: CreateSourceResearchBatchCommand | ResumeSourceResearchCommand): Promise<SourceResearchBatch | Readonly<{ resumed: number }>> {
    if (command.type === "RESUME_SOURCE") {
      const result = await pool.query(
        `UPDATE source_research_jobs
         SET state = 'QUEUED', worker_id = NULL, lease_expires_at = NULL,
             updated_at = $4
         WHERE owner_user_id = $1 AND source_id = $2 AND source_account_id = $3
           AND state = 'WAITING_SOURCE_LOGIN'`,
        [command.ownerUserId, command.sourceId, command.sourceAccountId, now()]
      );
      return { resumed: result.rowCount ?? 0 };
    }

    if (
      command.sources.length === 0 ||
      command.sources.length > 10 ||
      command.query.trim() === "" ||
      command.query.length > 4_000 ||
      command.decisionTaskId.length > 200 ||
      command.idempotencyKey.length > 200 ||
      command.sources.some(
        (source) =>
          source.sourceId.length > 100 ||
          source.sourceAccountId.length > 200 ||
          (source.accessMode !== undefined &&
            source.accessMode !== "PUBLIC" &&
            source.accessMode !== "CREDENTIAL") ||
          (source.accessMode === "PUBLIC" && source.sourceAccountId !== "public") ||
          (source.continuation !== undefined &&
            (source.accessMode !== "PUBLIC" ||
              !isPublicWebResearchContinuationV1(source.continuation)))
      )
    ) {
      throw new Error("SOURCE_RESEARCH_BATCH_INVALID");
    }
    if (command.originAgentRunId !== undefined &&
      (typeof command.originAgentRunId !== "string" || command.originAgentRunId.length === 0 || command.originAgentRunId.length > 200)) {
      throw new Error("SOURCE_RESEARCH_ORIGIN_INVALID");
    }
    if (command.target !== undefined && !isSourceResearchTarget(command.target)) {
      throw new Error("SOURCE_RESEARCH_TARGET_INVALID");
    }
    if (
      command.sources.some((source) => source.accessMode === "PUBLIC") &&
      command.target === undefined
    ) {
      throw new Error("SOURCE_RESEARCH_TARGET_REQUIRED");
    }
    const normalizedSources = command.sources
      .map((source) => ({
        sourceId: source.sourceId,
        sourceAccountId: source.sourceAccountId,
        accessMode: source.accessMode ?? "CREDENTIAL" as const,
        ...(source.continuation === undefined
          ? {}
          : {
              continuation: {
                contractType: source.continuation.contractType,
                contractVersion: source.continuation.contractVersion,
                searchUrls: [...source.continuation.searchUrls],
                deepReadUrls: [...source.continuation.deepReadUrls]
              }
            })
      }))
      .sort((left, right) =>
        `${left.sourceId}\0${left.sourceAccountId}`.localeCompare(
          `${right.sourceId}\0${right.sourceAccountId}`
        ) || left.accessMode.localeCompare(right.accessMode)
      );
    const fingerprintSources = normalizedSources.map((source) =>
      source.accessMode === "CREDENTIAL"
        ? { sourceId: source.sourceId, sourceAccountId: source.sourceAccountId }
        : source
    );
    const requestFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          decisionTaskId: command.decisionTaskId,
          ...(command.originAgentRunId === undefined ? {} : { originAgentRunId: command.originAgentRunId }),
          query: command.query.trim(),
          sources: fingerprintSources,
          ...(command.target === undefined ? {} : { target: command.target })
        })
      )
      .digest("hex");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const timestamp = now();
      const inserted = await client.query<BatchRow>(
        `INSERT INTO source_research_batches (
           batch_id, owner_user_id, decision_task_id, idempotency_key,
           request_fingerprint, query, research_target, created_at, updated_at, origin_agent_run_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8, $9)
         ON CONFLICT (owner_user_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          command.batchId,
          command.ownerUserId,
          command.decisionTaskId,
          command.idempotencyKey,
          requestFingerprint,
          command.query.trim(),
          command.target === undefined ? null : JSON.stringify(command.target),
          timestamp,
          command.originAgentRunId ?? null
        ]
      );
      if (inserted.rows[0] === undefined) {
        const existing = await client.query<BatchRow>(
          `SELECT * FROM source_research_batches
           WHERE owner_user_id = $1 AND idempotency_key = $2`,
          [command.ownerUserId, command.idempotencyKey]
        );
        const batch = requireRow(existing.rows[0]);
        if (batch.request_fingerprint !== requestFingerprint) {
          throw new Error("SOURCE_RESEARCH_IDEMPOTENCY_CONFLICT");
        }
        await client.query("COMMIT");
        return requireBatch(await readBatch(pool, batch.batch_id, command.ownerUserId));
      }
      for (const source of normalizedSources) {
        const jobResult = await client.query<{ job_id: string }>(
          `INSERT INTO source_research_jobs (
             batch_id, owner_user_id, decision_task_id, query,
             source_id, source_account_id, access_mode, checkpoint, state, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'QUEUED', $9, $9)
           RETURNING job_id`,
          [
            command.batchId,
            command.ownerUserId,
            command.decisionTaskId,
            command.query.trim(),
            source.sourceId,
            source.sourceAccountId,
            source.accessMode,
            source.continuation === undefined
              ? null
              : JSON.stringify({
                  searched: 0,
                  deepRead: 0,
                  hasMore: true,
                  continuation: source.continuation
                }),
            timestamp
          ]
        );
        await client.query(
          `INSERT INTO source_research_outbox (job_id, event_type, created_at)
           VALUES ($1, 'SOURCE_RESEARCH_QUEUED', $2)`,
          [jobResult.rows[0]?.job_id, timestamp]
        );
      }
      await client.query("COMMIT");
      return requireBatch(await readBatch(pool, command.batchId, command.ownerUserId));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    execute,
    async read(query) {
      if (query.type === "GET_BATCH") {
        return readBatch(pool, query.batchId, query.ownerUserId);
      }
      const result = await pool.query<{ batch_id: string }>(
        `SELECT batch_id FROM source_research_batches
         WHERE decision_task_id = $1 AND owner_user_id = $2
         ORDER BY updated_at DESC, batch_id DESC LIMIT 1`,
        [query.decisionTaskId, query.ownerUserId]
      );
      return result.rows[0] === undefined
        ? undefined
        : readBatch(pool, result.rows[0].batch_id, query.ownerUserId);
    },
    async readEvidenceCandidates(input) {
      const batch = await pool.query<{ decision_task_id: string }>(
        `SELECT decision_task_id FROM source_research_batches
         WHERE batch_id = $1 AND owner_user_id = $2`,
        [input.batchId, input.ownerUserId]
      );
      if (batch.rows[0] === undefined) return undefined;
      const result = await pool.query<EvidenceCandidateRow>(
        `SELECT result_key, material
         FROM source_research_results
         WHERE batch_id = $1 AND owner_user_id = $2
         ORDER BY created_at, result_key`,
        [input.batchId, input.ownerUserId]
      );
      return {
        batchId: input.batchId,
        ownerUserId: input.ownerUserId,
        decisionTaskId: batch.rows[0].decision_task_id,
        results: result.rows.map((row) => ({
          resultKey: row.result_key,
          material: row.material
        }))
      };
    },
    async claimNext(workerId, leaseDurationMs) {
      if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
        throw new Error("SOURCE_RESEARCH_LEASE_INVALID");
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const timestamp = now();
        await client.query(
          `UPDATE source_research_jobs
           SET state = 'FAILED_FINAL', worker_id = NULL, lease_expires_at = NULL,
               next_attempt_at = NULL,
               outcome = '{"type":"FAILED_FINAL","summary":"来源研究重试次数已耗尽"}'::jsonb,
               updated_at = $1
           WHERE state = 'RUNNING' AND lease_expires_at <= $1 AND attempt_count >= 5`,
          [timestamp]
        );
        const result = await client.query<JobRow>(
          `SELECT jobs.*, batches.research_target
           FROM source_research_jobs AS jobs
           JOIN source_research_batches AS batches USING (batch_id)
           WHERE jobs.state = 'QUEUED'
              OR (jobs.state = 'FAILED_RETRYABLE' AND jobs.next_attempt_at <= $1)
              OR (jobs.state = 'RUNNING' AND jobs.lease_expires_at <= $1 AND jobs.attempt_count < 5)
           ORDER BY jobs.created_at, jobs.job_id
           FOR UPDATE OF jobs SKIP LOCKED
           LIMIT 1`,
          [timestamp]
        );
        const job = result.rows[0];
        if (job === undefined) {
          await client.query("COMMIT");
          return { status: "EMPTY" } as const;
        }
        await client.query(
          `UPDATE source_research_jobs
           SET state = 'RUNNING', worker_id = $2,
               lease_expires_at = $3, attempt_count = attempt_count + 1,
               updated_at = $1
           WHERE job_id = $4`,
          [timestamp, workerId, new Date(timestamp.getTime() + leaseDurationMs), job.job_id]
        );
        await client.query("COMMIT");
        return {
          status: "CLAIMED" as const,
          jobId: job.job_id,
          batchId: job.batch_id,
          ownerUserId: job.owner_user_id,
          decisionTaskId: job.decision_task_id,
          query: job.query,
          sourceId: job.source_id,
          sourceAccountId: job.source_account_id,
          accessMode: job.access_mode,
          researchTarget: job.research_target,
          checkpoint: job.checkpoint,
          workerId,
          attemptCount: job.attempt_count + 1
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async renewLease(claim, leaseDurationMs) {
      if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
        throw new Error("SOURCE_RESEARCH_LEASE_INVALID");
      }
      const timestamp = now();
      const result = await pool.query(
        `UPDATE source_research_jobs
         SET lease_expires_at = $3, updated_at = $4
         WHERE job_id = $1 AND worker_id = $2 AND state = 'RUNNING'
           AND lease_expires_at > $4`,
        [
          claim.jobId,
          claim.workerId,
          new Date(timestamp.getTime() + leaseDurationMs),
          timestamp
        ]
      );
      return { status: result.rowCount === 1 ? "RENEWED" : "LEASE_LOST" };
    },
    async saveCheckpoint(claim, checkpoint) {
      const result = await pool.query(
        `UPDATE source_research_jobs
         SET checkpoint = $3::jsonb, updated_at = $4
         WHERE job_id = $1 AND worker_id = $2 AND state = 'RUNNING'
           AND lease_expires_at > $4`,
        [claim.jobId, claim.workerId, JSON.stringify(checkpoint), now()]
      );
      return { status: result.rowCount === 1 ? "SAVED" : "LEASE_LOST" };
    },
    async complete(claim, outcome) {
      if (outcome.type === "EVIDENCE_BATCH" && !isEvidenceBatchOutcome(outcome)) {
        throw new Error("SOURCE_RESEARCH_OUTCOME_INVALID");
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const evidenceItems = outcome.type === "EVIDENCE"
          ? [outcome]
          : outcome.type === "EVIDENCE_BATCH"
            ? outcome.items
            : [];
        if (outcome.type === "EVIDENCE" || outcome.type === "EVIDENCE_BATCH") {
          const existing = await client.query<{
            result_key: string; evidence_id: string; summary: string; material: unknown;
            job_cost_units: number; checkpoint: unknown;
          }>(
            `SELECT results.result_key, results.evidence_id, results.summary, results.material,
                    jobs.cost_units AS job_cost_units, jobs.checkpoint
             FROM source_research_results AS results
             JOIN source_research_jobs AS jobs ON jobs.job_id = results.job_id
             WHERE results.job_id = $1`,
            [claim.jobId]
          );
          if (existing.rows.length > 0) {
            const same = existing.rows.length === evidenceItems.length && evidenceItems.every((item) => {
              const row = existing.rows.find((candidate) => candidate.result_key === item.resultKey);
              return row !== undefined && row.evidence_id === item.evidenceId &&
                row.summary === item.summary && row.job_cost_units === outcome.costUnits &&
                isDeepStrictEqual(row.material, JSON.parse(JSON.stringify(item.material))) &&
                (outcome.type !== "EVIDENCE_BATCH" || isDeepStrictEqual(row.checkpoint, outcome.checkpoint));
            });
            if (!same) throw new Error("SOURCE_RESEARCH_OUTCOME_CONFLICT");
            await client.query("COMMIT");
            return { status: "ALREADY_COMMITTED" } as const;
          }
        }
        const locked = await client.query<JobRow>(
          `SELECT * FROM source_research_jobs
           WHERE job_id = $1 AND worker_id = $2 AND state = 'RUNNING'
             AND lease_expires_at > $3
           FOR UPDATE`,
          [claim.jobId, claim.workerId, now()]
        );
        if (locked.rows[0] === undefined) {
          await client.query("COMMIT");
          return { status: "LEASE_LOST" } as const;
        }
        const timestamp = now();
        if (outcome.type === "EVIDENCE" || outcome.type === "EVIDENCE_BATCH") {
          for (const item of evidenceItems) {
            await client.query(
              `INSERT INTO source_research_results (
                 job_id, batch_id, owner_user_id, result_key, evidence_id,
                 summary, material, cost_units, created_at
               ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
              [
                claim.jobId,
                claim.batchId,
                claim.ownerUserId,
                item.resultKey,
                item.evidenceId,
                item.summary,
                JSON.stringify(item.material),
                outcome.type === "EVIDENCE" ? outcome.costUnits : 0,
                timestamp
              ]
            );
          }
          await finishJob(
            client,
            claim.jobId,
            "COMPLETED",
            timestamp,
            null,
            outcome.costUnits,
            null,
            outcome.type === "EVIDENCE_BATCH" ? outcome.checkpoint : null
          );
        } else if (outcome.type === "NO_RESULT") {
          await finishJob(
            client,
            claim.jobId,
            "NO_RESULT",
            timestamp,
            outcome,
            outcome.costUnits
          );
        } else if (outcome.type === "WAITING_CHALLENGE") {
          await finishJob(
            client,
            claim.jobId,
            "WAITING_SOURCE_LOGIN",
            timestamp,
            outcome,
            0
          );
        } else if (outcome.type === "FAILED_RETRYABLE") {
          const attempts = locked.rows[0].attempt_count;
          const exhausted = attempts >= 5;
          await finishJob(
            client,
            claim.jobId,
            exhausted ? "FAILED_FINAL" : "FAILED_RETRYABLE",
            timestamp,
            outcome,
            0,
            exhausted
              ? null
              : new Date(timestamp.getTime() + Math.min(300_000, 1_000 * 2 ** (attempts - 1)))
          );
        } else {
          await finishJob(
            client,
            claim.jobId,
            outcome.type,
            timestamp,
            outcome,
            0
          );
        }
        await client.query(
          "UPDATE source_research_batches SET updated_at = $2 WHERE batch_id = $1",
          [claim.batchId, timestamp]
        );
        await client.query("COMMIT");
        return { status: "COMMITTED" } as const;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async purgePrivateDataForOwner(ownerUserId) {
      const result = await pool.query(
        "DELETE FROM source_research_batches WHERE owner_user_id = $1",
        [ownerUserId]
      );
      return { deletedBatches: result.rowCount ?? 0 };
    },
    async close() {
      await pool.end();
    }
  };
}

async function finishJob(
  client: PoolClient,
  jobId: string,
  state: SourceResearchBatch["jobs"][number]["state"],
  timestamp: Date,
  outcome: unknown,
  costUnits: number,
  nextAttemptAt: Date | null = null,
  checkpoint: unknown | null = null
): Promise<void> {
  await client.query(
    `UPDATE source_research_jobs
     SET state = $2, outcome = $3::jsonb, cost_units = $5, worker_id = NULL,
         lease_expires_at = NULL, next_attempt_at = $6,
         checkpoint = COALESCE($7::jsonb, checkpoint), updated_at = $4
     WHERE job_id = $1`,
    [
      jobId,
      state,
      outcome === null ? null : JSON.stringify(outcome),
      timestamp,
      costUnits,
      nextAttemptAt,
      checkpoint === null ? null : JSON.stringify(checkpoint)
    ]
  );
}

async function readBatch(
  pool: Pool,
  batchId: string,
  ownerUserId: string
): Promise<SourceResearchBatch | undefined> {
  const batchResult = await pool.query<BatchRow>(
    "SELECT * FROM source_research_batches WHERE batch_id = $1 AND owner_user_id = $2",
    [batchId, ownerUserId]
  );
  const batch = batchResult.rows[0];
  if (batch === undefined) return undefined;
  const [jobResult, resultResult] = await Promise.all([
    pool.query<JobRow>(
      `SELECT * FROM source_research_jobs WHERE batch_id = $1
       ORDER BY created_at, job_id`,
      [batchId]
    ),
    pool.query<ResultRow & { cost_units: number }>(
      `SELECT result_key, evidence_id, summary, cost_units
       FROM source_research_results WHERE batch_id = $1
       ORDER BY created_at, result_key`,
      [batchId]
    )
  ]);
  const states = jobResult.rows.map((row) => row.state);
  const terminal = (value: SourceResearchBatch["jobs"][number]["state"]) =>
    value === "COMPLETED" || value === "NO_RESULT" || value === "FAILED_FINAL";
  const state: SourceResearchBatchState = states.some((value) => value === "WAITING_SOURCE_LOGIN")
    ? "WAITING_SOURCE_LOGIN"
    : states.every(terminal) && states.some((value) => value === "FAILED_FINAL")
        ? "FAILED"
      : states.every((value) => value === "COMPLETED" || value === "NO_RESULT")
        ? "COMPLETED"
        : states.some((value) => value === "RUNNING")
          ? "RUNNING"
          : "QUEUED";
  return {
    batchId: batch.batch_id,
    ownerUserId: batch.owner_user_id,
    decisionTaskId: batch.decision_task_id,
    query: batch.query,
    ...(batch.research_target === null ? {} : { researchTarget: batch.research_target }),
    state,
    costUnits: jobResult.rows.reduce((sum, row) => sum + row.cost_units, 0),
    jobs: jobResult.rows.map((row) => {
      const continuation = readPublicWebResearchContinuation(row.checkpoint);
      return {
        jobId: row.job_id,
        sourceId: row.source_id,
        sourceAccountId: row.source_account_id,
        accessMode: row.access_mode,
        state: row.state,
        ...(continuation === undefined ? {} : { continuation }),
        ...(
          row.state === "WAITING_SOURCE_LOGIN" &&
          typeof row.outcome === "object" &&
          row.outcome !== null &&
          "loginSessionId" in row.outcome &&
          typeof row.outcome.loginSessionId === "string"
            ? { loginSessionId: row.outcome.loginSessionId }
            : {}
        )
      };
    }),
    results: resultResult.rows.map((row) => ({
      resultKey: row.result_key,
      evidenceId: row.evidence_id,
      summary: row.summary
    })),
    createdAt: batch.created_at.toISOString(),
    updatedAt: batch.updated_at.toISOString()
  };
}

async function migrateSourceResearch(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('choicemind-source-research-migration', 0))"
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS source_research_batches (
        batch_id uuid PRIMARY KEY,
        owner_user_id text NOT NULL,
        decision_task_id text NOT NULL,
        idempotency_key text NOT NULL,
        request_fingerprint text NOT NULL,
        query text NOT NULL,
        research_target jsonb,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        UNIQUE (owner_user_id, idempotency_key)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS source_research_jobs (
        job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        batch_id uuid NOT NULL REFERENCES source_research_batches(batch_id) ON DELETE CASCADE,
        owner_user_id text NOT NULL,
        decision_task_id text NOT NULL,
        query text NOT NULL,
        source_id text NOT NULL,
        source_account_id text NOT NULL,
        access_mode text NOT NULL DEFAULT 'CREDENTIAL'
          CHECK (access_mode IN ('PUBLIC', 'CREDENTIAL')),
        state text NOT NULL CHECK (state IN (
          'QUEUED', 'RUNNING', 'WAITING_SOURCE_LOGIN', 'COMPLETED',
          'NO_RESULT', 'FAILED_RETRYABLE', 'FAILED_FINAL'
        )),
        checkpoint jsonb,
        outcome jsonb,
        worker_id text,
        lease_expires_at timestamptz,
        attempt_count integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz DEFAULT CURRENT_TIMESTAMP,
        cost_units integer NOT NULL DEFAULT 0 CHECK (cost_units >= 0),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        UNIQUE (batch_id, source_id, source_account_id)
      )
    `);
    await client.query(`
      ALTER TABLE source_research_batches
      ADD COLUMN IF NOT EXISTS request_fingerprint text NOT NULL DEFAULT ''
    `);
    await client.query(`
      ALTER TABLE source_research_batches
      ADD COLUMN IF NOT EXISTS research_target jsonb
    `);
    await client.query(`
      ALTER TABLE source_research_batches
      ADD COLUMN IF NOT EXISTS origin_agent_run_id text
    `);
    await client.query(`
      ALTER TABLE source_research_jobs
      ADD COLUMN IF NOT EXISTS access_mode text NOT NULL DEFAULT 'CREDENTIAL'
      CHECK (access_mode IN ('PUBLIC', 'CREDENTIAL'))
    `);
    await client.query(`
      ALTER TABLE source_research_jobs
      ADD COLUMN IF NOT EXISTS cost_units integer NOT NULL DEFAULT 0
      CHECK (cost_units >= 0)
    `);
    await client.query(`
      ALTER TABLE source_research_jobs
      ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz DEFAULT CURRENT_TIMESTAMP
    `);
    await client.query(
      "ALTER TABLE source_research_jobs ALTER COLUMN next_attempt_at DROP NOT NULL"
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS source_research_results (
        job_id uuid NOT NULL REFERENCES source_research_jobs(job_id) ON DELETE CASCADE,
        batch_id uuid NOT NULL REFERENCES source_research_batches(batch_id) ON DELETE CASCADE,
        owner_user_id text NOT NULL,
        result_key text NOT NULL,
        evidence_id text NOT NULL,
        summary text NOT NULL,
        material jsonb NOT NULL,
        cost_units integer NOT NULL CHECK (cost_units >= 0),
        created_at timestamptz NOT NULL,
        PRIMARY KEY (job_id, result_key)
      )
    `);
    await client.query(`
      ALTER TABLE source_research_results
      ADD COLUMN IF NOT EXISTS material jsonb
    `);
    await client.query(`
      UPDATE source_research_results
      SET material = 'null'::jsonb
      WHERE material IS NULL
    `);
    await client.query(`
      ALTER TABLE source_research_results
      ALTER COLUMN material SET NOT NULL
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS source_research_outbox (
        outbox_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        job_id uuid NOT NULL REFERENCES source_research_jobs(job_id) ON DELETE CASCADE,
        event_type text NOT NULL,
        created_at timestamptz NOT NULL,
        published_at timestamptz
      )
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function requireBatch(batch: SourceResearchBatch | undefined): SourceResearchBatch {
  if (batch === undefined) throw new Error("SOURCE_RESEARCH_BATCH_NOT_FOUND");
  return batch;
}

function requireRow<T>(row: T | undefined): T {
  if (row === undefined) throw new Error("SOURCE_RESEARCH_WRITE_FAILED");
  return row;
}

function isSourceResearchTarget(value: unknown): value is SourceResearchTarget {
  if (typeof value !== "object" || value === null) return false;
  const target = value as Record<string, unknown>;
  if (
    typeof target.subject !== "object" ||
    target.subject === null ||
    !Array.isArray(target.claimTargets)
  ) {
    return false;
  }
  const subject = target.subject as Record<string, unknown>;
  return (
    typeof subject.kind === "string" &&
    /^[A-Z][A-Z0-9_]{0,49}$/.test(subject.kind) &&
    typeof subject.value === "string" &&
    isBoundedTrimmedString(subject.value, 200) &&
    target.claimTargets.length > 0 &&
    target.claimTargets.length <= 10 &&
    target.claimTargets.every(
      (claim) => {
        if (typeof claim !== "object" || claim === null) return false;
        const candidate = claim as Record<string, unknown>;
        return (
          typeof candidate.claimId === "string" &&
          isBoundedTrimmedString(candidate.claimId, 200) &&
          typeof candidate.statement === "string" &&
          isBoundedTrimmedString(candidate.statement, 2_000)
        );
      }
    ) &&
    new Set(
      target.claimTargets.map((claim) => (claim as { claimId: string }).claimId)
    ).size === target.claimTargets.length
  );
}

const PUBLIC_WEB_CONTINUATION_KEYS = new Set([
  "contractType",
  "contractVersion",
  "searchUrls",
  "deepReadUrls"
]);

export function isPublicWebResearchContinuationV1(
  value: unknown
): value is PublicWebResearchContinuationV1 {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(candidate);
  if (
    keys.length !== PUBLIC_WEB_CONTINUATION_KEYS.size ||
    keys.some(
      (key) => typeof key !== "string" || !PUBLIC_WEB_CONTINUATION_KEYS.has(key)
    ) ||
    candidate.contractType !== "public-web-research-continuation" ||
    candidate.contractVersion !== "1.0" ||
    !Array.isArray(candidate.searchUrls) ||
    !Array.isArray(candidate.deepReadUrls)
  ) {
    return false;
  }
  const urls = [...candidate.searchUrls, ...candidate.deepReadUrls];
  return (
    urls.length > 0 &&
    urls.length <= 20 &&
    urls.every(isSafePublicWebContinuationUrl) &&
    new Set(urls).size === urls.length
  );
}

export function readPublicWebResearchContinuation(
  checkpoint: unknown
): PublicWebResearchContinuationV1 | undefined {
  if (
    typeof checkpoint !== "object" ||
    checkpoint === null ||
    !("hasMore" in checkpoint) ||
    checkpoint.hasMore !== true ||
    !("continuation" in checkpoint)
  ) {
    return undefined;
  }
  return isPublicWebResearchContinuationV1(checkpoint.continuation)
    ? checkpoint.continuation
    : undefined;
}

function isSafePublicWebContinuationUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048 || value.trim() !== value) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      url.toString() === value
    );
  } catch {
    return false;
  }
}

function isEvidenceBatchOutcome(
  outcome: Extract<SourceResearchOutcome, { type: "EVIDENCE_BATCH" }>
): boolean {
  if (
    !Array.isArray(outcome.items) ||
    typeof outcome.checkpoint !== "object" ||
    outcome.checkpoint === null
  ) {
    return false;
  }
  return (
    outcome.items.length > 0 &&
    outcome.items.length <= 5 &&
    outcome.items.every(
      (item) =>
        isBoundedTrimmedString(item.resultKey, 500) &&
        isBoundedTrimmedString(item.evidenceId, 500) &&
        isBoundedTrimmedString(item.summary, 4_000) &&
        item.material !== undefined
    ) &&
    new Set(outcome.items.map((item) => item.resultKey)).size === outcome.items.length &&
    new Set(outcome.items.map((item) => item.evidenceId)).size === outcome.items.length &&
    Number.isSafeInteger(outcome.costUnits) &&
    outcome.costUnits >= 0 &&
    Number.isSafeInteger(outcome.checkpoint.searched) &&
    outcome.checkpoint.searched >= 0 &&
    outcome.checkpoint.searched <= 20 &&
    Number.isSafeInteger(outcome.checkpoint.deepRead) &&
    outcome.checkpoint.deepRead > 0 &&
    outcome.checkpoint.deepRead <= 5 &&
    outcome.checkpoint.deepRead <= outcome.checkpoint.searched &&
    outcome.items.length <= outcome.checkpoint.deepRead &&
    typeof outcome.checkpoint.hasMore === "boolean" &&
    (outcome.checkpoint.continuation === undefined ||
      (outcome.checkpoint.hasMore &&
        isPublicWebResearchContinuationV1(outcome.checkpoint.continuation)))
  );
}

function isBoundedTrimmedString(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength && value.trim() === value;
}
