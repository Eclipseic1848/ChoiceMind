import type { Pool, PoolClient } from "pg";

export async function migrateIdentityLifecycleEventTable(
	client: Pool | PoolClient,
): Promise<void> {
	await client.query(`
		CREATE TABLE IF NOT EXISTS identity_account_lifecycle_events (
			event_id uuid PRIMARY KEY,
			account_id uuid NOT NULL REFERENCES identity_accounts(account_id),
			event_type text NOT NULL CHECK (event_type IN ('RESTRICT_ACCOUNT', 'DELETE_ACCOUNT')),
			correlation_id text NOT NULL,
			occurred_at timestamptz NOT NULL,
			scheduled_at timestamptz NOT NULL,
			processed_at timestamptz,
			cancelled_at timestamptz,
			attempt_count integer NOT NULL DEFAULT 0,
			last_attempt_at timestamptz
		)
	`);
	await client.query(
		`CREATE INDEX IF NOT EXISTS identity_account_lifecycle_events_pending_idx
		 ON identity_account_lifecycle_events (scheduled_at, occurred_at, event_id)
		 WHERE processed_at IS NULL AND cancelled_at IS NULL`,
	);
}
