import type { PoolClient } from "pg";

export const persistentDecisionTaskMigrationVersion = "0001_initial_task_outbox";
export const persistentDecisionTaskExecutionMigrationVersion =
  "0002_agent_run_execution_lease";
export const persistentDecisionTaskResultMigrationVersion =
  "0003_agent_run_result";
export const persistentDecisionTaskOutcomeMigrationVersion =
  "0004_agent_run_outcome_states";
export const persistentDecisionTaskRunEventMigrationVersion = "0005_decision_task_run_events";
export const persistentDecisionTaskRunEventNotificationMigrationVersion =
  "0006_run_event_notification_outbox";
export const persistentDecisionTaskAgentRunAttemptMigrationVersion =
  "0007_agent_run_attempts";

export async function migratePersistentDecisionTasks(client: PoolClient): Promise<void> {
  await client.query("BEGIN");

  try {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('choicemind-task-persistence-migration', 0))"
    );
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    await client.query(`
      CREATE TABLE IF NOT EXISTS decision_task_schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS decision_task_submissions (
        execution_request_id text PRIMARY KEY,
        command_fingerprint text NOT NULL,
        decision_task_id text NOT NULL,
        command_payload jsonb NOT NULL,
        created_at timestamptz NOT NULL
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_run_operations (
        operation_id uuid PRIMARY KEY,
        agent_run_id text NOT NULL UNIQUE,
        execution_request_id text NOT NULL UNIQUE
          REFERENCES decision_task_submissions(execution_request_id),
        decision_task_id text NOT NULL,
        state text NOT NULL CHECK (state IN ('ACCEPTED')),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS agent_run_operations_task_lookup
      ON agent_run_operations (decision_task_id, created_at DESC)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS outbox_messages (
        message_id uuid PRIMARY KEY,
        operation_id uuid NOT NULL UNIQUE REFERENCES agent_run_operations(operation_id),
        payload_type text NOT NULL,
        payload_version text NOT NULL,
        payload jsonb NOT NULL,
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz NOT NULL,
        published_at timestamptz,
        created_at timestamptz NOT NULL
      )
    `);
    await client.query(
      `INSERT INTO decision_task_schema_migrations (version)
       VALUES ($1)
       ON CONFLICT (version) DO NOTHING`,
      [persistentDecisionTaskMigrationVersion]
    );
    const executionMigration = await client.query<{ applied: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM decision_task_schema_migrations
         WHERE version = $1
       ) AS applied`,
      [persistentDecisionTaskExecutionMigrationVersion]
    );

    if (!executionMigration.rows[0]?.applied) {
      await client.query(`
        ALTER TABLE agent_run_operations
        ADD COLUMN IF NOT EXISTS worker_id text,
        ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz
      `);
      await client.query(`
        ALTER TABLE agent_run_operations
        DROP CONSTRAINT IF EXISTS agent_run_operations_state_check
      `);
      await client.query(`
        ALTER TABLE agent_run_operations
        ADD CONSTRAINT agent_run_operations_state_check
        CHECK (state IN ('ACCEPTED', 'RUNNING'))
      `);
      await client.query(
        `INSERT INTO decision_task_schema_migrations (version)
         VALUES ($1)`,
        [persistentDecisionTaskExecutionMigrationVersion]
      );
    }
    const resultMigration = await client.query<{ applied: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM decision_task_schema_migrations
         WHERE version = $1
       ) AS applied`,
      [persistentDecisionTaskResultMigrationVersion]
    );

    if (!resultMigration.rows[0]?.applied) {
      await client.query(`
        ALTER TABLE agent_run_operations
        ADD COLUMN IF NOT EXISTS result_payload jsonb
      `);
      await client.query(`
        ALTER TABLE agent_run_operations
        DROP CONSTRAINT IF EXISTS agent_run_operations_state_check
      `);
      await client.query(`
        ALTER TABLE agent_run_operations
        ADD CONSTRAINT agent_run_operations_state_check
        CHECK (state IN ('ACCEPTED', 'RUNNING', 'COMPLETED', 'FAILED_FINAL'))
      `);
      await client.query(
        `INSERT INTO decision_task_schema_migrations (version)
         VALUES ($1)`,
        [persistentDecisionTaskResultMigrationVersion]
      );
    }
    const outcomeMigration = await client.query<{ applied: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM decision_task_schema_migrations
         WHERE version = $1
       ) AS applied`,
      [persistentDecisionTaskOutcomeMigrationVersion]
    );

    if (!outcomeMigration.rows[0]?.applied) {
      await client.query(`
        ALTER TABLE agent_run_operations
        DROP CONSTRAINT IF EXISTS agent_run_operations_state_check
      `);
      await client.query(`
        ALTER TABLE agent_run_operations
        ADD CONSTRAINT agent_run_operations_state_check
        CHECK (
          state IN (
            'ACCEPTED',
            'RUNNING',
            'COMPLETED',
            'FAILED_RETRYABLE',
            'FAILED_FINAL',
            'PARTIAL'
          )
        )
      `);
      await client.query(
        `INSERT INTO decision_task_schema_migrations (version)
         VALUES ($1)`,
        [persistentDecisionTaskOutcomeMigrationVersion]
      );
    }
    const runEventMigration = await client.query<{ applied: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM decision_task_schema_migrations
         WHERE version = $1
       ) AS applied`,
      [persistentDecisionTaskRunEventMigrationVersion]
    );

    if (!runEventMigration.rows[0]?.applied) {
      await client.query(`
        CREATE TABLE decision_task_run_events (
          cursor bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          event_id text NOT NULL UNIQUE,
          decision_task_id text NOT NULL,
          agent_run_id text NOT NULL REFERENCES agent_run_operations(agent_run_id),
          run_sequence integer NOT NULL CHECK (run_sequence > 0),
          event_payload jsonb NOT NULL,
          occurred_at timestamptz NOT NULL,
          persisted_at timestamptz NOT NULL,
          UNIQUE (agent_run_id, run_sequence)
        )
      `);
      await client.query(`
        CREATE INDEX decision_task_run_events_task_cursor_lookup
        ON decision_task_run_events (decision_task_id, cursor)
      `);
      await client.query(
        `INSERT INTO decision_task_schema_migrations (version)
         VALUES ($1)`,
        [persistentDecisionTaskRunEventMigrationVersion]
      );
    }
    const runEventNotificationMigration = await client.query<{
      applied: boolean;
    }>(
      `SELECT EXISTS (
         SELECT 1
         FROM decision_task_schema_migrations
         WHERE version = $1
       ) AS applied`,
      [persistentDecisionTaskRunEventNotificationMigrationVersion]
    );

    if (!runEventNotificationMigration.rows[0]?.applied) {
      await client.query(`
        CREATE TABLE decision_task_run_event_notifications (
          event_cursor bigint PRIMARY KEY REFERENCES decision_task_run_events(cursor),
          decision_task_id text NOT NULL,
          attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          next_attempt_at timestamptz NOT NULL,
          published_at timestamptz,
          created_at timestamptz NOT NULL
        )
      `);
      await client.query(`
        CREATE INDEX decision_task_run_event_notifications_pending
        ON decision_task_run_event_notifications (next_attempt_at, event_cursor)
        WHERE published_at IS NULL
      `);
      await client.query(
        `INSERT INTO decision_task_schema_migrations (version)
         VALUES ($1)`,
        [persistentDecisionTaskRunEventNotificationMigrationVersion]
      );
    }
    const agentRunAttemptMigration = await client.query<{
      applied: boolean;
    }>(
      `SELECT EXISTS (
         SELECT 1
         FROM decision_task_schema_migrations
         WHERE version = $1
       ) AS applied`,
      [persistentDecisionTaskAgentRunAttemptMigrationVersion]
    );

    if (!agentRunAttemptMigration.rows[0]?.applied) {
      await client.query(`
        CREATE TABLE decision_task_agent_runs (
          agent_run_id text PRIMARY KEY,
          operation_id uuid NOT NULL REFERENCES agent_run_operations(operation_id),
          attempt integer NOT NULL CHECK (attempt > 0),
          created_at timestamptz NOT NULL,
          UNIQUE (operation_id, attempt)
        )
      `);
      await client.query(`
        INSERT INTO decision_task_agent_runs (
          agent_run_id,
          operation_id,
          attempt,
          created_at
        )
        SELECT agent_run_id, operation_id, 1, created_at
        FROM agent_run_operations
      `);
      await client.query(`
        ALTER TABLE decision_task_run_events
        DROP CONSTRAINT decision_task_run_events_agent_run_id_fkey
      `);
      await client.query(`
        ALTER TABLE decision_task_run_events
        ADD CONSTRAINT decision_task_run_events_agent_run_id_fkey
        FOREIGN KEY (agent_run_id) REFERENCES decision_task_agent_runs(agent_run_id)
      `);
      await client.query(
        `INSERT INTO decision_task_schema_migrations (version)
         VALUES ($1)`,
        [persistentDecisionTaskAgentRunAttemptMigrationVersion]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
