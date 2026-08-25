import { createHash, randomUUID } from "node:crypto";

import {
  decodeDecisionTaskResultV1,
  decodeExecuteDecisionTaskCommandV1,
  decodePersistedRunEventV1,
  type DecisionTaskResultV1,
  type DecisionTaskSnapshotV1,
  type DecisionTaskStateV1,
  type ExecuteDecisionTaskCommandV1,
  type PersistedRunEventV1,
  type RunEventV1
} from "@choicemind/contracts/decision/v1";
import type { EgressRecord, EncryptedCredentialRecord } from "@choicemind/security";
import { createClient } from "@redis/client";
import { Pool, type PoolClient } from "pg";

import { migratePersistentDecisionTasks } from "./migration.js";

export {
  openRunEventNotificationPublisher,
  type RunEventNotificationPublisher,
  type RunEventNotificationPublisherBatchResult
} from "./event-publisher.js";
export {
  openRunEventNotificationSubscriber,
  type RunEventNotificationSubscriber
} from "./event-subscriber.js";
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
  submit(command: ExecuteDecisionTaskCommandV1, ownerUserId: string): Promise<DecisionTaskSnapshotV1>;
  get(
    decisionTaskId: string,
    ownerUserId: string
  ): Promise<DecisionTaskSnapshotV1 | PersistedDecisionTaskResultV1 | undefined>;
  listEvents(
    decisionTaskId: string,
    ownerUserId: string,
    afterCursor?: string
  ): Promise<readonly PersistedRunEventV1[]>;
  appendAuditRecord(record: PersistentAuditRecordInput): Promise<void>;
  listAuditRecords(correlationId: string): Promise<readonly PersistentAuditRecord[]>;
  saveEncryptedCredential(record: EncryptedCredentialRecord): Promise<void>;
  loadEncryptedCredential(
    credentialId: string,
    ownerUserId: string
  ): Promise<EncryptedCredentialRecord | undefined>;
  appendEgressRecord(record: EgressRecord): Promise<void>;
  listEgressRecords(correlationId: string): Promise<readonly EgressRecord[]>;
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

export type PersistentAuditRecordInput = Readonly<{
  actor: Readonly<{
    principalId: string;
    role: "USER" | "ADMIN" | "SUPERADMIN";
    userId: string;
  }>;
  action: string;
  object: Readonly<{ id: string; type: string }>;
  result: string;
  correlationId: string;
}>;

export type PersistentAuditRecord = PersistentAuditRecordInput &
  Readonly<{ occurredAt: string }>;

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
    owner_user_id: string;
  }>;

type ClaimedOperationRow = Readonly<{
  operation_id: string;
  agent_run_id: string;
  decision_task_id: string;
  state: TaskRow["state"];
  lease_expires_at: Date | null;
  command_payload: unknown;
}>;

type RunEventRow = Readonly<{
  cursor: string;
  event_payload: unknown;
}>;

type AuditRecordRow = Readonly<{
  actor_principal_id: string;
  actor_user_id: string;
  actor_role: "USER" | "ADMIN" | "SUPERADMIN";
  action: string;
  object_type: string;
  object_id: string;
  result: string;
  correlation_id: string;
  occurred_at: Date;
}>;

type EncryptedCredentialRow = Readonly<{
  owner_user_id: string;
  credential_id: string;
  secret_type: EncryptedCredentialRecord["secretType"];
  encryption_version: EncryptedCredentialRecord["encryptionVersion"];
  ciphertext: string;
  ciphertext_iv: string;
  ciphertext_tag: string;
  wrapped_data_key: string;
  wrapped_data_key_iv: string;
  wrapped_data_key_tag: string;
}>;

type EgressRecordRow = Readonly<{
  egress_id: string;
  user_id: string;
  operation_id: string;
  correlation_id: string;
  destination_origin: string;
  method: string;
  policy_version: "p0-v1";
  state: "STARTED";
  occurred_at: Date;
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
    async submit(command, ownerUserId) {
      assertOpen(closed);
      let client: PoolClient | undefined;

      try {
        client = await pool.connect();
        return await submitInTransaction(client, command, ownerUserId, now());
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
    async get(decisionTaskId, ownerUserId) {
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
             AND submission.owner_user_id = $2
           ORDER BY operation.created_at DESC
           LIMIT 1`,
          [decisionTaskId, ownerUserId]
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
    async listEvents(decisionTaskId, ownerUserId, afterCursor) {
      assertOpen(closed);

      try {
        const result = await pool.query<RunEventRow>(
          `SELECT cursor::text, event_payload
           FROM decision_task_run_events AS event
           INNER JOIN decision_task_agent_runs AS agent_run
             ON agent_run.agent_run_id = event.agent_run_id
           INNER JOIN agent_run_operations AS operation
             ON operation.operation_id = agent_run.operation_id
           INNER JOIN decision_task_submissions AS submission
             ON submission.execution_request_id = operation.execution_request_id
           WHERE event.decision_task_id = $1
             AND submission.owner_user_id = $2
             AND ($3::bigint IS NULL OR event.cursor > $3::bigint)
           ORDER BY event.cursor ASC`,
          [decisionTaskId, ownerUserId, afterCursor ?? null]
        );

        return result.rows.map((row) => {
          const decoded = decodePersistedRunEventV1({
            contractType: "persisted-run-event",
            contractVersion: "1.0",
            cursor: row.cursor,
            event: row.event_payload
          });

          if (!decoded.ok) {
            throw new PersistenceUnavailableError();
          }

          return decoded.value;
        });
      } catch (error) {
        if (error instanceof PersistenceUnavailableError) {
          throw error;
        }

        throw new PersistenceUnavailableError();
      }
    },
    async appendAuditRecord(record) {
      assertOpen(closed);

      try {
        await pool.query(
          `INSERT INTO audit_records (
             audit_record_id, actor_principal_id, actor_user_id, actor_role,
             action, object_type, object_id, result, correlation_id, occurred_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            randomUUID(),
            record.actor.principalId,
            record.actor.userId,
            record.actor.role,
            record.action,
            record.object.type,
            record.object.id,
            record.result,
            record.correlationId,
            now()
          ]
        );
      } catch {
        throw new PersistenceUnavailableError();
      }
    },
    async listAuditRecords(correlationId) {
      assertOpen(closed);

      try {
        const result = await pool.query<AuditRecordRow>(
          `SELECT actor_principal_id, actor_user_id, actor_role, action,
                  object_type, object_id, result, correlation_id, occurred_at
           FROM audit_records
           WHERE correlation_id = $1
           ORDER BY occurred_at, audit_record_id`,
          [correlationId]
        );

        return result.rows.map((row) => ({
          actor: {
            principalId: row.actor_principal_id,
            role: row.actor_role,
            userId: row.actor_user_id
          },
          action: row.action,
          object: { id: row.object_id, type: row.object_type },
          result: row.result,
          correlationId: row.correlation_id,
          occurredAt: row.occurred_at.toISOString()
        }));
      } catch {
        throw new PersistenceUnavailableError();
      }
    },
    async saveEncryptedCredential(record) {
      assertOpen(closed);

      try {
        await pool.query(
          `INSERT INTO encrypted_credentials (
             owner_user_id, credential_id, secret_type, encryption_version,
             ciphertext, ciphertext_iv, ciphertext_tag,
             wrapped_data_key, wrapped_data_key_iv, wrapped_data_key_tag,
             created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
           ON CONFLICT (owner_user_id, credential_id) DO UPDATE SET
             secret_type = EXCLUDED.secret_type,
             encryption_version = EXCLUDED.encryption_version,
             ciphertext = EXCLUDED.ciphertext,
             ciphertext_iv = EXCLUDED.ciphertext_iv,
             ciphertext_tag = EXCLUDED.ciphertext_tag,
             wrapped_data_key = EXCLUDED.wrapped_data_key,
             wrapped_data_key_iv = EXCLUDED.wrapped_data_key_iv,
             wrapped_data_key_tag = EXCLUDED.wrapped_data_key_tag,
             updated_at = EXCLUDED.updated_at`,
          [
            record.ownerUserId,
            record.credentialId,
            record.secretType,
            record.encryptionVersion,
            record.ciphertext,
            record.ciphertextIv,
            record.ciphertextTag,
            record.wrappedDataKey,
            record.wrappedDataKeyIv,
            record.wrappedDataKeyTag,
            now()
          ]
        );
      } catch {
        throw new PersistenceUnavailableError();
      }
    },
    async loadEncryptedCredential(credentialId, ownerUserId) {
      assertOpen(closed);

      try {
        const result = await pool.query<EncryptedCredentialRow>(
          `SELECT owner_user_id, credential_id, secret_type, encryption_version,
                  ciphertext, ciphertext_iv, ciphertext_tag,
                  wrapped_data_key, wrapped_data_key_iv, wrapped_data_key_tag
           FROM encrypted_credentials
           WHERE owner_user_id = $1 AND credential_id = $2`,
          [ownerUserId, credentialId]
        );
        const row = result.rows[0];

        return row === undefined
          ? undefined
          : {
              ownerUserId: row.owner_user_id,
              credentialId: row.credential_id,
              secretType: row.secret_type,
              encryptionVersion: row.encryption_version,
              ciphertext: row.ciphertext,
              ciphertextIv: row.ciphertext_iv,
              ciphertextTag: row.ciphertext_tag,
              wrappedDataKey: row.wrapped_data_key,
              wrappedDataKeyIv: row.wrapped_data_key_iv,
              wrappedDataKeyTag: row.wrapped_data_key_tag
            };
      } catch {
        throw new PersistenceUnavailableError();
      }
    },
    async appendEgressRecord(record) {
      assertOpen(closed);

      try {
        await pool.query(
          `INSERT INTO egress_records (
             egress_id, user_id, operation_id, correlation_id,
             destination_origin, method, policy_version, state, occurred_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            record.egressId,
            record.userId,
            record.operationId,
            record.correlationId,
            record.destinationOrigin,
            record.method,
            record.policyVersion,
            record.state,
            record.occurredAt
          ]
        );
      } catch {
        throw new PersistenceUnavailableError();
      }
    },
    async listEgressRecords(correlationId) {
      assertOpen(closed);

      try {
        const result = await pool.query<EgressRecordRow>(
          `SELECT egress_id, user_id, operation_id, correlation_id,
                  destination_origin, method, policy_version, state, occurred_at
           FROM egress_records
           WHERE correlation_id = $1
           ORDER BY occurred_at, egress_id`,
          [correlationId]
        );

        return result.rows.map((row) => ({
          egressId: row.egress_id,
          userId: row.user_id,
          operationId: row.operation_id,
          correlationId: row.correlation_id,
          destinationOrigin: row.destination_origin,
          method: row.method,
          policyVersion: row.policy_version,
          state: row.state,
          occurredAt: row.occurred_at.toISOString()
        }));
      } catch {
        throw new PersistenceUnavailableError();
      }
    },
    async claimNext(operationId, workerId, leaseDurationMs) {
      assertOpen(closed);
      const claimedAt = now();
      let client: PoolClient | undefined;
      let transactionStarted = false;

      try {
        client = await pool.connect();
        await client.query("BEGIN");
        transactionStarted = true;
        const result = await client.query<ClaimedOperationRow>(
          `SELECT
             operation.operation_id,
             operation.agent_run_id,
             operation.decision_task_id,
             operation.state,
             operation.lease_expires_at,
             submission.command_payload
           FROM agent_run_operations AS operation
           INNER JOIN decision_task_submissions AS submission
             ON submission.execution_request_id = operation.execution_request_id
           WHERE operation.operation_id = $1
           FOR UPDATE OF operation`,
          [operationId]
        );
        const row = result.rows[0];

        if (row === undefined) {
          await client.query("COMMIT");
          transactionStarted = false;
          return { status: "UNKNOWN" };
        }

        const claimable =
          row.state === "ACCEPTED" ||
          row.state === "FAILED_RETRYABLE" ||
          (row.state === "RUNNING" &&
            row.lease_expires_at !== null &&
            row.lease_expires_at < claimedAt);

        if (!claimable) {
          await client.query("COMMIT");
          transactionStarted = false;
          return row.state === "COMPLETED" ||
            row.state === "FAILED_FINAL" ||
            row.state === "PARTIAL"
            ? { status: "ALREADY_FINISHED" }
            : { status: "DEFERRED" };
        }

        const decoded = decodeExecuteDecisionTaskCommandV1(row.command_payload);

        if (!decoded.ok) {
          throw new PersistenceUnavailableError();
        }

        let agentRunId = row.agent_run_id;

        if (row.state === "FAILED_RETRYABLE") {
          agentRunId = `agent-run-${randomUUID()}`;
          await client.query(
            `INSERT INTO decision_task_agent_runs (
               agent_run_id,
               operation_id,
               attempt,
               created_at
             )
             SELECT $1, $2, COALESCE(MAX(attempt), 0) + 1, $3
             FROM decision_task_agent_runs
             WHERE operation_id = $2`,
            [agentRunId, operationId, claimedAt]
          );
          const createdEvent: RunEventV1 = {
            contractType: "run-event",
            contractVersion: "1.0",
            eventId: `event-persistent-${randomUUID()}`,
            decisionTaskId: row.decision_task_id,
            agentRunId,
            sequence: 1,
            occurredAt: claimedAt.toISOString(),
            eventType: "TASK_STATE_CHANGED",
            taskState: "CREATED",
            summary: "决策任务开始新的重试执行",
            synthetic: true
          };
          await insertRunEvent(client, createdEvent, claimedAt);
        }

        await client.query(
          `UPDATE agent_run_operations
           SET agent_run_id = $2,
               state = 'RUNNING',
               worker_id = $3,
               lease_expires_at = $4,
               updated_at = $5
           WHERE operation_id = $1`,
          [
            operationId,
            agentRunId,
            workerId,
            new Date(claimedAt.getTime() + leaseDurationMs),
            claimedAt
          ]
        );
        const existingEvents = await loadRunEvents(
          client,
          row.decision_task_id,
          agentRunId
        );

        if (existingEvents.at(-1)?.taskState !== "UNDERSTANDING") {
          const runningEvent: RunEventV1 = {
            contractType: "run-event",
            contractVersion: "1.0",
            eventId: `event-persistent-${randomUUID()}`,
            decisionTaskId: row.decision_task_id,
            agentRunId,
            sequence: existingEvents.length + 1,
            occurredAt: claimedAt.toISOString(),
            eventType: "TASK_STATE_CHANGED",
            taskState: "UNDERSTANDING",
            summary: "决策任务开始执行",
            synthetic: true
          };
          await insertRunEvent(client, runningEvent, claimedAt);
        }
        await client.query("COMMIT");
        transactionStarted = false;

        return {
          status: "CLAIMED",
          operationId: row.operation_id,
          agentRunId,
          command: decoded.value
        };
      } catch (error) {
        if (transactionStarted && client !== undefined) {
          await client.query("ROLLBACK");
        }

        if (error instanceof PersistenceUnavailableError) {
          throw error;
        }

        throw new PersistenceUnavailableError();
      } finally {
        client?.release();
      }
    },
    async complete(operationId, workerId, outcome) {
      assertOpen(closed);
      const decodedOutcome = decodePersistentOutcome(outcome);

      const completedAt = now();
      let client: PoolClient | undefined;
      let transactionStarted = false;

      try {
        client = await pool.connect();
        await client.query("BEGIN");
        transactionStarted = true;
        const update = await client.query<TaskRow>(
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
          await client.query("COMMIT");
          transactionStarted = false;
          return { status: "NOT_COMPLETABLE" };
        }

        let completion: DecisionTaskCompletionResult;

        if ("runEvents" in decodedOutcome.payload) {
          const persistedResult = await persistResultRunEvents(
            client,
            row,
            decodedOutcome.payload,
            completedAt
          );
          await client.query(
            `UPDATE agent_run_operations
             SET result_payload = $2::jsonb,
                 updated_at = $3
             WHERE operation_id = $1`,
            [operationId, JSON.stringify(persistedResult), persistedResult.taskStatus.updatedAt]
          );
          completion =
            row.state === "COMPLETED"
              ? { status: "COMMITTED", result: persistedResult }
              : { status: "COMMITTED", snapshot: toTaskSnapshot(row) };
        } else {
          const existingEvents = await loadRunEvents(
            client,
            row.decision_task_id,
            row.agent_run_id
          );
          const completedEvent: RunEventV1 = {
            contractType: "run-event",
            contractVersion: "1.0",
            eventId: `event-persistent-${randomUUID()}`,
            decisionTaskId: row.decision_task_id,
            agentRunId: row.agent_run_id,
            sequence: existingEvents.length + 1,
            occurredAt: completedAt.toISOString(),
            eventType: row.state === "COMPLETED" ? "RUNTIME_SUCCEEDED" : "RUNTIME_FAILED",
            taskState: row.state === "COMPLETED" ? "COMPLETED" : "FAILED",
            summary: getPublicOutcomeSummary(row.state),
            synthetic: true
          };
          await insertRunEvent(client, completedEvent, completedAt);
          completion = { status: "COMMITTED", snapshot: toTaskSnapshot(row) };
        }

        await client.query("COMMIT");
        transactionStarted = false;
        return completion;
      } catch (error) {
        if (transactionStarted && client !== undefined) {
          await client.query("ROLLBACK");
        }

        if (error instanceof PersistenceUnavailableError) {
          throw error;
        }

        throw new PersistenceUnavailableError();
      } finally {
        client?.release();
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
  ownerUserId: string,
  submittedAt: Date
): Promise<DecisionTaskSnapshotV1> {
  const fingerprint = createHash("sha256").update(canonicalize(command)).digest("hex");
  const agentRunId = `agent-run-${randomUUID()}`;
  const operationId = randomUUID();
  const messageId = randomUUID();
  const submittedEvent: RunEventV1 = {
    contractType: "run-event",
    contractVersion: "1.0",
    eventId: `event-persistent-${randomUUID()}`,
    decisionTaskId: command.requirementRevision.decisionTaskId,
    agentRunId,
    sequence: 1,
    occurredAt: submittedAt.toISOString(),
    eventType: "TASK_STATE_CHANGED",
    taskState: "CREATED",
    summary: "决策任务已接受",
    synthetic: true
  };

  await client.query("BEGIN");

  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      command.executionRequestId
    ]);
    const existingResult = await client.query<ExistingSubmissionRow>(
      `SELECT
         submission.command_fingerprint,
         submission.owner_user_id,
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
      if (
        existing.owner_user_id !== ownerUserId ||
        existing.command_fingerprint !== fingerprint
      ) {
        throw new IdempotencyConflictError(command.executionRequestId);
      }

      await client.query("COMMIT");
      return toTaskSnapshot(existing);
    }

    await client.query(
      `INSERT INTO decision_task_submissions (
         execution_request_id,
         owner_user_id,
         command_fingerprint,
         decision_task_id,
         command_payload,
         created_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        command.executionRequestId,
        ownerUserId,
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
      `INSERT INTO decision_task_agent_runs (
         agent_run_id,
         operation_id,
         attempt,
         created_at
       ) VALUES ($1, $2, 1, $3)`,
      [agentRunId, operationId, submittedAt]
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
    await insertRunEvent(client, submittedEvent, submittedAt);
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

function getPublicOutcomeSummary(state: TaskRow["state"]): string {
  if (state === "FAILED_RETRYABLE") {
    return "决策任务暂时失败，等待重试";
  }

  if (state === "FAILED_FINAL") {
    return "决策任务执行失败，已结束";
  }

  if (state === "PARTIAL") {
    return "决策任务仅部分完成";
  }

  return "决策任务已完成";
}

const publicTaskStateSummaries = {
  CREATED: "决策任务已创建",
  UNDERSTANDING: "正在理解需求",
  PLANNING: "正在规划决策步骤",
  RESEARCHING: "正在收集候选与证据",
  VERIFYING: "正在核验候选与证据",
  GAP_RESEARCH: "正在补充证据缺口",
  COMPARING: "正在比较可行候选",
  CRITIQUING: "正在检查风险与反例",
  GENERATING: "正在生成可审查决策",
  PAUSED_USER: "等待用户补充信息",
  PAUSED_PERMISSION: "等待必要权限",
  PAUSED_SOURCE_LOGIN: "等待数据源登录",
  PAUSED_LIMIT: "因资源限制暂停",
  COMPLETED: "决策任务已完成",
  FAILED: "决策任务执行失败",
  CANCELLED: "决策任务已取消"
} satisfies Readonly<Record<DecisionTaskStateV1, string>>;

async function insertRunEvent(
  client: PoolClient,
  event: RunEventV1,
  persistedAt: Date
): Promise<void> {
  const inserted = await client.query<{ cursor: string }>(
    `INSERT INTO decision_task_run_events (
       event_id,
       decision_task_id,
       agent_run_id,
       run_sequence,
       event_payload,
       occurred_at,
       persisted_at
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     RETURNING cursor::text`,
    [
      event.eventId,
      event.decisionTaskId,
      event.agentRunId,
      event.sequence,
      JSON.stringify(event),
      event.occurredAt,
      persistedAt
    ]
  );
  const cursor = inserted.rows[0]?.cursor;

  if (cursor === undefined) {
    throw new PersistenceUnavailableError();
  }

  await client.query(
    `INSERT INTO decision_task_run_event_notifications (
       event_cursor,
       decision_task_id,
       next_attempt_at,
       created_at
     ) VALUES ($1::bigint, $2, $3, $3)`,
    [cursor, event.decisionTaskId, persistedAt]
  );
}

async function loadRunEvents(
  client: PoolClient,
  decisionTaskId: string,
  agentRunId: string
): Promise<readonly RunEventV1[]> {
  const result = await client.query<RunEventRow>(
    `SELECT cursor::text, event_payload
     FROM decision_task_run_events
     WHERE decision_task_id = $1
       AND agent_run_id = $2
     ORDER BY run_sequence ASC`,
    [decisionTaskId, agentRunId]
  );

  return result.rows.map((row) => {
    const decoded = decodePersistedRunEventV1({
      contractType: "persisted-run-event",
      contractVersion: "1.0",
      cursor: row.cursor,
      event: row.event_payload
    });

    if (!decoded.ok) {
      throw new PersistenceUnavailableError();
    }

    return decoded.value.event;
  });
}

async function persistResultRunEvents(
  client: PoolClient,
  row: TaskRow,
  outcome: PersistedDecisionTaskResultV1,
  persistedAt: Date
): Promise<PersistedDecisionTaskResultV1> {
  const existingEvents = await loadRunEvents(
    client,
    row.decision_task_id,
    row.agent_run_id
  );
  const persistedStates = new Set(existingEvents.map((event) => event.taskState));
  const newEvents = outcome.runEvents
    .filter((event) => !persistedStates.has(event.taskState))
    .map((event, index, events): RunEventV1 => ({
      ...event,
      eventId: `event-persistent-${randomUUID()}`,
      decisionTaskId: row.decision_task_id,
      agentRunId: row.agent_run_id,
      sequence: existingEvents.length + index + 1,
      summary: publicTaskStateSummaries[event.taskState],
      occurredAt:
        index === events.length - 1 ? persistedAt.toISOString() : event.occurredAt
    }));
  const runEvents = [...existingEvents, ...newEvents];
  const finalEvent = runEvents.at(-1);

  if (finalEvent === undefined) {
    throw new PersistenceUnavailableError();
  }

  for (const event of newEvents) {
    await insertRunEvent(client, event, persistedAt);
  }

  const canonicalResult = {
    ...outcome,
    taskStatus: {
      ...outcome.taskStatus,
      latestEventSequence: finalEvent.sequence,
      updatedAt: finalEvent.occurredAt
    },
    runEvents
  };

  return decodePersistedResult(canonicalResult, row);
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
