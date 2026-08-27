import { createHash, randomUUID } from "node:crypto";

import {
  canonicalizeJsonV1,
  decodeEffectReceiptV1,
  decodeDecisionTaskResultV1,
  decodeExecuteDecisionTaskCommandV1,
  decodePersistedRunEventV1,
  decodeRuntimePausedOutcomeV1,
  decodeRuntimeSnapshotV1,
  evaluateRuntimeRecoveryPermissionV1,
  type DecisionTaskResultV1,
  type DecisionTaskSnapshotV1,
  type DecisionTaskStateV1,
  type ExecuteDecisionTaskCommandV1,
  type EffectReceiptV1,
  type EffectResultRefV1,
  type PersistedRunEventV1,
  type RawRuntimeSnapshotRefV1,
  type RuntimeSnapshotV1,
  type RuntimeControlErrorV1,
  type RuntimeControlStatusV1 as ContractRuntimeControlStatusV1,
  type RuntimePausedOutcomeV1,
  type RunEventV1
} from "@choicemind/contracts/decision/v1";
import type { EgressRecord, EncryptedCredentialRecord } from "@choicemind/security";
import { createClient } from "@redis/client";
import { Pool, type PoolClient } from "pg";

import { migratePersistentDecisionTasks } from "./migration.js";

export {
  openEvidenceIndexStore,
  type EvidenceIndexRecord,
  type EvidenceIndexStore
} from "./evidence-index.js";

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

export class EffectResultIntegrityError extends Error {
  readonly code = "EFFECT_RESULT_INVALID";

  constructor() {
    super("副作用结果完整性校验失败");
    this.name = "EffectResultIntegrityError";
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
  requestRuntimeResume(
    input: RuntimeResumeRequestInput
  ): Promise<RuntimeControlStatusV1 | undefined>;
  requestRuntimeCancel(
    input: RuntimeCancelRequestInput
  ): Promise<RuntimeControlStatusV1 | undefined>;
  claimNextRuntimeControl(
    workerId: string,
    leaseDurationMs: number
  ): Promise<RuntimeControlRequestClaim>;
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
    outcome: PersistentDecisionTaskOutcome,
    controlRequestId?: string
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
  | RuntimePausedOutcomeV1
  | Readonly<{
      state: "FAILED_RETRYABLE" | "FAILED_FINAL" | "PARTIAL";
      summary: string;
      runtimeControlError?: RuntimeControlErrorV1;
    }>;

export type DecisionTaskClaimResult =
  | Readonly<{
      status: "CLAIMED";
      operationId: string;
      agentRunId: string;
      ownerUserId: string;
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
      operationId: string;
      ownerUserId: string;
    }>
  ): Promise<PersistentDecisionTaskOutcome>;
  executeRuntimeControl?(
    claim: Extract<RuntimeControlRequestClaim, Readonly<{ status: "CLAIMED" }>>
  ): Promise<PersistentDecisionTaskOutcome>;
}>;

type PersistentDecisionTaskModuleOptions = Readonly<{
  databaseUrl: string;
  now?: () => Date;
}>;

export type RuntimeResumeRequestInput = Readonly<{
  controlRequestId: string;
  decisionTaskId: string;
  ownerUserId: string;
  runtimeSnapshotId: string;
  correlationId: string;
  egressConfirmation: Readonly<{ operationId: string; userId: string }>;
}>;

export type RuntimeCancelRequestInput = Readonly<{
  controlRequestId: string;
  decisionTaskId: string;
  ownerUserId: string;
  cancellationId: string;
  correlationId: string;
}>;

export type RuntimeControlStatusV1 = ContractRuntimeControlStatusV1;

export type RuntimeControlRequestClaim =
  | Readonly<{
      status: "CLAIMED";
      controlRequestId: string;
      operationId: string;
      action: "RESUME";
      decisionTaskId: string;
      agentRunId: string;
      ownerUserId: string;
      correlationId: string;
      egressConfirmation: Readonly<{ operationId: string; userId: string }>;
      command: ExecuteDecisionTaskCommandV1;
      snapshot: RuntimeSnapshotV1;
      effectReceipts: readonly EffectReceiptV1[];
    }>
  | Readonly<{ status: "EMPTY" }>;

export type RuntimeRecoveryStore = Readonly<{
  putRawSnapshot(payload: unknown): Promise<RawRuntimeSnapshotRefV1>;
  loadRawSnapshot(reference: RawRuntimeSnapshotRefV1): Promise<unknown | undefined>;
  putEffectResult(identity: EffectResultIdentityV1, payload: unknown): Promise<EffectResultRefV1>;
  loadEffectResult(reference: EffectResultRefV1): Promise<unknown | undefined>;
  saveRecoveryFacts(
    snapshot: RuntimeSnapshotV1,
    effectReceipts: readonly EffectReceiptV1[]
  ): Promise<void>;
  loadRecoveryFacts(snapshotId: string): Promise<
    | Readonly<{
        snapshot: RuntimeSnapshotV1;
        effectReceipts: readonly EffectReceiptV1[];
      }>
    | undefined
  >;
  recordRuntimeRunning(
    agentRunId: string,
    controllerId: string,
    leaseDurationMs: number
  ): Promise<void>;
  claimRuntimeResume(
    agentRunId: string,
    snapshotId: string,
    controllerId: string,
    leaseDurationMs: number
  ): Promise<RuntimeControlClaimResult>;
  completeRuntimeControl(
    agentRunId: string,
    controllerId: string,
    expectedSnapshotId: string | undefined,
    nextSnapshotId: string | undefined,
    state: RuntimeControlState,
    runEvents: readonly RunEventV1[]
  ): Promise<void>;
  claimRuntimeCancel(
    agentRunId: string,
    cancellationId: string,
    runEvents: readonly RunEventV1[]
  ): Promise<RuntimeControlClaimResult>;
  isRuntimeCancelled(agentRunId: string): Promise<boolean>;
  appendEgressRecord(record: EgressRecord): Promise<void>;
  close(): Promise<void>;
}>;

export type EffectResultIdentityV1 = Readonly<{
  decisionTaskId: string;
  agentRunId: string;
  checkpointId: string;
  effectId: string;
}>;

export type RuntimeControlState =
  | "RUNNING"
  | "PAUSED_USER"
  | "PAUSED_PERMISSION"
  | "PAUSED_SOURCE_LOGIN"
  | "PAUSED_LIMIT"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED";

export type RuntimeControlClaimResult = Readonly<{
  status: "ACQUIRED" | "UNCHANGED" | "BUSY" | "DENIED";
  state: RuntimeControlState;
  runEvents: readonly RunEventV1[];
}>;

type RuntimeRecoveryStoreOptions = Readonly<{
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
    | "PARTIAL"
    | "PAUSED_USER"
    | "PAUSED_PERMISSION"
    | "PAUSED_SOURCE_LOGIN"
    | "PAUSED_LIMIT"
    | "CANCELLED";
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
  owner_user_id: string;
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

type RuntimeControlRow = Readonly<{
  snapshot_id: string | null;
  state: RuntimeControlState;
  event_payload: unknown;
  controller_id: string | null;
  lease_expires_at: Date | null;
}>;

type RuntimeControlRequestRow = Readonly<{
  control_request_id: string;
  operation_id: string;
  decision_task_id: string;
  agent_run_id: string;
  owner_user_id: string;
  action: "RESUME" | "CANCEL";
  runtime_snapshot_id: string | null;
  cancellation_id: string | null;
  correlation_id: string;
  confirmation_operation_id: string | null;
  confirmation_user_id: string | null;
  state: RuntimeControlStatusV1["state"];
  result_payload: unknown | null;
  updated_at: Date;
}>;

type RuntimeControlClaimRow = RuntimeControlRequestRow &
  Readonly<{
    command_payload: unknown;
    execution_request_id: string;
    operation_state: TaskRow["state"];
    operation_result_payload: unknown | null;
  }>;

export async function openRuntimeRecoveryStore(
  options: RuntimeRecoveryStoreOptions
): Promise<RuntimeRecoveryStore> {
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
    async putRawSnapshot(payload) {
      assertOpen(closed);
      const canonicalPayload = canonicalizeJsonV1(payload);
      const digest = createHash("sha256").update(canonicalPayload, "utf8").digest("hex");
      const objectKey = `runtime-snapshots/sha256/${digest}`;

      try {
        await pool.query(
          `INSERT INTO runtime_snapshot_objects (
             digest, object_key, snapshot_payload, created_at
           ) VALUES ($1, $2, $3::jsonb, $4)
           ON CONFLICT (digest) DO NOTHING`,
          [digest, objectKey, canonicalPayload, now()]
        );
        const stored = await pool.query<{ object_key: string; snapshot_payload: unknown }>(
          `SELECT object_key, snapshot_payload
           FROM runtime_snapshot_objects
           WHERE digest = $1`,
          [digest]
        );
        const row = stored.rows[0];
        if (
          row === undefined ||
          row.object_key !== objectKey ||
          canonicalizeJsonV1(row.snapshot_payload) !== canonicalPayload
        ) {
          throw new PersistenceUnavailableError();
        }

        return { algorithm: "sha256", digest, objectKey };
      } catch (error) {
        if (error instanceof PersistenceUnavailableError) {
          throw error;
        }
        throw new PersistenceUnavailableError();
      }
    },
    async loadRawSnapshot(reference) {
      assertOpen(closed);
      if (
        reference.algorithm !== "sha256" ||
        !/^[0-9a-f]{64}$/.test(reference.digest) ||
        reference.objectKey !== `runtime-snapshots/sha256/${reference.digest}`
      ) {
        throw new PersistenceUnavailableError();
      }

      try {
        const result = await pool.query<{ snapshot_payload: unknown }>(
          `SELECT snapshot_payload
           FROM runtime_snapshot_objects
           WHERE digest = $1 AND object_key = $2`,
          [reference.digest, reference.objectKey]
        );
        const payload = result.rows[0]?.snapshot_payload;
        if (payload === undefined) {
          return undefined;
        }
        const digest = createHash("sha256")
          .update(canonicalizeJsonV1(payload), "utf8")
          .digest("hex");
        if (digest !== reference.digest) {
          throw new PersistenceUnavailableError();
        }
        return payload;
      } catch (error) {
        if (error instanceof PersistenceUnavailableError) {
          throw error;
        }
        throw new PersistenceUnavailableError();
      }
    },
    async putEffectResult(identity, payload) {
      assertOpen(closed);
      if (
        identity.decisionTaskId.length === 0 ||
        identity.agentRunId.length === 0 ||
        identity.checkpointId.length === 0 ||
        identity.effectId.length === 0
      ) {
        throw new PersistenceUnavailableError();
      }
      const canonicalPayload = canonicalizeJsonV1(payload);
      const digest = createHash("sha256").update(canonicalPayload, "utf8").digest("hex");
      const objectKey = `effect-results/sha256/${digest}`;
      let client: PoolClient | undefined;
      let transactionStarted = false;

      try {
        client = await pool.connect();
        await client.query("BEGIN");
        transactionStarted = true;
        await client.query(
          `INSERT INTO runtime_effect_result_objects (
             digest, object_key, result_payload, created_at
           ) VALUES ($1, $2, $3::jsonb, $4)
           ON CONFLICT (digest) DO NOTHING`,
          [digest, objectKey, canonicalPayload, now()]
        );
        const storedObject = await client.query<{
          object_key: string;
          result_payload: unknown;
        }>(
          `SELECT object_key, result_payload
           FROM runtime_effect_result_objects
           WHERE digest = $1`,
          [digest]
        );
        const object = storedObject.rows[0];
        if (
          object === undefined ||
          object.object_key !== objectKey ||
          canonicalizeJsonV1(object.result_payload) !== canonicalPayload
        ) {
          throw new PersistenceUnavailableError();
        }
        await client.query(
          `INSERT INTO runtime_effect_result_bindings (
             decision_task_id, agent_run_id, checkpoint_id, effect_id,
             digest, object_key, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (decision_task_id, agent_run_id, checkpoint_id, effect_id) DO NOTHING`,
          [
            identity.decisionTaskId,
            identity.agentRunId,
            identity.checkpointId,
            identity.effectId,
            digest,
            objectKey,
            now()
          ]
        );
        const storedBinding = await client.query<{ digest: string; object_key: string }>(
          `SELECT digest, object_key
           FROM runtime_effect_result_bindings
           WHERE decision_task_id = $1
             AND agent_run_id = $2
             AND checkpoint_id = $3
             AND effect_id = $4`,
          [
            identity.decisionTaskId,
            identity.agentRunId,
            identity.checkpointId,
            identity.effectId
          ]
        );
        if (
          storedBinding.rows[0]?.digest !== digest ||
          storedBinding.rows[0]?.object_key !== objectKey
        ) {
          throw new PersistenceUnavailableError();
        }
        await client.query("COMMIT");
        transactionStarted = false;
        return { algorithm: "sha256", digest, objectKey, ...identity };
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
    async loadEffectResult(reference) {
      assertOpen(closed);
      if (
        reference.algorithm !== "sha256" ||
        !/^[0-9a-f]{64}$/.test(reference.digest) ||
        reference.objectKey !== `effect-results/sha256/${reference.digest}`
      ) {
        throw new PersistenceUnavailableError();
      }

      try {
        const result = await pool.query<{ result_payload: unknown }>(
          `SELECT object.result_payload
           FROM runtime_effect_result_bindings AS binding
           INNER JOIN runtime_effect_result_objects AS object
             ON object.digest = binding.digest
            AND object.object_key = binding.object_key
           WHERE binding.decision_task_id = $1
             AND binding.agent_run_id = $2
             AND binding.checkpoint_id = $3
             AND binding.effect_id = $4
             AND binding.digest = $5
             AND binding.object_key = $6`,
          [
            reference.decisionTaskId,
            reference.agentRunId,
            reference.checkpointId,
            reference.effectId,
            reference.digest,
            reference.objectKey
          ]
        );
        const payload = result.rows[0]?.result_payload;
        if (payload === undefined) {
          return undefined;
        }
        const digest = createHash("sha256")
          .update(canonicalizeJsonV1(payload), "utf8")
          .digest("hex");
        if (digest !== reference.digest) {
          throw new EffectResultIntegrityError();
        }
        return payload;
      } catch (error) {
        if (
          error instanceof PersistenceUnavailableError ||
          error instanceof EffectResultIntegrityError
        ) {
          throw error;
        }
        throw new PersistenceUnavailableError();
      }
    },
    async saveRecoveryFacts(snapshot, effectReceipts) {
      assertOpen(closed);
      const decodedSnapshot = decodeRuntimeSnapshotV1(snapshot);
      const decodedReceipts = effectReceipts.map(decodeEffectReceiptV1);
      if (
        !decodedSnapshot.ok ||
        decodedReceipts.some((receipt) => !receipt.ok) ||
        decodedReceipts.some(
          (receipt) =>
            receipt.ok &&
            (receipt.value.decisionTaskId !== snapshot.decisionTaskId ||
              receipt.value.agentRunId !== snapshot.agentRunId ||
              receipt.value.checkpointId !== snapshot.checkpoint.checkpointId)
        )
      ) {
        throw new PersistenceUnavailableError();
      }

      let client: PoolClient | undefined;
      let transactionStarted = false;
      try {
        client = await pool.connect();
        await client.query("BEGIN");
        transactionStarted = true;
        const rawObject = await client.query<{ present: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM runtime_snapshot_objects
             WHERE digest = $1 AND object_key = $2
           ) AS present`,
          [snapshot.rawSnapshot.digest, snapshot.rawSnapshot.objectKey]
        );
        if (!rawObject.rows[0]?.present) {
          throw new PersistenceUnavailableError();
        }
        await client.query(
          `INSERT INTO runtime_recovery_facts (
             snapshot_id, decision_task_id, agent_run_id,
             raw_snapshot_digest, snapshot_payload, created_at
           ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           ON CONFLICT (snapshot_id) DO NOTHING`,
          [
            snapshot.snapshotId,
            snapshot.decisionTaskId,
            snapshot.agentRunId,
            snapshot.rawSnapshot.digest,
            JSON.stringify(snapshot),
            now()
          ]
        );
        const existing = await client.query<{ snapshot_payload: unknown }>(
          `SELECT snapshot_payload FROM runtime_recovery_facts WHERE snapshot_id = $1`,
          [snapshot.snapshotId]
        );
        if (canonicalize(existing.rows[0]?.snapshot_payload) !== canonicalize(snapshot)) {
          throw new PersistenceUnavailableError();
        }
        for (const receipt of effectReceipts) {
          if (receipt.state === "committed") {
            const resultBinding = await client.query<{ present: boolean }>(
              `SELECT EXISTS (
                 SELECT 1
                 FROM runtime_effect_result_bindings
                 WHERE decision_task_id = $1
                   AND agent_run_id = $2
                   AND checkpoint_id = $3
                   AND effect_id = $4
                   AND digest = $5
                   AND object_key = $6
               ) AS present`,
              [
                receipt.result.decisionTaskId,
                receipt.result.agentRunId,
                receipt.result.checkpointId,
                receipt.result.effectId,
                receipt.result.digest,
                receipt.result.objectKey
              ]
            );
            if (!resultBinding.rows[0]?.present) {
              throw new PersistenceUnavailableError();
            }
          }
          await client.query(
            `INSERT INTO runtime_effect_receipts (
               effect_receipt_id, snapshot_id, receipt_payload, created_at
             ) VALUES ($1, $2, $3::jsonb, $4)
             ON CONFLICT (effect_receipt_id) DO NOTHING`,
            [receipt.effectReceiptId, snapshot.snapshotId, JSON.stringify(receipt), now()]
          );
        }
        const storedReceipts = await client.query<{ receipt_payload: unknown }>(
          `SELECT receipt_payload FROM runtime_effect_receipts
           WHERE snapshot_id = $1 ORDER BY effect_receipt_id`,
          [snapshot.snapshotId]
        );
        const expected = [...effectReceipts]
          .sort((left, right) =>
            left.effectReceiptId < right.effectReceiptId
              ? -1
              : left.effectReceiptId > right.effectReceiptId
                ? 1
                : 0
          )
          .map(canonicalize);
        if (!storedReceipts.rows.map((row) => canonicalize(row.receipt_payload)).every(
          (receipt, index) => receipt === expected[index]
        ) || storedReceipts.rows.length !== expected.length) {
          throw new PersistenceUnavailableError();
        }
        await client.query(
          `INSERT INTO runtime_control_states (
             agent_run_id, snapshot_id, state, event_payload, updated_at
           ) VALUES ($1, $2, $3, '[]'::jsonb, $4)
           ON CONFLICT (agent_run_id) DO UPDATE
           SET snapshot_id = EXCLUDED.snapshot_id,
               updated_at = EXCLUDED.updated_at
            WHERE runtime_control_states.state = 'RUNNING'
              AND runtime_control_states.snapshot_id IS NULL`,
          [snapshot.agentRunId, snapshot.snapshotId, snapshot.taskState, now()]
        );
        await client.query("COMMIT");
        transactionStarted = false;
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
    async loadRecoveryFacts(snapshotId) {
      assertOpen(closed);
      try {
        const snapshotResult = await pool.query<{ snapshot_payload: unknown }>(
          `SELECT snapshot_payload FROM runtime_recovery_facts WHERE snapshot_id = $1`,
          [snapshotId]
        );
        const payload = snapshotResult.rows[0]?.snapshot_payload;
        if (payload === undefined) {
          return undefined;
        }
        const decodedSnapshot = decodeRuntimeSnapshotV1(payload);
        if (!decodedSnapshot.ok) {
          throw new PersistenceUnavailableError();
        }
        const receiptResult = await pool.query<{ receipt_payload: unknown }>(
          `SELECT receipt_payload FROM runtime_effect_receipts
           WHERE snapshot_id = $1 ORDER BY effect_receipt_id`,
          [snapshotId]
        );
        const receipts = receiptResult.rows.map((row) => decodeEffectReceiptV1(row.receipt_payload));
        if (receipts.some((receipt) => !receipt.ok)) {
          throw new PersistenceUnavailableError();
        }
        return {
          snapshot: decodedSnapshot.value,
          effectReceipts: receipts.flatMap((receipt) => (receipt.ok ? [receipt.value] : []))
        };
      } catch (error) {
        if (error instanceof PersistenceUnavailableError) {
          throw error;
        }
        throw new PersistenceUnavailableError();
      }
    },
    async recordRuntimeRunning(agentRunId, controllerId, leaseDurationMs) {
      assertOpen(closed);
      try {
        const updatedAt = now();
        const result = await pool.query(
          `INSERT INTO runtime_control_states (
             agent_run_id, snapshot_id, state, event_payload,
             controller_id, lease_expires_at, updated_at
           ) VALUES ($1, NULL, 'RUNNING', '[]'::jsonb, $2, $3, $4)
           ON CONFLICT (agent_run_id) DO UPDATE
           SET controller_id = EXCLUDED.controller_id,
               lease_expires_at = EXCLUDED.lease_expires_at,
               updated_at = EXCLUDED.updated_at
            WHERE runtime_control_states.state = 'RUNNING'
              AND (
                runtime_control_states.controller_id = EXCLUDED.controller_id
                OR (
                  runtime_control_states.snapshot_id IS NULL
                  AND runtime_control_states.lease_expires_at <= EXCLUDED.updated_at
                )
              )`,
          [
            agentRunId,
            controllerId,
            new Date(updatedAt.getTime() + leaseDurationMs),
            updatedAt
          ]
        );
        if (result.rowCount !== 1) throw new PersistenceUnavailableError();
      } catch {
        throw new PersistenceUnavailableError();
      }
    },
    async claimRuntimeResume(agentRunId, snapshotId, controllerId, leaseDurationMs) {
      assertOpen(closed);
      return updateRuntimeControlState(pool, agentRunId, async (client, row) => {
        const updatedAt = now();
        if (row.snapshot_id !== snapshotId) {
          return { status: "DENIED", state: row.state, runEvents: decodeControlEvents(row) };
        }
        if (row.state === "RUNNING") {
          if (row.controller_id === controllerId) {
            return { status: "UNCHANGED", state: row.state, runEvents: decodeControlEvents(row) };
          }
          if (row.lease_expires_at !== null && row.lease_expires_at > updatedAt) {
            return { status: "BUSY", state: row.state, runEvents: decodeControlEvents(row) };
          }
        } else if (row.state === "COMPLETED") {
          return { status: "UNCHANGED", state: row.state, runEvents: decodeControlEvents(row) };
        }
        if (row.state !== "RUNNING" && !row.state.startsWith("PAUSED_")) {
          return { status: "DENIED", state: row.state, runEvents: decodeControlEvents(row) };
        }
        await client.query(
          `UPDATE runtime_control_states
           SET state = 'RUNNING', event_payload = '[]'::jsonb,
               controller_id = $2, lease_expires_at = $3, updated_at = $4
           WHERE agent_run_id = $1`,
          [
            agentRunId,
            controllerId,
            new Date(updatedAt.getTime() + leaseDurationMs),
            updatedAt
          ]
        );
        return { status: "ACQUIRED", state: "RUNNING", runEvents: [] };
      });
    },
    async completeRuntimeControl(
      agentRunId,
      controllerId,
      expectedSnapshotId,
      nextSnapshotId,
      state,
      runEvents
    ) {
      assertOpen(closed);
      try {
        const result = await pool.query(
          `UPDATE runtime_control_states
           SET snapshot_id = $3,
               state = $4,
               event_payload = $5::jsonb,
               controller_id = NULL,
               lease_expires_at = NULL,
               updated_at = $6
            WHERE agent_run_id = $1
              AND snapshot_id IS NOT DISTINCT FROM $2
              AND state = 'RUNNING'
              AND controller_id = $7`,
          [
            agentRunId,
            expectedSnapshotId ?? null,
            nextSnapshotId ?? null,
            state,
            JSON.stringify(runEvents),
            now(),
            controllerId
          ]
        );
        if (result.rowCount !== 1) {
          const existing = await pool.query<RuntimeControlRow>(
            `SELECT snapshot_id, state, event_payload, controller_id, lease_expires_at
             FROM runtime_control_states WHERE agent_run_id = $1`,
            [agentRunId]
          );
          const row = existing.rows[0];
          if (
            row === undefined ||
            row.snapshot_id !== (nextSnapshotId ?? null) ||
            row.state !== state ||
            canonicalizeJsonV1(row.event_payload) !== canonicalizeJsonV1(runEvents)
          ) {
            throw new PersistenceUnavailableError();
          }
        }
      } catch (error) {
        if (error instanceof PersistenceUnavailableError) throw error;
        throw new PersistenceUnavailableError();
      }
    },
    async claimRuntimeCancel(agentRunId, cancellationId, runEvents) {
      assertOpen(closed);
      return updateRuntimeControlState(pool, agentRunId, async (client, row) => {
        if (row.state === "CANCELLED") {
          return { status: "UNCHANGED", state: row.state, runEvents: decodeControlEvents(row) };
        }
        if (row.state === "COMPLETED" || row.state === "FAILED") {
          return { status: "DENIED", state: row.state, runEvents: decodeControlEvents(row) };
        }
        await client.query(
          `UPDATE runtime_control_states
           SET state = 'CANCELLED', cancellation_id = $2,
               event_payload = $3::jsonb, controller_id = NULL,
               lease_expires_at = NULL, updated_at = $4
           WHERE agent_run_id = $1`,
          [agentRunId, cancellationId, JSON.stringify(runEvents), now()]
        );
        return { status: "ACQUIRED", state: "CANCELLED", runEvents };
      });
    },
    async isRuntimeCancelled(agentRunId) {
      assertOpen(closed);
      try {
        const result = await pool.query<{ cancelled: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM runtime_control_states
             WHERE agent_run_id = $1 AND state = 'CANCELLED'
           ) AS cancelled`,
          [agentRunId]
        );
        return result.rows[0]?.cancelled ?? false;
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
            new Date(record.occurredAt)
          ]
        );
      } catch {
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

export class RuntimeControlRejectedError extends Error {
  readonly code = "RUNTIME_RESUME_DENIED";

  constructor() {
    super("Runtime 当前状态或权威快照不允许恢复");
    this.name = "RuntimeControlRejectedError";
  }
}

export class RuntimeCancelRejectedError extends Error {
  readonly code = "RUNTIME_CANCEL_RACE";

  constructor() {
    super("Runtime 已进入不可取消终态");
    this.name = "RuntimeCancelRejectedError";
  }
}

async function updateRuntimeControlState(
  pool: Pool,
  agentRunId: string,
  update: (
    client: PoolClient,
    row: RuntimeControlRow
  ) => Promise<RuntimeControlClaimResult>
): Promise<RuntimeControlClaimResult> {
  let client: PoolClient | undefined;
  let transactionStarted = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;
    const result = await client.query<RuntimeControlRow>(
      `SELECT snapshot_id, state, event_payload, controller_id, lease_expires_at
       FROM runtime_control_states WHERE agent_run_id = $1 FOR UPDATE`,
      [agentRunId]
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new PersistenceUnavailableError();
    }
    const outcome = await update(client, row);
    await client.query("COMMIT");
    transactionStarted = false;
    return outcome;
  } catch (error) {
    if (transactionStarted && client !== undefined) {
      await client.query("ROLLBACK");
    }
    if (error instanceof PersistenceUnavailableError) throw error;
    throw new PersistenceUnavailableError();
  } finally {
    client?.release();
  }
}

function decodeControlEvents(row: RuntimeControlRow): readonly RunEventV1[] {
  if (!Array.isArray(row.event_payload)) {
    throw new PersistenceUnavailableError();
  }
  return row.event_payload as RunEventV1[];
}

function toRuntimeControlStatus(row: RuntimeControlRequestRow): RuntimeControlStatusV1 {
  const error = row.state === "FAILED" ? decodeRuntimeControlError(row.result_payload) : undefined;
  if (row.state === "FAILED" && error === undefined) {
    throw new PersistenceUnavailableError();
  }
  return {
    contractType: "runtime-control-status",
    contractVersion: "1.0",
    controlRequestId: row.control_request_id,
    decisionTaskId: row.decision_task_id,
    agentRunId: row.agent_run_id,
    action: row.action,
    state: row.state,
    ...(error === undefined ? {} : { error }),
    updatedAt: row.updated_at.toISOString()
  };
}

function decodeRuntimeControlError(input: unknown): RuntimeControlErrorV1 | undefined {
  if (!isUnknownRecord(input) || !isUnknownRecord(input.error)) return undefined;
  const code = input.error.code;
  const message = input.error.message;
  if (
    typeof message !== "string" ||
    message.trim().length === 0 ||
    ![
      "RUNTIME_SNAPSHOT_INVALID",
      "RUNTIME_PROTOCOL_UNSUPPORTED",
      "RUNTIME_RESUME_DENIED",
      "RUNTIME_RESUME_IN_PROGRESS",
      "RUNTIME_FAILED",
      "RUNTIME_CANCEL_RACE",
      "PERSISTENCE_UNAVAILABLE",
      "RUNTIME_RESULT_UNAVAILABLE"
    ].includes(String(code))
  ) {
    return undefined;
  }
  return { code: code as RuntimeControlErrorV1["code"], message };
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runtimeControlErrorFromOutcome(
  outcome: PersistentDecisionTaskOutcome
): RuntimeControlErrorV1 | undefined {
  if (isRuntimePausedOutcome(outcome)) {
    return { code: "RUNTIME_RESUME_DENIED", message: outcome.summary };
  }
  if ("runtimeControlError" in outcome && outcome.runtimeControlError !== undefined) {
    return outcome.runtimeControlError;
  }
  if (
    "state" in outcome &&
    (outcome.state === "FAILED_RETRYABLE" || outcome.state === "FAILED_FINAL")
  ) {
    return { code: "RUNTIME_FAILED", message: outcome.summary };
  }
  return undefined;
}

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
    async requestRuntimeResume(input) {
      assertOpen(closed);
      if (
        input.egressConfirmation.operationId !== input.controlRequestId ||
        input.egressConfirmation.userId !== input.ownerUserId
      ) {
        throw new RuntimeControlRejectedError();
      }
      const requestedAt = now();
      let client: PoolClient | undefined;
      let transactionStarted = false;
      try {
        client = await pool.connect();
        await client.query("BEGIN");
        transactionStarted = true;
        const operationResult = await client.query<TaskRow & { operation_id: string }>(
          `SELECT
             operation.operation_id,
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
           LIMIT 1
           FOR UPDATE OF operation`,
          [input.decisionTaskId, input.ownerUserId]
        );
        const operation = operationResult.rows[0];
        if (operation === undefined) {
          await client.query("COMMIT");
          transactionStarted = false;
          return undefined;
        }
        const existingControlResult = await client.query<RuntimeControlRequestRow>(
          `SELECT control_request_id, operation_id::text, decision_task_id,
                  agent_run_id, owner_user_id, action, runtime_snapshot_id,
                  cancellation_id, correlation_id, confirmation_operation_id,
                  confirmation_user_id, state, result_payload, updated_at
           FROM runtime_control_requests
           WHERE control_request_id = $1
           FOR UPDATE`,
          [input.controlRequestId]
        );
        const existingControl = existingControlResult.rows[0];
        if (existingControl !== undefined) {
          if (
            existingControl.operation_id !== operation.operation_id ||
            existingControl.decision_task_id !== input.decisionTaskId ||
            existingControl.agent_run_id !== operation.agent_run_id ||
            existingControl.owner_user_id !== input.ownerUserId ||
            existingControl.action !== "RESUME" ||
            existingControl.runtime_snapshot_id !== input.runtimeSnapshotId ||
            existingControl.correlation_id !== input.correlationId ||
            existingControl.confirmation_operation_id !==
              input.egressConfirmation.operationId ||
            existingControl.confirmation_user_id !== input.egressConfirmation.userId
          ) {
            throw new IdempotencyConflictError(input.controlRequestId);
          }
          await client.query("COMMIT");
          transactionStarted = false;
          return toRuntimeControlStatus(existingControl);
        }
        const snapshot = toTaskSnapshot(operation);
        if (
          !operation.state.startsWith("PAUSED_") ||
          !("runtimeSnapshotId" in snapshot) ||
          snapshot.runtimeSnapshotId !== input.runtimeSnapshotId
        ) {
          throw new RuntimeControlRejectedError();
        }
        await client.query(
          `INSERT INTO runtime_control_requests (
             control_request_id, operation_id, decision_task_id, agent_run_id,
             owner_user_id, action, runtime_snapshot_id, cancellation_id,
             correlation_id, confirmation_operation_id, confirmation_user_id,
             state, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, 'RESUME', $6, NULL,
             $7, $8, $9, 'ACCEPTED', $10, $10
           )
           ON CONFLICT (control_request_id) DO NOTHING`,
          [
            input.controlRequestId,
            operation.operation_id,
            input.decisionTaskId,
            operation.agent_run_id,
            input.ownerUserId,
            input.runtimeSnapshotId,
            input.correlationId,
            input.egressConfirmation.operationId,
            input.egressConfirmation.userId,
            requestedAt
          ]
        );
        const storedResult = await client.query<RuntimeControlRequestRow>(
          `SELECT control_request_id, operation_id::text, decision_task_id,
                  agent_run_id, owner_user_id, action, runtime_snapshot_id,
                  cancellation_id, correlation_id, confirmation_operation_id,
                  confirmation_user_id, state, result_payload, updated_at
           FROM runtime_control_requests
           WHERE control_request_id = $1`,
          [input.controlRequestId]
        );
        const stored = storedResult.rows[0];
        if (
          stored === undefined ||
          stored.operation_id !== operation.operation_id ||
          stored.decision_task_id !== input.decisionTaskId ||
          stored.agent_run_id !== operation.agent_run_id ||
          stored.owner_user_id !== input.ownerUserId ||
          stored.action !== "RESUME" ||
          stored.runtime_snapshot_id !== input.runtimeSnapshotId ||
          stored.correlation_id !== input.correlationId ||
          stored.confirmation_operation_id !== input.egressConfirmation.operationId ||
          stored.confirmation_user_id !== input.egressConfirmation.userId
        ) {
          throw new IdempotencyConflictError(input.controlRequestId);
        }
        await client.query("COMMIT");
        transactionStarted = false;
        return toRuntimeControlStatus(stored);
      } catch (error) {
        if (transactionStarted && client !== undefined) {
          await client.query("ROLLBACK");
        }
        if (
          error instanceof RuntimeControlRejectedError ||
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
    async requestRuntimeCancel(input) {
      assertOpen(closed);
      const cancelledAt = now();
      let client: PoolClient | undefined;
      let transactionStarted = false;
      try {
        client = await pool.connect();
        await client.query("BEGIN");
        transactionStarted = true;
        const operationResult = await client.query<TaskRow & { operation_id: string }>(
          `SELECT
             operation.operation_id, submission.execution_request_id,
             operation.decision_task_id, operation.agent_run_id,
             operation.state, operation.updated_at, operation.result_payload
           FROM agent_run_operations AS operation
           INNER JOIN decision_task_submissions AS submission
             ON submission.execution_request_id = operation.execution_request_id
           WHERE operation.decision_task_id = $1
             AND submission.owner_user_id = $2
           ORDER BY operation.created_at DESC
           LIMIT 1
           FOR UPDATE OF operation`,
          [input.decisionTaskId, input.ownerUserId]
        );
        const operation = operationResult.rows[0];
        if (operation === undefined) {
          await client.query("COMMIT");
          transactionStarted = false;
          return undefined;
        }
        const existingResult = await client.query<RuntimeControlRequestRow>(
          `SELECT control_request_id, operation_id::text, decision_task_id,
                  agent_run_id, owner_user_id, action, runtime_snapshot_id,
                  cancellation_id, correlation_id, confirmation_operation_id,
                  confirmation_user_id, state, result_payload, updated_at
           FROM runtime_control_requests
           WHERE control_request_id = $1
           FOR UPDATE`,
          [input.controlRequestId]
        );
        const existing = existingResult.rows[0];
        if (existing !== undefined) {
          if (
            existing.operation_id !== operation.operation_id ||
            existing.decision_task_id !== input.decisionTaskId ||
            existing.agent_run_id !== operation.agent_run_id ||
            existing.owner_user_id !== input.ownerUserId ||
            existing.action !== "CANCEL" ||
            existing.cancellation_id !== input.cancellationId ||
            existing.correlation_id !== input.correlationId
          ) {
            throw new IdempotencyConflictError(input.controlRequestId);
          }
          await client.query("COMMIT");
          transactionStarted = false;
          return toRuntimeControlStatus(existing);
        }
        if (
          operation.state === "COMPLETED" ||
          operation.state === "FAILED_FINAL" ||
          operation.state === "CANCELLED"
        ) {
          throw new RuntimeCancelRejectedError();
        }
        const existingEvents = await loadRunEvents(
          client,
          operation.decision_task_id,
          operation.agent_run_id
        );
        const cancelEvent: RunEventV1 = {
          contractType: "run-event",
          contractVersion: "1.0",
          eventId: `event-persistent-${randomUUID()}`,
          decisionTaskId: operation.decision_task_id,
          agentRunId: operation.agent_run_id,
          sequence: existingEvents.length + 1,
          occurredAt: cancelledAt.toISOString(),
          eventType: "TASK_STATE_CHANGED",
          taskState: "CANCELLED",
          summary: "决策任务已取消",
          synthetic: true
        };
        await client.query(
          `INSERT INTO runtime_control_requests (
             control_request_id, operation_id, decision_task_id, agent_run_id,
             owner_user_id, action, runtime_snapshot_id, cancellation_id,
             correlation_id, confirmation_operation_id, confirmation_user_id,
             state, result_payload, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, 'CANCEL', NULL, $6,
             $7, NULL, NULL, 'COMPLETED', $8::jsonb, $9, $9
           )`,
          [
            input.controlRequestId,
            operation.operation_id,
            input.decisionTaskId,
            operation.agent_run_id,
            input.ownerUserId,
            input.cancellationId,
            input.correlationId,
            JSON.stringify({ state: "CANCELLED" }),
            cancelledAt
          ]
        );
        await client.query(
          `INSERT INTO runtime_control_states (
             agent_run_id, snapshot_id, state, cancellation_id,
             event_payload, controller_id, lease_expires_at, updated_at
           ) VALUES ($1, NULL, 'CANCELLED', $2, $3::jsonb, NULL, NULL, $4)
           ON CONFLICT (agent_run_id) DO UPDATE
           SET state = 'CANCELLED', cancellation_id = EXCLUDED.cancellation_id,
               event_payload = EXCLUDED.event_payload, controller_id = NULL,
               lease_expires_at = NULL, updated_at = EXCLUDED.updated_at`,
          [
            operation.agent_run_id,
            input.cancellationId,
            JSON.stringify([cancelEvent]),
            cancelledAt
          ]
        );
        await client.query(
          `UPDATE agent_run_operations
           SET state = 'CANCELLED', result_payload = $2::jsonb,
               worker_id = NULL, lease_expires_at = NULL, updated_at = $3
           WHERE operation_id = $1`,
          [operation.operation_id, JSON.stringify({ state: "CANCELLED" }), cancelledAt]
        );
        await insertRunEvent(client, cancelEvent, cancelledAt);
        await client.query("COMMIT");
        transactionStarted = false;
        return {
          contractType: "runtime-control-status",
          contractVersion: "1.0",
          controlRequestId: input.controlRequestId,
          decisionTaskId: input.decisionTaskId,
          agentRunId: operation.agent_run_id,
          action: "CANCEL",
          state: "COMPLETED",
          updatedAt: cancelledAt.toISOString()
        };
      } catch (error) {
        if (transactionStarted && client !== undefined) await client.query("ROLLBACK");
        if (
          error instanceof RuntimeCancelRejectedError ||
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
    async claimNextRuntimeControl(workerId, leaseDurationMs) {
      assertOpen(closed);
      const claimedAt = now();
      let client: PoolClient | undefined;
      let transactionStarted = false;
      try {
        client = await pool.connect();
        await client.query("BEGIN");
        transactionStarted = true;
        const claimResult = await client.query<RuntimeControlClaimRow>(
          `SELECT
             request.control_request_id,
             request.operation_id::text,
             request.decision_task_id,
             request.agent_run_id,
             request.owner_user_id,
             request.action,
             request.runtime_snapshot_id,
             request.cancellation_id,
             request.correlation_id,
             request.confirmation_operation_id,
             request.confirmation_user_id,
             request.state,
             request.result_payload,
             request.updated_at,
             submission.command_payload,
             submission.execution_request_id,
             operation.state AS operation_state,
             operation.result_payload AS operation_result_payload
           FROM runtime_control_requests AS request
           INNER JOIN agent_run_operations AS operation
             ON operation.operation_id = request.operation_id
           INNER JOIN decision_task_submissions AS submission
             ON submission.execution_request_id = operation.execution_request_id
           WHERE request.action = 'RESUME'
             AND (
               request.state = 'ACCEPTED'
               OR (
                 request.state = 'RUNNING'
                 AND request.lease_expires_at < $1
               )
             )
           ORDER BY request.created_at, request.control_request_id
           LIMIT 1
           FOR UPDATE OF request, operation SKIP LOCKED`,
          [claimedAt]
        );
        const row = claimResult.rows[0];
        if (row === undefined) {
          await client.query("COMMIT");
          transactionStarted = false;
          return { status: "EMPTY" };
        }
        const decodedCommand = decodeExecuteDecisionTaskCommandV1(row.command_payload);
        const paused = decodeRuntimePausedOutcomeV1(row.operation_result_payload);
        const reclaimingExpiredRequest = row.state === "RUNNING";
        const operationCanBeClaimed = reclaimingExpiredRequest
          ? row.operation_state === "RUNNING"
          : row.operation_state.startsWith("PAUSED_");
        if (
          !decodedCommand.ok ||
          !paused.ok ||
          !operationCanBeClaimed ||
          paused.value.snapshot.snapshotId !== row.runtime_snapshot_id ||
          paused.value.snapshot.agentRunId !== row.agent_run_id ||
          paused.value.snapshot.decisionTaskId !== row.decision_task_id ||
          row.confirmation_operation_id !== row.control_request_id ||
          row.confirmation_user_id !== row.owner_user_id
        ) {
          await client.query(
            `UPDATE runtime_control_requests
             SET state = 'FAILED', worker_id = NULL, lease_expires_at = NULL,
                 result_payload = $3::jsonb, updated_at = $2
             WHERE control_request_id = $1`,
            [
              row.control_request_id,
              claimedAt,
              JSON.stringify({
                error: {
                  code: "RUNTIME_SNAPSHOT_INVALID",
                  message: "恢复请求与权威任务状态不一致"
                }
              })
            ]
          );
          await client.query("COMMIT");
          transactionStarted = false;
          return { status: "EMPTY" };
        }
        const storedFacts = await client.query<{
          snapshot_payload: unknown;
        }>(
          `SELECT snapshot_payload
           FROM runtime_recovery_facts
           WHERE snapshot_id = $1`,
          [row.runtime_snapshot_id]
        );
        const decodedSnapshot = decodeRuntimeSnapshotV1(
          storedFacts.rows[0]?.snapshot_payload
        );
        const storedReceipts = await client.query<{ receipt_payload: unknown }>(
          `SELECT receipt_payload
           FROM runtime_effect_receipts
           WHERE snapshot_id = $1
           ORDER BY effect_receipt_id`,
          [row.runtime_snapshot_id]
        );
        const decodedReceipts = storedReceipts.rows.map((receipt) =>
          decodeEffectReceiptV1(receipt.receipt_payload)
        );
        if (!decodedSnapshot.ok || decodedReceipts.some((receipt) => !receipt.ok)) {
          await client.query(
            `UPDATE runtime_control_requests
             SET state = 'FAILED', worker_id = NULL, lease_expires_at = NULL,
                 result_payload = $3::jsonb, updated_at = $2
             WHERE control_request_id = $1`,
            [
              row.control_request_id,
              claimedAt,
              JSON.stringify({
                error: {
                  code: "PERSISTENCE_UNAVAILABLE",
                  message: "权威 Runtime 恢复事实不可用"
                }
              })
            ]
          );
          await client.query("COMMIT");
          transactionStarted = false;
          return { status: "EMPTY" };
        }
        const effectReceipts = decodedReceipts.flatMap((receipt) =>
          receipt.ok ? [receipt.value] : []
        );
        const recoveryPermission = evaluateRuntimeRecoveryPermissionV1({
          snapshot: decodedSnapshot.value,
          effectReceipts
        });
        if (recoveryPermission.decision !== "RESUME_ALLOWED") {
          await client.query(
            `UPDATE runtime_control_requests
             SET state = 'FAILED', worker_id = NULL,
                 lease_expires_at = NULL, result_payload = $3::jsonb,
                 updated_at = $2
             WHERE control_request_id = $1`,
            [
              row.control_request_id,
              claimedAt,
              JSON.stringify({
                error: {
                  code: "RUNTIME_RESUME_DENIED",
                  message:
                    recoveryPermission.decision === "MANUAL_VERIFICATION_REQUIRED"
                      ? "副作用状态需要人工核验"
                      : "Runtime 快照不允许原位恢复"
                }
              })
            ]
          );
          if (recoveryPermission.decision === "MANUAL_VERIFICATION_REQUIRED") {
            const existingEvents = await loadRunEvents(
              client,
              row.decision_task_id,
              row.agent_run_id
            );
            const manualVerificationEvent: RunEventV1 = {
              contractType: "run-event",
              contractVersion: "1.0",
              eventId: `event-persistent-${randomUUID()}`,
              decisionTaskId: row.decision_task_id,
              agentRunId: row.agent_run_id,
              sequence: existingEvents.length + 1,
              occurredAt: claimedAt.toISOString(),
              eventType: "TASK_STATE_CHANGED",
              taskState: decodedSnapshot.value.taskState,
              summary: "副作用状态需要人工核验",
              synthetic: true
            };
            await insertRunEvent(client, manualVerificationEvent, claimedAt);
          }
          await client.query("COMMIT");
          transactionStarted = false;
          return { status: "EMPTY" };
        }
        const leaseExpiresAt = new Date(claimedAt.getTime() + leaseDurationMs);
        await client.query(
          `UPDATE runtime_control_requests
           SET state = 'RUNNING', worker_id = $2,
               lease_expires_at = $3, updated_at = $4
           WHERE control_request_id = $1`,
          [row.control_request_id, workerId, leaseExpiresAt, claimedAt]
        );
        await client.query(
          `UPDATE agent_run_operations
           SET state = 'RUNNING', worker_id = $2,
               lease_expires_at = $3, updated_at = $4
           WHERE operation_id = $1`,
          [row.operation_id, workerId, leaseExpiresAt, claimedAt]
        );
        if (!reclaimingExpiredRequest) {
          const existingEvents = await loadRunEvents(
            client,
            row.decision_task_id,
            row.agent_run_id
          );
          const runningEvent: RunEventV1 = {
            contractType: "run-event",
            contractVersion: "1.0",
            eventId: `event-persistent-${randomUUID()}`,
            decisionTaskId: row.decision_task_id,
            agentRunId: row.agent_run_id,
            sequence: existingEvents.length + 1,
            occurredAt: claimedAt.toISOString(),
            eventType: "TASK_STATE_CHANGED",
            taskState: "UNDERSTANDING",
            summary: "决策任务正在安全恢复",
            synthetic: true
          };
          await insertRunEvent(client, runningEvent, claimedAt);
        }
        await client.query("COMMIT");
        transactionStarted = false;
        return {
          status: "CLAIMED",
          controlRequestId: row.control_request_id,
          operationId: row.operation_id,
          action: "RESUME",
          decisionTaskId: row.decision_task_id,
          agentRunId: row.agent_run_id,
          ownerUserId: row.owner_user_id,
          correlationId: row.correlation_id,
          egressConfirmation: {
            operationId: row.confirmation_operation_id,
            userId: row.confirmation_user_id
          },
          command: decodedCommand.value,
          snapshot: decodedSnapshot.value,
          effectReceipts
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
             submission.command_payload,
             submission.owner_user_id
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
            row.state === "PARTIAL" ||
            row.state === "CANCELLED"
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
          ownerUserId: row.owner_user_id,
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
    async complete(operationId, workerId, outcome, controlRequestId) {
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

        if (isRuntimePausedOutcome(decodedOutcome.payload)) {
          const persistedPaused = await persistPausedRunEvents(
            client,
            row,
            decodedOutcome.payload,
            completedAt
          );
          const pausedAt = persistedPaused.runEvents.at(-1)?.occurredAt;
          if (pausedAt === undefined) {
            throw new PersistenceUnavailableError();
          }
          await client.query(
            `UPDATE agent_run_operations
             SET result_payload = $2::jsonb,
                 updated_at = $3
             WHERE operation_id = $1`,
            [operationId, JSON.stringify(persistedPaused), pausedAt]
          );
          completion = {
            status: "COMMITTED",
            snapshot: toTaskSnapshot({
              ...row,
              result_payload: persistedPaused,
              updated_at: new Date(pausedAt)
            })
          };
        } else if ("runEvents" in decodedOutcome.payload) {
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

        if (controlRequestId !== undefined) {
          const controlError = runtimeControlErrorFromOutcome(decodedOutcome.payload);
          const controlCompletion = await client.query(
            `UPDATE runtime_control_requests
             SET state = $5, worker_id = NULL,
                 lease_expires_at = NULL, result_payload = $6::jsonb,
                 updated_at = $4
             WHERE control_request_id = $1
               AND operation_id = $2
               AND worker_id = $3
               AND state = 'RUNNING'`,
            [
              controlRequestId,
              operationId,
              workerId,
              completedAt,
              controlError === undefined ? "COMPLETED" : "FAILED",
              controlError === undefined ? null : JSON.stringify({ error: controlError })
            ]
          );
          if (controlCompletion.rowCount !== 1) {
            await client.query("ROLLBACK");
            transactionStarted = false;
            return { status: "NOT_COMPLETABLE" };
          }
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
      if (options.executeRuntimeControl !== undefined) {
        const controlClaim = await persistence.claimNextRuntimeControl(
          options.workerId,
          leaseDurationMs
        );
        if (controlClaim.status === "CLAIMED") {
          const controlOutcome = await options.executeRuntimeControl(controlClaim);
          await persistence.complete(
            controlClaim.operationId,
            options.workerId,
            controlOutcome,
            controlClaim.controlRequestId
          );
          return { acknowledged: 0, executed: 1, received: 0 };
        }
      }
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
        agentRunId: claim.agentRunId,
        operationId: claim.operationId,
        ownerUserId: claim.ownerUserId
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
    row.state === "PAUSED_USER" ||
    row.state === "PAUSED_PERMISSION" ||
    row.state === "PAUSED_SOURCE_LOGIN" ||
    row.state === "PAUSED_LIMIT"
  ) {
    const paused = decodeRuntimePausedOutcomeV1(row.result_payload);
    if (
      !paused.ok ||
      paused.value.state !== row.state ||
      paused.value.snapshot.decisionTaskId !== row.decision_task_id ||
      paused.value.snapshot.agentRunId !== row.agent_run_id
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
      terminal: false,
      runtimeSnapshotId: paused.value.snapshot.snapshotId,
      updatedAt: row.updated_at.toISOString()
    };
  }

  if (
    row.state !== "ACCEPTED" &&
    row.state !== "RUNNING" &&
    row.state !== "FAILED_RETRYABLE" &&
    row.state !== "FAILED_FINAL" &&
    row.state !== "PARTIAL" &&
    row.state !== "CANCELLED"
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
    terminal: row.state === "FAILED_FINAL" || row.state === "CANCELLED",
    updatedAt: row.updated_at.toISOString()
  } as DecisionTaskSnapshotV1;
}

function decodePersistentOutcome(outcome: PersistentDecisionTaskOutcome): Readonly<{
  state:
    | "COMPLETED"
    | "FAILED_RETRYABLE"
    | "FAILED_FINAL"
    | "PARTIAL"
    | "PAUSED_USER"
    | "PAUSED_PERMISSION"
    | "PAUSED_SOURCE_LOGIN"
    | "PAUSED_LIMIT";
  payload: PersistentDecisionTaskOutcome;
  agentRunId: string | null;
  decisionTaskId: string | null;
}> {
  const paused = decodeRuntimePausedOutcomeV1(outcome);
  if (paused.ok) {
    return {
      state: paused.value.state,
      payload: paused.value,
      agentRunId: paused.value.snapshot.agentRunId,
      decisionTaskId: paused.value.snapshot.decisionTaskId
    };
  }

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

function isRuntimePausedOutcome(
  outcome: PersistentDecisionTaskOutcome
): outcome is RuntimePausedOutcomeV1 {
  return decodeRuntimePausedOutcomeV1(outcome).ok;
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
  const recoveredFromPause = existingEvents.some(
    (event) =>
      event.taskState === "PAUSED_USER" ||
      event.taskState === "PAUSED_PERMISSION" ||
      event.taskState === "PAUSED_SOURCE_LOGIN" ||
      event.taskState === "PAUSED_LIMIT"
  );
  const eventsToPersist = recoveredFromPause
    ? outcome.runEvents.filter((event) => event.taskState === "COMPLETED")
    : outcome.runEvents;
  const newEvents = eventsToPersist
    .filter((event) => !persistedStates.has(event.taskState))
    .map((event, index, events): RunEventV1 => ({
      ...event,
      eventId: `event-persistent-${randomUUID()}`,
      decisionTaskId: row.decision_task_id,
      agentRunId: row.agent_run_id,
      sequence: existingEvents.length + index + 1,
      summary: publicRuntimeEventSummary(event),
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

  const resultRunEvents = recoveredFromPause
    ? outcome.runEvents.map((event, index, events): RunEventV1 => ({
        ...event,
        sequence: index + 1,
        summary: publicRuntimeEventSummary(event),
        occurredAt:
          index === events.length - 1 ? persistedAt.toISOString() : event.occurredAt
      }))
    : runEvents;
  const resultFinalEvent = resultRunEvents.at(-1);
  if (resultFinalEvent === undefined) {
    throw new PersistenceUnavailableError();
  }
  const canonicalResult = {
    ...outcome,
    taskStatus: {
      ...outcome.taskStatus,
      latestEventSequence: resultFinalEvent.sequence,
      updatedAt: resultFinalEvent.occurredAt
    },
    runEvents: resultRunEvents
  };

  return decodePersistedResult(canonicalResult, row);
}

async function persistPausedRunEvents(
  client: PoolClient,
  row: TaskRow,
  outcome: RuntimePausedOutcomeV1,
  persistedAt: Date
): Promise<RuntimePausedOutcomeV1> {
  const existingEvents = await loadRunEvents(
    client,
    row.decision_task_id,
    row.agent_run_id
  );
  const persistedStates = new Set(existingEvents.map((event) => event.taskState));
  let newEvents = outcome.runEvents
    .filter((event) => !persistedStates.has(event.taskState))
    .map((event, index): RunEventV1 => ({
      ...event,
      eventId: `event-persistent-${randomUUID()}`,
      decisionTaskId: row.decision_task_id,
      agentRunId: row.agent_run_id,
      sequence: existingEvents.length + index + 1,
      summary: publicRuntimeEventSummary(event),
      occurredAt: persistedAt.toISOString()
    }));
  const latestPersistedEvent = existingEvents.at(-1);
  const latestPersistedState = latestPersistedEvent?.taskState;
  const latestOutcomeEvent = outcome.runEvents.at(-1);
  if (
    newEvents.length === 0 &&
    latestOutcomeEvent !== undefined &&
    (latestPersistedState !== outcome.state ||
      latestPersistedEvent?.summary !== publicRuntimeEventSummary(latestOutcomeEvent))
  ) {
    newEvents = [
      {
        ...latestOutcomeEvent,
        eventId: `event-persistent-${randomUUID()}`,
        decisionTaskId: row.decision_task_id,
        agentRunId: row.agent_run_id,
        sequence: existingEvents.length + 1,
        taskState: outcome.state,
        summary: publicRuntimeEventSummary(latestOutcomeEvent),
        occurredAt: persistedAt.toISOString()
      }
    ];
  }
  for (const event of newEvents) {
    await insertRunEvent(client, event, persistedAt);
  }

  const canonical = {
    ...outcome,
    runEvents: [...existingEvents, ...newEvents]
  };
  const decoded = decodeRuntimePausedOutcomeV1(canonical);
  if (!decoded.ok) {
    throw new PersistenceUnavailableError();
  }
  return decoded.value;
}

function publicRuntimeEventSummary(event: RunEventV1): string {
  const approvedRuntimeSummaries = new Set([
    "Runtime 已复用权威副作用结果并完成",
    "副作用状态需要人工核验（EFFECT_STATUS_UNSAFE）",
    "已提交副作用的权威结果不可用（EFFECT_RESULT_UNAVAILABLE）",
    "已提交副作用的结果完整性校验失败（EFFECT_RESULT_INVALID）",
    "已提交副作用的结果合同无效（EFFECT_RESULT_INVALID）",
    "恢复事实包含冲突的 Decision 草稿结果（EFFECT_RESULT_INVALID）"
  ]);

  return approvedRuntimeSummaries.has(event.summary)
    ? event.summary
    : publicTaskStateSummaries[event.taskState];
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
