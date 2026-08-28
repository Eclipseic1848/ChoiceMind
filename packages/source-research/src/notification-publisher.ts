import { createClient } from "@redis/client";
import { Pool } from "pg";

export type SourceResearchNotificationPublisher = Readonly<{
  runOnce(): Promise<Readonly<{ published: number }>>;
  close(): Promise<void>;
}>;

export async function openSourceResearchNotificationPublisher(options: Readonly<{
  databaseUrl: string;
  redisUrl: string;
  channelName?: string;
}>): Promise<SourceResearchNotificationPublisher> {
  const pool = new Pool({ connectionString: options.databaseUrl });
  const redis = createClient({ url: options.redisUrl });
  await redis.connect();
  const channelName = options.channelName ?? "choicemind:source-research";

  return {
    async runOnce() {
      const result = await pool.query<{
        outbox_id: string;
        job_id: string;
        event_type: string;
      }>(
        `SELECT outbox_id, job_id, event_type
         FROM source_research_outbox
         WHERE published_at IS NULL
         ORDER BY outbox_id
         LIMIT 100`
      );
      let published = 0;
      for (const row of result.rows) {
        await redis.publish(
          channelName,
          JSON.stringify({
            eventType: row.event_type,
            jobId: row.job_id,
            outboxId: row.outbox_id
          })
        );
        const marked = await pool.query(
          `UPDATE source_research_outbox
           SET published_at = CURRENT_TIMESTAMP
           WHERE outbox_id = $1 AND published_at IS NULL`,
          [row.outbox_id]
        );
        if (marked.rowCount === 1) published += 1;
      }
      return { published };
    },
    async close() {
      await Promise.all([redis.close(), pool.end()]);
    }
  };
}
