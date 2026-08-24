import { createClient } from "@redis/client";
import { Pool, type PoolClient } from "pg";

import { migratePersistentDecisionTasks } from "./migration.js";

export type RunEventNotificationPublisherBatchResult = Readonly<{
  attempted: number;
  failed: number;
  published: number;
}>;

export type RunEventNotificationPublisher = Readonly<{
  runOnce(): Promise<RunEventNotificationPublisherBatchResult>;
  close(): Promise<void>;
}>;

type RunEventNotificationPublisherOptions = Readonly<{
  databaseUrl: string;
  redisUrl: string;
  channelName: string;
  retryDelayMs?: number;
  now?: () => Date;
}>;

type PendingNotificationRow = Readonly<{
  cursor: string;
  decision_task_id: string;
}>;

export async function openRunEventNotificationPublisher(
  options: RunEventNotificationPublisherOptions
): Promise<RunEventNotificationPublisher> {
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
  let closed = false;

  return {
    async runOnce() {
      assertOpen(closed);
      const client = await pool.connect();

      try {
        return await publishNext(client, options, now(), retryDelayMs);
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
  options: RunEventNotificationPublisherOptions,
  attemptedAt: Date,
  retryDelayMs: number
): Promise<RunEventNotificationPublisherBatchResult> {
  await client.query("BEGIN");

  try {
    const pendingResult = await client.query<PendingNotificationRow>(
      `SELECT event_cursor::text AS cursor, decision_task_id
       FROM decision_task_run_event_notifications
       WHERE published_at IS NULL
         AND next_attempt_at <= $1
       ORDER BY event_cursor
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

    try {
      await redis.connect();
      await redis.publish(
        options.channelName,
        JSON.stringify({
          decisionTaskId: pending.decision_task_id,
          cursor: pending.cursor
        })
      );
      await client.query(
        `UPDATE decision_task_run_event_notifications
         SET published_at = $2
         WHERE event_cursor = $1::bigint`,
        [pending.cursor, attemptedAt]
      );
      await client.query("COMMIT");
      return { attempted: 1, failed: 0, published: 1 };
    } catch {
      await client.query(
        `UPDATE decision_task_run_event_notifications
         SET attempts = attempts + 1,
             next_attempt_at = $2
         WHERE event_cursor = $1::bigint`,
        [pending.cursor, new Date(attemptedAt.getTime() + retryDelayMs)]
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
    throw new Error("RunEvent Notification Publisher 已关闭");
  }
}
