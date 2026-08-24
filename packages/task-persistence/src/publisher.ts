import { createClient } from "@redis/client";
import { Pool, type PoolClient } from "pg";

import { migratePersistentDecisionTasks } from "./migration.js";

export type OutboxPublisherBatchResult = Readonly<{
  attempted: number;
  failed: number;
  published: number;
}>;

export type OutboxPublisher = Readonly<{
  runOnce(): Promise<OutboxPublisherBatchResult>;
  close(): Promise<void>;
}>;

type OutboxPublisherOptions = Readonly<{
  databaseUrl: string;
  redisUrl: string;
  streamName: string;
  retryDelayMs?: number;
  republishDelayMs?: number;
  now?: () => Date;
}>;

type PendingOutboxRow = Readonly<{
  message_id: string;
  operation_id: string;
  payload_type: string;
  payload_version: string;
  payload: unknown;
}>;

export async function openOutboxPublisher(
  options: OutboxPublisherOptions
): Promise<OutboxPublisher> {
  const pool = new Pool({
    connectionString: options.databaseUrl,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    max: 2
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
  const retryDelayMs = options.retryDelayMs ?? 5_000;
  const republishDelayMs = options.republishDelayMs ?? 30_000;
  let closed = false;

  return {
    async runOnce() {
      assertOpen(closed);
      const client = await pool.connect();

      try {
        return await publishNext(
          client,
          options,
          now(),
          retryDelayMs,
          republishDelayMs
        );
      } finally {
        client.release();
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

async function publishNext(
  client: PoolClient,
  options: OutboxPublisherOptions,
  attemptedAt: Date,
  retryDelayMs: number,
  republishDelayMs: number
): Promise<OutboxPublisherBatchResult> {
  await client.query("BEGIN");

  try {
    const pendingResult = await client.query<PendingOutboxRow>(
      `SELECT
         outbox.message_id,
         outbox.operation_id,
         outbox.payload_type,
         outbox.payload_version,
         outbox.payload
       FROM outbox_messages AS outbox
       INNER JOIN agent_run_operations AS operation
         ON operation.operation_id = outbox.operation_id
       WHERE outbox.next_attempt_at <= $1
         AND (
           outbox.published_at IS NULL
           OR operation.state IN ('ACCEPTED', 'FAILED_RETRYABLE')
           OR (
             operation.state = 'RUNNING'
             AND operation.lease_expires_at < $1
           )
         )
       ORDER BY outbox.created_at, outbox.message_id
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [attemptedAt]
    );
    const pending = pendingResult.rows[0];

    if (pending === undefined) {
      await client.query("COMMIT");
      return { attempted: 0, failed: 0, published: 0 };
    }

    const redis = createClient({
      url: options.redisUrl,
      socket: {
        connectTimeout: 500,
        reconnectStrategy: false,
        socketTimeout: 1_000
      }
    });
    redis.on("error", () => undefined);
    await client.query("SAVEPOINT publish_outbox_message");

    try {
      await redis.connect();
      await redis.xAdd(options.streamName, "*", {
        messageId: pending.message_id,
        operationId: pending.operation_id,
        payload: JSON.stringify(pending.payload),
        payloadType: pending.payload_type,
        payloadVersion: pending.payload_version
      });
      await client.query(
        `UPDATE outbox_messages
         SET published_at = $2,
             next_attempt_at = $3
         WHERE message_id = $1`,
        [
          pending.message_id,
          attemptedAt,
          new Date(attemptedAt.getTime() + republishDelayMs)
        ]
      );
      await client.query("RELEASE SAVEPOINT publish_outbox_message");
      await client.query("COMMIT");
      return { attempted: 1, failed: 0, published: 1 };
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT publish_outbox_message");
      await client.query(
        `UPDATE outbox_messages
         SET attempts = attempts + 1,
             next_attempt_at = $2
         WHERE message_id = $1`,
        [pending.message_id, new Date(attemptedAt.getTime() + retryDelayMs)]
      );
      await client.query("COMMIT");
      return { attempted: 1, failed: 1, published: 0 };
    } finally {
      if (redis.isOpen) {
        redis.destroy();
      }
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function assertOpen(closed: boolean): void {
  if (closed) {
    throw new Error("Outbox Publisher 已关闭");
  }
}
