import { createHash, randomUUID } from "node:crypto";

import {
  decodeDecisionTaskResultV1,
  decodeExecuteDecisionTaskCommandV1,
  type DecisionTaskResultV1,
  type DecisionTaskSnapshotV1,
  type ExecuteDecisionTaskCommandV1
} from "@choicemind/contracts/decision/v1";
import { createClient } from "@redis/client";
import { Pool, type PoolClient } from "pg";

import { migratePersistentDecisionTasks } from "./migration.js";

export {
  openOutboxPublisher,
  type OutboxPublisher,
  type OutboxPublisherBatchResult
} from "./publisher.js";

export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT";

  constructor(readonly executionRequestId: string) {
    super("执行标识与原命令不一致");
    this.name = "IdempotencyConflictError";
  }
}

export class PersistenceUnavailableError extends Error {
  readonly code = "PERSISTENCE_UNAVAILABLE";

  constructor() {
    super("持久任务存储暂时不可用");
    this.name = "PersistenceUnavailableError";
  }
}

export type PersistentDecisionTaskModule = Readonly<{
  submit(command: ExecuteDecisionTaskCommandV1): Promise<DecisionTaskSnapshotV1>;
  get(
    decisionTaskId: string
  ): Promise<DecisionTaskSnapshotV1 | PersistedDecisionTaskResultV1 | undefined>;
  claimNext(
    operationId: string,
    workerId: string,
    leaseDurationMs: number
  ): Promise<DecisionTaskClaimResult>;
  complete(
    operationId: string,
    workerId: string,
    outcome: PersistentDecisionTaskOutcome
  ): Promise<DecisionTaskCompletionResult>;
  close(): Promise<void>;
}>;

export type PersistedDecisionTaskResultV1 = Extract<
  DecisionTaskResultV1,
  Readonly<{ taskStatus: unknown }>
>;

export type PersistentDecisionTaskOutcome =
  | PersistedDecisionTaskResultV1
  | Readonly<{
      state: "FAILED_RETRYABLE" | "FAILED_FINAL" | "PARTIAL";
      summary: string;
    }>;

export type DecisionTaskClaimResult =
  | Readonly<{
      status: "CLAIMED";
      operationId: string;
      agentRunId: string;
      command: ExecuteDecisionTaskCommandV1;
  }>
  | Readonly<{ status: "DEFERRED" }>
  | Readonly<{ status: "UNKNOWN" }>
  | Readonly<{ status: "ALREADY_FINISHED" }>;

export type DecisionTaskCompletionResult =
  | Readonly<{ status: "COMMITTED"; result: PersistedDecisionTaskResultV1 }>
  | Readonly<{ status: "COMMITTED"; snapshot: DecisionTaskSnapshotV1 }>
  | Readonly<{ status: "NOT_COMPLETABLE" }>;

export type PersistentDecisionTaskWorkerBatchResult = Readonly<{
  acknowledged: number;
  executed: number;
  received: number;
}>;

export type PersistentDecisionTaskWorker = Readonly<{
  runOnce(): Promise<PersistentDecisionTaskWorkerBatchResult>;
  close(): Promise<void>;
}>;

type PersistentDecisionTaskWorkerOptions = Readonly<{
  databaseUrl: string;
  redisUrl: string;
  streamName: string;
  consumerGroup: string;
  workerId: string;
  leaseDurationMs?: number;
  pendingClaimIdleMs?: number;
  readBlockMs?: number;
  execute(
    claim: Readonly<{
      command: ExecuteDecisionTaskCommandV1;
      agentRunId: string;
    }>
  ): Promise<PersistentDecisionTaskOutcome>;
}>;

type PersistentDecisionTaskModuleOptions = Readonly<{
  databaseUrl: string;
  now?: () => Date;
}>;

type TaskRow = Readonly<{
  execution_request_id: string;
  decision_task_id: string;
  agent_run_id: string;
  state:
    | "ACCEPTED"
    | "RUNNING"
    | "COMPLETED"
    | "FAILED_RETRYABLE"
    | "FAILED_FINAL"
    | "PARTIAL";
  updated_at: Date;
  result_payload: unknown | null;
}>;

type ExistingSubmissionRow = TaskRow &
  Readonly<{
    command_fingerprint: string;
  }>;

type ClaimedOperationRow = Readonly<{
  operation_id: string;
  agent_run_id: string;
  command_payload: unknown;
}>;

type OperationStateRow = Readonly<{
  state: TaskRow["state"];
}>;

export async function openPersistentDecisionTaskModule(
  options: PersistentDecisionTaskModuleOptions
): Promise<PersistentDecisionTaskModule> {
  const pool = new Pool({
    connectionString: options.databaseUrl,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    max: 5
  });
  pool.on("error", () => undefined);
  const migrationClient = await pool.connect();

  try {
    await migratePersistentDecisionTasks(migrationClient);
  } catch (error) {
    await pool.end();
    throw error;
  } finally {
    migrationClient.release();
  }

  const now = options.now ?? (() => new Date());
  let closed = false;

  return {
    async submit(command) {
      assertOpen(closed);
      let client: PoolClient | undefined;

      try {
        client = await pool.connect();
        return await submitInTransaction(client, command, now());
      } catch (error) {
        if (
          error instanceof IdempotencyConflictError ||
          error instanceof PersistenceUnavailableError
        ) {
          throw error;
        }

        throw new PersistenceUnavailableError();
      } finally {
        client?.release();
      }
    },
    async get(decisionTaskId) {
      assertOpen(closed);
      try {
        const result = await pool.query<TaskRow>(
          `SELECT
             submission.execution_request_id,
             operation.decision_task_id,
             operation.agent_run_id,
             operation.state,
             operation.updated_at,
             operation.result_payload
           FROM agent_run_operations AS operation
           INNER JOIN decision_task_submissions AS submission
             ON submission.execution_request_id = operation.execution_request_id
           WHERE operation.decision_task_id = $1
           ORDER BY operation.created_at DESC
           LIMIT 1`,
          [decisionTaskId]
        );
        const row = result.rows[0];

        if (row === undefined) {
          return undefined;
        }

        if (row.state === "COMPLETED" && row.result_payload !== null) {
          return decodePersistedResult(row.result_payload, row);
        }

        return toTaskSnapshot(row);
      } catch (error) {
        if (error instanceof PersistenceUnavailableError) {
          throw error;
        }

        throw new PersistenceUnavailableError();
      }
    },
    async claimNext(operationId, workerId, leaseDurationMs) {
      assertOpen(closed);
      const claimedAt = now();

      try {
        const result = await pool.query<ClaimedOperationRow>(
          `UPDATE agent_run_operations AS operation
           SET state = 'RUNNING',
               worker_id = $2,
               lease_expires_at = $3,
               updated_at = $4
           FROM decision_task_submissions AS submission
           WHERE operation.operation_id = $1
             AND operation.execution_request_id = submission.execution_request_id
             AND (
               operation.state = 'ACCEPTED'
               OR operation.state = 'FAILED_RETRYABLE'
               OR (
                 operation.state = 'RUNNING'
                 AND operation.lease_expires_at < $4
               )
             )
           RETURNING
             operation.operation_id,
             operation.agent_run_id,
             submission.command_payload`,
          [
            operationId,
            workerId,
            new Date(claimedAt.getTime() + leaseDurationMs),
            claimedAt
          ]
        );
        const row = result.rows[0];

        if (row === undefined) {
          const stateResult = await pool.query<OperationStateRow>(
            `SELECT state
             FROM agent_run_operations
             WHERE operation_id = $1`,
            [operationId]
          );
          const state = stateResult.rows[0]?.state;

          if (state === undefined) {
            return { status: "UNKNOWN" };
          }

          return state === "COMPLETED" ||
            state === "FAILED_FINAL" ||
            state === "PARTIAL"
            ? { status: "ALREADY_FINISHED" }
            : { status: "DEFERRED" };
        }

        const decoded = decodeExecuteDecisionTaskCommandV1(row.command_payload);

        if (!decoded.ok) {
          throw new PersistenceUnavailableError();
        }

        return {
          status: "CLAIMED",
          operationId: row.operation_id,
          agentRunId: row.agent_run_id,
          command: decoded.value
        };
      } catch (error) {
        if (error instanceof PersistenceUnavailableError) {
          throw error;
        }

        throw new PersistenceUnavailableError();
      }
    },
    async complete(operationId, workerId, outcome) {
      assertOpen(closed);
      const decodedOutcome = decodePersistentOutcome(outcome);

      const completedAt = now();

      try {
        const update = await pool.query<TaskRow>(
          `UPDATE agent_run_operations AS operation
           SET state = $4,
               result_payload = $5::jsonb,
               updated_at = $6,
               worker_id = NULL,
               lease_expires_at = NULL
           FROM decision_task_submissions AS submission
           WHERE operation.operation_id = $1
             AND operation.worker_id = $2
             AND operation.state = 'RUNNING'
             AND operation.lease_expires_at >= $6
             AND operation.execution_request_id = submission.execution_request_id
             AND ($3::text IS NULL OR operation.agent_run_id = $3)
             AND ($7::text IS NULL OR operation.decision_task_id = $7)
           RETURNING
             submission.execution_request_id,
             operation.decision_task_id,
             operation.agent_run_id,
             operation.state,
             operation.updated_at,
             operation.result_payload`,
          [
            operationId,
            workerId,
            decodedOutcome.agentRunId,
            decodedOutcome.state,
            JSON.stringify(decodedOutcome.payload),
            completedAt,
            decodedOutcome.decisionTaskId
          ]
        );
        const row = update.rows[0];

        if (row === undefined) {
          return { status: "NOT_COMPLETABLE" };
        }

        if (row.state === "COMPLETED") {
          return {
            status: "COMMITTED",
            result: decodePersistedResult(row.result_payload, row)
          };
        }

        return { status: "COMMITTED", snapshot: toTaskSnapshot(row) };
      } catch (error) {
        if (error instanceof PersistenceUnavailableError) {
          throw error;
        }

        throw new PersistenceUnavailableError();
      }
    },
    async close() {
      if (closed) {
        return;
      }

      closed = true;
      await pool.end();
    }
  };
}

export async function openPersistentDecisionTaskWorker(
  options: PersistentDecisionTaskWorkerOptions
): Promise<PersistentDecisionTaskWorker> {
  const persistence = await openPersistentDecisionTaskModule({
    databaseUrl: options.databaseUrl
  });
  const redis = createClient({
    url: options.redisUrl,
    socket: {
      connectTimeout: 1_000,
      reconnectStrategy: false,
      socketTimeout: 2_000
    }
  });
  redis.on("error", () => undefined);

  try {
    await redis.connect();

    try {
      await redis.xGroupCreate(options.streamName, options.consumerGroup, "0", {
        MKSTREAM: true
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("BUSYGROUP")) {
        throw error;
      }
    }
  } catch (error) {
    if (redis.isOpen) {
      redis.destroy();
    }
    await persistence.close();
    throw error;
  }

  const leaseDurationMs = options.leaseDurationMs ?? 30_000;
  const pendingClaimIdleMs = options.pendingClaimIdleMs ?? 30_000;
  const readBlockMs = options.readBlockMs ?? 1_000;
  let closed = false;

  return {
    async runOnce() {
      assertOpen(closed);
      const streams = await redis.xReadGroup(
        options.consumerGroup,
        options.workerId,
        { key: options.streamName, id: ">" },
        { COUNT: 1, BLOCK: readBlockMs, CLAIM: pendingClaimIdleMs }
      );
      const message = streams?.[0]?.messages[0];

      if (message === undefined) {
        return { acknowledged: 0, executed: 0, received: 0 };
      }

      const operationId = message.message.operationId;

      if (operationId === undefined || !isCanonicalUuid(operationId)) {
        const acknowledged = await redis.xAck(
          options.streamName,
          options.consumerGroup,
          message.id
        );
        return { acknowledged, executed: 0, received: 1 };
      }

      const claim = await persistence.claimNext(
        operationId,
        options.workerId,
        leaseDurationMs
      );

      if (claim.status === "DEFERRED") {
        return { acknowledged: 0, executed: 0, received: 1 };
      }

      if (claim.status === "ALREADY_FINISHED" || claim.status === "UNKNOWN") {
        const acknowledged = await redis.xAck(
          options.streamName,
          options.consumerGroup,
          message.id
        );
        return { acknowledged, executed: 0, received: 1 };
      }

      const result = await options.execute({
        command: claim.command,
        agentRunId: claim.agentRunId
      });

      const completion = await persistence.complete(
        claim.operationId,
        options.workerId,
        result
      );

      if (completion.status === "NOT_COMPLETABLE") {
        return { acknowledged: 0, executed: 1, received: 1 };
      }

      if (
        "snapshot" in completion &&
        completion.snapshot.state === "FAILED_RETRYABLE"
      ) {
        return { acknowledged: 0, executed: 1, received: 1 };
      }

      const acknowledged = await redis.xAck(
        options.streamName,
        options.consumerGroup,
        message.id
      );
      return { acknowledged, executed: 1, received: 1 };
    },
    async close() {
      if (closed) {
        return;
      }

      closed = true;
      await redis.close();
      await persistence.close();
    }
  };
}

async function submitInTransaction(
  client: PoolClient,
  command: ExecuteDecisionTaskCommandV1,
  submittedAt: Date
): Promise<DecisionTaskSnapshotV1> {
  const fingerprint = createHash("sha256").update(canonicalize(command)).digest("hex");
  const agentRunId = `agent-run-${randomUUID()}`;
  const operationId = randomUUID();
  const messageId = randomUUID();

  await client.query("BEGIN");

  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      command.executionRequestId
    ]);
    const existingResult = await client.query<ExistingSubmissionRow>(
      `SELECT
         submission.command_fingerprint,
         submission.execution_request_id,
         operation.decision_task_id,
         operation.agent_run_id,
         operation.state,
         operation.updated_at,
         operation.result_payload
       FROM decision_task_submissions AS submission
       INNER JOIN agent_run_operations AS operation
         ON operation.execution_request_id = submission.execution_request_id
       WHERE submission.execution_request_id = $1`,
      [command.executionRequestId]
    );
    const existing = existingResult.rows[0];

    if (existing !== undefined) {
      if (existing.command_fingerprint !== fingerprint) {
        throw new IdempotencyConflictError(command.executionRequestId);
      }

      await client.query("COMMIT");
      return toTaskSnapshot(existing);
    }

    await client.query(
      `INSERT INTO decision_task_submissions (
         execution_request_id,
         command_fingerprint,
         decision_task_id,
         command_payload,
         created_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [
        command.executionRequestId,
        fingerprint,
        command.requirementRevision.decisionTaskId,
        JSON.stringify(command),
        submittedAt
      ]
    );
    await client.query(
      `INSERT INTO agent_run_operations (
         operation_id,
         agent_run_id,
         execution_request_id,
         decision_task_id,
         state,
         created_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, 'ACCEPTED', $5, $5)`,
      [
        operationId,
        agentRunId,
        command.executionRequestId,
        command.requirementRevision.decisionTaskId,
        submittedAt
      ]
    );
    await client.query(
      `INSERT INTO outbox_messages (
         message_id,
         operation_id,
         payload_type,
         payload_version,
         payload,
         next_attempt_at,
         created_at
       ) VALUES ($1, $2, 'decision-task-ready', '1.0', $3::jsonb, $4, $4)`,
      [
        messageId,
        operationId,
        JSON.stringify({ operationId }),
        submittedAt
      ]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");

    if (error instanceof IdempotencyConflictError) {
      throw error;
    }

    throw new PersistenceUnavailableError();
  }

  return {
    contractType: "decision-task-snapshot",
    contractVersion: "1.0",
    executionRequestId: command.executionRequestId,
    decisionTaskId: command.requirementRevision.decisionTaskId,
    agentRunId,
    state: "ACCEPTED",
    terminal: false,
    updatedAt: submittedAt.toISOString()
  };
}

function toTaskSnapshot(row: TaskRow): DecisionTaskSnapshotV1 {
  if (
    row.state !== "ACCEPTED" &&
    row.state !== "RUNNING" &&
    row.state !== "FAILED_RETRYABLE" &&
    row.state !== "FAILED_FINAL" &&
    row.state !== "PARTIAL"
  ) {
    throw new PersistenceUnavailableError();
  }

  return {
    contractType: "decision-task-snapshot",
    contractVersion: "1.0",
    executionRequestId: row.execution_request_id,
    decisionTaskId: row.decision_task_id,
    agentRunId: row.agent_run_id,
    state: row.state,
    terminal: row.state === "FAILED_FINAL",
    updatedAt: row.updated_at.toISOString()
  } as DecisionTaskSnapshotV1;
}

function decodePersistentOutcome(outcome: PersistentDecisionTaskOutcome): Readonly<{
  state: "COMPLETED" | "FAILED_RETRYABLE" | "FAILED_FINAL" | "PARTIAL";
  payload: PersistentDecisionTaskOutcome;
  agentRunId: string | null;
  decisionTaskId: string | null;
}> {
  if (
    "state" in outcome &&
    (outcome.state === "FAILED_RETRYABLE" ||
      outcome.state === "FAILED_FINAL" ||
      outcome.state === "PARTIAL") &&
    typeof outcome.summary === "string" &&
    outcome.summary.trim().length > 0
  ) {
    return {
      state: outcome.state,
      payload: outcome,
      agentRunId: null,
      decisionTaskId: null
    };
  }

  const decoded = decodeDecisionTaskResultV1(outcome);

  if (!decoded.ok || !("taskStatus" in decoded.value)) {
    throw new PersistenceUnavailableError();
  }

  return {
    state: decoded.value.ok ? "COMPLETED" : "FAILED_FINAL",
    payload: decoded.value,
    agentRunId: decoded.value.taskStatus.agentRunId,
    decisionTaskId: decoded.value.taskStatus.decisionTaskId
  };
}

function decodePersistedResult(
  input: unknown,
  row: Pick<TaskRow, "agent_run_id" | "decision_task_id">
): PersistedDecisionTaskResultV1 {
  const decoded = decodeDecisionTaskResultV1(input);

  if (
    !decoded.ok ||
    !("taskStatus" in decoded.value) ||
    decoded.value.taskStatus.agentRunId !== row.agent_run_id ||
    decoded.value.taskStatus.decisionTaskId !== row.decision_task_id
  ) {
    throw new PersistenceUnavailableError();
  }

  return decoded.value;
}

function assertOpen(closed: boolean): void {
  if (closed) {
    throw new Error("持久 Decision Task Module 已关闭");
  }
}

function isCanonicalUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value
  );
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }

  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}
